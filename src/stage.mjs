#!/usr/bin/env node
/**
 * Put a real app window where a demo needs it, and report the region to record.
 *
 *   node src/stage.mjs --app "Google Chrome" [--fill 0.78] [--display 1]
 *
 * Screen capture gets you the REAL cursor - the one thing a CDP screencast can
 * never have, because dispatching input never moves an OS pointer. The cost is
 * that you film whatever the desktop happens to look like: dock, menu bar, other
 * windows, a wallpaper that fights the one we composite onto.
 *
 * So stage it first. The window is resized to a clean 16:9, centred on the
 * display, and only that rectangle is recorded. What comes back is the window
 * and nothing else - which is exactly what the browser path produces, except
 * the cursor and the window chrome are real pixels instead of drawn ones.
 *
 * The size is not arbitrary: a 16:9 window that fills `fill` of the display,
 * rounded to even pixels, so the recording needs no letterboxing and the
 * compositor can inset it on the backdrop unchanged.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);

/**
 * Display geometry in BOTH units, measured rather than assumed.
 *
 * This is the trap: `screencapture` reports and crops in POINTS, AppleScript
 * positions windows in POINTS, but the PNG that comes back is in PIXELS. On a
 * Retina display those differ by 2x - staging a window to a pixel-sized rect
 * makes it twice the intended size and half of it lands off-screen.
 */
export async function displaySize(display = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'dk-disp-'));
  const shot = join(dir, 'd.png');
  try {
    await run('screencapture', ['-x', '-t', 'png', '-D', String(display), shot]);
    const { stdout } = await run('python3', ['-c',
      `from PIL import Image; im=Image.open(${JSON.stringify(shot)}); print(im.width, im.height)`]);
    const [pw, ph] = stdout.trim().split(/\s+/).map(Number);
    // Finder's desktop bounds are the union of all displays, in points.
    const { stdout: b } = await run('osascript', ['-e',
      'tell application "Finder" to get bounds of window of desktop']);
    const [, , uw] = b.trim().split(',').map((v) => Number(v.trim()));
    const scale = Math.max(1, Math.round((pw / Math.max(1, uw)) * 2) / 2);
    return { w: Math.round(pw / scale), h: Math.round(ph / scale), px: { w: pw, h: ph }, scale };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const osa = async (script) => (await run('osascript', ['-e', script])).stdout.trim();

/** The frontmost real app, so a flow does not have to hardcode a browser name.
 *  This machine runs Helium, not Chrome; the next one will run something else. */
export async function frontApp() {
  return osa('tell application "System Events" to get name of first application process '
    + 'whose frontmost is true and background only is false');
}

const boundsOf = async (app) => osa(
  `tell application "System Events" to tell process ${JSON.stringify(app)}
      set p to position of window 1
      set s to size of window 1
      return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
    end tell`);

/** Put a window back where it was. Rearranging someone's desktop to record a
 *  video and leaving it that way is not a side effect anyone asked for. */
export async function restore(app, prev) {
  if (!app || !prev) return;
  const [x, y, w, h] = prev.split(',').map(Number);
  await osa(`tell application "System Events" to tell process ${JSON.stringify(app)}
      set position of window 1 to {${x}, ${y}}
      set size of window 1 to {${w}, ${h}}
    end tell`).catch(() => {});
}

export async function stage({ app, fill = 0.82, display = 1, aspect = 16 / 9 }) {
  const disp = await displaySize(display);
  const { w: dw, h: dh } = disp;   // points

  // 16:9 at `fill` of the display, whichever axis binds, even pixels.
  let w = Math.round(dw * fill);
  let h = Math.round(w / aspect);
  if (h > dh * fill) { h = Math.round(dh * fill); w = Math.round(h * aspect); }
  w -= w % 2; h -= h % 2;
  const x = Math.round((dw - w) / 2);
  // Sit slightly above centre: the dock eats the bottom of the display, and a
  // window centred on raw pixels reads as low once the menu bar is accounted for.
  const y = Math.max(28, Math.round((dh - h) / 2) - Math.round(dh * 0.02));

  const before = await boundsOf(app).catch(() => null);
  await osa(`tell application ${JSON.stringify(app)} to activate`);
  await new Promise((r) => setTimeout(r, 600));
  await osa(`tell application "System Events" to tell process ${JSON.stringify(app)}
      set position of window 1 to {${x}, ${y}}
      set size of window 1 to {${w}, ${h}}
    end tell`);
  await new Promise((r) => setTimeout(r, 500));

  // Read back what actually happened - apps clamp sizes, and recording a region
  // the window does not fill puts desktop in the frame.
  const got = await osa(`tell application "System Events" to tell process ${JSON.stringify(app)}
      set p to position of window 1
      set s to size of window 1
      return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
    end tell`);
  const [gx, gy, gw, gh] = got.split(',').map((v) => Math.round(Number(v)));
  const region = { x: gx, y: gy, w: gw - (gw % 2), h: gh - (gh % 2) };
  return { display: disp, asked: { x, y, w, h }, region, before,
           captureSize: { w: region.w * disp.scale, h: region.h * disp.scale },
           exact: gw === w && gh === h && gx === x && gy === y };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rest = process.argv.slice(2);
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const app = arg('app');
  if (!app) { console.error('usage: stage.mjs --app "Google Chrome" [--fill 0.78] [--display 1]'); process.exit(2); }
  const r = await stage({ app, fill: Number(arg('fill', '0.82')), display: Number(arg('display', '1')) });
  console.log(`display ${r.display.w}x${r.display.h} points (${r.display.px.w}x${r.display.px.h} px, ${r.display.scale}x)`);
  console.log(`window  ${r.region.w}x${r.region.h} at ${r.region.x},${r.region.y}`
    + (r.exact ? '' : `  (asked for ${r.asked.w}x${r.asked.h} at ${r.asked.x},${r.asked.y} - the app clamped it)`));
  console.log(`region  ${r.region.x},${r.region.y},${r.region.w},${r.region.h} points`
    + `  -> captures ${r.captureSize.w}x${r.captureSize.h} px`);
}
