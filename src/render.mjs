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

export function buildGraph({
  srcW, srcH, outW, outH, fps, clicks, rippleCount, cursorH,
  // Composite at capture resolution. Building at 1080p and letting zoompan
  // upscale 1.35x throws away the 2560 capture at exactly the moment the
  // viewer is looking closest. Instead we crop from the full-res canvas and
  // downscale ONCE, at the end.
  inset = 0.8, level = 1.4, ramp = 0.55, hold = 0.9, centerBias = 0.4, minGapMs = 1500,
  blurSigma = 46, bgDim = 0.06, bgSat = 0.85, pad, rippleSize,
}) {
  const parts = [];
  // Cursor and click pulses are already composited into the frames by
  // src/cursor.py - it interpolates the dense pointer path per frame, which an
  // ffmpeg overlay expression cannot do without encoding hundreds of samples.
  parts.push(`[0:v]fps=${fps}[withcur]`);

  // ---- frame composite (at capture resolution) -----------------------------
  const compW = srcW, compH = srcH;
  const fgW = even(Math.round(compW * inset));
  const fgH = even(Math.round(fgW * (srcH / srcW)));
  const ox = Math.round((compW - fgW) / 2);
  const oy = Math.round((compH - fgH) / 2);
  const M = 1, S = 2; // inputs: 0 frames, 1 mask, 2 shadow

  parts.push(
    `[withcur]split=2[fga_src][bg_src]`,
    `[bg_src]scale=${compW}:${compH}:force_original_aspect_ratio=increase,crop=${compW}:${compH},` +
      `gblur=sigma=${Math.round(blurSigma * (compW / 1920))},eq=brightness=-${bgDim}:saturation=${bgSat}[bg]`,
    `[fga_src]scale=${fgW}:${fgH}:flags=lanczos[fgs]`,
    `[${M}:v]scale=${fgW}:${fgH}[mk]`,
    `[fgs][mk]alphamerge[fga]`,
    `[bg][${S}:v]overlay=${ox - pad}:${oy - pad}[bgs]`,
    `[bgs][fga]overlay=${ox}:${oy}[flat]`,
  );

  // ---- zoom ----------------------------------------------------------------
  const kept = [];
  for (const c of clicks) {
    if (!kept.length || c.t - kept[kept.length - 1].t >= minGapMs) kept.push(c);
  }
  if (!kept.length) {
    parts.push(`[flat]scale=${outW}:${outH}:flags=lanczos[out]`);
    return parts.join(';');
  }

  const sx = fgW / srcW, sy = fgH / srcH;
  const tv = `(in/${fps})`;
  const envs = kept.map((c) => {
    const half = ramp + hold / 2, at = c.t / 1000;
    const lin = `clip(min(min((${tv}-${(at - half).toFixed(4)})/${ramp},(${(at + half).toFixed(4)}-${tv})/${ramp}),1),0,1)`;
    return `(3*pow(${lin},2)-2*pow(${lin},3))`;
  });
  const envMax = envs.reduce((a, e) => (a ? `max(${a},${e})` : e), '');
  const sum = envs.map((e) => `(${e})`).join('+');
  const bias = (v) => (v * (1 - centerBias) + 0.5 * centerBias).toFixed(5);
  const wx = kept.map((c, i) => `(${envs[i]})*${bias((ox + c.x * sx) / compW)}`).join('+');
  const wy = kept.map((c, i) => `(${envs[i]})*${bias((oy + c.y * sy) / compH)}`).join('+');
  const z = `(1+(${level}-1)*(${envMax}))`;

  // zoompan can't zoom below 1.0, so it runs at the composite size and the
  // single downscale to the delivery size happens after it. At max zoom the
  // cropped region is ~compW/level wide, which lands near 1:1 with the output
  // instead of being blown up.
  parts.push(
    `[flat]zoompan=z='${z}'` +
    `:x='max(0,min(((${wx})/max(${sum},0.0001))*iw*zoom-ow/2,iw*zoom-ow))'` +
    `:y='max(0,min(((${wy})/max(${sum},0.0001))*ih*zoom-oh/2,ih*zoom-oh))'` +
    `:d=1:s=${compW}x${compH}:fps=${fps}[zoomed]`,
    `[zoomed]scale=${outW}:${outH}:flags=lanczos[out]`);
  return parts.join(';');
}

export async function render({ shotDir, output, assetDir, fps = 30, crf = 15, ...opts }) {
  mkdirSync(assetDir, { recursive: true });
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const { width: srcW, height: srcH } = man;
  // Frames are device pixels, click coords are CSS pixels.
  const dsf = man.dsf ?? 1;
  const clicks = man.clicks.map((c) => ({ ...c, x: c.x * dsf, y: c.y * dsf }));
  const outW = opts.outW ?? srcW, outH = opts.outH ?? srcH;

  const fgW = even(Math.round(srcW * (opts.inset ?? 0.8)));
  const fgH = even(Math.round(fgW * (srcH / srcW)));
  const { mask, shadow, pad } = await makeAssets({
    dir: assetDir, w: fgW, h: fgH,
    radius: Math.round(18 * (srcW / 1920)), pad: Math.round(40 * (srcW / 1920)),
    shadowBlur: Math.round(22 * (srcW / 1920)), shadowDy: Math.round(14 * (srcW / 1920)),
  });

  // prefer the cursor-composited frames when the cursor pass has run
  const framesDir = existsSync(join(shotDir, 'frames-cur'))
    ? join(shotDir, 'frames-cur') : join(shotDir, 'frames');

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

  const graph = buildGraph({
    srcW, srcH, outW, outH, fps, clicks,
    pad, ...opts,
  });
  const gp = join(assetDir, 'graph.txt');
  writeFileSync(gp, graph);

  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-sws_flags', 'lanczos+accurate_rnd+full_chroma_int',
    '-f', 'concat', '-safe', '0', '-i', lp,
    '-i', mask, '-i', shadow,
    '-filter_complex_script', gp, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slower', '-crf', String(crf),
    '-x264-params', 'aq-mode=3:psy-rd=0.4:deblock=-1,-1',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
  await run('ffmpeg', args, { maxBuffer: 1 << 26 });
  return { output, srcW, srcH, outW, outH, frames: man.frames.length, clicks, graphLength: graph.length };
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
