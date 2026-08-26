#!/usr/bin/env node
/**
 * The director: decide the camera AFTER recording, from what happened.
 *
 *   node src/edit.mjs <shotDir>            # write edit.json and explain it
 *   node src/edit.mjs <shotDir> --print    # just show the current one
 *
 * Recording used to decide this. Every hover became a zoom anchor, committed
 * before a single frame existed, by whoever wrote the flow, blind - which is
 * why the camera moved for no reason and never quite framed the thing.
 *
 * Now recording emits events, and this pass produces an EDIT DECISION LIST:
 * an explicit, editable edit.json of zooms, each one carrying the reason it
 * exists and the RECTANGLE it must contain. A human or an agent can open that
 * file, change it, and re-render without recording again.
 *
 * Two rules it will not break:
 *
 *   1. A zoom needs a REASON. A click or a keystroke is a reason. A measured
 *      change on screen is a reason. A hover over something that did not react
 *      is not, and produces nothing.
 *   2. A zoom targets a RECT, not a point. The renderer solves for a crop that
 *      contains that rect, so "frame this element" is exact rather than a
 *      depth guess aimed at a coordinate.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

const DEFAULTS = {
  minGapMs: 1800,        // two zooms closer than this merge into one push
  holdMs: 1500,          // how long a zoom stays at depth
  rampMs: 550,           // in and out
  padFrac: 0.55,         // extra room around the target rect, as a share of it
  changeFrac: 0.0025,    // pixels that must move for "something happened"
  lookBackMs: 3000,      // a result arrives before the beat that reports it
  lookFwdMs: 1400,
  maxZooms: 6,
  sceneFrac: 0.45,       // more of the frame than this changed = a scene change
  sceneArea: 0.45,       // a target covering more of the frame than this is not one
  chainGapMs: 3200,      // targets closer than this share one camera move
  preLeadMs: 350,        // start the move slightly before the target
  panMs: 420,            // ease between targets inside a chain
};

/** Where the pointer actually was over a span - OpenScreen calls this the
 *  cursorAnchor, and it is the honest way to check a zoom is looking at
 *  something rather than trusting the number we computed. */
function cursorAnchor(path, fromMs, toMs) {
  const pts = path.filter((p) => p.t >= fromMs && p.t <= toMs);
  if (!pts.length) return null;
  const mid = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mx = mid(pts.map((p) => p.x)), my = mid(pts.map((p) => p.y));
  const spread = Math.round(Math.max(
    ...pts.map((p) => Math.hypot(p.x - mx, p.y - my)),
  ));
  return { x: mx, y: my, spread, samples: pts.length };
}

/** Per-sample change energy over the whole take, measured once. */
async function changeTrack(shotDir, man) {
  const py = `
import json, os, numpy as np
from PIL import Image
man = json.load(open(${JSON.stringify(join(shotDir, 'manifest.json'))}))
frames = man["frames"]
fdir = ${JSON.stringify(join(shotDir, 'frames'))}
span = (frames[-1]["ms"] - frames[0]["ms"]) or 1
stride = max(1, round(len(frames) / max(2, span / 1000 * 8)))
picks = frames[::stride]
def load(p):
    im = Image.open(p).convert("L")
    h = max(1, round(im.height * 320 / im.width))
    return np.asarray(im.resize((320, h)), dtype=np.float32)
out, prev = [], None
sx = None
for f in picks:
    p = os.path.join(fdir, "f%05d.png" % f["i"])
    if not os.path.exists(p):
        continue
    cur = load(p)
    if sx is None:
        sx = man["width"] / cur.shape[1]
    if prev is not None and prev.shape == cur.shape:
        d = np.abs(cur - prev)
        m = d > 14
        frac = float(m.mean())
        if frac > 0:
            ys, xs = np.nonzero(m)
            w = d[ys, xs]
            out.append({
                "t": f["ms"], "frac": frac,
                "x": float((xs * w).sum() / w.sum() * sx),
                "y": float((ys * w).sum() / w.sum() * sx),
                "x0": float(xs.min() * sx), "x1": float(xs.max() * sx),
                "y0": float(ys.min() * sx), "y1": float(ys.max() * sx),
            })
    prev = cur
print(json.dumps(out))`;
  const { stdout } = await run('python3', ['-c', py], { maxBuffer: 1 << 28 });
  return JSON.parse(stdout);
}

export async function direct(shotDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const manPath = join(shotDir, 'manifest.json');
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  // Older takes have no event stream. `actions` records real presses, so a beat
  // sitting on one was a click - which is better than calling everything a
  // hover and dropping every genuine action.
  const acts = man.actions || [];
  const events = man.events || (man.clicks || []).map((c) => ({
    ...c,
    // beatAfter marks the beat AFTER the step's dwell, so the press can be
    // seconds earlier. Look back far, forward barely.
    kind: acts.some((a) => (c.t - a.t) >= -700 && (c.t - a.t) <= 6000
      && (a.type === 'click' || a.type === 'down')) ? 'click' : 'hover',
  }));
  const path = man.path || [];
  const endMs = man.endMs || (man.frames.at(-1)?.ms ?? 0);

  const track = await changeTrack(shotDir, man);
  const changedNear = (t) => track.filter((s) => s.t - t >= -o.lookBackMs && s.t - t <= o.lookFwdMs);

  // ---- 1. every candidate must justify itself ------------------------------
  const cands = [];
  for (const e of events) {
    const near = changedNear(e.t);
    const peak = near.length ? near.reduce((a, b) => (b.frac > a.frac ? b : a)) : null;
    const moved = peak && peak.frac >= o.changeFrac;
    const acted = e.kind === 'click' || e.kind === 'type' || e.kind === 'drag';

    if (!acted && !moved) continue;      // rule 1: a hover that did nothing is not a reason

    // rule 2: a rect, not a point. Prefer the element we acted on; fall back to
    // the region of the screen that actually changed.
    let rect, why;
    if (e.w && e.h) {
      rect = [e.bx || e.x - e.w / 2, e.by || e.y - e.h / 2, e.w, e.h];
      why = `${e.kind}: ${e.label || 'element'}`;
      if (moved) why += ` (+${(peak.frac * 100).toFixed(1)}% of frame changed)`;
    } else if (moved) {
      rect = [peak.x0, peak.y0, Math.max(24, peak.x1 - peak.x0), Math.max(24, peak.y1 - peak.y0)];
      why = `change: ${(peak.frac * 100).toFixed(1)}% of frame`;
    } else continue;

    // A deliberate action outranks any amount of pixels moving. Otherwise a
    // page navigation - which changes almost everything - wins every slot and
    // the clicks that make the demo get pushed out.
    cands.push({
      tMs: e.t, rect: rect.map(Math.round), reason: why,
      kind: e.kind, weight: (acted ? 100 : 0) + (moved ? Math.min(20, peak.frac * 40) : 0),
    });
  }

  // changes nobody clicked for - a result arriving on its own is worth framing
  for (const s of track) {
    if (s.frac < o.changeFrac * 4) continue;
    if (s.frac > o.sceneFrac) continue;   // see below
    if (cands.some((c) => Math.abs(c.tMs - s.t) < o.minGapMs)) continue;
    cands.push({
      tMs: s.t,
      rect: [s.x0, s.y0, Math.max(24, s.x1 - s.x0), Math.max(24, s.y1 - s.y0)].map(Math.round),
      reason: `unprompted change: ${(s.frac * 100).toFixed(1)}% of frame`,
      kind: 'change', weight: Math.min(20, s.frac * 40),
    });
  }

  // A target bigger than the frame can hold is not a target. A page navigation
  // changes almost every pixel, so its "changed region" is the whole screen -
  // solving a crop that contains it gives zoom 1.0, a zoom that does nothing
  // while occupying a slot a real one could have used.
  const area = man.width * man.height;
  for (let i = cands.length - 1; i >= 0; i--) {
    const [, , w, h] = cands[i].rect;
    if (w * h > area * o.sceneArea && cands[i].kind === 'change') cands.splice(i, 1);
  }

  // ---- 2. merge and rank ---------------------------------------------------
  cands.sort((a, b) => a.tMs - b.tMs);
  const merged = [];
  for (const c of cands) {
    const last = merged.at(-1);
    if (last && c.tMs - last.tMs < o.minGapMs) {
      if (c.weight > last.weight) merged[merged.length - 1] = c;   // keep the stronger reason
      continue;
    }
    merged.push(c);
  }
  const kept = merged
    .slice().sort((a, b) => b.weight - a.weight).slice(0, o.maxZooms)
    .sort((a, b) => a.tMs - b.tMs);

  // ---- 3. annotate each with where the pointer really was ------------------
  for (const z of kept) {
    z.holdMs = o.holdMs;
    z.rampMs = o.rampMs;
    z.padFrac = o.padFrac;
    const a = cursorAnchor(path, z.tMs - 400, z.tMs + z.holdMs);
    if (a) {
      z.cursorAnchor = a;
      const [x, y, w, h] = z.rect;
      const inside = a.x >= x - w && a.x <= x + 2 * w && a.y >= y - h && a.y <= y + 2 * h;
      // Only a problem for a hover. A click that navigates re-measures its
      // target in the NEW layout while the pointer stays where it clicked, so
      // the distance there is expected, not a mistake.
      if (!inside && z.kind === 'hover') z.warn = 'pointer was not near this rect';
    }
  }

  // ---- 4. chain them ------------------------------------------------------
  //
  // Targets close together in time become ONE camera move: zoom in, pan between
  // them while staying in, zoom out. Treating each as its own push-and-release
  // is what makes the camera bob - it pops out to full frame and back for every
  // click, which reads as twitchy rather than deliberate. (The idea is
  // pagecast's; it calls them zoom chains.)
  const chains = [];
  for (const z of kept) {
    const last = chains.at(-1);
    if (last && z.tMs - last.targets.at(-1).tMs <= o.chainGapMs) last.targets.push(z);
    else chains.push({ targets: [z] });
  }
  for (const c of chains) {
    c.startMs = Math.max(0, c.targets[0].tMs - o.preLeadMs);
    c.endMs = c.targets.at(-1).tMs + o.holdMs;
    c.reason = c.targets.length === 1
      ? c.targets[0].reason
      : `${c.targets.length} targets: ` + c.targets.map((t) => t.reason.split(':')[1]?.trim() || t.kind).join(' -> ');
  }

  const edl = {
    source: shotDir,
    durationMs: endMs,
    frame: { w: man.width, h: man.height },
    chains,
    zooms: kept,
    // dropped candidates are kept so the decision is auditable, not silent
    rejected: events
      .filter((e) => !kept.some((k) => k.tMs === e.t))
      .map((e) => ({ tMs: e.t, kind: e.kind, label: e.label }))
      .slice(0, 40),
  };
  writeFileSync(join(shotDir, 'edit.json'), JSON.stringify(edl, null, 1));
  return edl;
}

function explain(edl) {
  const ch = edl.chains || [];
  console.log(`edit: ${ch.length} camera move(s) covering ${edl.zooms.length} target(s) over ${(edl.durationMs / 1000).toFixed(1)}s`);
  for (const c of ch) {
    console.log(`  ${(c.startMs / 1000).toFixed(1)}s-${(c.endMs / 1000).toFixed(1)}s  ${c.targets.length > 1 ? 'pan' : 'hold'}`);
    for (const z of c.targets) {
      const [x, y, w, h] = z.rect;
      console.log(`      ${(z.tMs / 1000).toFixed(1).padStart(6)}s  ${String(w).padStart(4)}x${String(h).padEnd(4)} at ${x},${y}  ${z.reason}`
        + (z.warn ? `  [!] ${z.warn}` : ''));
    }
  }
  const dropped = edl.rejected.filter((r) => r.kind === 'hover' || r.kind === 'beat');
  if (dropped.length) {
    console.log(`  ${dropped.length} event(s) produced no zoom (nothing changed):`);
    for (const r of dropped.slice(0, 6)) console.log(`    - ${(r.tMs / 1000).toFixed(1)}s ${r.label || r.kind}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shotDir, ...rest] = process.argv;
  if (!shotDir) { console.error('usage: edit.mjs <shotDir> [--print]'); process.exit(2); }
  if (rest.includes('--print')) {
    const p = join(shotDir, 'edit.json');
    if (!existsSync(p)) { console.error('no edit.json yet — run without --print'); process.exit(1); }
    explain(JSON.parse(readFileSync(p, 'utf8')));
  } else {
    const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? Number(rest[i + 1]) : d; };
    explain(await direct(shotDir, {
      maxZooms: arg('max', DEFAULTS.maxZooms),
      minGapMs: arg('gap', DEFAULTS.minGapMs),
      padFrac: arg('pad', DEFAULTS.padFrac),
    }));
  }
}
