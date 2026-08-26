#!/usr/bin/env node
/**
 * shot dir (frames + manifest.json) -> polished demo MP4.
 *
 *   playwriter -s <id> -f src/record.js          # capture
 *   node src/demo.mjs .cache/shot out.mp4        # render
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, copyFileSync } from 'node:fs';
import { render } from './render.mjs';
import { pace } from './pace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '.assets');

const [, , shotArg, outArg, ...rest] = process.argv;
if (!shotArg || !outArg) {
  console.error('usage: demo.mjs <shotDir> <out.mp4> [--level N --inset N --bias N --gap MS --keep S --speed N]');
  process.exit(2);
}
const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const shotDir = resolve(shotArg), outPath = resolve(outArg);
const stage = join(ASSETS, 'stage.mp4');

const r = await render({
  shotDir, output: stage, assetDir: ASSETS,
  // capture is 2x device pixels; downscale to 1080p so the picture is sharp
  outW: Number(arg('w', '1920')), outH: Number(arg('h', '1080')),
  level: Number(arg('level', '1.4')),
  inset: Number(arg('inset', '0.8')),
  centerBias: Number(arg('bias', '0.4')),
  minGapMs: Number(arg('gap', '1500')),
});
console.log(`composited ${r.frames} frames @ ${r.srcW}x${r.srcH}, ${r.clicks.length} click(s)`);

const clicks = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8')).clicks
  .map((c) => ({ ...c, atMs: c.t }));
const p = await pace({
  input: stage, output: outPath, clicks, workDir: ASSETS,
  keep: Number(arg('keep', '1.35')), speed: Number(arg('speed', '4')),
});
if (p.skipped) copyFileSync(stage, outPath);
else console.log(`paced ${p.duration.toFixed(1)}s -> ${(p.duration - p.saved).toFixed(1)}s`);
console.log(`wrote ${outPath}`);
