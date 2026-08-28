/**
 * Idle speed-up, applied AFTER the zoom pass.
 *
 * Ordering matters: the zoom envelopes are expressed in video time, so
 * compressing the timeline first desynchronises every keyframe. Running it
 * afterwards is safe precisely because idle regions carry no zoom - there is
 * nothing being animated in the stretches we speed through.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

/**
 * Build normal/fast segments around each zoom window.
 *
 * @param clicks   [{atMs}] zoom anchors
 * @param duration seconds
 * @param keep     seconds of normal speed held either side of a click
 */
/**
 * @param clicks    [{atMs}] instants to protect, or [{fromMs,toMs}] spans
 */
export function planSegments({ clicks, duration, keep = 1.35, speed = 4, minIdle = 0.9,
                               tailHold = 3.5, dead = [], deadSpeed = 9 }) {
  if (!clicks.length && !dead.length) return [{ start: 0, end: duration, speed: 1 }];
  // A camera move is a SPAN, not two instants. Passing only its endpoints left
  // the middle unprotected, so a 2.1s stretch inside a held zoom - the pan
  // between two targets - got sped up 4x and the camera lurched. Nothing
  // between the start of a move and its end may be compressed.
  const windows = clicks
    .map((c) => (c.fromMs != null
      ? [Math.max(0, c.fromMs / 1000 - keep), Math.min(duration, c.toMs / 1000 + keep)]
      : [Math.max(0, c.atMs / 1000 - keep), Math.min(duration, c.atMs / 1000 + keep)]))
    .sort((a, b) => a[0] - b[0]);
  // The stretch after the LAST beat is the payoff hold, not dead air - resting
  // on the outcome is the point. Speeding it 4x is how a demo ends on a jump
  // cut. Keep it at normal speed up to tailHold, then compress the remainder.
  const lastEnd = windows[windows.length - 1][1];
  windows[windows.length - 1][1] = Math.min(duration, Math.max(lastEnd, lastEnd + tailHold - keep));

  // merge overlapping keep-windows
  const merged = [windows[0]];
  for (const w of windows.slice(1)) {
    const last = merged[merged.length - 1];
    if (w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push(w);
  }

  // MEASURED dead air wins over inferred protection.
  //
  // Everything above reasons from the event log: a camera move is happening, the
  // pointer is travelling, so keep it. That is a guess about whether anything is
  // on screen, and it is wrong in one direction that matters - a step can hold a
  // protected window open across ten seconds in which the screen does not change
  // at all. `dead` comes from the frames themselves, and it is allowed to cut a
  // hole in a protected window.
  if (dead.length) {
    const out = [];
    for (const [a, b] of merged) {
      let segs = [[a, b]];
      for (const d of dead) {
        const next = [];
        for (const [x, y] of segs) {
          if (d.to <= x || d.from >= y) { next.push([x, y]); continue; }
          if (d.from > x) next.push([x, Math.min(y, d.from)]);
          if (d.to < y) next.push([Math.max(x, d.to), y]);
        }
        segs = next;
      }
      for (const sg of segs) if (sg[1] - sg[0] > 0.05) out.push(sg);
    }
    merged.length = 0;
    merged.push(...out);
  }

  const segs = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a - cursor > 0.01) {
      // only bother speeding a gap that is actually dead air
      // Compress harder the longer the dead stretch. A 60s static gap at 4x is
      // still 15s of nothing; the rate has to scale with the problem.
      const gap = a - cursor;
      const isDead = dead.some((d) => d.from <= cursor + 0.05 && d.to >= a - 0.05);
      const rate = gap < minIdle ? 1
        : isDead ? Math.min(24, Math.max(deadSpeed, gap / 1.2))
        : Math.min(24, speed * Math.max(1, gap / 8));
      segs.push({ start: cursor, end: a, speed: rate });
    }
    segs.push({ start: a, end: b, speed: 1 });
    cursor = b;
  }
  if (duration - cursor > 0.01) {
    const gap = duration - cursor;
    segs.push({ start: cursor, end: duration,
      speed: gap < minIdle ? 1 : Math.min(24, speed * Math.max(1, gap / 8)) });
  }
  return segs;
}

export async function pace({ input, output, clicks, workDir, keep, speed, crf = 18,
                             dead = [], deadSpeed = 9 }) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', input]);
  const duration = parseFloat(stdout.trim());
  const segs = planSegments({ clicks, duration, keep, speed, dead, deadSpeed });

  const fast = segs.filter((s) => s.speed > 1);
  if (!fast.length) return { output: input, skipped: true, segs };

  const parts = segs.map((s, i) =>
    `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},` +
    `setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`);
  parts.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[out]`);
  const graph = parts.join(';');

  const gp = join(workDir, `pace-${Date.now()}.txt`);
  writeFileSync(gp, graph);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-filter_complex_script', gp, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { maxBuffer: 1 << 26 });

  const saved = segs.reduce((a, s) => a + (s.end - s.start) * (1 - 1 / s.speed), 0);
  return { output, segs, duration, saved };
}
