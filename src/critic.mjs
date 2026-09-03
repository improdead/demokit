#!/usr/bin/env node
/**
 * Prepare a finished demo for an agent to WATCH, and let it edit what it saw.
 *
 *   node src/critic.mjs <shotDir> <out.mp4>            # build the review pack
 *   node src/critic.mjs <shotDir> <out.mp4> --apply p.json
 *
 * review.mjs measures. It cannot answer "does this look right", and saying it
 * can is how a demo of the wrong thing passes eight green checks. This pass
 * pulls the frames that actually decide that question - derived from the edit
 * decision list, not sampled on a timer - says what each one is SUPPOSED to
 * show, and hands the lot to something with eyes.
 *
 * It also runs invariants the eyes miss. DemoTape has a good story about this:
 * a take where the camera held on the left of a text field while the sentence
 * grew out of frame passed every assertion AND their vision gate; the only
 * thing that caught it was a measured invariant. Vision and arithmetic fail in
 * different directions, so both run.
 *
 * Three outcomes, never two: `verified`, `failed`, and `inconclusive` - the
 * gate could not run. Treating "I could not look" as "it is fine" is the one
 * result that quietly ships a bad demo.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from './verify.mjs';

// The Python renderer, as resolved by bin/demokit (a venv when the system
// interpreter lacks Pillow/numpy).
const PY = process.env.DEMOKIT_PY || 'python3';

const run = promisify(execFile);

/** Source seconds -> seconds in the finished video, through the pace map. */
function timeMapper(shotDir) {
  const p = join(shotDir, 'pace.json');
  if (!existsSync(p)) return (t) => t;
  const { segments } = JSON.parse(readFileSync(p, 'utf8'));
  return (t) => {
    let out = 0;
    for (const s of segments) {
      if (t <= s.start) break;
      out += (Math.min(t, s.end) - s.start) / s.speed;
      if (t <= s.end) break;
    }
    return out;
  };
}

/** Geometric invariants: things vision reliably fails to notice. */
function invariants(edl, man, recipe) {
  const out = [];
  const even = (v) => (v % 2 ? v + 1 : v);
  const outW = Number(recipe.w || 1920), outH = Number(recipe.h || 1080);
  const inset = Number(recipe.inset || 0.8), maxLevel = Number(recipe.deep || 1.7);
  const compW = even(man.width), compH = even(Math.round(man.width * (outH / outW)));
  const ar = man.width / man.height;
  let fgW = compW * inset, fgH = fgW / ar;
  if (fgH > compH * inset) { fgH = compH * inset; fgW = fgH * ar; }
  fgW = even(Math.round(fgW)); fgH = even(Math.round(fgH));
  const sx = fgW / man.width, sy = fgH / man.height;
  const ox = Math.round((compW - fgW) / 2), oy = Math.round((compH - fgH) / 2);
  const fillZ = Math.max(compW / fgW, compH / fgH);

  const seen = [];
  for (const c of edl.chains || []) {
    for (const t of c.targets) {
      const pad = t.padFrac ?? 0.55;
      const rw = t.rect[2] * sx, rh = t.rect[3] * sy;
      let z = Math.min(compW / Math.max(1, rw * (1 + 2 * pad)), compH / Math.max(1, rh * (1 + 2 * pad)));
      z = Math.max(fillZ, Math.min(Math.max(maxLevel, fillZ), z));
      const halfW = compW / (2 * z), halfH = compH / (2 * z);
      let cx = ox + t.rect[0] * sx + rw / 2, cy = oy + t.rect[1] * sy + rh / 2;
      if (halfW * 2 <= fgW) cx = Math.max(ox + halfW, Math.min(ox + fgW - halfW, cx));
      if (halfH * 2 <= fgH) cy = Math.max(oy + halfH, Math.min(oy + fgH - halfH, cy));

      // 1. the thing the zoom exists for must be inside the frame it produces
      const rx0 = ox + t.rect[0] * sx, ry0 = oy + t.rect[1] * sy;
      const inside = rx0 >= cx - halfW && rx0 + rw <= cx + halfW
                  && ry0 >= cy - halfH && ry0 + rh <= cy + halfH;
      if (!inside) {
        out.push({ ok: false, at: t.tMs,
          check: 'target inside frame',
          detail: `"${t.reason}" is cropped out of its own zoom` });
      }

      // 2. the crop must not straddle the window edge
      const clean = cx - halfW >= ox - 1 && cx + halfW <= ox + fgW + 1;
      if (!clean && z > 1.05) {
        out.push({ ok: false, at: t.tMs, check: 'crop inside window',
          detail: `crop ${Math.round(halfW * 2)}px vs window ${fgW}px - backdrop will slice the frame` });
      }

      // 3. two moves that land on the same place are one move
      const key = `${Math.round(cx / 40)},${Math.round(cy / 40)},${z.toFixed(2)}`;
      const dup = seen.find((s) => s.key === key && Math.abs(s.t - t.tMs) > 500);
      if (dup) {
        out.push({ ok: false, at: t.tMs, check: 'distinct moves',
          detail: `frames the same region as ${(dup.t / 1000).toFixed(1)}s - the camera moves for nothing` });
      }
      seen.push({ key, t: t.tMs });
    }
  }

  // 4. a pointer that never moves during a typing run means the measurement went blind
  const typing = (man.events || []).filter((e) => e.kind === 'type');
  for (const ty of typing) {
    const pts = (man.path || []).filter((p) => p.t >= ty.t - 200 && p.t <= ty.t + 2500);
    if (pts.length > 4 && new Set(pts.map((p) => Math.round(p.x / 8))).size <= 1) {
      out.push({ ok: false, at: ty.t, check: 'pointer tracks typing',
        detail: 'pointer x is constant across a typing run' });
    }
  }
  return out;
}

export async function buildPack(shotDir, mp4) {
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const edl = JSON.parse(readFileSync(join(shotDir, 'edit.json'), 'utf8'));
  let recipe = {};
  try { recipe = JSON.parse(readFileSync(join(shotDir, 'recipe.json'), 'utf8')); } catch {}
  const toOut = timeMapper(shotDir);

  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'csv=p=0', mp4]);
  const dur = parseFloat(stdout.trim());

  // Frames chosen from the EDIT, not on a timer: the opening, then before /
  // peak / after for every camera move, then the ending.
  const shots = [{ t: 0.3, what: 'opening frame', expect: 'the product already on screen, in motion, not a title card' }];
  for (const c of edl.chains || []) {
    const a = toOut(c.startMs / 1000), b = toOut(c.endMs / 1000);
    shots.push({ t: Math.max(0, a - 0.6), what: `before: ${c.reason}`, expect: 'whole window at rest on the backdrop' });
    shots.push({ t: (a + b) / 2, what: `PEAK: ${c.reason}`, expect: `framed on: ${c.targets.map((x) => x.reason).join(' then ')}` });
    shots.push({ t: Math.min(dur - 0.1, b + 0.6), what: `after: ${c.reason}`, expect: 'back at rest' });
  }
  shots.push({ t: Math.max(0, dur - 0.4), what: 'final frame', expect: 'resting on the outcome' });

  const dir = join(shotDir, 'critic');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [i, s] of shots.entries()) {
    s.file = join(dir, `s${String(i).padStart(2, '0')}.png`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', s.t.toFixed(2), '-i', mp4,
      '-frames:v', '1', '-vf', 'scale=1280:-2', s.file]);
  }

  // one sheet, so it can be looked at in a single pass
  const sheet = join(dir, 'sheet.png');
  const py = `
from PIL import Image, ImageDraw, ImageFont
import json
shots = json.loads(${JSON.stringify(JSON.stringify(shots))})
W, H = 900, 506
try: f = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 17)
except Exception: f = None
sheet = Image.new("RGB", (W, (H + 30) * len(shots)), (12, 13, 17))
d = ImageDraw.Draw(sheet)
for i, s in enumerate(shots):
    y = i * (H + 30)
    sheet.paste(Image.open(s["file"]).resize((W, H), Image.LANCZOS), (0, y + 30))
    d.text((10, y + 7), f'{i}. {s["t"]:.1f}s  {s["what"]}'[:100], fill=(240, 150, 150), font=f)
sheet.save(${JSON.stringify(sheet)})`;
  await run(PY, ['-c', py], { maxBuffer: 1 << 26 });

  const inv = invariants(edl, man, recipe);

  // The camera passing is not the demo passing. A take can be framed perfectly
  // on a feature that did nothing, so the functional verdict is folded in here
  // and it can only ever make the outcome worse, never better.
  let feature = null;
  try { feature = await verify(shotDir, mp4); }
  catch (e) { feature = { outcome: 'inconclusive', why: 'verify pass failed: ' + String(e.message || e), steps: [] }; }

  const outcome = (inv.length || feature.outcome === 'failed') ? 'failed'
    : feature.outcome === 'inconclusive' ? 'inconclusive' : 'pending-vision';

  const pack = {
    video: mp4, durationSec: dur, sheet,
    claim: edl.claim || null,
    shots: shots.map(({ t, what, expect, file }) => ({ t: +t.toFixed(2), what, expect, file })),
    invariants: inv.length ? inv : [{ ok: true, check: 'all', detail: 'no geometric problems' }],
    feature: { outcome: feature.outcome, counts: feature.counts || null,
      steps: (feature.steps || []).map((s) => ({ at: s.atSec, label: s.label, verdict: s.verdict, why: s.why })),
      strips: (feature.steps || []).flatMap((s) => s.strips || []) },
    think: feature.think || [],
    outcome,
  };
  writeFileSync(join(shotDir, 'critic.json'), JSON.stringify(pack, null, 1));
  return pack;
}

/** Apply an agent's judgement. Only these fields; anything else is named. */
export function applyPatch(shotDir, patch) {
  const edlPath = join(shotDir, 'edit.json');
  const recPath = join(shotDir, 'recipe.json');
  const edl = JSON.parse(readFileSync(edlPath, 'utf8'));
  let rec = {}; try { rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch {}
  const log = [];

  for (const t of patch.dropZooms || []) {
    const before = edl.zooms.length;
    edl.zooms = edl.zooms.filter((z) => Math.abs(z.tMs - t) > 400);
    for (const c of edl.chains) c.targets = c.targets.filter((z) => Math.abs(z.tMs - t) > 400);
    edl.chains = edl.chains.filter((c) => c.targets.length);
    log.push(`drop zoom @${t}ms: ${before} -> ${edl.zooms.length}`);
  }
  for (const m of patch.setRect || []) {
    for (const c of edl.chains) for (const z of c.targets) {
      if (Math.abs(z.tMs - m.tMs) <= 400) { z.rect = m.rect; log.push(`rect @${m.tMs}ms -> ${m.rect}`); }
    }
  }
  for (const m of patch.setHold || []) {
    for (const c of edl.chains) {
      if (Math.abs(c.startMs - m.startMs) <= 600) { c.endMs = c.startMs + m.holdMs; log.push(`hold @${m.startMs}ms -> ${m.holdMs}ms`); }
    }
  }
  const RECIPE_OK = ['w', 'h', 'inset', 'deep', 'speed', 'keep', 'gap', 'bg', 'bgblur', 'bgsat',
    'bgdim', 'pull', 'pullms', 'chrome', 'tabs', 'level', 'bias', 'pad'];
  for (const [k, v] of Object.entries(patch.recipe || {})) {
    if (!RECIPE_OK.includes(k)) { log.push(`IGNORED unknown recipe key: ${k}`); continue; }
    rec[k] = String(v); log.push(`recipe ${k} -> ${v}`);
  }
  for (const k of Object.keys(patch)) {
    if (!['dropZooms', 'setRect', 'setHold', 'recipe', 'note'].includes(k)) {
      log.push(`IGNORED unknown patch key: ${k}`);
    }
  }
  writeFileSync(edlPath, JSON.stringify(edl, null, 1));
  writeFileSync(recPath, JSON.stringify(rec, null, 1));
  return log;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, mp4, ...rest] = process.argv;
  if (!shotDir || !mp4) {
    console.error('usage: critic.mjs <shotDir> <out.mp4> [--apply patch.json]');
    process.exit(2);
  }
  const ai = rest.indexOf('--apply');
  if (ai >= 0) {
    const patch = JSON.parse(readFileSync(rest[ai + 1], 'utf8'));
    for (const l of applyPatch(shotDir, patch)) console.log('  ' + l);
    console.log('\nre-render:  bin/demokit --render-only ' + shotDir + ' ' + mp4);
    process.exit(0);
  }
  const pack = await buildPack(shotDir, mp4);
  console.log(`critic pack for ${mp4} (${pack.durationSec.toFixed(1)}s)\n`);
  console.log(`  LOOK AT: ${pack.sheet}\n`);
  for (const [i, s] of pack.shots.entries()) {
    console.log(`  ${String(i).padStart(2)}  ${String(s.t).padStart(6)}s  ${s.what}`);
    console.log(`      expect: ${s.expect}`);
  }
  console.log('\n  invariants (the camera):');
  for (const v of pack.invariants) {
    console.log(`    ${v.ok ? 'PASS' : 'FAIL'}  ${v.check}${v.at != null ? ` @${(v.at / 1000).toFixed(1)}s` : ''}  ${v.detail}`);
  }
  console.log(`\n  feature (the product): ${pack.feature.outcome}`);
  for (const s of pack.feature.steps) {
    console.log(`    ${s.verdict.toUpperCase().padEnd(12)} ${String(s.at).padStart(6)}s  ${s.label}`);
    console.log(`                 ${s.why}`);
  }
  for (const f of pack.feature.strips) console.log(`    look: ${f}`);
  console.log(`\n  outcome: ${pack.outcome}`);
  if (pack.think.length) {
    console.log('  the checks above cannot answer these, and they are the ones that matter:');
    for (const q of pack.think) console.log('    - ' + q);
  }
  console.log('  If the frames contradict what they should show, write a patch and apply it:');
  console.log('    {"dropZooms":[12800], "setRect":[{"tMs":20600,"rect":[x,y,w,h]}], "recipe":{"inset":"0.8"}}');
  process.exit(pack.outcome === 'failed' ? 2 : 0);
}
