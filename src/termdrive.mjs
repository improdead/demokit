#!/usr/bin/env node
/**
 * Type into the REAL macOS Terminal while the screen is being recorded.
 *
 *   node src/termdrive.mjs <spec.json>
 *
 * The drawn terminal in term.py renders a real command's real output into a
 * window it paints itself. This is the other option: a genuine screen recording
 * of Terminal.app, with the commands typed in by System Events at human speed.
 * It costs the screen - the recording is of the actual display, so the machine
 * cannot be used while it runs - and it needs Accessibility permission. What it
 * buys is that every pixel is real, including the window chrome, the font
 * rendering and the user's own prompt.
 *
 * The whole session is ONE AppleScript. Calling osascript per keystroke costs
 * ~50ms of process setup each, which is the same mistake that made the
 * container's pointer take four seconds to cross a window.
 *
 * spec.json:
 *   { "cps": 22, "startDelayMs": 900, "endPauseMs": 2500,
 *     "commands": [ { "text": "demokit verify ...", "waitMs": 1200 } ] }
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const run = promisify(execFile);

/** AppleScript string literal: only backslash and quote need escaping. */
const lit = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function buildScript(spec) {
  const cps = Number(spec.cps || 22);
  const per = (1 / cps).toFixed(3);
  const L = [];
  L.push('tell application "Terminal" to activate');
  L.push('delay 0.35');
  // Target ONE window by id. A bare `activate` raises whichever Terminal window
  // happens to be frontmost, and with more than one open that is how the
  // staging sized one window while the keystrokes went into another - the take
  // filmed a region larger than the window, with the desktop showing behind it.
  if (spec.windowId) {
    L.push(`tell application "Terminal" to set index of window id ${Number(spec.windowId)} to 1`);
    L.push('delay 0.25');
  }
  L.push('tell application "System Events" to tell process "Terminal" to set frontmost to true');
  L.push(`delay ${(Number(spec.startDelayMs ?? 900) / 1000).toFixed(2)}`);

  for (const c of spec.commands || []) {
    L.push('tell application "System Events"');
    L.push(`  repeat with ch in characters of ${lit(c.text)}`);
    L.push('    keystroke (ch as text)');
    L.push(`    delay ${per}`);
    L.push('  end repeat');
    L.push('  key code 36');
    L.push('end tell');
    // Wait for the command itself, rather than guessing a duration. Terminal
    // reports `busy` for the whole time a foreground process is running.
    L.push('tell application "Terminal"');
    L.push('  set n to 0');
    L.push(`  repeat while (busy of front window) and n < ${Math.round(Number(c.maxWaitMs ?? 60000) / 200)}`);
    L.push('    delay 0.2');
    L.push('    set n to n + 1');
    L.push('  end repeat');
    L.push('end tell');
    L.push(`delay ${(Number(c.waitMs ?? 1200) / 1000).toFixed(2)}`);
  }
  L.push(`delay ${(Number(spec.endPauseMs ?? 2500) / 1000).toFixed(2)}`);
  return L.join('\n');
}

/** Profile, font size and working directory - set BEFORE the camera rolls. */
// Properties this touches on the settings set. They belong to the USER's
// profile, not to us - Terminal has no per-window override for them and no
// scriptable way to make a throwaway profile - so every one is read first and
// put back afterwards. stage.mjs already takes this line about window bounds:
// rearranging someone's desktop to record a video and leaving it that way is
// not a side effect anyone asked for.
const SAVED = ['background color', 'font size', 'title displays window size',
               'title displays shell path', 'title displays device name',
               'title displays custom title'];

export async function snapshotProfile(profile) {
  const lines = SAVED.map((k) => `  set out to out & my enc(${k} of settings set ${lit(profile)}) & linefeed`);
  const scpt = [
    'on enc(v)',
    '  if class of v is list then',
    '    set t to ""',
    '    repeat with x in v',
    '      set t to t & (x as text) & ","',
    '    end repeat',
    '    return t',
    '  end if',
    '  return v as text',
    'end enc',
    'tell application "Terminal"',
    '  set out to ""',
    ...lines,
    '  return out',
    'end tell',
  ].join('\n');
  const { stdout } = await run('osascript', ['-e', scpt]);
  const vals = String(stdout).split('\n');
  return Object.fromEntries(SAVED.map((k, i) => [k, (vals[i] || '').trim()]));
}

export async function restoreProfile(profile, saved) {
  if (!saved) return;
  const set = [];
  for (const k of SAVED) {
    const v = saved[k];
    if (v == null || v === '') continue;
    if (v.includes(',')) {
      const nums = v.split(',').filter(Boolean).join(', ');
      set.push(`  set ${k} of settings set ${lit(profile)} to {${nums}}`);
    } else if (v === 'true' || v === 'false') {
      set.push(`  set ${k} of settings set ${lit(profile)} to ${v}`);
    } else {
      set.push(`  set ${k} of settings set ${lit(profile)} to ${Number(v)}`);
    }
  }
  await run('osascript', ['-e', ['tell application "Terminal"', ...set, 'end tell'].join('\n')])
    .catch((e) => console.error('termdrive: could not restore the profile: ' + e.message));
}

export async function prepare({ cwd, profile = 'Pro', fontSize = 18, title = null }) {
  // One `do script` only. A second one racing the first is what produced
  // `zsh: command not found: trclear` - two writers on the same tty.
  const setup = [
    'tell application "Terminal"',
    '  activate',
    `  set w to do script ${lit(`cd ${cwd} && export PATH="${cwd}/bin:$PATH" && clear`)}`,
    '  delay 0.7',
    `  set current settings of front window to settings set ${lit(profile)}`,
    `  set font size of current settings of front window to ${Number(fontSize)}`,
    // Pro is semi-transparent, so whatever is behind the window bleeds through
    // the terminal text. Opaque, or the take shows the desktop through it.
    '  set background color of current settings of front window to {4200, 4600, 5800, 65535}',
    '  set title displays window size of current settings of front window to false',
    '  set title displays shell path of current settings of front window to false',
    '  set title displays device name of current settings of front window to false',
    '  set title displays custom title of current settings of front window to true',
    title ? `  set custom title of front window to ${lit(title)}` : '',
    '  delay 0.3',
    '  return id of front window',
    'end tell',
  ].filter(Boolean).join('\n');
  const { stdout } = await run('osascript', ['-e', setup]);
  return Number(String(stdout).trim());
}

/** Make one window the frontmost, so System Events' "window 1" is that one. */
export async function front(windowId) {
  await run('osascript', ['-e',
    `tell application "Terminal"
       activate
       set index of window id ${Number(windowId)} to 1
     end tell`]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--front') { await front(argv[1]); process.exit(0); }
  if (argv[0] === '--restore') {   // --restore <profile> <saved.json>
    await restoreProfile(argv[1], JSON.parse(readFileSync(argv[2], 'utf8')));
    process.exit(0);
  }
  const spec = JSON.parse(readFileSync(argv[0], 'utf8'));
  const prof = (spec.prepare && spec.prepare.profile) || 'Pro';

  if (argv.includes('--prepare')) {
    const saveTo = argv[argv.indexOf('--save') + 1];
    if (argv.includes('--save')) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(saveTo, JSON.stringify(await snapshotProfile(prof)));
    }
    console.log(await prepare(spec.prepare || {}));
    process.exit(0);
  }
  const wi = argv.indexOf('--window');
  if (wi >= 0) spec.windowId = Number(argv[wi + 1]);
  await run('osascript', ['-e', buildScript(spec)], { maxBuffer: 1 << 24 });
}
