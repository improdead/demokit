/**
 * Composite a raw screen recording into a framed, edited-looking demo.
 *
 * The look, matching what Screen Studio produces:
 *   - the recording sits INSET (~80%), so at rest it reads as a window on a
 *     desk rather than a permanently zoomed-in screen
 *   - rounded corners and a soft drop shadow under it
 *   - behind it, a blown-up, heavily blurred, slightly darkened copy of itself
 *   - the click zoom pushes into the whole composite, so the backdrop and
 *     corners scale with the content
 *
 * Zoom easing is smoothstep. A linear ramp is what makes a zoom feel
 * mechanical - it starts and stops abruptly at both ends.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

export async function probe(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', path]);
  const s = JSON.parse(stdout).streams[0];
  const [n, d] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, fps: d ? n / d : n };
}

/** Rounded-corner alpha mask + a blurred drop shadow, drawn with PIL. */
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
s = s.filter(ImageFilter.GaussianBlur(${shadowBlur}))
s.save(${JSON.stringify(shadow)})
print('ok')
`;
  await run('python3', ['-c', py]);
  return { mask, shadow, pad };
}

const clamp01 = (s) => `clip(${s},0,1)`;
/** smoothstep(e) = 3e^2 - 2e^3, applied to a linear 0..1 ramp */
const smooth = (e) => `(3*pow(${e},2)-2*pow(${e},3))`;

/**
 * Per-click trapezoid envelope, eased. ffmpeg's min() is BINARY - a three-arg
 * min() fails filter config with "Failed to configure output pad".
 */
function envelope(t, atSec, ramp, hold) {
  const half = ramp + hold / 2;
  const a = (atSec - half).toFixed(4);
  const b = (atSec + half).toFixed(4);
  const lin = clamp01(`min(min((${t}-${a})/${ramp},(${b}-${t})/${ramp}),1)`);
  return smooth(lin);
}

export function buildGraph({
  srcW, srcH, outW, outH, fps, clicks,
  inset = 0.8, level = 1.4, ramp = 0.55, hold = 0.9, centerBias = 0.4, minGapMs = 1500,
  blurSigma = 46, bgDim = 0.06, bgSat = 0.85, pad,
}) {
  const fgW = even(Math.round(outW * inset));
  const fgH = even(Math.round(fgW * (srcH / srcW)));
  const ox = Math.round((outW - fgW) / 2);
  const oy = Math.round((outH - fgH) / 2);

  const parts = [
    `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
      `gblur=sigma=${blurSigma},eq=brightness=-${bgDim}:saturation=${bgSat}[bg]`,
    `[0:v]scale=${fgW}:${fgH}[fgs]`,
    `[1:v]scale=${fgW}:${fgH}[mk]`,
    `[fgs][mk]alphamerge[fga]`,
    `[bg][2:v]overlay=${ox - pad}:${oy - pad}[bgs]`,
    `[bgs][fga]overlay=${ox}:${oy}[flat]`,
  ];

  if (!clicks.length) {
    parts.push(`[flat]null[out]`);
    return { graph: parts.join(';'), fgW, fgH, ox, oy };
  }

  // Click points are in PAGE space; map them into the composited frame.
  const sx = fgW / srcW, sy = fgH / srcH;
  const t = `(in/${fps})`;

  // Clicks closer together than minGapMs collapse into one zoom. Zooming on
  // every click in a rapid sequence yields one continuous push with no rest
  // state, which is what makes a demo read as "permanently zoomed in".
  const kept = [];
  for (const c of clicks) {
    if (!kept.length || c.atMs - kept[kept.length - 1].atMs >= minGapMs) kept.push(c);
  }
  clicks = kept;

  const envs = clicks.map((c) => envelope(t, c.atMs / 1000, ramp, hold));
  const envMax = envs.reduce((acc, e) => (acc ? `max(${acc},${e})` : e), '');
  const sum = envs.map((e) => `(${e})`).join('+');
  // Pull each target toward frame centre so an edge click doesn't shove the
  // window out of frame.
  const bx = (v) => (v * (1 - centerBias) + 0.5 * centerBias).toFixed(5);
  const wx = clicks.map((c, i) => `(${envs[i]})*${bx((ox + c.x * sx) / outW)}`).join('+');
  const wy = clicks.map((c, i) => `(${envs[i]})*${bx((oy + c.y * sy) / outH)}`).join('+');
  const cx = `((${wx})/max(${sum},0.0001))`;
  const cy = `((${wy})/max(${sum},0.0001))`;
  const z = `(1+(${level}-1)*(${envMax}))`;

  parts.push(
    `[flat]zoompan=z='${z}'` +
      `:x='max(0,min((${cx})*iw*zoom-ow/2,iw*zoom-ow))'` +
      `:y='max(0,min((${cy})*ih*zoom-oh/2,ih*zoom-oh))'` +
      `:d=1:s=${outW}x${outH}:fps=${fps}[out]`,
  );
  return { graph: parts.join(';'), fgW, fgH, ox, oy };
}

const even = (v) => (v % 2 ? v + 1 : v);

export async function compose({ input, output, clicks = [], assetDir, outW, outH, crf = 18, ...opts }) {
  const v = await probe(input);
  const W = outW ?? v.width, H = outH ?? v.height;
  const fgW = even(Math.round(W * (opts.inset ?? 0.8)));
  const fgH = even(Math.round(fgW * (v.height / v.width)));
  const { mask, shadow, pad } = await makeAssets({ dir: assetDir, w: fgW, h: fgH });

  const { graph } = buildGraph({ srcW: v.width, srcH: v.height, outW: W, outH: H, fps: v.fps, clicks, pad, ...opts });
  const gp = join(assetDir, `graph-${Date.now()}.txt`);
  writeFileSync(gp, graph);

  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', input, '-i', mask, '-i', shadow,
    '-filter_complex_script', gp, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { maxBuffer: 1 << 26 });
  return { output, ...v, graphLength: graph.length };
}
