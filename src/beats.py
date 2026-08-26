#!/usr/bin/env python3
"""
Find beats by watching what CHANGES on screen, instead of only where a cursor
clicked.

A click is a good beat when there is a cursor to log. There often isn't:
a terminal printing output, a chart redrawing, a build finishing, a desktop
recording where nothing is driving the mouse. In all of those the interesting
moment is a region of pixels changing, and that region is exactly what the zoom
should push into.

    python3 src/beats.py <shotDir> [--max 6] [--gap 1800] [--merge]

Writes `autoBeats` into the manifest. With --merge they replace `clicks`, which
is what the renderer zooms on.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ANALYSIS_W = 320          # everything is measured at this width, then scaled up
DIFF_THRESH = 14          # per-pixel 0-255 delta that counts as "changed"
MIN_FRAC = 0.0006         # ignore specks: <0.06% of the frame is noise
SCENE_FRAC = 0.55         # >55% changed is a scene change, not a thing to zoom


def load(path, w):
    im = Image.open(path).convert("L")
    h = max(1, round(im.height * w / im.width))
    return np.asarray(im.resize((w, h), Image.BILINEAR), dtype=np.float32), im.size


def main():
    shot = sys.argv[1]
    argv = sys.argv[2:]

    def opt(name, default):
        return argv[argv.index(name) + 1] if name in argv else default

    max_beats = int(opt("--max", 6))
    min_gap = float(opt("--gap", 1800))
    merge = "--merge" in argv
    augment = "--augment" in argv
    prune = "--prune" in argv
    prune_back = float(opt("--prune-back", 3000))    # beatAfter puts the beat
    prune_fwd = float(opt("--prune-fwd", 1200))      # after the change
    prune_frac = float(opt("--prune-frac", 0.002))

    man = json.load(open(os.path.join(shot, "manifest.json")))
    frames = man["frames"]
    if len(frames) < 3:
        print("beats: too few frames")
        return

    fdir = os.path.join(shot, "frames")
    # Analyse at ~8fps regardless of capture rate: fine enough to catch a beat,
    # coarse enough that a 60s take doesn't take a minute to scan.
    span = frames[-1]["ms"] - frames[0]["ms"] or 1
    stride = max(1, round(len(frames) / max(2, span / 1000 * 8)))
    picks = frames[::stride]

    prev, full = load(os.path.join(fdir, f"f{picks[0]['i']:05d}.png"), ANALYSIS_W)
    scale = full[0] / prev.shape[1]

    samples = []   # (ms, energy, cx, cy, frac)
    for f in picks[1:]:
        p = os.path.join(fdir, f"f{f['i']:05d}.png")
        if not os.path.exists(p):
            continue
        cur, _ = load(p, ANALYSIS_W)
        if cur.shape != prev.shape:
            prev = cur
            continue
        d = np.abs(cur - prev)
        mask = d > DIFF_THRESH
        frac = mask.mean()
        if MIN_FRAC < frac < SCENE_FRAC:
            ys, xs = np.nonzero(mask)
            wgt = d[ys, xs]
            cx = float((xs * wgt).sum() / wgt.sum())
            cy = float((ys * wgt).sum() / wgt.sum())
            samples.append((f["ms"], float(d[mask].sum()), cx, cy, float(frac)))
        prev = cur

    if not samples:
        print("beats: nothing changed enough to be a beat")
        return

    # Cluster in time: a single UI transition spans several sampled frames, and
    # each one should not become its own zoom.
    clusters, cur_c = [], [samples[0]]
    for s in samples[1:]:
        if s[0] - cur_c[-1][0] <= min_gap * 0.55:
            cur_c.append(s)
        else:
            clusters.append(cur_c)
            cur_c = [s]
    clusters.append(cur_c)

    beats = []
    for c in clusters:
        energy = sum(s[1] for s in c)
        peak = max(c, key=lambda s: s[1])
        # Position from the energy-weighted centroid of the whole cluster, so a
        # panel that fills in over 400ms is framed by where it ENDED UP.
        tot = energy or 1.0
        cx = sum(s[2] * s[1] for s in c) / tot
        cy = sum(s[3] * s[1] for s in c) / tot
        beats.append({
            "x": round(cx * scale), "y": round(cy * scale),
            "t": int(peak[0]), "energy": round(energy),
            "label": f"change {round(max(s[4] for s in c) * 100)}% of frame",
        })

    beats.sort(key=lambda b: -b["energy"])
    kept = []
    for b in beats:
        if all(abs(b["t"] - k["t"]) >= min_gap for k in kept):
            kept.append(b)
        if len(kept) >= max_beats:
            break
    kept.sort(key=lambda b: b["t"])

    if prune:
        # Drop beats where nothing actually happened.
        #
        # A hover marks a beat, so the zoom pushes in at a moment the screen is
        # identical before and after - which is the single biggest reason the
        # zoom reads as arbitrary. Keep a click beat only if some pixels near it
        # changed within a window around it. The LAST beat is always kept: it is
        # the payoff hold, and resting on an unchanged result is the point.
        clicks = man.get("clicks", [])
        if clicks:
            live, dropped = [], []
            for n_, c in enumerate(clicks):
                if n_ == len(clicks) - 1:
                    live.append(c)
                    continue
                near = [sm for sm in samples if -prune_back <= sm[0] - c["t"] <= prune_fwd]
                if near and max(sm[4] for sm in near) >= prune_frac:
                    live.append(c)
                else:
                    dropped.append(c)
            # Never gut a demo: pruning more than a third of the beats means the
            # detector is wrong about this take, not that the take is wrong.
            if dropped and len(live) >= 2 and len(dropped) <= max(1, len(clicks) // 3):
                man["clicks"] = live
                print(f"beats: pruned {len(dropped)} beat(s) where nothing changed:")
                for c in dropped:
                    print(f"  - {c['t'] / 1000:.1f}s  {c.get('label', '')}")
            elif dropped:
                print(f"beats: {len(dropped)} beat(s) look static but too few would remain; kept all")

    man["autoBeats"] = kept
    slim = [{k: b[k] for k in ("x", "y", "t", "label")} for b in kept]
    if augment:
        # Keep the click beats and add only the changes that happened away from
        # them - a change right on a click is that click, not a second beat.
        existing = man.get("clicks", [])
        extra = [b for b in slim if all(abs(b["t"] - c["t"]) >= min_gap for c in existing)]
        man["clicks"] = sorted(existing + extra, key=lambda c: c["t"])
        print(f"beats: augmented {len(existing)} click beats with {len(extra)} change beats")
    elif merge:
        man["clicks"] = slim
    json.dump(man, open(os.path.join(shot, "manifest.json"), "w"), indent=1)

    print(f"beats: {len(samples)} changed samples -> {len(clusters)} clusters -> {len(kept)} beats"
          + (" (merged into clicks)" if merge and not augment else ""))
    for b in kept:
        print(f"  {b['t'] / 1000:6.1f}s  ({b['x']:5d},{b['y']:5d})  {b['label']}")


if __name__ == "__main__":
    main()
