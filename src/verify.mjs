#!/usr/bin/env node
/**
 * Did the FEATURE work? Not: did the camera behave.
 *
 *   node src/verify.mjs <shotDir> [out.mp4]
 *
 * Every other pass in here measures the film. review.mjs measures pace and
 * framing; critic.mjs measures whether a zoom contains the thing it zoomed to.
 * A demo can pass all of that while the product does nothing at all - the click
 * lands on a dead button, the filter filters nothing, the detail view was
 * already open. That take is geometrically perfect and worthless, and it is the
 * one failure watching-with-a-checklist reliably misses, because the checklist
 * is about the video.
 *
 * So this asks a different question for every step, three ways, and requires the
 * answers to agree:
 *
 *   1. DOM      the recorded before/after state either differs or it does not
 *   2. SOURCE   the pixels in the element's own region either moved or did not
 *   3. DELIVERED the change is visible in the finished mp4, at the right moment
 *
 * They fail in different directions. The DOM can change without rendering. The
 * pixels can move because a spinner spun. The delivered video can miss a real
 * change because the camera was somewhere else or the pace cut through it. One
 * of the three saying yes is not verification; it is a hint.
 *
 * Three outcomes, always: verified / failed / inconclusive. "I could not tell"
 * is a result, and collapsing it into "fine" is how a broken demo ships.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

// A change this small in a region is a cursor or a caret, not a feature.
// A change smaller than this share of the window is a caret, a spinner or a
// hover tint - not something a viewer registers as the product doing its job.
const T = { area: 0.004, region: 3.5, frame: 0.9 };

/** Source seconds -> seconds in the finished video, through the pace map. */
function timeMapper(shotDir) {
  const p = join(shotDir, 'pace.json');
  if (!existsSync(p)) return (t) => t;
  const { segments } = JSON.parse(readFileSync(p, 'utf8'));
  return (t) => {
    let out = 0;
    for (const s of segments) {
      if (t <= s.start) break;
      out += (Math.min(t, s.end) - s.start) / s.speed;
      if (t <= s.end) break;
    }
    return out;
  };
}

const frameAt = (man, ms) => {
  const fs = man.frames || [];
  if (!fs.length) return null;
  let best = fs[0];
  for (const f of fs) if (Math.abs(f.ms - ms) < Math.abs(best.ms - ms)) best = f;
  return best;
};

const framePath = (shotDir, f) =>
  join(shotDir, 'frames', 'f' + String(f.i).padStart(5, '0') + '.png');

/**
 * Pixel evidence, in one python pass so the images are decoded once.
 * Returns per-job region/frame diffs and writes a before|after strip that a
 * human or an agent has to actually look at.
 */
async function pixels(jobs, outDir) {
  const py = `
import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
jobs = json.load(open(sys.argv[1]))
try: F = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 16)
except Exception: F = None
out = []
for j in jobs:
    r = {"i": j["i"], "region": None, "frame": None, "strip": None}
    try:
        a = Image.open(j["a"]).convert("RGB"); b = Image.open(j["b"]).convert("RGB")
    except Exception as e:
        r["error"] = str(e)[:120]; out.append(r); continue
    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    an = np.asarray(a.convert("L"), dtype=float); bn = np.asarray(b.convert("L"), dtype=float)
    r["frame"] = round(float(np.abs(an - bn).mean()), 3)
    W, H = a.size
    x, y, w, h = j.get("rect") or [0, 0, 0, 0]
    # Pad the element box: a filter chip changes the LIST, not the chip. The
    # region that proves a feature worked is rarely the pixels under the cursor.
    pad = j.get("pad", 0)
    x0, y0 = max(0, int(x - pad)), max(0, int(y - pad))
    x1, y1 = min(W, int(x + w + pad)), min(H, int(y + h + pad))
    if x1 - x0 > 8 and y1 - y0 > 8:
        r["region"] = round(float(np.abs(an[y0:y1, x0:x1] - bn[y0:y1, x0:x1]).mean()), 3)
        r["regionBox"] = [x0, y0, x1 - x0, y1 - y0]
    # WHERE it changed, not just how much. A padded box around the element is a
    # guess - a filter chip changes the list, a search box changes the rows below
    # it - so measure the bounding box of the pixels that actually differ, and
    # let that be the answer to "did something happen, and was it worth filming".
    dm = np.abs(an - bn)
    mask = dm > 10
    frac = float(mask.mean())
    r["changedFrac"] = round(frac, 5)
    if frac > 0.0006:
        rows = np.nonzero(mask.any(axis=1))[0]; cols = np.nonzero(mask.any(axis=0))[0]
        r["changed"] = [int(cols.min()), int(rows.min()),
                        int(cols.max() - cols.min() + 1), int(rows.max() - rows.min() + 1)]
    if j.get("strip"):
        SW = 760
        sh = int(H * SW / W)
        panel = Image.new("RGB", (SW * 2 + 12, sh + 34), (12, 13, 17))
        for k, im in ((0, a), (1, b)):
            im2 = im.resize((SW, sh), Image.LANCZOS)
            d0 = ImageDraw.Draw(im2)
            sc = SW / W
            if r.get("changed"):
                bx = [int(v * sc) for v in r["changed"]]
                d0.rectangle([bx[0], bx[1], bx[0] + bx[2], bx[1] + bx[3]],
                             outline=(90, 230, 120), width=4)
            if j.get("rect"):
                ex = [int(v * sc) for v in j["rect"]]
                d0.rectangle([ex[0], ex[1], ex[0] + ex[2], ex[1] + ex[3]],
                             outline=(255, 90, 90), width=3)
            panel.paste(im2, (k * (SW + 12), 34))
        d = ImageDraw.Draw(panel)
        d.text((8, 9), j.get("title", "")[:150], fill=(235, 235, 240), font=F)
        d.text((SW + 20, 9), "after   red = what was clicked   green = what changed",
               fill=(150, 200, 150), font=F)
        panel.save(j["strip"]); r["strip"] = j["strip"]
    out.append(r)
print(json.dumps(out))`;
  // Not `input:` - execFile's async form has no such option, so the child sits
  // on a stdin that is never written and never closed, and the whole pass hangs.
  const jobFile = join(outDir, 'jobs.json');
  writeFileSync(jobFile, JSON.stringify(jobs));
  const { stdout } = await run('python3', ['-c', py, jobFile], { maxBuffer: 1 << 26 });
  return JSON.parse(stdout);
}

export async function verify(shotDir, mp4 = null) {
  const man = JSON.parse(readFileSync(join(shotDir, 'manifest.json'), 'utf8'));
  const proof = man.proof || [];
  const dir = join(shotDir, 'verify');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  if (!proof.length) {
    const pack = {
      outcome: 'inconclusive', steps: [],
      why: 'the capture recorded no per-step page state, so nothing here can say the product worked. '
         + 'Re-record with a flow whose steps carry `prove`, or accept that this take is unverified.',
    };
    writeFileSync(join(shotDir, 'verify.json'), JSON.stringify(pack, null, 1));
    return pack;
  }

  // 1 + 2: DOM evidence is already recorded; measure the source frames around
  // each action. `pad` is generous on purpose - see the note in the python.
  const pad = Math.round(Math.max(man.width || 1920, 1) * 0.22);
  const jobs = [];
  proof.forEach((p, i) => {
    const a = frameAt(man, p.tMs - 350);
    const b = frameAt(man, p.afterMs - 150);
    if (!a || !b || a.i === b.i) return;
    jobs.push({ i, a: framePath(shotDir, a), b: framePath(shotDir, b),
      rect: p.region, pad, strip: join(dir, `step-${i}-source.png`),
      title: `${i}. ${p.label}  (source ${(p.tMs / 1000).toFixed(1)}s -> ${(p.afterMs / 1000).toFixed(1)}s)` });
  });
  const src = jobs.length ? await pixels(jobs, dir) : [];
  const srcBy = new Map(src.map((r) => [r.i, r]));

  // 3: the same moments, in the video that actually ships - sampled where the
  // camera is AT REST.
  //
  // The first version of this compared frames across the push and reported
  // "yes, the viewer sees it happen" for a step whose product change was 1% of
  // the page: the 53-point frame difference it measured was the zoom, not the
  // feature. A moving camera makes every step look eventful. So find the camera
  // move that covers this step and sample outside it, at both ends.
  let delBy = new Map();
  let edl = null;
  try { edl = JSON.parse(readFileSync(join(shotDir, 'edit.json'), 'utf8')); } catch {}
  const restAround = (tMs, afterMs) => {
    let a = tMs - 500, b = afterMs + 500;
    for (const c of (edl?.chains) || []) {
      if (c.endMs < tMs - 1200 || c.startMs > afterMs + 1200) continue;
      a = Math.min(a, c.startMs - 550);
      b = Math.max(b, c.endMs + 700);
    }
    return [Math.max(0, a), b];
  };
  if (mp4 && existsSync(mp4)) {
    const toOut = timeMapper(shotDir);
    const shots = [];
    proof.forEach((p, i) => {
      const [ra, rb] = restAround(p.tMs, p.afterMs);
      const ta = Math.max(0.05, toOut(ra / 1000));
      const tb = toOut(rb / 1000);
      if (tb <= ta) return;
      shots.push({ i, ta, tb, secs: +(tb - ta).toFixed(2) });
    });
    const djobs = [];
    for (const s of shots) {
      const fa = join(dir, `d${s.i}a.png`), fb = join(dir, `d${s.i}b.png`);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', s.ta.toFixed(2), '-i', mp4,
        '-frames:v', '1', '-vf', 'scale=1280:-2', fa]).catch(() => {});
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', s.tb.toFixed(2), '-i', mp4,
        '-frames:v', '1', '-vf', 'scale=1280:-2', fb]).catch(() => {});
      if (existsSync(fa) && existsSync(fb)) {
        djobs.push({ i: s.i, a: fa, b: fb, rect: null, secs: s.secs,
          strip: join(dir, `step-${s.i}-delivered.png`),
          title: `${s.i}. ${proof[s.i].label}  (delivered, camera at rest, ${s.ta.toFixed(1)}s -> ${s.tb.toFixed(1)}s)` });
      }
    }
    const del = djobs.length ? await pixels(djobs, dir) : [];
    delBy = new Map(del.map((r, k) => [r.i, { ...r, secs: djobs[k].secs }]));
  }

  // Fold the three into one verdict per step.
  const steps = proof.map((p, i) => {
    const s = srcBy.get(i) || {}, d = delBy.get(i) || {};
    const dom = p.checks || [];
    const domFail = dom.filter((c) => c.ok === false);
    const domPass = dom.filter((c) => c.ok === true);
    const srcMoved = s.changedFrac != null ? s.changedFrac >= T.area : null;
    const delMoved = d.changedFrac != null ? d.changedFrac >= T.area : null;

    const ev = [];
    for (const c of dom) ev.push({ how: 'dom', ok: c.ok, check: c.check, detail: c.detail });
    if (srcMoved != null) ev.push({ how: 'source', ok: srcMoved, check: 'the screen actually changed',
      detail: `${(s.changedFrac * 100).toFixed(2)}% of the window differs`
        + (s.changed ? `, in a ${s.changed[2]}x${s.changed[3]} area at ${s.changed[0]},${s.changed[1]}`
                     : ' - no coherent area changed')
        + ` (>${(T.area * 100).toFixed(2)}% is a real change)` });
    if (delMoved != null) ev.push({ how: 'delivered', ok: delMoved,
      check: 'the finished cut shows the before and the after',
      detail: `${(d.changedFrac * 100).toFixed(2)}% of the frame differs between the two rest points`
        + `, ${d.secs ?? '?'}s of screen time` });
    if (p.expect) ev.push({ how: 'dom', ok: p.expect.ok, check: `"${p.expect.sel}" is visible`,
      detail: p.expect.ok ? 'appeared' : 'never appeared' });

    let verdict, why;
    if (domFail.length) {
      verdict = 'failed';
      why = domFail.map((c) => `${c.check}: ${c.detail}`).join('; ');
    } else if (p.expect && p.expect.ok === false) {
      verdict = 'failed'; why = `the step's own expectation never appeared: ${p.expect.sel}`;
    } else if (srcMoved === false) {
      verdict = 'failed';
      why = p.kind === 'hover'
        ? 'nothing on screen responded to the hover - this beat films a control that does not react'
        : 'nothing on screen changed at all - whatever the DOM says, the viewer sees this step do nothing';
    } else if (delMoved === false) {
      verdict = 'failed';
      why = 'it happened, and the finished cut does not show it - the camera was elsewhere, '
          + 'or the pace ran through the moment';
    } else if (srcMoved == null && !domPass.length) {
      verdict = 'inconclusive'; why = 'no usable evidence either way';
    } else if (p.kind === 'hover' && !domPass.length && srcMoved !== true) {
      verdict = 'inconclusive';
      why = 'a hover with no measurable effect - it may be filming a button that does nothing yet';
    } else {
      verdict = 'verified';
      why = [domPass.length ? `${domPass.length} state check(s)` : null,
        srcMoved ? 'pixels moved in the region' : null,
        delMoved ? 'and it is visible in the cut' : null].filter(Boolean).join(', ');
    }

    return {
      i, label: p.label, kind: p.kind,
      atSec: +(p.tMs / 1000).toFixed(2),
      shows: p.shows || null,
      verdict, why, evidence: ev,
      strips: [s.strip, d.strip].filter(Boolean),
      state: { before: { url: p.before?.url, rows: p.before?.rows, chars: p.before?.chars },
               after: { url: p.after?.url, rows: p.after?.rows, chars: p.after?.chars } },
    };
  });

  const failed = steps.filter((s) => s.verdict === 'failed');
  const incon = steps.filter((s) => s.verdict === 'inconclusive');
  const pack = {
    video: mp4 || null,
    claim: man.claim || null,
    outcome: failed.length ? 'failed' : (incon.length ? 'inconclusive' : 'verified'),
    counts: { verified: steps.length - failed.length - incon.length,
              failed: failed.length, inconclusive: incon.length },
    steps,
    // The part a checklist cannot do. Answering these is the job.
    think: [
      'Does the sequence of after-states tell the story the claim makes, or only touch its parts?',
      'Is there a step whose evidence is real but whose PAYOFF is off-screen or never opened?',
      'Which step would a sceptic say proves nothing, and are they right?',
      'If a step is inconclusive, what would have to be recorded to settle it?',
    ],
  };
  writeFileSync(join(shotDir, 'verify.json'), JSON.stringify(pack, null, 1));
  return pack;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, mp4] = process.argv;
  if (!shotDir) { console.error('usage: verify.mjs <shotDir> [out.mp4]'); process.exit(2); }
  const p = await verify(shotDir, mp4 || null);
  if (p.claim) console.log(`claim: ${p.claim}\n`);
  for (const s of p.steps) {
    const tag = { verified: 'VERIFIED', failed: 'FAILED  ', inconclusive: 'UNCLEAR ' }[s.verdict];
    console.log(`  ${tag} ${String(s.atSec).padStart(6)}s  ${s.label}`);
    console.log(`            ${s.why}`);
    for (const e of s.evidence) {
      console.log(`            [${e.how}] ${e.ok === true ? 'yes' : e.ok === false ? 'NO ' : '?  '} ${e.check} - ${e.detail}`);
    }
    for (const f of s.strips) console.log(`            look: ${f}`);
  }
  if (!p.steps.length) console.log('  ' + (p.why || 'nothing to verify'));
  console.log(`\n  outcome: ${p.outcome}  (${JSON.stringify(p.counts || {})})`);
  console.log('\n  then think, because the numbers above cannot:');
  for (const q of p.think || []) console.log('    - ' + q);
  process.exit(p.outcome === 'failed' ? 2 : 0);
}
