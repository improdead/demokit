#!/usr/bin/env node
/**
 * Show an agent the RAW recording, before anything was decided about it.
 *
 *   node src/raw.mjs <shotDir> [--n 12] [--out sheet.png]
 *
 * Every other review surface in here looks at the FINISHED video, or at frames
 * chosen from the edit. Both inherit the edit's opinion: critic.mjs samples
 * "before / peak / after" for each camera move, so a camera move that should
 * never have existed still gets three frames devoted to it, and a stretch the
 * director ignored gets none.
 *
 * This is the take with no opinion applied. Frames evenly across the source,
 * each labelled with its source timestamp, whether the screen was frozen there,
 * and which step of the flow was running - so the question "what did we
 * actually record" can be answered by looking rather than by trusting the
 * pipeline that produced the answer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stillness } from './still.mjs';

const run = promisify(execFile);

export async function rawSheet(shotDir, { n = 12, out = null } = {}) {
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const frames = man.frames || [];
  if (!frames.length) throw new Error('no frames in this shot');
  const dir = existsSync(join(shotDir, 'frames-chrome')) ? 'frames-chrome'
    : existsSync(join(shotDir, 'frames-cur')) ? 'frames-cur' : 'frames';

  const { spans } = await stillness(shotDir, { minSec: 3 }).catch(() => ({ spans: [] }));
  const frozenAt = (ms) => spans.find((s) => ms >= s.from && ms <= s.to);
  const events = (man.events || []).slice().sort((a, b) => a.t - b.t);
  const stepAt = (ms) => {
    let cur = null;
    for (const e of events) if ((e.at ?? e.t) <= ms) cur = e;
    return cur;
  };

  const last = frames.at(-1).ms;
  const picks = [];
  for (let k = 0; k < n; k++) {
    const ms = Math.round((last * k) / Math.max(1, n - 1));
    const f = frames.reduce((b, x) => (Math.abs(x.ms - ms) < Math.abs(b.ms - ms) ? x : b), frames[0]);
    const fz = frozenAt(f.ms);
    const st = stepAt(f.ms);
    picks.push({
      ms: f.ms, file: join(shotDir, dir, `f${String(f.i).padStart(5, '0')}.png`),
      frozen: !!fz,
      label: `${(f.ms / 1000).toFixed(1)}s`
        + (fz ? `  FROZEN ${( (fz.to - fz.from) / 1000).toFixed(1)}s` : '')
        + (st ? `  after: ${st.label}` : '  (before any step)'),
    });
  }

  const sheet = out || join(shotDir, 'raw-sheet.png');
  mkdirSync(join(shotDir), { recursive: true });
  const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
picks = json.load(open(sys.argv[1]))
out = sys.argv[2]
try: F = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 19)
except Exception: F = None
COLS = 3
W = 620
rows = (len(picks) + COLS - 1) // COLS
im0 = Image.open(picks[0]["file"])
H = int(W * im0.height / im0.width)
sheet = Image.new("RGB", (COLS * W, rows * (H + 30)), (12, 13, 17))
d = ImageDraw.Draw(sheet)
for i, p in enumerate(picks):
    x = (i % COLS) * W
    y = (i // COLS) * (H + 30)
    sheet.paste(Image.open(p["file"]).resize((W, H), Image.LANCZOS), (x, y + 30))
    d.text((x + 8, y + 6), p["label"][:70],
           fill=(255, 140, 140) if p["frozen"] else (200, 210, 220), font=F)
sheet.save(out)`;
  const spec = join(shotDir, 'raw-picks.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(spec, JSON.stringify(picks));
  await run('python3', ['-c', py, spec, sheet], { maxBuffer: 1 << 26 });
  return { sheet, picks, spans, durationSec: last / 1000 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, ...rest] = process.argv;
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  if (!shotDir) { console.error('usage: raw.mjs <shotDir> [--n 12]'); process.exit(2); }
  const r = await rawSheet(shotDir, { n: Number(arg('n', '12')), out: arg('out', null) });
  const frozen = r.spans.reduce((a, s) => a + (s.to - s.from), 0) / 1000;
  console.log(`raw take: ${r.durationSec.toFixed(1)}s, `
    + `${frozen.toFixed(1)}s of it frozen (${(frozen / r.durationSec * 100).toFixed(0)}%)`);
  for (const s of r.spans) {
    console.log(`  frozen ${(s.from / 1000).toFixed(1)}s -> ${(s.to / 1000).toFixed(1)}s`);
  }
  console.log(`\n  LOOK AT: ${r.sheet}`);
  console.log('  This is the take with no edit applied. If it is boring here, no camera fixes it.');
}
