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
export function planSegments({ clicks, duration, keep = 1.35, speed = 4, minIdle = 0.9, tailHold = 3.5 }) {
  if (!clicks.length) return [{ start: 0, end: duration, speed: 1 }];
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

  const segs = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a - cursor > 0.01) {
      // only bother speeding a gap that is actually dead air
      segs.push({ start: cursor, end: a, speed: a - cursor >= minIdle ? speed : 1 });
    }
    segs.push({ start: a, end: b, speed: 1 });
    cursor = b;
  }
  if (duration - cursor > 0.01) {
    segs.push({ start: cursor, end: duration, speed: duration - cursor >= minIdle ? speed : 1 });
  }
  return segs;
}

export async function pace({ input, output, clicks, workDir, keep, speed, crf = 18 }) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', input]);
  const duration = parseFloat(stdout.trim());
  const segs = planSegments({ clicks, duration, keep, speed });

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
