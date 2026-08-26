#!/usr/bin/env node
/**
 * shot dir (frames + manifest.json) -> polished demo MP4.
 *
 *   playwriter -s <id> -f src/record.js          # capture
 *   node src/demo.mjs .cache/shot out.mp4        # render
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render } from './render.mjs';
import { pace } from './pace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '.assets');

const [, , shotArg, outArg, ...rest] = process.argv;
if (!shotArg || !outArg) {
  console.error('usage: demo.mjs <shotDir> <out.mp4> [--level N --inset N --bias N --gap MS --keep S --speed N --bg NAME]');
  console.error('  --bg     auto (default) | dusk ember tide slate noir linen | #rrggbb | <image.png> | blur');
  console.error('  --beats  off | auto (replace clicks with change-detected beats) | augment');
  process.exit(2);
}
const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const shotDir = resolve(shotArg), outPath = resolve(outArg);
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
if (arg('beats', noClicks ? 'auto' : 'off') !== 'off') {
  const mode = arg('beats', noClicks ? 'auto' : 'augment');
  const b = await runp('python3', [join(HERE, 'beats.py'), shotDir,
    '--max', arg('maxbeats', '6'), '--gap', arg('gap', '1500'),
    ...(mode === 'augment' ? ['--augment'] : ['--merge'])], { maxBuffer: 1 << 26 });
  process.stdout.write(b.stdout);
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

const r = await render({
  shotDir, output: stage, assetDir: ASSETS,
  // capture is 2x device pixels; downscale to 1080p so the picture is sharp
  outW: Number(arg('w', '1920')), outH: Number(arg('h', '1080')),
  level: Number(arg('level', '1.4')),
  inset: Number(arg('inset', '0.8')),
  centerBias: Number(arg('bias', '0.4')),
  minGapMs: Number(arg('gap', '1500')),
  bg: arg('bg', 'auto'),
});
console.log(`composited ${r.frames} frames @ ${r.srcW}x${r.srcH}, ${r.clicks.length} click(s), backdrop=${r.backdrop}`);

const clicks = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8')).clicks
  .map((c) => ({ ...c, atMs: c.t }));
const p = await pace({
  input: stage, output: outPath, clicks, workDir: ASSETS,
  keep: Number(arg('keep', '1.35')), speed: Number(arg('speed', '4')),
});
if (p.skipped) copyFileSync(stage, outPath);
else console.log(`paced ${p.duration.toFixed(1)}s -> ${(p.duration - p.saved).toFixed(1)}s`);
console.log(`wrote ${outPath}`);
