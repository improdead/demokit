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

export async function capture({ shotDir, flowPath, size = '4288x2560', fps = 25, keep = false, dsf = 2 }) {
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
  // The image's own entrypoint brings up Xvfb, dbus and a MATE session - that
  // session is what makes the window chrome real. Let it do that, then correct
  // the three things it does that a demo cannot use.
  await run(bin, ['run', '-d', '--name', name, '--shm-size=1g',
    '-p', '9223:9223',
    '-e', `SCREENBOX_RESOLUTION=${W}x${H}`,
    '-e', 'SCREENBOX_CHROME_URL=about:blank',
    IMAGE]);
  await new Promise((r) => setTimeout(r, 9000));

  let geom = { x: 0, y: 0, w: W, h: H };
  try {
    // 1. Its Chromium binds CDP to 127.0.0.1, which a published port cannot
    //    reach from the host. 2. It opens a file manager and a terminal that
    //    would both be in shot. 3. Nothing is sized for a demo.
    const url = JSON.stringify(flow.url);
    await dexec(bin, name, ['bash', '-c',
      `# -x matches the process NAME. -f matches the whole command line, which
       # includes this very command - so \`pkill -f chromium\` kills its own shell
       # and the exec dies with 143 before anything starts.
       pkill -x chromium || true; pkill -x mate-terminal || true; pkill -x caja || true
       sleep 1
       chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --test-type \
         --no-first-run --no-default-browser-check --disable-features=TranslateUI \
         --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
         --force-device-scale-factor=${dsf} \
         --remote-allow-origins='*' ${url} >/tmp/chromium.log 2>&1 &
       sleep 7`]);

    // Chromium ignores --remote-debugging-address and binds CDP to loopback
    // only, so a published port reaches nothing. python3 is already in the
    // image; a nine-line TCP relay is cheaper than adding socat to it.
    await run(bin, ['exec', '-d', name, 'python3', '-c',
      `import socket,threading
def pipe(a,b):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    finally:
        for s_ in (a,b):
            try: s_.close()
            except Exception: pass
srv=socket.socket(); srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
srv.bind(('0.0.0.0',9223)); srv.listen(64)
while True:
    c,_=srv.accept()
    try:
        u=socket.create_connection(('127.0.0.1',9222))
    except Exception:
        c.close(); continue
    threading.Thread(target=pipe,args=(c,u),daemon=True).start()
    threading.Thread(target=pipe,args=(u,c),daemon=True).start()`]);
    await new Promise((r) => setTimeout(r, 1200));

    // Size and centre the window, then read back where it actually landed. Only
    // that rectangle is recorded - the MATE panels and the desktop behind are
    // furniture, and filming them is the mistake the macOS path had to stage
    // around.
    const PANEL = 28;                       // MATE's top panel
    const wW = Math.round(W * 0.90) & ~1;
    const wH = Math.round((H - PANEL * 2) * 0.90) & ~1;
    await dexec(bin, name, ['bash', '-c',
      `id=$(xdotool search --class chromium | tail -1)
       xdotool windowsize $id ${wW} ${wH}
       xdotool windowmove $id ${(W - wW) >> 1} ${Math.max(PANEL + 4, (H - wH) >> 1)}
       xdotool windowactivate $id
       sleep 1`]);
    // The true window rect is NOT what xdotool reports. xdotool gives the CLIENT
    // area, which excludes the title bar the WM draws around it - capture that
    // and the top 32px of the window is missing while 32px of desktop shows at
    // the bottom. xwininfo gives the client origin, _NET_FRAME_EXTENTS gives the
    // decoration on each side, and the frame is the two combined.
    const { stdout: g } = await dexec(bin, name, ['bash', '-c',
      `id=$(xdotool search --class chromium | tail -1)
       eval $(xwininfo -id $id | awk '/Absolute upper-left X/{print "CX="$4}
                                      /Absolute upper-left Y/{print "CY="$4}
                                      /^  Width:/{print "CW="$2}
                                      /^  Height:/{print "CH="$2}')
       ext=$(xprop -id $id _NET_FRAME_EXTENTS 2>/dev/null | sed 's/.*= //' | tr -d ' ')
       L=\${ext%%,*}; ext=\${ext#*,}; R=\${ext%%,*}; ext=\${ext#*,}; T=\${ext%%,*}; B=\${ext#*,}
       L=\${L:-0}; R=\${R:-0}; T=\${T:-0}; B=\${B:-0}
       echo "X=$((CX-L))"; echo "Y=$((CY-T))"; echo "WIDTH=$((CW+L+R))"; echo "HEIGHT=$((CH+T+B))"`]);
    const gv2 = Object.fromEntries(g.trim().split('\n').map((l) => l.trim().split('=')));
    const gx = Math.max(0, Number(gv2.X) || 0);
    const gy = Math.max(0, Number(gv2.Y) || 0);
    geom = {
      x: gx, y: gy,
      w: Math.min(Number(gv2.WIDTH) || wW, W - gx) & ~1,
      h: Math.min(Number(gv2.HEIGHT) || wH, H - gy) & ~1,
    };
    console.log(`screenbox: window ${geom.w}x${geom.h} device px at ${geom.x},${geom.y} `
      + `on a ${W}x${H} desktop (dsf ${dsf} -> ~${Math.round(geom.w / dsf)} CSS px of layout)`);

    // Prepare BEFORE the camera rolls: wait out the auth screen and preflight
    // every selector. Recording first meant the opening shot was a sign-in page
    // and a half-failed flow still produced a video.
    const prep = await new Promise((res) => {
      const p = spawn('node', [join(here, 'src', 'boxflow.mjs'), flowPath, name, bin,
        String(geom.x), String(geom.y), String(dsf), 'prepare'], { stdio: 'inherit',
        env: { ...process.env, DEMOKIT_PW: process.env.DEMOKIT_PW || '',
               DEMOKIT_COOKIES: process.env.DEMOKIT_COOKIES || '' } });
      p.on('exit', (c) => res(c ?? 1));
      p.on('error', () => res(1));
    });
    if (prep !== 0) throw new Error('box preflight failed - not recording');

    // `docker exec ... "cmd &"` does not survive: the backgrounded process dies
    // with the exec session. -d detaches it properly.
    await run(bin, ['exec', '-d', '-e', `DISPLAY=${DISPLAY}`, name, 'bash', '-c',
      `ffmpeg -y -f x11grab -draw_mouse 1 -framerate ${fps} `
      + `-video_size ${geom.w}x${geom.h} -i '${DISPLAY}.0+${geom.x},${geom.y}' `
      + `-c:v libx264 -preset ultrafast -qp 0 /tmp/box.mkv > /tmp/ff.log 2>&1`]);
    await new Promise((r) => setTimeout(r, 1500));
    const { stdout: rec } = await dexec(bin, name, ['bash', '-c',
      'pgrep -x ffmpeg >/dev/null && echo recording || (echo FAILED; tail -4 /tmp/ff.log)']);
    console.log('screenbox: ' + rec.trim().split('\n').join(' | '));
    if (rec.includes('FAILED')) throw new Error('ffmpeg did not start');

    // The flow runs from the host over CDP - a bounding box is the only honest
    // way to know where a thing is - while xdotool puts the REAL pointer on the
    // same coordinates, so the cursor on screen and the click that lands are
    // one event instead of two that agree by luck.
    console.log('screenbox: driving the flow over CDP at localhost:9223');
    // execFile CAPTURES output even with stdio:'inherit', so boxflow's log -
    // which is the only place a skipped step or a failed expect is reported -
    // was being swallowed. spawn actually inherits.
    await new Promise((res) => {
      const p = spawn('node', [join(here, 'src', 'boxflow.mjs'), flowPath, name, bin,
        String(geom.x), String(geom.y), String(dsf)], { stdio: 'inherit',
        env: { ...process.env, DEMOKIT_PW: process.env.DEMOKIT_PW || '',
               DEMOKIT_COOKIES: process.env.DEMOKIT_COOKIES || '',
               DEMOKIT_EVENTS: join(shotDir, 'boxevents.json') } });
      p.on('exit', () => res());
      p.on('error', (e) => { console.error('screenbox: flow failed: ' + e.message); res(); });
    });
    await Promise.resolve({ _unused: [join(here, 'src', 'boxflow.mjs'), flowPath, name, bin,
      String(geom.x), String(geom.y)],
      _o: { maxBuffer: 1 << 26,
        env: { ...process.env, DEMOKIT_PW: process.env.DEMOKIT_PW || '',
               DEMOKIT_COOKIES: process.env.DEMOKIT_COOKIES || '' } } });

    await dexec(bin, name, ['bash', '-c', 'pkill -INT ffmpeg; sleep 1.5']);
    await dexec(bin, name, ['bash', '-c',
      `mkdir -p /tmp/f && ffmpeg -y -i /tmp/box.mkv -vf fps=${fps} /tmp/f/f%05d.png >/dev/null 2>&1`]);
    await run(bin, ['cp', `${name}:/tmp/f/.`, join(shotDir, 'frames')]);

    const files = readdirSync(join(shotDir, 'frames')).filter((f) => f.endsWith('.png')).sort();
    const frames = files.map((f, i) => ({ i: Number(f.slice(1, 6)), ms: Math.round((i * 1000) / fps) }));
    writeFileSync(join(shotDir, 'manifest.json'), JSON.stringify({
      width: geom.w, height: geom.h, layout: [geom.w, geom.h], zoom: 1, dsf: 1,
      source: 'screenbox',
      endMs: frames.length ? frames.at(-1).ms : 0,
      ...(existsSync(join(shotDir, 'boxevents.json'))
        ? (() => {
            const e = JSON.parse(readFileSync(join(shotDir, 'boxevents.json'), 'utf8'));
            // path stays empty on purpose: the cursor is REAL in these frames,
            // so cursor.py must not draw a second one over it.
            return { frames, events: e.events, clicks: e.events, actions: e.actions, path: [] };
          })()
        : { frames, clicks: [], path: [], actions: [] }),
    }, null, 1));
    return { frames: frames.length, width: geom.w, height: geom.h };
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
    shotDir, flowPath: arg('flow'), size: arg('size', '4288x2560'),
    fps: Number(arg('fps', '25')), dsf: Number(arg('dsf', '2')), keep: rest.includes('--keep'),
  });
  console.log(`screenbox: ${r.frames} frames @ ${r.width}x${r.height} -> ${shotDir}`);
}
