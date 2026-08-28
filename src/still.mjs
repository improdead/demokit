#!/usr/bin/env node
/**
 * Where is nothing happening?
 *
 *   node src/still.mjs <shotDir> [--sec 3] [--thresh 0.35]
 *
 * Everything else in the pipeline reasons about dead air from the EVENT LOG: a
 * camera move is running, the pointer is travelling, a typing run is in flight,
 * so keep those at normal speed. That is a guess about whether anything is on
 * screen, and it is wrong in the direction that matters - a flow's own `ms`
 * waits routinely hold a "protected" window open across ten seconds in which
 * the screen does not change by a single pixel.
 *
 * This measures it instead. One ffmpeg pass decodes the frames to 64x36 greys;
 * a stretch where consecutive frames differ by less than `thresh` for longer
 * than `sec` is dead, and dead air gets cut whatever the event log thinks.
 *
 * It is also what an agent should read before deciding a take is any good: the
 * report says, in source time, exactly where the video has nothing in it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

export async function stillness(shotDir, { minSec = 3, thresh = 0.35 } = {}) {
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const frames = man.frames || [];
  if (frames.length < 3) return { spans: [], samples: [] };

  const dir = existsSync(join(shotDir, 'frames-chrome')) ? 'frames-chrome'
    : existsSync(join(shotDir, 'frames-cur')) ? 'frames-cur' : 'frames';
  const W = 64, H = 36;
  const { stdout: raw } = await run('ffmpeg', ['-loglevel', 'error',
    '-start_number', String(frames[0].i),
    '-i', join(shotDir, dir, 'f%05d.png'),
    '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 28, encoding: 'buffer' });

  const per = W * H;
  const n = Math.min(frames.length, Math.floor(raw.length / per));
  const diffs = [0];
  for (let k = 1; k < n; k++) {
    let sum = 0;
    const a = k * per, b = (k - 1) * per;
    for (let j = 0; j < per; j++) sum += Math.abs(raw[a + j] - raw[b + j]);
    diffs.push(sum / per);
  }

  // Contiguous runs under the threshold. The ends are pulled IN by a frame so a
  // cut never lands on the frame where motion resumes.
  const spans = [];
  let start = null;
  for (let k = 1; k < n; k++) {
    if (diffs[k] < thresh) {
      if (start == null) start = k;
    } else if (start != null) {
      const from = frames[start].ms, to = frames[k - 1].ms;
      if (to - from >= minSec * 1000) spans.push({ from, to, frames: k - start });
      start = null;
    }
  }
  if (start != null) {
    const from = frames[start].ms, to = frames[n - 1].ms;
    if (to - from >= minSec * 1000) spans.push({ from, to, frames: n - start });
  }
  // A single frame over the threshold in the middle of a freeze is a cursor
  // blink, not the screen doing something. Do not let it split one dead
  // stretch into two that each look shorter than they are.
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.from - last.to < 400) { last.to = sp.to; last.frames += sp.frames; }
    else merged.push({ ...sp });
  }
  return { spans: merged, samples: diffs.length, thresh, minSec };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, ...rest] = process.argv;
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? Number(rest[i + 1]) : d; };
  if (!shotDir) { console.error('usage: still.mjs <shotDir> [--sec 3] [--thresh 0.35]'); process.exit(2); }
  const r = await stillness(shotDir, { minSec: arg('sec', 3), thresh: arg('thresh', 0.35) });
  const total = r.spans.reduce((a, s) => a + (s.to - s.from), 0) / 1000;
  console.log(`${r.spans.length} stretch(es) with nothing on screen for ${r.minSec}s+  (${total.toFixed(1)}s in total)`);
  for (const s of r.spans) {
    console.log(`  ${(s.from / 1000).toFixed(1)}s -> ${(s.to / 1000).toFixed(1)}s   `
      + `${((s.to - s.from) / 1000).toFixed(1)}s frozen`);
  }
  if (!r.spans.length) console.log('  (none - the screen is doing something throughout)');
}
