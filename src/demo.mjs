#!/usr/bin/env node
/**
 * trace.zip -> polished demo MP4.
 *
 *   node src/demo.mjs <trace.zip> <out.mp4> [--level 1.9] [--viewport 1280x720]
 *
 * Two passes on purpose:
 *   1. playwright-recast draws the cursor overlay and click ripples. Speed-up is
 *      deliberately NOT enabled here: recast reports click times in pre-speed-up
 *      time, so compressing before the zoom pass desynchronises every keyframe.
 *      Its subtitle cues are synthetic and never burned - `burnSubtitles` and
 *      `embedSubtitles` default off, so the picture stays caption-free.
 *   2. Our own zoompan pass does the click-focused zoom, because recast's zoom
 *      phase reports applying but does not land on this input path (see README).
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyZoom } from './zoom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..', '.tools');

const [, , tracePath, outPath, ...rest] = process.argv;
if (!tracePath || !outPath) {
  console.error('usage: demo.mjs <trace.zip> <out.mp4> [--level N] [--viewport WxH]');
  process.exit(2);
}
const arg = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
const level = Number(arg('level', '1.9'));
const [VW, VH] = String(arg('viewport', '1280x720')).split('x').map(Number);

const stage1 = join(mkdtempSync(join(tmpdir(), 'demokit-')), 'stage1.mp4');

// --- pass 1: recast (cursor, clicks, speed) ---------------------------------
const script = `
import { Recast } from 'playwright-recast';
await Recast.from(${JSON.stringify(tracePath)})
  .parse()
  .subtitles(a => (a.method === 'click' ? 'click' : undefined))
  .cursorOverlay({ size: 30, moveDurationMs: 260 })
  .clickEffect({ radius: 36, duration: 420, color: '#4F6B3D', opacity: 0.6 })
  .render({ resolution: '1080p', fps: 25, crf: 21 })
  .toFile(${JSON.stringify(stage1)});
`;

const log = await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: TOOLS });
  let out = '';
  p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`recast exited ${c}`))));
});

// recast prints each click in OUTPUT-video time, which is what the zoom pass needs.
const clicks = [...log.matchAll(/click:\s*\(([\d.]+),\s*([\d.]+)\)\s*@\s*(\d+)ms/g)]
  .map((m) => ({ x: +m[1], y: +m[2], atMs: +m[3] }));
console.log(`\n${clicks.length} click(s) -> zoom keyframes`);
if (!clicks.length) {
  console.log('no clicks found; copying stage 1 through unchanged');
}

// --- pass 2: click-focused zoom --------------------------------------------
const r = await applyZoom({ input: stage1, output: outPath, clicks, srcW: VW, srcH: VH, level });
console.log(`wrote ${outPath} (${r.width}x${r.height} @ ${r.fps}fps)`);
