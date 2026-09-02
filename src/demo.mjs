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
const ASSETS = process.env.DEMOKIT_WORK ? join(process.env.DEMOKIT_WORK, '.assets') : resolve('.assets');
mkdirSync(ASSETS, { recursive: true });   // the Cap engine writes its stage file here; nothing else creates it

const [, , shotArg, outArg, ...rest] = process.argv;
if (!shotArg || !outArg) {
  console.error('usage: demo.mjs <shotDir> <out.mp4> [--level N --inset N --bias N --gap MS --keep S --speed N --bg NAME]');
  console.error('  --bg     auto | canvas-garden|canvas-dusk|canvas-tide|canvas-ember|canvas-slate');
  console.error('           | dusk ember tide slate noir linen | #rrggbb | <wallpaper.jpg> | blur');
  console.error('  --bgblur 0.004 --bgsat 0.82 --bgdim 0.92   how far a photo backdrop recedes');
  console.error('  --edit   auto (write edit.json) | off      --redirect  regenerate it');
  console.error('  --cap    Cap auto-zoom (merged click segments)   --zoom-clicks  one push per click');
  console.error('           (default: still - the camera does not move)');
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
const RECIPE_KEYS = ['w', 'h', 'level', 'deep', 'inset', 'bias', 'edgesnap', 'maxoff', 'still', 'deadspeed', 'tailhold', 'headhold', 'read', 'gap', 'keep', 'speed',
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
  if (!RECIPE_KEYS.includes(k) && !['edit', 'redirect', 'beats', 'maxbeats', 'fill', 'no-verify', 'engine',
      'cap-config', 'cap-assets', 'no-maclights', 'no-trim', 'still', 'cap', 'zoom-clicks', 'smart', 'fps'].includes(k)) {
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
      mode: rest.includes('--smart') ? 'smart'
        : rest.includes('--still') ? 'still'
        : rest.includes('--zoom-clicks') ? 'clicks' : 'cap',
    });
    for (const w of edl.warnings || []) console.log(`edit: ! ${w}`);
    if (edl.mode === 'still') console.log('edit: still camera - it does not move');
    else if (edl.mode === 'cap') console.log(`edit: Cap auto-zoom - ${edl.chains.length} segment(s), ${edl.zooms.length} focus point(s)`);
    else console.log(`edit: ${edl.zooms.length} zoom(s), each with a reason:`);
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
// Engine. `cap` renders the way Cap does - springs, squircle, shadow, cursor
// shapes, the display scaling over a fixed wallpaper - in one Python pass that
// streams frames to ffmpeg. `ffmpeg` is the older zoompan graph. Cap is the
// default because a Cap recording is what the user pointed at and said "this".
const ENGINE = arg0('engine', 'cap');
if (ENGINE !== 'cap' && (man0.path || []).length) {
  const cur = await runp('python3', [join(HERE, 'cursor.py'), shotDir], { maxBuffer: 1 << 26 });
  process.stdout.write(cur.stdout);
} else if (ENGINE !== 'cap') {
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

let r;
if (ENGINE === 'cap') {
  const outW = Number(arg('w', '3840')), outH = Number(arg('h', '2160'));
  const args = [join(HERE, 'caprender.py'), shotDir, stage, '--w', String(outW), '--h', String(outH),
    '--fps', String(arg('fps', '30'))];
  if (arg0('cap-config', null)) args.push('--config', arg0('cap-config', null));
  if (arg0('cap-assets', null)) args.push('--assets', arg0('cap-assets', null));
  const cr = await runp('python3', args, { maxBuffer: 1 << 26 });
  process.stdout.write(cr.stdout);
  if (cr.stderr) process.stderr.write(cr.stderr.split('\n').filter((l) => !l.startsWith('caprender:')).join('\n'));
  const edlCap = existsSync(edlPath) ? JSON.parse(readFileSync(edlPath, 'utf8')) : { chains: [], zooms: [] };
  r = { frames: man0.frames.length, srcW: man0.width, srcH: man0.height, outW, outH,
        zooms: edlCap.chains.length, backdrop: 'cap: desktop wallpaper' };
} else r = await render({
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
  maxOffFrac: Number(arg('maxoff', '0.055')),
  trimTop: rest.includes('--no-trim') ? 0 : undefined,
  macLights: !rest.includes('--no-maclights'),
  minGapMs: Number(arg('gap', '1500')),
  maxLevel: Number(arg('deep', '1.7')),
  openPull: Number(arg('pull', '1.28')),
  openMs: Number(arg('pullms', '1500')),
  bg: arg('bg', 'auto'),
  bgBlur: Number(arg('bgblur', '0.016')),
  bgSat: Number(arg('bgsat', '1.12')),
  bgDim2: Number(arg('bgdim', '1.0')),
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
// The moments a camera segment actually MOVES: the spring-in at its start, the
// spring-out at its end, and each re-aim inside it. With Cap's spring the
// motion has settled ~0.8s after the target changes; between those moments the
// camera holds perfectly still, and holding still is not a reason to keep
// idle footage at 1x. Protecting a whole 7s segment is why a 14s take came
// back 13.7s long.
function cameraMotion(edl) {
  const out = [];
  for (const c of (edl?.chains) || []) {
    out.push([c.startMs - 100, c.startMs + 900]);
    out.push([c.endMs - 100, c.endMs + 900]);
    for (const t of c.targets || []) if (t.tMs > c.startMs + 200) out.push([t.tMs - 100, t.tMs + 700]);
  }
  return out;
}

function protectedSpans(man, edl) {
  const out = [];
  for (const [a, b] of cameraMotion(edl)) out.push({ fromMs: Math.max(0, a), toMs: b });

  // Typing runs: from the keystroke beat back over the run and past its settle.
  for (const e of man.events || []) {
    if (e.kind === 'type') out.push({ fromMs: Math.max(0, e.t - 2600), toMs: e.t + 700 });
  }

  // Time to READ what just appeared.
  //
  // "Nothing is moving" and "nothing to look at" are different things, and the
  // dead-air pass only measures the first. A click that reveals a page leaves
  // the screen perfectly static while the viewer reads it - which is the payoff,
  // not dead air. Without this the take collapsed from 14.8s to 4.1s and every
  // reveal flashed past.
  //
  // 2.5s, which is the same number Cap holds a zoom for after a click, for the
  // same reason.
  const readMs = Number(arg('read', '1600'));
  for (const e of man.events || []) {
    if (e.kind === 'click' || e.kind === 'type') {
      out.push({ fromMs: e.t, toMs: e.t + readMs });
    }
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

// Measured dead air, which overrides all of the above. The protected spans are
// reasoned from the event log and are wrong in one direction: a flow's own `ms`
// waits hold a window open across stretches where the screen does not change at
// all. On the take this was written for, 20.1 of 23.8 seconds were frozen and
// the event log had found 3 of them.
const { stillness } = await import('./still.mjs');
const stillSec = Number(arg('still', '1.2'));
let dead = [];
try {
  const st = await stillness(shotDir, { minSec: stillSec });
  const tailKeep = Number(arg('tailhold', '2.6')) * 1000;
  const headKeep = Number(arg('headhold', '0.9')) * 1000;
  const endMs = manNow.frames?.length ? manNow.frames.at(-1).ms : 0;

  // Stretches dead air may never touch: a camera move, and the seconds after a
  // change while the viewer READS what appeared. Without the second one the take
  // collapsed from 14.8s to 4.1s - a page that has just been revealed is
  // perfectly static, and the stillness pass cannot tell that apart from
  // nothing happening. 2.5s, the same number Cap holds a zoom for after a click,
  // for the same reason.
  const keepOut = [
    ...cameraMotion(edlNow),
    ...(manNow.events || [])
      .filter((e) => e.kind === 'click' || e.kind === 'type')
      .map((e) => [e.t, e.t + Number(arg('read', '1600'))]),
  ].sort((a, b) => a[0] - b[0]);

  for (const sp of st.spans) {
    let segs = [[Math.max(sp.from, headKeep), Math.min(sp.to, endMs - tailKeep)]];
    for (const [a, b] of keepOut) {
      const next = [];
      for (const [x, y] of segs) {
        if (b <= x || a >= y) { next.push([x, y]); continue; }
        if (a > x) next.push([x, Math.min(y, a)]);
        if (b < y) next.push([Math.max(x, b), y]);
      }
      segs = next;
    }
    for (const [from, to] of segs) {
      if (to - from >= stillSec * 1000) dead.push({ from: from / 1000, to: to / 1000 });
    }
  }
  if (dead.length) {
    const frozen = dead.reduce((a, d) => a + (d.to - d.from), 0);
    console.log(`still: ${dead.length} stretch(es) with nothing on screen for ${stillSec}s+ `
      + `(${frozen.toFixed(1)}s) - fast-forwarding them`);
  }
} catch (e) {
  console.log('still: could not measure dead air - ' + String(e.message || e).slice(0, 90));
}
const clicks = spans.length
  ? protectOpen.concat(spans)
  : manNow.clicks.map((c) => ({ ...c, atMs: c.t }));
console.log(`pace: protecting ${spans.length} span(s) - camera moves, typing runs `
  + `and every stretch where the pointer is moving`);
const p = await pace({
  input: stage, output: outPath, clicks, workDir: ASSETS,
  keep: Number(arg('keep', '0.35')), speed: Number(arg('speed', '4')),
  dead, deadSpeed: Number(arg('deadspeed', '9')),
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
