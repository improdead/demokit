/**
 * Click-focused zoom as a standalone ffmpeg pass.
 *
 * Applies a Screen-Studio-style zoom toward each click: a smooth trapezoid
 * (ease in, hold, ease out) whose crop centre is the envelope-weighted blend
 * of the click points, so the active click stays framed.
 *
 * Uses `zoompan` rather than `crop:eval=frame` because several ffmpeg builds
 * (including ffmpeg-static 6.0) ship a `crop` without the `eval` option.
 * zoompan expressions take PLAIN commas - do not escape them.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export async function probe(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', path]);
  const s = JSON.parse(stdout).streams[0];
  const [n, d] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, fps: d ? n / d : n };
}

/** Smooth trapezoid envelope for one click, in ffmpeg expression form. */
function envelope(tVar, atSec, ramp, hold) {
  const half = ramp + hold / 2;
  const a = (atSec - half).toFixed(4);
  const b = (atSec + half).toFixed(4);
  // ffmpeg's min() is BINARY - a 3-arg min() fails filter config with the
  // unhelpful "Failed to configure output pad". Nest them.
  return `clip(min(min((${tVar}-${a})/${ramp},(${b}-${tVar})/${ramp}),1),0,1)`;
}

export function buildZoomFilter({ clicks, srcW, srcH, outW, outH, fps, level = 1.9, ramp = 0.45, hold = 1.5 }) {
  if (!clicks.length) return `scale=${outW}:${outH}`;
  const t = `(in/${fps})`;
  const envs = clicks.map((c) => envelope(t, c.atMs / 1000, ramp, hold));

  // max() keeps overlapping clicks from compounding the zoom level
  const envMax = envs.reduce((acc, e) => (acc ? `max(${acc},${e})` : e), '');
  // envelope-weighted centroid, as 0..1 fractions of the frame
  const sum = envs.map((e) => `(${e})`).join('+');
  const wx = clicks.map((c, i) => `(${envs[i]})*${(c.x / srcW).toFixed(5)}`).join('+');
  const wy = clicks.map((c, i) => `(${envs[i]})*${(c.y / srcH).toFixed(5)}`).join('+');
  const cx = `((${wx})/max(${sum},0.0001))`;
  const cy = `((${wy})/max(${sum},0.0001))`;

  const z = `(1+(${level}-1)*(${envMax}))`;
  const x = `max(0,min((${cx})*iw*zoom-ow/2,iw*zoom-ow))`;
  const y = `max(0,min((${cy})*ih*zoom-oh/2,ih*zoom-oh))`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${outW}x${outH}:fps=${fps}`;
}

export async function applyZoom({ input, output, clicks, srcW, srcH, level, ramp, hold, crf = 21 }) {
  const v = await probe(input);
  const filter = buildZoomFilter({
    clicks, srcW: srcW ?? v.width, srcH: srcH ?? v.height,
    outW: v.width, outH: v.height, fps: v.fps, level, ramp, hold,
  });
  const fp = join(tmpdir(), `zoom-${Date.now()}.filter`);
  writeFileSync(fp, filter);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-filter_script:v', fp, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { maxBuffer: 1 << 26 });
  return { output, filterLength: filter.length, ...v };
}
