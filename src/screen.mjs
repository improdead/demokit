#!/usr/bin/env node
/**
 * Capture the real screen - a terminal, a native app, anything not in a browser
 * tab - into the same shot format the browser recorder produces.
 *
 *   node src/screen.mjs <shotDir> --seconds 30 [--display 1] [--region x,y,w,h] [--fps 30]
 *
 * Uses macOS's own `screencapture -v` rather than ffmpeg's avfoundation input,
 * which gets killed on this machine (exit 137) even though the screen-recording
 * permission is granted. screencapture is also the thing that already HAS the
 * permission, so there is nothing extra to approve.
 *
 * The real cursor is in the pixels, so there is no pointer path and nothing for
 * cursor.py to draw - demo.mjs skips that pass when `path` is empty. Beats come
 * from src/beats.py watching what changes, because there is no click log here.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

export async function captureScreen({ shotDir, seconds, display = 1, region = null, fps = 30, app = null, fill = 0.78 }) {
  // Stage the window first. Filming the whole display puts the dock, the menu
  // bar, other windows and the desktop wallpaper in the frame - all of which
  // then fight the backdrop we composite onto. A staged window gives the same
  // clean rectangle the browser path produces, except the cursor and the window
  // chrome are real pixels rather than drawn ones.
  let staged = null, stageMod = null;
  if (app && !region) {
    stageMod = await import('./stage.mjs');
    if (app === 'auto') {
      app = await stageMod.frontApp();
      console.log(`stage: front app is ${app}`);
    }
    staged = await stageMod.stage({ app, fill, display });
    region = [staged.region.x, staged.region.y, staged.region.w, staged.region.h];
    console.log(`stage: ${app} -> ${staged.region.w}x${staged.region.h} at `
      + `${staged.region.x},${staged.region.y} on a ${staged.display.w}x${staged.display.h} display`
      + (staged.exact ? '' : '  (app clamped the size)'));
  }
  rmSync(shotDir, { recursive: true, force: true });
  mkdirSync(join(shotDir, 'frames'), { recursive: true });
  const mov = join(shotDir, 'screen.mov');

  const args = ['-v', '-V', String(seconds), '-x'];
  if (region) args.push('-R', region.join(','));
  else args.push('-D', String(display));
  args.push(mov);

  await new Promise((res, rej) => {
    const p = spawn('screencapture', args, { stdio: 'inherit' });
    p.on('error', rej);
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`screencapture exited ${c}`))));
  });
  if (!existsSync(mov)) throw new Error('screencapture produced no file');

  // Retina displays record at 2x, which is exactly the resolution the renderer
  // wants: composite at capture res, downscale once at the end.
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v',
    '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', mov]);
  const [w, h, dur] = stdout.trim().split('\n').map(Number);

  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', mov,
    '-vf', `fps=${fps}`, '-vsync', '0',
    join(shotDir, 'frames', 'f%05d.png')], { maxBuffer: 1 << 26 });

  // ffmpeg numbers from 1; the manifest is 0-based like the browser recorder.
  const files = readdirSync(join(shotDir, 'frames')).filter((f) => f.endsWith('.png')).sort();
  const frames = files.map((f, i) => ({ i: Number(f.slice(1, 6)), ms: Math.round((i * 1000) / fps) }));

  writeFileSync(join(shotDir, 'manifest.json'), JSON.stringify({
    width: w, height: h, layout: [w, h], zoom: 1, dsf: 1,
    source: 'screen',
    staged: staged ? { app, ...staged } : null,
    endMs: Math.round(dur * 1000),
    frames,
    clicks: [],     // filled by beats.py - there is no click log for a desktop
    path: [],       // the real cursor is already in the pixels
    actions: [],
  }, null, 1));

  rmSync(mov, { force: true });
  if (staged && stageMod && staged.before) {
    await stageMod.restore(app, staged.before);
    console.log('stage: window put back where it was');
  }
  return { width: w, height: h, frames: frames.length, duration: dur };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, ...rest] = process.argv;
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  if (!shotDir) {
    console.error('usage: screen.mjs <shotDir> --seconds N [--app "Google Chrome"] [--fill 0.78]');
    console.error('                              [--display 1] [--region x,y,w,h] [--fps 30]');
    process.exit(2);
  }
  const region = arg('region', null);
  const r = await captureScreen({
    shotDir,
    seconds: Number(arg('seconds', '20')),
    display: Number(arg('display', '1')),
    region: region ? region.split(',').map(Number) : null,
    app: arg('app', null),
    fill: Number(arg('fill', '0.78')),
    fps: Number(arg('fps', '30')),
  });
  console.log(`screen: ${r.frames} frames @ ${r.width}x${r.height}, ${r.duration.toFixed(1)}s -> ${shotDir}`);
}
