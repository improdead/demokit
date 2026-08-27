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
  holdMs: 2200,          // how long a zoom stays at depth
  rampMs: 550,           // in and out
  padFrac: 0.55,         // extra room around the target rect, as a share of it
  changeFrac: 0.0025,    // pixels that must move for "something happened"
  lookBackMs: 3000,      // a result arrives before the beat that reports it
  lookFwdMs: 1400,
  maxZooms: 2,          // the version that read well had NO zoom; two is generous
  sceneFrac: 0.45,       // more of the frame than this changed = a scene change
  sceneArea: 0.45,       // a target covering more of the frame than this is not one
  chainGapMs: 4000,      // targets closer than this share one camera move.
                         // 8s let two beats 6.6s apart become a 7.8s held pan -
                         // long enough that the camera reads as stuck, not moving.
  minUseful: 1.25,       // below this a "zoom" is drift; stay still instead
  usefulFill: 0.55,      // target should span this much of the frame when framed
  preLeadMs: 350,        // start the move slightly before the target
  panMs: 420,            // ease between targets inside a chain
  hoverIntent: false,    // clicks and keystrokes only, unless asked otherwise
  minHoldMs: 900,        // never shorter than this once the camera has moved
  settleMs: 700,         // linger this long after the last thing that moved
  maxTargets: 3,
  mode: 'clicks',        // 'clicks' = one push per click; 'smart' = the full director
  clickZoom: 1.85,       // fixed depth, so every push reads the same
  clickHoldMs: 1500,     // in, hold, out
  zoomTyping: false,
  blankFrac: 0.45,       // below this share of the usual on-screen content = blank
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
out, inks, prev = [], [], None
sx = None
for f in picks:
    p = os.path.join(fdir, "f%05d.png" % f["i"])
    if not os.path.exists(p):
        continue
    cur = load(p)
    if sx is None:
        sx = man["width"] / cur.shape[1]
    # How much is actually ON this frame. A page mid-navigation is near-blank,
    # and a camera move that lands there pushes in on nothing.
    ink = float((np.abs(np.diff(cur, axis=0)) > 12).mean())
    inks.append({"t": f["ms"], "ink": ink})
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
print(json.dumps({"track": out, "ink": inks}))`;
  const { stdout } = await run('python3', ['-c', py], { maxBuffer: 1 << 28 });
  return JSON.parse(stdout);
}

/**
 * The simple camera: one push per CLICK, centred on the cursor, then out again.
 *
 * The elaborate version below - change detection, hover intent, chaining, scene
 * rejection - could always justify each individual zoom and still produced a
 * camera that felt arbitrary, because "defensible" and "legible" are not the
 * same thing. A viewer cannot see the reasoning; they see a camera that moves
 * when they clicked and is still the rest of the time. So: clicks only,
 * anchored on the pointer, one fixed depth.
 */
function directClicks(man, o) {
  const events = man.events || [];
  const path = man.path || [];
  const clicks = events.filter((e) => e.kind === 'click' || (o.zoomTyping && e.kind === 'type'));

  const chains = [];
  for (const e of clicks) {
    const last = chains.at(-1);
    if (last && e.t - last.targets[0].tMs < o.minGapMs) continue;   // no double push
    // Anchor on where the POINTER is, not on the element box - that is what the
    // viewer's eye follows, and it is what "focus on the cursor" means. Falls
    // back to the event's own coordinates when there is no pointer track, which
    // is the case for the container path: its cursor is real, so nothing logs a
    // synthetic one.
    const a = path.length ? cursorAnchor(path, e.t - 250, e.t + 250) : null;
    const cx = a ? a.x : e.x;
    const cy = a ? a.y : e.y;
    const halfW = Math.round(man.width / (2 * o.clickZoom));
    const halfH = Math.round(man.height / (2 * o.clickZoom));
    chains.push({
      startMs: Math.max(0, e.t - o.preLeadMs),
      endMs: e.t + o.clickHoldMs,
      reason: `click: ${e.label || 'element'}`,
      targets: [{
        tMs: e.t,
        rect: [cx - halfW, cy - halfH, halfW * 2, halfH * 2],
        z: o.clickZoom,
        reason: `click: ${e.label || 'element'}`,
        kind: 'click',
        cursorAnchor: a || undefined,
      }],
    });
  }
  return chains;
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

  // Simple mode is the default. The full director still exists behind --smart;
  // the machinery is sound, it just is not what a demo needs.
  if ((o.mode || 'clicks') === 'clicks') {
    const chains = directClicks(man, o);
    const edl = {
      source: shotDir, durationMs: endMs, mode: 'clicks',
      frame: { w: man.width, h: man.height },
      warnings: chains.length ? [] : ['no clicks in this take - the camera will not move'],
      chains, shallow: 0,
      zooms: chains.flatMap((c) => c.targets),
      rejected: events.filter((e) => e.kind !== 'click')
        .map((e) => ({ tMs: e.t, kind: e.kind, label: e.label })).slice(0, 40),
    };
    writeFileSync(join(shotDir, 'edit.json'), JSON.stringify(edl, null, 1));
    return edl;
  }

  const probe = await changeTrack(shotDir, man);
  const track = probe.track || probe;
  const inks = probe.ink || [];
  /** Fraction of the frame carrying content at time t (0 = blank page). */
  const inkAt = (t) => {
    if (!inks.length) return 1;
    let best = inks[0];
    for (const s of inks) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best.ink;
  };
  const inkMedian = inks.length
    ? inks.map((s) => s.ink).sort((a, b) => a - b)[Math.floor(inks.length / 2)] : 1;
  const changedNear = (t) => track.filter((s) => s.t - t >= -o.lookBackMs && s.t - t <= o.lookFwdMs);

  // ---- 1. every candidate must justify itself ------------------------------
  const cands = [];
  for (const e of events) {
    const near = changedNear(e.t);
    const peak = near.length ? near.reduce((a, b) => (b.frac > a.frac ? b : a)) : null;
    const moved = peak && peak.frac >= o.changeFrac;
    const acted = e.kind === 'click' || e.kind === 'type' || e.kind === 'drag';
    // A hover the flow AUTHOR wrote and labelled is intent - they said "look at
    // this". The zooms that felt random were never those; they were beats that
    // framed nothing and popped in and out. Framing and chaining fixed that, so
    // an authored hover is a reason. An unlabelled one still is not.
    const intended = e.kind === 'hover' && !!e.label && o.hoverIntent;

    if (!acted && !moved && !intended) continue;   // rule 1: a reason, or nothing

    // Do not frame a blank screen. Mid-navigation the page is nearly empty, and
    // a move that lands there is a confident push-in on nothing.
    if (inkAt(e.t) < inkMedian * o.blankFrac) {
      e.blank = true;
      continue;
    }

    // rule 2: a rect, not a point. Prefer the element we acted on; fall back to
    // the region of the screen that actually changed.
    let rect, why;
    if (e.w && e.h) {
      rect = [e.bx || e.x - e.w / 2, e.by || e.y - e.h / 2, e.w, e.h];
      why = `${e.kind}: ${e.label || 'element'}`;
      if (intended && !acted && !moved) why += ' (authored)';
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
      kind: e.kind,
      weight: (acted ? 100 : 0) + (intended ? 40 : 0) + (moved ? Math.min(20, peak.frac * 40) : 0),
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
    .slice().sort((a, b) => b.weight - a.weight).slice(0, o.maxTargets)
    .sort((a, b) => a.tMs - b.tMs);

  // ---- 2b. drop the ones that would barely magnify -------------------------
  //
  // A target that already fills half the frame solves to a ~1.1x push. That is
  // not a zoom, it is drift - and it costs a full in-and-out cycle for no gain.
  // Measured on a real take the camera moved 8 times in 30s, mostly by 7-15%:
  // always moving, never enough to see anything. Better to stay still.
  const frameW = man.width;
  const useful = kept.filter((z) => {
    const need = (o.usefulFill * frameW) / Math.max(1, z.rect[2]);
    if (need >= o.minUseful) return true;
    z.dropped = `would only magnify ${need.toFixed(2)}x`;
    return false;
  });
  const shallow = kept.length - useful.length;
  kept.length = 0;
  kept.push(...useful);

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
  /** Did anything move on screen between these two instants? */
  const activeBetween = (a, b) =>
    track.some((s) => s.t > a + 250 && s.t < b - 250 && s.frac >= o.changeFrac);

  const chains = [];
  for (const z of kept) {
    const last = chains.at(-1);
    const prev = last && last.targets.at(-1);
    // Chain only across time where something is HAPPENING. Holding a zoom over
    // a static gap is the worst kind of camera move: it is pushed in, nothing
    // is going on, and the viewer waits. Two targets 2.2s apart with a dead
    // screen between them are two moves, not one pan.
    const chainable = prev
      && z.tMs - prev.tMs <= o.chainGapMs
      && (z.tMs - prev.tMs <= o.panMs * 2.5 || activeBetween(prev.tMs, z.tMs));
    if (chainable) last.targets.push(z);
    else chains.push({ targets: [z] });
  }
  for (const c of chains) {
    c.startMs = Math.max(0, c.targets[0].tMs - o.preLeadMs);
    // End the hold shortly after the last thing that actually happened, not a
    // fixed time later - otherwise the camera sits pushed in on a still frame.
    const lastT = c.targets.at(-1).tMs;
    const lastActive = track.filter((s) => s.t >= lastT - 300 && s.t <= lastT + o.holdMs && s.frac >= o.changeFrac)
      .reduce((m, s) => Math.max(m, s.t), lastT);
    c.endMs = Math.min(lastT + o.holdMs, Math.max(lastActive + o.settleMs, lastT + o.minHoldMs));
    c.reason = c.targets.length === 1
      ? c.targets[0].reason
      : `${c.targets.length} targets: ` + c.targets.map((t) => t.reason.split(':')[1]?.trim() || t.kind).join(' -> ');
  }

  // A demo is things happening. Counting hovers as beats let a flow of four
  // hovers, one click and one keystroke pass as a demo - the camera moved five
  // times and the product did almost nothing. Say so loudly; it is a flow
  // problem and no render flag fixes it.
  const nAct = events.filter((e) => ['click', 'type', 'drag'].includes(e.kind)).length;
  const hovers = events.filter((e) => e.kind === 'hover').length;
  const warnings = [];
  if (nAct && hovers > nAct * 1.5) {
    warnings.push(`${hovers} hovers vs ${nAct} actions - this is a tour, not a demo. `
      + 'Replace hovers with clicks that change something.');
  }
  // A long stretch with nothing happening is a hole, and it is a FLOW problem -
  // pacing can compress it but cannot make it interesting.
  const times = events.map((e) => e.t).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > 20000) {
      warnings.push(`${((times[i] - times[i - 1]) / 1000).toFixed(0)}s with nothing happening `
        + `between ${(times[i - 1] / 1000).toFixed(0)}s and ${(times[i] / 1000).toFixed(0)}s `
        + '- a step probably did nothing. Check the log for STEP SKIPPED.');
    }
  }
  if (!nAct) {
    warnings.push('no clicks, keystrokes or drags at all - nothing happens in this take.');
  }

  const edl = {
    source: shotDir,
    warnings,
    durationMs: endMs,
    frame: { w: man.width, h: man.height },
    chains,
    shallow,
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
  if (edl.shallow) console.log(`  (${edl.shallow} target(s) dropped - too big to be worth magnifying)`);
  for (const w of edl.warnings || []) console.log(`  ! ${w}`);
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
      clickZoom: arg('zoom', DEFAULTS.clickZoom),
      mode: rest.includes('--smart') ? 'smart' : 'clicks',
    }));
  }
}
