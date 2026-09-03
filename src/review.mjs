#!/usr/bin/env node
/**
 * Measure a rendered demo against the checks in skill/SKILL.md §9, and - with
 * --fix - re-render until they pass.
 *
 *   node src/review.mjs <shotDir> <out.mp4> [--fix] [--rounds 4]
 *
 * The point is that "does this look good" is the one question the thing that
 * made the video cannot answer honestly about itself. So none of these checks
 * ask that. Each one is a number with a threshold: how long it runs, whether a
 * rest state exists, whether anything actually changed between the opening
 * frame and the payoff, whether the ending is held or cut off.
 *
 * --fix only ever adjusts RENDER flags, never the flow. Framing is the one
 * layer a knob can repair; a demo of the wrong thing needs a different take,
 * and this deliberately will not pretend otherwise - it says so and stops.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);

const TARGET = {
  minDur: 20, maxDur: 75,        // the skill wants 45-75; under 20s is a clip, not a demo
  minBeats: 3, maxBeats: 7,
  restFrac: 0.12,                // at least this share of the video unzoomed
  tailHold: 2.5,                 // seconds resting on the payoff at the end
  minChange: 6.0,                // mean |luma| difference, first frame vs payoff
  maxStall: 2.6,                 // longest stretch with no visual change
};

/** Sample the output at a low rate and measure zoom, change and stalls. */
async function measure(mp4) {
  const dir = mkdtempSync(join(tmpdir(), 'dk-review-'));
  try {
    const { stdout: probe } = await run('ffprobe', ['-v', 'error',
      '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]);
    const duration = parseFloat(probe.trim());

    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4,
      '-vf', 'fps=4,scale=320:-2', join(dir, 'r%04d.png')], { maxBuffer: 1 << 26 });

    // The window is found by DETAIL, not brightness: a gradient backdrop has
    // almost no vertical gradient, UI content has a lot. Thresholding on
    // luminance instead reports a bright backdrop as content and measures
    // every frame as unzoomed.
    const py = `
import glob, numpy as np
from PIL import Image
fs = sorted(glob.glob(${JSON.stringify(join(dir, 'r*.png'))}))
prev, widths, diffs, frames = None, [], [], []
for f in fs:
    im = Image.open(f).convert('L')
    a = np.asarray(im, dtype=float)
    frames.append(a)
    e = np.abs(np.diff(a, axis=0)).sum(axis=0)      # per-column detail energy
    thr = e.max() * 0.06
    cols = np.nonzero(e > thr)[0]
    widths.append(int(cols.max() - cols.min()) if cols.size else 0)
    diffs.append(0.0 if prev is None else float(np.abs(a - prev).mean()))
    prev = a
import json

// The Python renderer, as resolved by bin/demokit (a venv when the system
// interpreter lacks Pillow/numpy).
const PY = process.env.DEMOKIT_PY || 'python3';
first = frames[0]
print(json.dumps({
  "n": len(fs),
  "widths": widths,
  "diffs": [round(d, 3) for d in diffs],
  "changeVsFirst": [round(float(np.abs(f - first).mean()), 2) for f in frames],
}))`;
    const { stdout } = await run(PY, ['-c', py], { maxBuffer: 1 << 26 });
    const m = JSON.parse(stdout);

    // Tolerance is RELATIVE, not a flat +5px. The detail span shifts with the
    // page content - a detail view simply has a different amount of edge energy
    // than a list - so an absolute threshold reads a content change as a zoom
    // and reports a resting tail as still zoomed. A real zoom here is ~30%
    // wider; content drift is a few percent.
    const rest = Math.min(...m.widths.filter((w) => w > 0));
    const peak = Math.max(...m.widths);
    const atRest = (w) => w <= rest * 1.08;
    const restFrames = m.widths.filter(atRest).length;

    let tail = 0;
    for (let i = m.widths.length - 1; i >= 0 && atRest(m.widths[i]); i--) tail += 0.25;

    // Dead air is a stall in the MIDDLE. The stretch at the end is the payoff
    // hold, which the skill requires to be 3-5s - counting it as dead air makes
    // two checks contradict each other, and no flag can satisfy both.
    let stall = 0, cur = 0;
    const lastMoving = m.diffs.reduce((acc, d, i) => (d >= 0.35 ? i : acc), 0);
    for (let i = 0; i <= lastMoving; i++) {
      cur = m.diffs[i] < 0.35 ? cur + 0.25 : 0;
      stall = Math.max(stall, cur);
    }

    return {
      duration,
      zoomRange: peak - rest,
      restFrac: restFrames / m.widths.length,
      tailHold: tail,
      maxChange: Math.max(...m.changeVsFirst),
      maxStall: stall,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function review({ shotDir, mp4, gap = 1500 }) {
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  // The edit decision list is the camera. Reading manifest.clicks measures
  // what was recorded, not what the video does.
  const edlPath = join(shotDir, 'edit.json');
  const edl = existsSync(edlPath) ? JSON.parse(readFileSync(edlPath, 'utf8')) : null;
  const all = edl ? (edl.chains || []).map((c) => ({ t: c.startMs, label: c.reason }))
                  : (man.clicks || []);

  // Camera state comes from the EDIT, not from pixels.
  //
  // The pixel test measured how wide the detailed region was, which worked only
  // while zooming moved the window on the canvas. The zoom now happens inside
  // the recording and the window never changes size, so that test measures page
  // CONTENT and reports a resting camera as permanently zoomed. edit.json says
  // exactly when the camera moves and pace.json says where that lands in the
  // finished video - no inference required.
  let camera = null;
  const pacePath = join(shotDir, 'pace.json');
  if (edl && existsSync(pacePath)) {
    const { segments } = JSON.parse(readFileSync(pacePath, 'utf8'));
    const toOut = (t) => {
      let out = 0;
      for (const sg of segments) {
        if (t <= sg.start) break;
        out += (Math.min(t, sg.end) - sg.start) / sg.speed;
        if (t <= sg.end) break;
      }
      return out;
    };
    const total = toOut((edl.durationMs || 0) / 1000);
    const spans = (edl.chains || []).map((c) => [toOut(c.startMs / 1000), toOut(c.endMs / 1000)]);
    const moving = spans.reduce((a, [x, y]) => a + (y - x), 0);
    const lastEnd = spans.length ? Math.max(...spans.map((x) => x[1])) : 0;
    camera = { total, restFrac: total ? 1 - moving / total : 1, tailHold: Math.max(0, total - lastEnd) };
  }
  const m = await measure(mp4);

  // Measure the beats that actually produce a zoom. render.mjs drops any beat
  // closer than --gap to the previous one, so checking raw manifest times
  // reports a merge the renderer already handled - and no flag can fix it,
  // because --gap is the thing doing the merging.
  const kept = [];
  for (const c of all) if (!kept.length || c.t - kept[kept.length - 1].t >= gap) kept.push(c);
  const beats = kept.length;
  const merged = all.length - kept.length;
  const gaps = kept.slice(1).map((c, i) => (c.t - kept[i].t) / 1000);
  const checks = [
    ['duration', m.duration >= TARGET.minDur && m.duration <= TARGET.maxDur,
      `${m.duration.toFixed(1)}s (want ${TARGET.minDur}-${TARGET.maxDur})`,
      m.duration < TARGET.minDur ? { speed: -1, keep: +0.5 } : { speed: +1 }],
    ['beats', beats >= TARGET.minBeats && beats <= TARGET.maxBeats,
      `${beats} camera move(s)${merged ? ` (${merged} merged)` : ''} (want ${TARGET.minBeats}-${TARGET.maxBeats})`, null],
    ['zoom lands', m.zoomRange > 12, `range ${m.zoomRange}px`, { level: +0.15 }],
    ['rest state', (camera ? camera.restFrac : m.restFrac) >= TARGET.restFrac,
      `${((camera ? camera.restFrac : m.restFrac) * 100).toFixed(0)}% camera at rest`
      + `${camera ? ' (from the edit)' : ' (inferred)'} (want >=${TARGET.restFrac * 100}%)`,
      { gap: +500 }],
    ['payoff hold', (camera ? camera.tailHold : m.tailHold) >= TARGET.tailHold,
      `${(camera ? camera.tailHold : m.tailHold).toFixed(2)}s at rest at the end`
      + ` (want >=${TARGET.tailHold})`, { keep: +0.4 }],
    ['something changed', m.maxChange >= TARGET.minChange,
      `max ${m.maxChange} mean-luma vs frame 0 (want >=${TARGET.minChange})`, null],
    ['no dead air', m.maxStall <= TARGET.maxStall,
      `longest still stretch ${m.maxStall.toFixed(2)}s (want <=${TARGET.maxStall})`,
      { speed: +1 }],
    ['beats spaced', !gaps.length || Math.min(...gaps) >= 1.8,
      gaps.length ? `closest zooms ${Math.min(...gaps).toFixed(1)}s apart` : 'n/a',
      { gap: +400 }],
  ];
  return { m, beats, checks };
}

function report({ checks }) {
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail}`);
  }
  return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, mp4, ...rest] = process.argv;
  if (!shotDir || !mp4) {
    console.error('usage: review.mjs <shotDir> <out.mp4> [--fix] [--rounds 4]');
    process.exit(2);
  }
  const fix = rest.includes('--fix');
  const rounds = Number(rest[rest.indexOf('--rounds') + 1]) || 4;
  const HERE = new URL('.', import.meta.url).pathname;

  // Only these are safe to move automatically: all four are framing, and the
  // frames on disk are untouched, so every round is a re-render not a re-shoot.
  const knob = { level: 1.4, gap: 1500, keep: 1.35, speed: 4 };

  let r = await review({ shotDir, mp4, gap: knob.gap });
  console.log(`\nreview: ${mp4}`);
  let failed = report(r);

  if (!fix || failed === 0) {
    console.log(failed === 0 ? '\nall checks pass' : `\n${failed} check(s) failed — re-run with --fix`);
    const story = r.checks.find(([n, ok]) => n === 'something changed' && !ok);
    if (story) {
      console.log('NOTE: "something changed" is a STORY failure. No render flag fixes it —');
      console.log('      the take shows nothing happening. Pick a different case and re-record.');
    }
    process.exit(failed ? 1 : 0);
  }

  let lastFailed = failed;
  for (let i = 1; i <= rounds && failed; i++) {
    const deltas = r.checks.filter(([, ok, , d]) => !ok && d).map(([, , , d]) => d);
    if (!deltas.length) break;
    for (const d of deltas) {
      for (const [k, v] of Object.entries(d)) {
        knob[k] = Math.max(k === 'speed' ? 1 : 0.1, (knob[k] || 0) + v);
      }
    }
    console.log(`\nround ${i}: ${JSON.stringify(knob)}`);
    await run('node', [join(HERE, 'demo.mjs'), shotDir, mp4,
      '--level', String(knob.level), '--gap', String(knob.gap),
      '--keep', String(knob.keep), '--speed', String(knob.speed)], { maxBuffer: 1 << 26 });
    r = await review({ shotDir, mp4, gap: knob.gap });
    failed = report(r);
    // A round that fixes nothing will not start fixing something on the next
    // one - the knobs only move in one direction. Stop and say so.
    if (failed >= lastFailed && i > 1) {
      console.log('\nno improvement from the last round; stopping.');
      console.log('What is left is not a framing problem - it needs a different take.');
      break;
    }
    lastFailed = failed;
  }
  console.log(failed === 0 ? '\nall checks pass' : `\n${failed} check(s) still failing`);
  process.exit(failed ? 1 : 0);
}
