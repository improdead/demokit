#!/usr/bin/env node
/**
 * Record a browser demo inside a container that has a REAL desktop.
 *
 *   node src/screenbox.mjs <shotDir> --flow flows/x.json [--size 2560x1440]
 *
 * Every other capture path here trades something away:
 *
 *   CDP screencast   real input, but no pointer exists so one has to be drawn,
 *                    and no window chrome exists so one has to be drawn too.
 *   macOS screen     real pointer and real chrome, but it films YOUR display -
 *                    dock, other windows, and it cannot run in the background.
 *
 * A container running Xvfb + a window manager + Chromium has neither problem.
 * The pointer is a real X11 cursor moved by xdotool, the chrome is a real
 * browser window, ffmpeg x11grab records the virtual display, and the whole
 * thing happens on a screen that does not physically exist - so it runs while
 * the machine is being used for something else. This is demo-agent's Screenbox
 * idea; the Dockerfile is vendored from it.
 *
 * The flow is still driven over CDP, not by xdotool, because a selector's
 * bounding box is the only honest way to know where to aim. xdotool moves the
 * VISIBLE pointer to the same place, so the cursor you see and the click that
 * lands are the same event rather than two guesses that agree.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const IMAGE = process.env.SCREENBOX_IMAGE || 'screenbox:mate';
const DISPLAY = ':99';

/** Docker is optional here, so say precisely what is missing and how to fix it. */
export async function preflight() {
  const problems = [];
  const paths = ['docker', `${process.env.HOME}/.orbstack/bin/docker`,
    '/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
  let bin = null;
  for (const p of paths) {
    try { await run(p, ['--version']); bin = p; break; } catch { /* next */ }
  }
  if (!bin) {
    problems.push('no docker CLI. OrbStack.app is installed but has never been launched -'
      + ' open it once and it installs the CLI, or `brew install --cask docker`.');
    return { ok: false, problems };
  }
  try { await run(bin, ['info']); } catch {
    problems.push(`\`${bin}\` exists but the daemon is not running - start OrbStack or Docker Desktop.`);
    return { ok: false, bin, problems };
  }
  let hasImage = true;
  try {
    const { stdout } = await run(bin, ['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
    hasImage = !!stdout.trim();
  } catch { hasImage = false; }
  return { ok: true, bin, hasImage, problems };
}

export async function buildImage(bin, contextDir) {
  const dockerfile = join(contextDir, 'docker', 'Dockerfile.screenbox');
  if (!existsSync(dockerfile)) throw new Error(`no Dockerfile at ${dockerfile}`);
  console.log(`screenbox: building ${IMAGE} (first run only, a few minutes)...`);
  await new Promise((res, rej) => {
    const p = spawn(bin, ['build', '-t', IMAGE, '-f', dockerfile, contextDir], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exited ${c}`))));
    p.on('error', rej);
  });
}

const dexec = (bin, name, args, opts = {}) =>
  run(bin, ['exec', '-e', `DISPLAY=${DISPLAY}`, name, ...args], { maxBuffer: 1 << 26, ...opts });

export async function capture({ shotDir, flowPath, size = '2560x1440', fps = 30, keep = false }) {
  const pre = await preflight();
  if (!pre.ok) {
    for (const p of pre.problems) console.error('screenbox: ' + p);
    throw new Error('screenbox unavailable');
  }
  const bin = pre.bin;
  const here = resolve(new URL('.', import.meta.url).pathname, '..');
  if (!pre.hasImage) await buildImage(bin, join(here, 'vendor', 'demo-agent'));

  const [W, H] = size.split('x').map(Number);
  const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
  const name = 'demokit-screenbox';
  rmSync(shotDir, { recursive: true, force: true });
  mkdirSync(join(shotDir, 'frames'), { recursive: true });

  await run(bin, ['rm', '-f', name]).catch(() => {});
  await run(bin, ['run', '-d', '--name', name, '--shm-size=1g',
    '-p', '9222:9222', '-e', `SCREEN=${W}x${H}x24`, IMAGE]);

  try {
    // Xvfb + a window manager, then Chromium filling the virtual display with
    // its real chrome and remote debugging exposed to the host.
    await dexec(bin, name, ['bash', '-c',
      `Xvfb ${DISPLAY} -screen 0 ${W}x${H}x24 -nolisten tcp >/dev/null 2>&1 &
       sleep 1; marco --no-composite >/dev/null 2>&1 &
       sleep 1;
       chromium --no-sandbox --disable-gpu --remote-debugging-address=0.0.0.0 \
         --remote-debugging-port=9222 --window-position=0,0 --window-size=${W},${H} \
         --disable-features=TranslateUI --no-first-run ${JSON.stringify(flow.url)} \
         >/dev/null 2>&1 &
       sleep 4; xdotool search --class chromium windowactivate --sync %1 || true`]);

    await dexec(bin, name, ['bash', '-c',
      `ffmpeg -y -f x11grab -draw_mouse 1 -framerate ${fps} -video_size ${W}x${H} \
        -i ${DISPLAY} -c:v libx264 -preset ultrafast -qp 0 /tmp/box.mkv >/dev/null 2>&1 &
       echo started`]);

    // The flow runs from the host over CDP - a bounding box is the only honest
    // way to know where a thing is - while xdotool puts the REAL pointer on the
    // same coordinates, so the cursor on screen and the click that lands are
    // one event instead of two that agree by luck.
    console.log('screenbox: driving the flow over CDP at localhost:9222');
    await run('node', [join(here, 'src', 'boxflow.mjs'), flowPath, name, bin],
      { maxBuffer: 1 << 26, stdio: 'inherit' }).catch((e) => {
        console.error('screenbox: flow failed: ' + (e.message || e).slice(0, 200));
      });

    await dexec(bin, name, ['bash', '-c', 'pkill -INT ffmpeg; sleep 1.5']);
    await dexec(bin, name, ['bash', '-c',
      `mkdir -p /tmp/f && ffmpeg -y -i /tmp/box.mkv -vf fps=${fps} /tmp/f/f%05d.png >/dev/null 2>&1`]);
    await run(bin, ['cp', `${name}:/tmp/f/.`, join(shotDir, 'frames')]);

    const files = readdirSync(join(shotDir, 'frames')).filter((f) => f.endsWith('.png')).sort();
    const frames = files.map((f, i) => ({ i: Number(f.slice(1, 6)), ms: Math.round((i * 1000) / fps) }));
    writeFileSync(join(shotDir, 'manifest.json'), JSON.stringify({
      width: W, height: H, layout: [W, H], zoom: 1, dsf: 1,
      source: 'screenbox',
      endMs: frames.length ? frames.at(-1).ms : 0,
      frames, clicks: [], path: [], actions: [],   // real cursor is in the pixels
    }, null, 1));
    return { frames: frames.length, width: W, height: H };
  } finally {
    if (!keep) await run(bin, ['rm', '-f', name]).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, ...rest] = process.argv;
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  if (!shotDir || !arg('flow')) {
    console.error('usage: screenbox.mjs <shotDir> --flow <flow.json> [--size 2560x1440] [--fps 30]');
    const pre = await preflight();
    if (!pre.ok) for (const p of pre.problems) console.error('  ' + p);
    process.exit(2);
  }
  const r = await capture({
    shotDir, flowPath: arg('flow'), size: arg('size', '2560x1440'),
    fps: Number(arg('fps', '30')), keep: rest.includes('--keep'),
  });
  console.log(`screenbox: ${r.frames} frames @ ${r.width}x${r.height} -> ${shotDir}`);
}
