/**
 * Frames + click log -> polished demo MP4. Single ffmpeg pass, then pacing.
 *
 * Everything is drawn here from the recorder's exact click coordinates, so
 * there is only ever one cursor and it is always where the click actually
 * landed. (recast's cursorOverlay is fed from trace coordinates in a different
 * space and drifts; we don't use it.)
 *
 * Order matters:
 *   cursor + ripple in PAGE space  ->  they scale with the window like a real
 *                                      screen recording
 *   inset frame / backdrop / shadow
 *   zoom into the whole composite
 *   pacing last (see pace.mjs)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);
const even = (v) => (v % 2 ? v + 1 : v);

/** macOS-ish arrow: white fill, dark outline, soft shadow. */
export async function makeCursor(dir, h = 52) {
  const p = join(dir, `cursor-${h}.png`);
  if (existsSync(p)) return p;
  const py = `
from PIL import Image, ImageDraw, ImageFilter
h=${h}; s=h/32.0
W,H=int(24*s)+12,int(32*s)+12
pts=[(0,0),(0,22),(5,17),(9,27),(13,25),(9,16),(16,16)]
pts=[(6+x*s,6+y*s) for x,y in pts]
sh=Image.new('RGBA',(W,H),(0,0,0,0))
ImageDraw.Draw(sh).polygon(pts, fill=(0,0,0,120))
sh=sh.filter(ImageFilter.GaussianBlur(3))
im=Image.new('RGBA',(W,H),(0,0,0,0))
d=ImageDraw.Draw(im)
d.polygon(pts, fill=(255,255,255,255), outline=(28,28,32,255))
d.line(pts+[pts[0]], fill=(28,28,32,255), width=max(1,int(1.6*s)), joint='curve')
Image.alpha_composite(sh, im).save(${JSON.stringify(p)})
print('ok')`;
  await run('python3', ['-c', py]);
  return p;
}

/** Expanding rings for the click pulse: successive radii, fading out. */
export async function makeRipples(dir, steps = 7, maxR = 46, color = '79,107,61') {
  const paths = [];
  for (let i = 0; i < steps; i++) {
    const p = join(dir, `ripple-${i}-${maxR}.png`);
    paths.push(p);
    if (existsSync(p)) continue;
    const f = (i + 1) / steps;
    const r = Math.round(10 + (maxR - 10) * f);
    const a = Math.round(150 * (1 - f) ** 1.4);
    const w = Math.max(2, Math.round(6 * (1 - f) + 2));
    const py = `
from PIL import Image, ImageDraw
S=${maxR * 2 + 8}
im=Image.new('RGBA',(S,S),(0,0,0,0))
d=ImageDraw.Draw(im)
c=S/2
d.ellipse([c-${r},c-${r},c+${r},c+${r}], outline=(${color},${a}), width=${w})
im.save(${JSON.stringify(p)})
print('ok')`;
    await run('python3', ['-c', py]);
  }
  return paths;
}

/** Piecewise position expression: rest, then eased travel into each click. */
function pathExpr(clicks, key, travel = 0.45) {
  if (!clicks.length) return '0';
  let e = String(clicks[clicks.length - 1][key].toFixed(1));
  for (let i = clicks.length - 1; i >= 0; i--) {
    const tc = clicks[i].t / 1000;
    const from = i === 0 ? clicks[0][key] : clicks[i - 1][key];
    const to = clicks[i][key];
    const a = (tc - travel).toFixed(4);
    const p = `clip((t-${a})/${travel},0,1)`;
    const s = `(3*pow(${p},2)-2*pow(${p},3))`;
    const lerp = `(${from.toFixed(1)}+(${(to - from).toFixed(1)})*${s})`;
    // before this click's travel window -> hold previous position
    e = `if(lt(t,${a}), ${from.toFixed(1)}, if(lt(t,${tc.toFixed(4)}), ${lerp}, ${e}))`;
  }
  return e;
}

/**
 * Backdrops.
 *
 * The old default blurred the recording behind itself. Screen Studio ships
 * wallpaper / gradient / colour / image and treats "blur the recording" as an
 * open feature request, not a default - and for good reason: a dark app blurred
 * behind itself is just murk, with no tonal separation between the window and
 * the ground it sits on.
 *
 * These are mesh gradients: a few colour points blended by inverse-square
 * distance, rendered small and upscaled, which is how a smooth wallpaper is
 * made without banding. Grain is added last because flat gradients band badly
 * at 8-bit after x264.
 */
/** Painterly grounds: layered colour fields with visible brush texture.
 *  A smooth mesh gradient reads as a CSS default. The demos worth copying sit
 *  on something that looks like a surface - canvas, paint, paper - and the
 *  texture is what sells the depth once the window has a shadow on it. */
export const CANVASES = {
  'canvas-garden': ['#5c7a3f', '#94ad5e', '#e8d9a8', '#d98fa0', '#3d5730', '#f2e6c8'],
  'canvas-dusk':   ['#2b2350', '#5b3a7a', '#a8547e', '#e0956f', '#1d1836', '#f0c9a0'],
  'canvas-tide':   ['#123c4e', '#1f7a86', '#6cc0ab', '#d8e6c8', '#0d2536', '#f0f3e2'],
  'canvas-ember':  ['#3d1f18', '#8c3d22', '#d1743a', '#e8bb72', '#241210', '#f2ddb8'],
  'canvas-slate':  ['#33383f', '#565e68', '#8b949f', '#c3c9cf', '#22262b', '#e4e7ea'],
};

export const BACKDROPS = {
  // for DARK app UIs - the ground has to be lighter or richer than the window
  dusk:   { pts: [[0.08, 0.10, '#3b2a6b'], [0.92, 0.06, '#7b3fa0'], [0.75, 0.95, '#c2557a'], [0.15, 0.85, '#2a1f52']] },
  ember:  { pts: [[0.10, 0.12, '#4a2318'], [0.90, 0.10, '#a8542a'], [0.80, 0.92, '#d98f45'], [0.12, 0.90, '#361a14']] },
  tide:   { pts: [[0.10, 0.08, '#0f3f56'], [0.90, 0.12, '#1f7d8c'], [0.85, 0.90, '#6fc0ad'], [0.10, 0.92, '#0d2f45']] },
  // neutral - safe under anything
  slate:  { pts: [[0.12, 0.10, '#3a4250'], [0.88, 0.14, '#59636f'], [0.86, 0.90, '#2c333d'], [0.14, 0.88, '#454e5b']] },
  // for LIGHT app UIs - a dark ground makes a white window read as paper
  noir:   { pts: [[0.15, 0.12, '#1b1d22'], [0.85, 0.10, '#2b2f38'], [0.88, 0.92, '#101216'], [0.10, 0.90, '#23262e']] },
  linen:  { pts: [[0.12, 0.10, '#e8dcc6'], [0.88, 0.12, '#f2ece0'], [0.85, 0.90, '#d8c7ab'], [0.12, 0.90, '#efe6d4']] },
};

/** Pick a backdrop from how bright the recording actually is. */
export async function pickBackdrop(framePath, dir0 = process.cwd()) {
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(framePath)}).convert('L').resize((64, 36))
px = list(im.getdata())
print(sum(px) / len(px))`;
  const { stdout } = await run('python3', ['-c', py]);
  const lum = parseFloat(stdout.trim());
  // A background exists to SEPARATE, not to blend - so pick by contrast against
  // what was actually recorded, and prefer the real macOS wallpapers when they
  // are on disk. These are what the look being copied actually sits on.
  //
  // An earlier version rejected them as muddy. That was true of the picture it
  // was producing and false of the wallpaper: the treatment was blurring 0.4%,
  // desaturating to 0.82 and dimming to 0.92, which turns any photograph into
  // grey soup. Blurred harder and left saturated, the same file reads as a
  // macOS desktop. The generated gradients remain as a fallback and for anyone
  // who wants no photograph at all.
  const wall = (n) => {
    const p = join(dir0, '.cache', 'wallpapers', n);
    return existsSync(p) ? p : null;
  };
  // Sonoma under everything, and the luminance is not consulted for it.
  //
  // The rule that a light app needs a DARK ground is the usual advice and it
  // produced the worse picture here: the dark radial fan behind a white UI
  // blurs to a flat navy smear, while Sonoma behind the same UI is vivid and
  // still leaves the window as the subject. Separation is coming from the
  // shadow and the blur, not from making the ground dark.
  //
  // Which also means the code this replaced was right to prefer a wallpaper and
  // wrong only in how it treated one - and the version in between blamed the
  // wallpaper for what the treatment was doing.
  const sonoma = wall('mac-sonoma.png');
  if (sonoma) return sonoma;
  return lum > 150 ? 'dusk' : lum < 70 ? 'linen' : 'tide';
}

/** @param spec  "dusk" | "#101010" | "/path/to/wallpaper.png" | "blur" */
// Treatment defaults for a photographic ground. Blur HARD - the point is a
// surface, not a picture, and a soft field of colour is what reads as depth.
// Do not desaturate: that is what made every wallpaper look like grey soup, and
// it is the reason the generated gradients briefly won a comparison they should
// have lost.
export async function makeBackdrop({ dir, w, h, spec, treatBlur = 0.016, treatSat = 1.12, treatDim = 1.0 }) {
  mkdirSync(dir, { recursive: true });
  const key = (spec.replace(/[^a-z0-9]/gi, '_') + `_${treatBlur}_${treatSat}_${treatDim}`).slice(-90);
  const out = join(dir, `bg-${key}-${w}x${h}.png`);
  if (existsSync(out)) return out;

  if (/^[#][0-9a-f]{6}$/i.test(spec)) {
    await run('python3', ['-c', `
from PIL import Image
Image.new('RGB', (${w}, ${h}), ${JSON.stringify(spec)}).save(${JSON.stringify(out)})`]);
    return out;
  }
  if (!BACKDROPS[spec] && !CANVASES[spec]) {   // treat anything else as an image path
    // A real photograph at full contrast fights the UI - the window stops being
    // the subject. Soften, desaturate and dim it a little so it reads as a
    // surface the window is sitting on rather than a second thing to look at.
    await run('python3', ['-c', `
from PIL import Image, ImageFilter, ImageEnhance
im = Image.open(${JSON.stringify(spec)}).convert('RGB')
tw, th = ${w}, ${h}
s = max(tw / im.width, th / im.height)
im = im.resize((max(tw, int(im.width * s)), max(th, int(im.height * s))), Image.LANCZOS)
l = (im.width - tw) // 2; t = (im.height - th) // 2
im = im.crop((l, t, l + tw, t + th))
if ${treatBlur} > 0:
    im = im.filter(ImageFilter.GaussianBlur(tw * ${treatBlur}))
im = ImageEnhance.Color(im).enhance(${treatSat})
im = ImageEnhance.Brightness(im).enhance(${treatDim})
im.save(${JSON.stringify(out)}, quality=95)`], { maxBuffer: 1 << 26 });
    return out;
  }

  if (CANVASES[spec]) {
    const cols = CANVASES[spec];
    const py = `
from PIL import Image, ImageDraw, ImageFilter
import random, math
W, H = ${w}, ${h}
cols = [tuple(int(c.lstrip('#')[i:i+2], 16) for i in (0, 2, 4)) for c in ${JSON.stringify(cols)}]
random.seed(${w} * 7 + ${h})

def stroke(d, x, y, a, L, wd, c, alpha):
    # a brush stroke is a tapered smear, not a line: several overlapping dabs
    n = max(3, int(L / max(2, wd * 0.6)))
    for i in range(n):
        t = i / (n - 1)
        taper = math.sin(math.pi * (0.15 + 0.85 * t)) ** 0.5
        r = wd * taper
        px_, py_ = x + math.cos(a) * L * t, y + math.sin(a) * L * t
        d.ellipse([px_ - r, py_ - r * 0.75, px_ + r, py_ + r * 0.75],
                  fill=c + (int(alpha * taper),))

im = Image.new('RGB', (W, H), cols[0])
d = ImageDraw.Draw(im, 'RGBA')

# 1. big colour fields, kept distinct - this is the composition, and blurring
#    it into a single hue is what made the first attempt look like fabric
for i in range(11):
    c = cols[random.randrange(len(cols))]
    r = random.uniform(W * 0.20, W * 0.50)
    x, y = random.uniform(-W * 0.1, W * 1.1), random.uniform(-H * 0.1, H * 1.1)
    d.ellipse([x - r, y - r * 0.8, x + r, y + r * 0.8], fill=c + (random.randint(120, 210),))
im = im.filter(ImageFilter.GaussianBlur(W * 0.020))

# 2. few, LARGE strokes with real angular variety. 2600 tiny ones at a shared
#    angle read as fur; 260 big ones read as a hand holding a brush.
d = ImageDraw.Draw(im, 'RGBA')
for i in range(150):
    c = cols[random.randrange(len(cols))]
    x, y = random.uniform(0, W), random.uniform(0, H)
    a = random.uniform(0, math.pi * 2)
    L = random.uniform(W * 0.06, W * 0.24)
    wd = random.uniform(W * 0.006, W * 0.024)
    stroke(d, x, y, a, L, wd, c, random.randint(14, 46))

# 3. a few bright accents so it is not one temperature
for i in range(26):
    c = cols[random.randrange(len(cols))]
    x, y = random.uniform(0, W), random.uniform(0, H)
    stroke(d, x, y, random.uniform(0, math.pi * 2),
           random.uniform(W * 0.03, W * 0.10), random.uniform(W * 0.004, W * 0.012),
           c, random.randint(28, 62))

# A backdrop has to recede. Blur hard at the end: the texture should read as
# a surface at a glance and dissolve the moment you look at the window.
im = im.filter(ImageFilter.GaussianBlur(max(2, W * 0.014)))

# 4. canvas tooth + grain, so it does not band after x264
px = im.load()
for y in range(H):
    for x in range(W):
        n_ = random.randint(-6, 6)
        r_, g_, b_ = px[x, y]
        px[x, y] = (max(0, min(255, r_ + n_)), max(0, min(255, g_ + n_)), max(0, min(255, b_ + n_)))
im.save(${JSON.stringify(out)})
print('ok')`;
    await run('python3', ['-c', py], { maxBuffer: 1 << 26 });
    return out;
  }

  const pts = BACKDROPS[spec].pts;
  const py = `
from PIL import Image, ImageFilter
import random
W, H = 96, 54                                   # render small, upscale smooth
pts = ${JSON.stringify(pts.map(([x, y, c]) => [x, y, c]))}
def rgb(h): h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
cols = [(p[0], p[1], rgb(p[2])) for p in pts]
im = Image.new('RGB', (W, H))
px = im.load()
for y in range(H):
    for x in range(W):
        u, v = x / (W - 1), y / (H - 1)
        acc = [0.0, 0.0, 0.0]; tot = 0.0
        for cx, cy, c in cols:
            d = (u - cx) ** 2 + (v - cy) ** 2 + 0.015   # +eps: no hot spikes
            w_ = 1.0 / (d * d)
            tot += w_
            for i in range(3): acc[i] += c[i] * w_
        px[x, y] = tuple(int(max(0, min(255, a / tot))) for a in acc)
im = im.resize((${w}, ${h}), Image.LANCZOS).filter(ImageFilter.GaussianBlur(${Math.round(w / 90)}))
# Flat gradients band after x264; a little grain dithers the steps away.
random.seed(7)
g = im.load()
for y in range(0, ${h}):
    for x in range(0, ${w}, 1):
        n = random.randint(-3, 3)
        r, gg, b = g[x, y]
        g[x, y] = (max(0, min(255, r + n)), max(0, min(255, gg + n)), max(0, min(255, b + n)))
im.save(${JSON.stringify(out)})
print('ok')`;
  await run('python3', ['-c', py]);
  return out;
}

export function buildGraph({
  srcW, srcH, outW, outH, fps, clicks, rippleCount, cursorH,
  macLights = false, trimTop = 0, barH = 0,
  // Composite at capture resolution. Building at 1080p and letting zoompan
  // upscale 1.35x throws away the 2560 capture at exactly the moment the
  // viewer is looking closest. Instead we crop from the full-res canvas and
  // downscale ONCE, at the end.
  // centerBias blends the aim toward the middle of the window. It defaulted to
  // 0.4, which means the camera went 40% of the way from the cursor to the
  // centre - the single largest reason a push looked like it landed somewhere
  // arbitrary. The cursor is the subject; blending away from it is a choice
  // that has to be asked for.
  inset = 0.8, level = 1.4, ramp = 0.55, hold = 0.9, centerBias = 0, minGapMs = 1500,
  edgeSnap = 0, maxOffFrac = 0.055,
  blurSigma = 46, bgDim = 0.06, bgSat = 0.85, pad, rippleSize, backdrop = null,
  minLevel = 1.22, maxLevel = 1.7, openPull = 1.28, openMs = 1500, edl = null, panMs = 420,
}) {
  const parts = [];
  // Cursor and click pulses are already composited into the frames by
  // src/cursor.py - it interpolates the dense pointer path per frame, which an
  // ffmpeg overlay expression cannot do without encoding hundreds of samples.
  // Crop the window manager's title bar away and put macOS buttons on the tab
  // strip, so the window matches the desktop it is sitting on.
  const M = 1, S = 2, B = 3, LT = 4; // inputs: 0 frames, 1 mask, 2 shadow, 3 backdrop, 4 buttons
  const trim = Math.max(0, Math.round(trimTop || 0));
  const bar = Math.max(0, Math.round(barH || 0));
  if (trim > 0 && bar > 0) {
    // Cut the window manager's bar off and put a macOS one in its place. The
    // first attempt overlaid the buttons straight onto the tab strip, where
    // macOS keeps them - but Linux Chromium starts its tabs at the left edge,
    // so the lights landed on top of the tab title and read as broken. A bar of
    // its own is not pixel-identical to Chrome on a Mac, and it is coherent.
    parts.push(
      `[0:v]fps=${fps},crop=iw:ih-${trim}:0:${trim},pad=iw:ih+${bar}:0:${bar}[padded]`,
      `[padded][${LT}:v]overlay=0:0[withcur]`);
  } else if (trim > 0) {
    parts.push(`[0:v]fps=${fps},crop=iw:ih-${trim}:0:${trim}[withcur]`);
  } else {
    parts.push(`[0:v]fps=${fps}[withcur]`);
  }
  // The zoom runs on the FINISHED composite - window, chrome, shadow and
  // backdrop together - so pushing in reads as a camera moving toward one
  // physical object. Zooming the recording alone and insetting it afterwards
  // pins the window and slides content inside it, which looks like an iframe,
  // not a camera: the frame and the ground stop belonging to the same scene.

  // ---- frame composite (at capture resolution) -----------------------------
  //
  // The canvas is the OUTPUT aspect, not the source aspect. It used to be
  // srcW x srcH, which is fine while the window is 16:9 - but the chrome pass
  // makes the frames taller, and scaling 2560x1592 straight into 1920x1080
  // stretches the whole picture horizontally.
  const compW = even(srcW);
  const compH = even(Math.round(srcW * (outH / outW)));
  // Fit the window inside the canvas on whichever axis binds.
  const fitW = compW * inset, fitH = compH * inset;
  const ar = srcW / srcH;
  let fgW = fitW, fgH = fitW / ar;
  if (fgH > fitH) { fgH = fitH; fgW = fitH * ar; }
  fgW = even(Math.round(fgW));
  fgH = even(Math.round(fgH));
  const ox = Math.round((compW - fgW) / 2);
  const oy = Math.round((compH - fgH) / 2);

  if (backdrop) {
    // A still wallpaper. It has to be scaled here rather than pre-sized,
    // because zoompan crops from this canvas at composite resolution.
    parts.push(
      `[${B}:v]scale=${compW}:${compH}:flags=lanczos,setsar=1[bg]`,
      `[withcur]scale=${fgW}:${fgH}:flags=lanczos[fgs]`);
  } else {
    // Legacy: blur the recording behind itself. Kept for --bg blur.
    parts.push(
      `[withcur]split=2[fga_src][bg_src]`,
      `[bg_src]scale=${compW}:${compH}:force_original_aspect_ratio=increase,crop=${compW}:${compH},` +
        `gblur=sigma=${Math.round(blurSigma * (compW / 1920))},eq=brightness=-${bgDim}:saturation=${bgSat}[bg]`,
      `[fga_src]scale=${fgW}:${fgH}:flags=lanczos[fgs]`);
  }
  parts.push(
    `[${M}:v]scale=${fgW}:${fgH}[mk]`,
    `[fgs][mk]alphamerge[fga]`,
    `[bg][${S}:v]overlay=${ox - pad}:${oy - pad}[bgs]`,
    `[bgs][fga]overlay=${ox}:${oy}[flat]`,
  );

  // ---- zoom ----------------------------------------------------------------
  //
  // Each zoom names a RECTANGLE it must contain. Solving for the crop that
  // contains it is exact: "frame this element" instead of "push 1.4x toward
  // this coordinate and hope". The old way could not be accurate even in
  // principle - depth and target were independent guesses.
  const chains = (edl && edl.chains && edl.chains.length) ? edl.chains : null;
  const zooms = (edl && edl.zooms) ? edl.zooms : kept.map((c) => ({
    tMs: c.t, rect: [c.x - (c.w || 120) / 2, c.y - (c.h || 40) / 2, c.w || 120, c.h || 40],
    holdMs: hold * 1000, rampMs: ramp * 1000, padFrac: 0.55, reason: c.label,
  }));
  if (!zooms.length) {
    parts.push(`[flat]scale=${outW}:${outH}:flags=lanczos[out]`);
    return parts.join(';');
  }

  // Composite space: the crop moves over the whole scene.
  const sx = fgW / srcW, sy = fgH / srcH;
  const zOx = ox, zOy = oy;
  const zW = compW, zH = compH;
  const tv = `(in/${fps})`;

  /** Solve the crop that CONTAINS a rect. Exact, rather than a depth guess
   *  aimed at a coordinate - which could not be accurate even in principle. */
  const solve = (zm) => {
    const pad = zm.padFrac ?? 0.55;
    const rx = zOx + zm.rect[0] * sx, ry = zOy + zm.rect[1] * sy;
    const rw = zm.rect[2] * sx, rh = zm.rect[3] * sy;
    const cw = rw * (1 + 2 * pad), chh = rh * (1 + 2 * pad);
    // A target may state its depth outright. The simple camera does, so every
    // push travels the same distance and the rhythm is predictable.
    let z = zm.z
      ? zm.z
      : Math.max(1.0, Math.min(maxLevel, Math.min(zW / Math.max(1, cw), zH / Math.max(1, chh))));

    const wcx = ox + fgW / 2, wcy = oy + fgH / 2;
    const b = Math.max(0, Math.min(0.9, centerBias));
    const tx = (rx + rw / 2) * (1 - b) + wcx * b;
    const ty = (ry + rh / 2) * (1 - b) + wcy * b;
    const halfW = zW / (2 * z), halfH = zH / (2 * z);

    // The crop must stay inside the WINDOW. It used to be clamped to the canvas,
    // so a target near an edge produced a frame holding 600px of backdrop with
    // the window sliced down the middle - exactly what the comment that used to
    // sit here claimed it prevented.
    const loX = ox + halfW, hiX = ox + fgW - halfW;
    const loY = oy + halfH, hiY = oy + fgH - halfH;

    // On Cap's travel space, and why it is not used by default.
    //
    // Cap (crates/rendering/src/zoom.rs, `from_amount_center`) maps the focus to
    // a scalar spread PROPORTIONALLY across the set of in-bounds framings: 0 is
    // flush to the left edge, 1 flush to the right. It is a good design for what
    // Cap does - follow a cursor cluster that drifts across a whole segment,
    // with corners reachable and no post-correction.
    //
    // It is the wrong design for one click. Proportional mapping systematically
    // decentres a single point: measured on this take, a cursor 39% across the
    // window framed 279px off centre, and with edge snapping on top of it, 313px.
    // The requirement here is "the click is in the middle of the frame", so the
    // focus is used directly and only clamped when centring would pull the crop
    // off the window. In the interior - where a click almost always is - the
    // cursor lands dead centre, and near an edge the frame stops at the edge
    // instead of showing backdrop.
    const snapToEdges = (v, r) => {
      const lo = r, hi = 1 - r + 0.0001;
      if (hi <= lo) return 0.5;
      return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    };
    // A crop wider than the window cannot sit inside it; centre it rather than
    // sliding off-target, and let the depth solver be what fixes that.
    const place = (focus, lo, hi, o0, span, mid) => {
      if (!(hi > lo)) return mid;
      if (edgeSnap > 0) return lo + snapToEdges((focus - o0) / Math.max(1, span), edgeSnap) * (hi - lo);
      return Math.max(lo, Math.min(hi, focus));
    };
    const cx = place(tx, loX, hiX, ox, fgW, wcx);
    const cy = place(ty, loY, hiY, oy, fgH, wcy);
    // If the camera cannot actually frame the target, it does not move.
    //
    // A click close to a window edge cannot be centred at any sensible depth -
    // the crop would have to hang off the window and fill with backdrop. The
    // clamp keeps the frame clean, but past a point the result is a push that
    // visibly misses its subject, and a still frame beats that every time. Note
    // that depth does not rescue this: a DEEPER zoom has more reach, not less,
    // and the depth needed here was about 5x.
    const off = Math.round(Math.hypot(cx - tx, cy - ty));
    if (off > compW * maxOffFrac) {
      return { z: 1, cx: wcx, cy: wcy, unframable: true, reason: zm.reason, off };
    }
    if (off > compW * 0.02) {
      console.log(`  NOTE: "${zm.reason}" framed ${off}px off the cursor - it sits `
        + `within half a frame of the window edge, so centring would show backdrop`);
    }
    return { z, cx, cy };
  };

  // Group targets into camera MOVES: one zoom in, pan between targets while
  // held, one zoom out. Popping out to full frame between every click is what
  // makes the camera bob.
  // Drop a target the camera cannot frame - do NOT let it drop the move.
  //
  // Cap merges nearby clicks into one segment with several focus points, and
  // the depth of a move is the shallowest its targets need. So a single
  // unframable focus point (one click too near the window edge) was collapsing
  // the entire merged segment to 1x: the take came back with no camera movement
  // at all and nothing said why.
  const keepFramable = (targets, reason) => {
    const ok = targets.filter((t) => !t.unframable);
    for (const t of targets) {
      if (!t.unframable) continue;
      console.log(ok.length
        ? `  skipping one focus point in "${t.reason}": ${t.off}px from any framing that `
          + `keeps the window full - the rest of the segment still moves`
        : `  not moving for "${t.reason}": it sits ${t.off}px from any framing that keeps `
          + `the window full, so the push would land off its own subject`);
    }
    return ok.length ? ok : targets;
  };
  const moves = chains
    ? chains.map((c) => ({ startMs: c.startMs, endMs: c.endMs,
        targets: keepFramable(c.targets.map(solve).map((s, i) => ({ ...s, tMs: c.targets[i].tMs })), c.reason) }))
    : zooms.map((zm) => {
        const s = solve(zm);
        const h = (zm.holdMs ?? hold * 1000);
        return { startMs: zm.tMs - h / 2, endMs: zm.tMs + h / 2, targets: [{ ...s, tMs: zm.tMs }] };
      });

  const trapezoid = (aSec, bSec, rIn, rOut) =>
    `clip(min(min((${tv}-${aSec.toFixed(4)})/${rIn.toFixed(4)},(${bSec.toFixed(4)}-${tv})/${rOut.toFixed(4)}),1),0,1)`;
  const smooth = (e) => `(3*pow(${e},2)-2*pow(${e},3))`;

  // Zoom amount. The ramp begins AT the click and reaches depth after it.
  //
  // It used to begin `ramp` seconds BEFORE startMs, so with startMs set to the
  // click the camera was already moving 0.55s before the thing that caused it -
  // and the aim envelope led by 1.21s on top. That is the whole of "it zooms in
  // before I click": the push was literally predicting the click.
  const envs = moves.map((mv) => smooth(trapezoid(
    mv.startMs / 1000, (mv.endMs / 1000) + ramp, ramp, ramp)));

  // Framing centre, PRE-AIMED - but pre-aimed WITHIN the push, not before it.
  // The centre still has to arrive before the zoom bites, or the camera slides
  // sideways into its target instead of scaling straight at it (Cap calls this
  // CENTER_PREAIM). So it starts at the same instant and simply ramps faster:
  // aim is in place at click+0.25s, depth arrives at click+0.55s.
  const aims = moves.map((mv) => smooth(trapezoid(
    mv.startMs / 1000, (mv.endMs / 1000) + ramp, ramp * 0.45, ramp)));

  // A move holds ONE depth - the shallowest its targets need, so every target
  // fits inside the crop as the camera pans between them.
  const levels = moves.map((mv) => Math.min(...mv.targets.map((t) => t.z)));

  /** Piecewise eased pan between the targets of one move. */
  const panExpr = (mv, key) => {
    const ts = mv.targets;
    if (ts.length === 1) return (ts[0][key] / (key === 'cx' ? zW : zH)).toFixed(5);
    const norm = (v) => (v / (key === 'cx' ? zW : zH)).toFixed(5);
    let e = norm(ts.at(-1)[key]);
    for (let i = ts.length - 1; i >= 1; i--) {
      const t0 = (ts[i].tMs / 1000) - panMs / 1000, t1 = ts[i].tMs / 1000;
      const p = `clip((${tv}-${t0.toFixed(4)})/${(panMs / 1000).toFixed(4)},0,1)`;
      const sm = `(3*pow(${p},2)-2*pow(${p},3))`;
      const from = norm(ts[i - 1][key]), to = norm(ts[i][key]);
      e = `if(lt(${tv},${t0.toFixed(4)}), ${from}, if(lt(${tv},${t1.toFixed(4)}), (${from}+((${to})-(${from}))*${sm}), ${e}))`;
    }
    return e;
  };

  const terms = moves.map((mv, i) => `(${(levels[i] - 1).toFixed(4)})*(${envs[i]})`);
  const openEnv = (openPull > 1.001 && openMs > 0)
    ? `(3*pow(clip(1-${tv}/${(openMs / 1000).toFixed(3)},0,1),2)-2*pow(clip(1-${tv}/${(openMs / 1000).toFixed(3)},0,1),3))`
    : null;
  if (openEnv) terms.push(`(${(openPull - 1).toFixed(4)})*(${openEnv})`);

  const allAims = openEnv ? aims.concat([openEnv]) : aims;
  const sum = allAims.map((e) => `(${e})`).join('+');
  const wxs = moves.map((mv, i) => `(${aims[i]})*(${panExpr(mv, 'cx')})`);
  const wys = moves.map((mv, i) => `(${aims[i]})*(${panExpr(mv, 'cy')})`);
  if (openEnv) { wxs.push(`(${openEnv})*0.5`); wys.push(`(${openEnv})*0.5`); }
  const wx = wxs.join('+');
  const wy = wys.join('+');
  const z = `(1+${terms.reduce((a, e) => (a ? `max(${a},${e})` : e), '')})`;

  // zoompan can't zoom below 1.0, so it runs at the composite size and the
  // single downscale to the delivery size happens after it. At max zoom the
  // cropped region is ~compW/level wide, which lands near 1:1 with the output
  // instead of being blown up.
  // zoompan's x/y are in INPUT coordinates, not the zoom-scaled space.
  //
  // This was wrong from the first version and it explains every "the crop is
  // off to the right and shows backdrop" symptom since. `fx*iw*zoom - ow/2`
  // placed a crop that should have started at 823 at 1440 - ~600px off at 1.75x,
  // and worse the deeper the zoom. Verified against a marked canvas: with
  // fx=0.5 the centre pixel landed at 805 instead of 1920. The crop is
  // [x, x + ow/zoom] in input space, so centring it means subtracting HALF THE
  // CROP, not half the output.
  parts.push(
    `[flat]zoompan=z='${z}'`
    + `:x='max(0,min(((${wx})/max(${sum},0.0001))*iw-(ow/zoom)/2,iw-ow/zoom))'`
    + `:y='max(0,min(((${wy})/max(${sum},0.0001))*ih-(oh/zoom)/2,ih-oh/zoom))'`
    + `:d=1:s=${compW}x${compH}:fps=${fps}[zoomed]`,
    `[zoomed]scale=${outW}:${outH}:flags=lanczos[out]`);
  return parts.join(';');
}

export async function render({ shotDir, output, assetDir, fps = 30, crf = 15, ...opts }) {
  mkdirSync(assetDir, { recursive: true });
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const { width: srcW } = man;
  // The window manager's title bar, measured at capture time. It is cropped off
  // and macOS buttons go on the tab strip instead, so the window matches the
  // desktop behind it - everything downstream works on the TRIMMED height.
  const trimTop = opts.trimTop != null ? Number(opts.trimTop) : Number(man.deco?.top || 0);
  const macLights = opts.macLights !== false && trimTop > 0;
  // A real macOS title bar is a little taller than MATE's.
  const barH = macLights ? (Math.round(man.height * 0.0235) & ~1) : 0;
  const srcH = man.height - trimTop + barH;
  // Frames are device pixels, click coords are CSS pixels.
  const dsf = man.dsf ?? 1;
  const clicks = man.clicks.map((c) => ({ ...c, x: c.x * dsf, y: (c.y - trimTop + barH) * dsf }));
  const outW = opts.outW ?? srcW, outH = opts.outH ?? srcH;

  // mirror buildGraph's fit so the mask and shadow match the window exactly
  const _compW = even(srcW), _compH = even(Math.round(srcW * (outH / outW)));
  const _inset = opts.inset ?? 0.8;
  const _ar = srcW / srcH;
  let _w = _compW * _inset, _h = _w / _ar;
  if (_h > _compH * _inset) { _h = _compH * _inset; _w = _h * _ar; }
  const fgW = even(Math.round(_w));
  const fgH = even(Math.round(_h));
  // Padding, corner radius and shadow all scale with the capture, and all three
  // are bigger than they were. The reference look is a small window floating on
  // a lot of colour with a deep soft shadow - a 0.8 inset with a 22px blur reads
  // as a screenshot with a border, not as an object above a surface.
  const { mask, shadow, pad } = await makeAssets({
    dir: assetDir, w: fgW, h: fgH,
    radius: Math.round(26 * (srcW / 1920)), pad: Math.round(120 * (srcW / 1920)),
    shadowBlur: Math.round(62 * (srcW / 1920)), shadowDy: Math.round(34 * (srcW / 1920)),
    shadowAlpha: 150,
  });

  // chrome > cursor > raw: each pass writes a new dir rather than mutating the
  // capture, so any of them can be re-run without re-recording.
  const framesDir = existsSync(join(shotDir, 'frames-chrome'))
    ? join(shotDir, 'frames-chrome')
    : existsSync(join(shotDir, 'frames-cur'))
      ? join(shotDir, 'frames-cur') : join(shotDir, 'frames');

  // Backdrop. "auto" reads the recording's own brightness and picks a ground
  // that separates from it, rather than one that blends into it.
  let bgSpec = opts.bg ?? 'auto';
  const firstFrame = join(framesDir, `f${String(man.frames[0].i).padStart(5, '0')}.png`);
  if (bgSpec === 'auto') bgSpec = await pickBackdrop(firstFrame);
  const backdrop = bgSpec === 'blur' ? null
    : await makeBackdrop({
        dir: assetDir, w: even(srcW), h: even(Math.round(srcW * (outH / outW))), spec: bgSpec,
        treatBlur: opts.bgBlur ?? 0.0, treatSat: opts.bgSat ?? 1.0, treatDim: opts.bgDim2 ?? 1.0,
      });

  // concat with real per-frame durations so wall-clock timing survives.
  // The last frame is special: the screencast stops emitting once the page
  // stops repainting, so a held payoff has no frames behind it. `endMs` says
  // when capture actually ended - without it the hold is cut off entirely.
  const lastMs = man.frames[man.frames.length - 1].ms;
  const tailS = Math.max(1 / fps, ((man.endMs ?? lastMs) - lastMs) / 1000);
  const list = man.frames.map((f, i) => {
    const next = man.frames[i + 1];
    const d = next ? Math.max(0.008, (next.ms - f.ms) / 1000) : tailS;
    return `file '${join(framesDir, `f${String(f.i).padStart(5, '0')}.png`)}'\nduration ${d.toFixed(4)}`;
  });
  const last = man.frames[man.frames.length - 1];
  list.push(`file '${join(framesDir, `f${String(last.i).padStart(5, '0')}.png`)}'`);
  const lp = join(assetDir, 'frames.txt');
  writeFileSync(lp, list.join('\n'));

  // The edit decision list, when there is one, is the camera. It is a plain
  // file: change it and re-render, no recording involved.
  const edlPath = join(shotDir, 'edit.json');
  const edl = existsSync(edlPath) ? JSON.parse(readFileSync(edlPath, 'utf8')) : null;
  // Camera targets were solved against the untrimmed frame; shift them up by
  // the strip that is no longer there, or every push aims 32px low.
  if (edl && trimTop) {
    for (const c of edl.chains || []) for (const t of c.targets) t.rect = [t.rect[0], t.rect[1] - trimTop + barH, t.rect[2], t.rect[3]];
    for (const z of edl.zooms || []) if (z.rect) z.rect = [z.rect[0], z.rect[1] - trimTop + barH, z.rect[2], z.rect[3]];
  }
  const bar = macLights
    ? await makeTitleBar({ dir: assetDir, w: even(srcW), h: barH, frame: firstFrame, trimTop })
    : null;

  const graph = buildGraph({
    srcW, srcH, outW, outH, fps, clicks,
    pad, ...opts, trimTop, barH, macLights, backdrop, edl,
  });
  const gp = join(assetDir, 'graph.txt');
  writeFileSync(gp, graph);

  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-sws_flags', 'lanczos+accurate_rnd+full_chroma_int',
    '-f', 'concat', '-safe', '0', '-i', lp,
    '-i', mask, '-i', shadow,
    ...(backdrop ? ['-i', backdrop] : []),
    ...(bar ? ['-i', bar] : []),
    '-filter_complex_script', gp, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slower', '-crf', String(crf),
    '-x264-params', 'aq-mode=3:psy-rd=0.4:deblock=-1,-1',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
  await run('ffmpeg', args, { maxBuffer: 1 << 26 });
  return { output, srcW, srcH, outW, outH, frames: man.frames.length, clicks,
    backdrop: bgSpec, zooms: edl ? edl.zooms.length : clicks.length,
    moves: edl && edl.chains ? edl.chains.length : null, graphLength: graph.length };
}

/**
 * The three macOS window buttons, to be laid over the left of the tab strip.
 *
 * The container films a Linux window: a MATE title bar, then Chromium's tab
 * strip. Composited onto a macOS wallpaper the result is incoherent - a real
 * window, of the wrong operating system, and that mismatch is what reads as
 * fake even though nothing about it is drawn.
 *
 * On macOS the lights ARE the left of the tab strip; there is no separate bar.
 * So the WM bar is cropped away and these go where they belong. Same
 * measurements as the terminal chrome: 12pt across, 20pt apart, 20pt in.
 */
export async function makeTitleBar({ dir, w, h, frame, trimTop = 0 }) {
  const p = join(dir, `macbar-${w}x${h}.png`);
  if (existsSync(p)) return p;
  // Match the bar to the browser's own tab strip, sampled from the recording,
  // so it reads as one window rather than a strip glued on top.
  const py = `
from PIL import Image, ImageDraw
import statistics
src = Image.open(${JSON.stringify(frame)}).convert("RGB")
w, h = ${w}, ${h}
# The bar has to be INDISTINGUISHABLE from the tab strip below it. Chrome on
# macOS has no separate title bar at all - the tab strip is the title bar - so a
# slab in a slightly different grey reads as two stacked bars, which is exactly
# what it looked like. One sampled pixel landed on a gradient and came out 10
# levels dark; take the median of a band on the right, clear of the tabs.
y0 = ${trimTop} + int((src.height - ${trimTop}) * 0.004)
band = [src.getpixel((x, y))
        for y in range(y0 + 6, y0 + max(10, h // 2))
        for x in range(int(src.width * 0.62), int(src.width * 0.92), 7)]
bg = tuple(int(statistics.median([p[i] for p in band])) for i in range(3))
im = Image.new("RGB", (w, h), bg)
d = ImageDraw.Draw(im)
# A top highlight, and NO line at the bottom - there is no seam there on a real
# window because there is no join.
d.line([(0, 0), (w, 0)], fill=tuple(min(255, c + 10) for c in bg))
dia = h * 12 / 28.0
gap = h * 20 / 28.0
for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    cx = gap + i * gap
    cy = h / 2.0
    r = dia / 2.0
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col,
              outline=tuple(int(c * 0.82) for c in col), width=max(1, int(h * 0.014)))
im.save(${JSON.stringify(p)})`;
  await run('python3', ['-c', py]);
  return p;
}

export async function makeAssets({ dir, w, h, radius = 18, pad = 40, shadowAlpha = 110, shadowBlur = 22, shadowDy = 14 }) {
  mkdirSync(dir, { recursive: true });
  const mask = join(dir, `mask-${w}x${h}-${radius}.png`);
  const shadow = join(dir, `shadow-${w}x${h}-${radius}.png`);
  if (existsSync(mask) && existsSync(shadow)) return { mask, shadow, pad };
  const py = `
from PIL import Image, ImageDraw, ImageFilter
w,h,r,pad = ${w},${h},${radius},${pad}
m = Image.new('L',(w,h),0)
ImageDraw.Draw(m).rounded_rectangle([0,0,w-1,h-1], radius=r, fill=255)
Image.merge('RGBA',(m,m,m,m)).save(${JSON.stringify(mask)})
s = Image.new('RGBA',(w+pad*2,h+pad*2),(0,0,0,0))
ImageDraw.Draw(s).rounded_rectangle([pad,pad+${shadowDy},pad+w-1,pad+h-1+${shadowDy}], radius=r, fill=(0,0,0,${shadowAlpha}))
s.filter(ImageFilter.GaussianBlur(${shadowBlur})).save(${JSON.stringify(shadow)})
print('ok')`;
  await run('python3', ['-c', py]);
  return { mask, shadow, pad };
}
