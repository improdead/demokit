#!/usr/bin/env node
/**
 * shot dir (frames + manifest.json) -> polished demo MP4.
 *
 *   playwriter -s <id> -f src/record.js          # capture
 *   node src/demo.mjs .cache/shot out.mp4        # render
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render } from './render.mjs';
import { pace } from './pace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '.assets');

const [, , shotArg, outArg, ...rest] = process.argv;
if (!shotArg || !outArg) {
  console.error('usage: demo.mjs <shotDir> <out.mp4> [--level N --inset N --bias N --gap MS --keep S --speed N --bg NAME]');
  console.error('  --bg     auto | canvas-garden|canvas-dusk|canvas-tide|canvas-ember|canvas-slate');
  console.error('           | dusk ember tide slate noir linen | #rrggbb | <wallpaper.jpg> | blur');
  console.error('  --bgblur 0.004 --bgsat 0.82 --bgdim 0.92   how far a photo backdrop recedes');
  console.error('  --edit   auto (write edit.json) | off      --redirect  regenerate it');
  console.error('  --pad    0.55  room around a zoom target, as a share of the target');
  console.error('  --deep   1.7   deepest zoom; small targets approach it, big ones stay shallow');
  console.error('  --chrome <url> draw macOS + browser chrome around the page  [--tabs a|b|c]');
  console.error('  --pull   1.28  opening pull-back depth (1 = off), --pullms 1500');
  process.exit(2);
}
// The look is DATA, saved beside the recording. Without this, anything that
// re-renders (the autotuner especially) silently drops --w/--bg/--chrome and
// hands back a 1080p demo on a default background. Idea taken from DemoTape's
// recipe.json: change a field, re-render, footage identical.
const RECIPE_KEYS = ['w', 'h', 'level', 'deep', 'inset', 'bias', 'edgesnap', 'gap', 'keep', 'speed',
  'bg', 'bgblur', 'bgsat', 'bgdim', 'chrome', 'tabs', 'chrome-theme', 'pull', 'pullms', 'pad'];
const arg0 = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const shotDir = resolve(shotArg), outPath = resolve(outArg);
const recipePath = join(shotDir, 'recipe.json');
let recipe = {};
try { recipe = JSON.parse(readFileSync(recipePath, 'utf8')); } catch { /* first render */ }
for (const k of RECIPE_KEYS) { const v = arg0(k, null); if (v !== null) recipe[k] = v; }
// Loud about typos: a misspelled key means the change did NOT happen, and
// reporting that as success is how a "fixed" render ships unchanged.
for (const k of rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2))) {
  if (!RECIPE_KEYS.includes(k) && !['edit', 'redirect', 'beats', 'maxbeats', 'fill'].includes(k)) {
    console.warn(`demo: ignoring unknown option --${k}`);
  }
}
const arg = (n, d) => (recipe[n] !== undefined ? recipe[n] : d);
// ffmpeg will not create the output directory for you.
mkdirSync(dirname(outPath), { recursive: true });
const stage = join(ASSETS, 'stage.mp4');

const runp = promisify(execFile);
const man0 = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));

// Beats from what CHANGED, for captures with no click log (a screen recording),
// or to augment clicks when asked. A hover changes nothing on screen, so this
// finds fewer beats than clicks does on a browser take - by design.
// Default on whenever there is no click log at all - that covers every capture
// source that isn't the browser recorder, present and future.
const noClicks = !(man0.clicks || []).length;
// The director decides the camera from what actually happened, and writes an
// editable edit.json. Skipped when one already exists, so hand edits survive a
// re-render - pass --redirect to regenerate.
const edlPath = join(shotDir, 'edit.json');
if (arg('edit', 'auto') !== 'off') {
  if (!existsSync(edlPath) || rest.includes('--redirect')) {
    const { direct } = await import('./edit.mjs');
    const edl = await direct(shotDir, {
      maxZooms: Number(arg('maxbeats', '6')),
      minGapMs: Number(arg('gap', '1800')),
      padFrac: Number(arg('pad', '0.55')),
    });
    for (const w of edl.warnings || []) console.log(`edit: ! ${w}`);
    console.log(`edit: ${edl.zooms.length} zoom(s), each with a reason:`);
    for (const z of edl.zooms) {
      console.log(`  ${(z.tMs / 1000).toFixed(1).padStart(6)}s  ${z.rect[2]}x${z.rect[3]}  ${z.reason}`
        + (z.warn ? `  [!] ${z.warn}` : ''));
    }
  } else {
    console.log(`edit: using existing ${edlPath} (--redirect to regenerate)`);
  }
}

// Pass 1: draw the cursor and click pulses onto the frames from the dense
// pointer path. Must happen before compositing so they scale with the window.
// A screen recording already has the real cursor in the pixels - drawing a
// second one there is the exact bug this tool exists to avoid.
if ((man0.path || []).length) {
  const cur = await runp('python3', [join(HERE, 'cursor.py'), shotDir], { maxBuffer: 1 << 26 });
  process.stdout.write(cur.stdout);
} else {
  console.log('cursor pass: skipped (no pointer path - real cursor is in the frames)');
}

// Synthetic window + browser chrome. A tab screencast is the page rectangle and
// nothing else; the chrome is what makes it read as an app someone is using.
// Runs after the cursor pass and shifts every beat down by its own height.
if (arg('chrome', null) !== null) {
  const c = await runp('python3', [join(HERE, 'chrome.py'), shotDir,
    '--url', arg('chrome', 'localhost'),
    ...(arg('tabs', null) ? ['--tabs', arg('tabs')] : []),
    '--theme', arg('chrome-theme', 'light')], { maxBuffer: 1 << 26 });
  process.stdout.write(c.stdout);
}

const r = await render({
  shotDir, output: stage, assetDir: ASSETS,
  // capture is 2x device pixels; downscale to 1080p so the picture is sharp
  // 4K by default. 1080p was the default and every 4K take needed two flags
  // nobody remembers, so the thing that shipped was 1080p with a note claiming
  // otherwise. The capture is 3860px wide; anything less throws pixels away.
  outW: Number(arg('w', '3840')), outH: Number(arg('h', '2160')),
  level: Number(arg('level', '1.4')),
  // How much of the frame the window occupies. Too tight and it stops floating
  // and starts being a screenshot with a border; 0.86 filled the frame edge to
  // edge and the backdrop stopped existing.
  inset: Number(arg('inset', '0.72')),
  centerBias: Number(arg('bias', '0')),
  edgeSnap: Number(arg('edgesnap', '0')),
  minGapMs: Number(arg('gap', '1500')),
  maxLevel: Number(arg('deep', '1.7')),
  openPull: Number(arg('pull', '1.28')),
  openMs: Number(arg('pullms', '1500')),
  bg: arg('bg', 'auto'),
  bgBlur: Number(arg('bgblur', '0.004')),
  bgSat: Number(arg('bgsat', '0.82')),
  bgDim2: Number(arg('bgdim', '0.92')),
});
console.log(`composited ${r.frames} frames @ ${r.srcW}x${r.srcH}, ${r.zooms} zoom(s), backdrop=${r.backdrop}`);

// Pacing protects the stretches around the camera moves. Reading
// manifest.clicks here protected beats the director had already rejected, and
// left the real ones exposed - the camera and the cut have to agree.
const edlNow = existsSync(edlPath) ? JSON.parse(readFileSync(edlPath, 'utf8')) : null;
const openPullMs = Number(arg('pullms', '1500'));
const protectOpen = Number(arg('pull', '1.28')) > 1.001 && openPullMs > 0
  ? [{ fromMs: 0, toMs: openPullMs }] : [];
// The opening pull-back is a camera move too. It sat inside the first
// compressed segment, so a 1.5s reveal played in 0.4s - a jolt before anything
// had happened, which is exactly what reads as a random zoom.
// Protect everything the viewer is meant to WATCH, not just the camera moves.
//
// This is what "glitchy" was. A 9.3s stretch holding the pointer gliding across
// the window and the whole typing run was compressed 3.5x, because the only
// spans anyone thought to protect were the zooms. The mouse teleports and the
// letters strobe. Typing had already been slowed to 135ms a character on purpose
// and then the pace map put it back.
//
// Idle means idle: nothing moving, nothing being typed, camera at rest.
function protectedSpans(man, edl) {
  const out = [];
  for (const c of (edl?.chains) || []) out.push({ fromMs: c.startMs, toMs: c.endMs });

  // Typing runs: from the keystroke beat back over the run and past its settle.
  for (const e of man.events || []) {
    if (e.kind === 'type') out.push({ fromMs: Math.max(0, e.t - 2600), toMs: e.t + 700 });
  }

  // Pointer motion: any stretch where the cursor is actually travelling. A
  // glide is the one moment a viewer's eye is locked to something, and it is
  // the cheapest thing in the video to get wrong.
  const pts = (man.pointer && man.pointer.length) ? man.pointer : (man.path || []);
  let runStart = null, prev = null;
  for (const q of pts) {
    if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > 2 && q.t - prev.t < 400) {
      if (runStart == null) runStart = prev.t;
    } else if (runStart != null) {
      out.push({ fromMs: Math.max(0, runStart - 150), toMs: prev.t + 250 });
      runStart = null;
    }
    prev = q;
  }
  if (runStart != null && prev) out.push({ fromMs: Math.max(0, runStart - 150), toMs: prev.t + 250 });
  return out;
}

const manNow = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
const spans = protectedSpans(manNow, edlNow);
const clicks = spans.length
  ? protectOpen.concat(spans)
  : manNow.clicks.map((c) => ({ ...c, atMs: c.t }));
console.log(`pace: protecting ${spans.length} span(s) - camera moves, typing runs `
  + `and every stretch where the pointer is moving`);
const p = await pace({
  input: stage, output: outPath, clicks, workDir: ASSETS,
  keep: Number(arg('keep', '0.55')), speed: Number(arg('speed', '4')),
});
if (p.skipped) copyFileSync(stage, outPath);
else console.log(`paced ${p.duration.toFixed(1)}s -> ${(p.duration - p.saved).toFixed(1)}s`);
// Persist how time was remapped. Without it nothing downstream can turn a
// source timestamp into the moment it appears in the finished video, so a
// critic looking for "the peak of move 2" has to guess.
writeFileSync(join(shotDir, 'pace.json'), JSON.stringify({
  sourceDurationSec: p.duration ?? null, segments: p.segs ?? [{ start: 0, end: p.duration, speed: 1 }],
}, null, 1));
writeFileSync(recipePath, JSON.stringify(recipe, null, 1));
console.log(`wrote ${outPath}`);
console.log(`recipe: ${recipePath} (edit a field and re-render; the footage is untouched)`);

// Verify the PRODUCT, not the film - and do it without being asked. A pass that
// only runs when someone remembers to run it is a pass that reports success by
// default, which is the failure it exists to prevent.
if (!process.argv.includes('--no-verify')) {
  try {
    const { verify } = await import('./verify.mjs');
    const v = await verify(shotDir, outPath);
    if (v.steps && v.steps.length) {
      console.log(`\nfeature check: ${v.outcome}  `
        + `(${v.counts.verified} verified, ${v.counts.failed} failed, ${v.counts.inconclusive} unclear)`);
      for (const st of v.steps) {
        if (st.verdict === 'verified') continue;
        console.log(`  ${st.verdict.toUpperCase()}  ${st.atSec}s  ${st.label}`);
        console.log(`     ${st.why}`);
        for (const f of st.strips) console.log(`     look: ${f}`);
      }
      if (v.outcome !== 'verified') {
        console.log('  A step that changes nothing is a beat the demo should not have. '
          + 'Fix the flow, not the framing.');
      }
    } else if (v.why && !['term', 'screen'].includes(man0.source)) {
      console.log(`\nfeature check: ${v.outcome} - ${v.why}`);
    }
  } catch (e) {
    console.log('\nfeature check: could not run - ' + String(e.message || e).slice(0, 140));
  }
}
