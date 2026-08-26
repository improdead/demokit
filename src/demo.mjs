#!/usr/bin/env node
/**
 * trace.zip -> framed, edited-looking demo MP4.
 *
 *   node src/demo.mjs <trace.zip> <out.mp4> [--level 1.45] [--inset 0.8] [--viewport 1920x1080]
 *
 * Pass 1  playwright-recast: cursor overlay + click ripples only.
 *         No zoom (its zoom phase does not land on an external trace) and no
 *         speed-up (it reports click times in pre-speed-up time, which would
 *         desync every zoom keyframe).
 * Pass 2  our compositor: inset frame, rounded corners, drop shadow, blurred
 *         backdrop, and the click zoom with smoothstep easing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from './frame.mjs';
import { pace } from './pace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..', '.tools');
const ASSETS = join(HERE, '..', '.assets');

const [, , tracePathArg, outPathArg, ...rest] = process.argv;
if (!tracePathArg || !outPathArg) {
  console.error('usage: demo.mjs <trace.zip> <out.mp4> [--level N] [--inset N] [--viewport WxH]');
  process.exit(2);
}
const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const level = Number(arg('level', '1.4'));
const inset = Number(arg('inset', '0.8'));
const [VW, VH] = String(arg('viewport', '1920x1080')).split('x').map(Number);
// The recast child runs with cwd=.tools, so relative paths must be resolved here.
const tracePath = resolve(tracePathArg);
const outPath = resolve(outPathArg);

const stage1 = join(mkdtempSync(join(tmpdir(), 'demokit-')), 'stage1.mp4');
mkdirSync(ASSETS, { recursive: true });

const script = `
import { Recast } from 'playwright-recast';
await Recast.from(${JSON.stringify(tracePath)})
  .parse()
  .subtitles(a => (a.method === 'click' ? 'click' : undefined))
  .cursorOverlay({ size: 26, moveDurationMs: 280, approachMs: 520 })
  .clickEffect({ radius: 30, duration: 450, color: '#4F6B3D', opacity: 0.5 })
  .render({ resolution: { width: ${VW}, height: ${VH} }, fps: 30, crf: 16 })
  .toFile(${JSON.stringify(stage1)});
`;

const log = await new Promise((res, rej) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: TOOLS });
  let o = '';
  p.stdout.on('data', d => { o += d; process.stdout.write(d); });
  p.stderr.on('data', d => { o += d; process.stderr.write(d); });
  p.on('close', c => (c === 0 ? res(o) : rej(new Error(`recast exited ${c}`))));
});

const clicks = [...log.matchAll(/click:\s*\(([\d.]+),\s*([\d.]+)\)\s*@\s*(\d+)ms/g)]
  .map(m => ({ x: +m[1], y: +m[2], atMs: +m[3] }));
console.log(`\n${clicks.length} click(s) -> zoom keyframes`);

const stage2 = join(dirname(stage1), 'stage2.mp4');
const r = await compose({
  input: stage1, output: stage2, clicks, assetDir: ASSETS,
  level, inset, centerBias: Number(arg('bias', '0.4')), minGapMs: Number(arg('gap', '1500')),
});

// Pass 3: compress the dead air. Must run after zoom - see pace.mjs.
const p = await pace({
  input: stage2, output: outPath, clicks, workDir: ASSETS,
  keep: Number(arg('keep', '1.35')), speed: Number(arg('speed', '4')),
});
if (p.skipped) {
  const { copyFileSync } = await import('node:fs');
  copyFileSync(stage2, outPath);
  console.log('no idle worth compressing');
} else {
  console.log(`paced: ${p.duration.toFixed(1)}s -> ${(p.duration - p.saved).toFixed(1)}s`);
}
console.log(`wrote ${outPath}  ${r.width}x${r.height} @ ${r.fps}fps`);
