#!/usr/bin/env python3
"""
Render a take the way Cap renders one.

    python3 src/caprender.py <shotDir> <out.mp4> [--w 3840 --h 2160 --fps 30]
                             [--config .cache/cap/project-config.json]
                             [--assets .cache/cap]

Everything the ffmpeg compositor approximated, this does the way Cap's
`crates/rendering` does it, because the reference video the user recorded WITH
Cap is what "good" means here and every attempt to approximate it was rejected:

  zoom segments   generate_zoom_segments_from_clicks_impl  (verified to the ms
                  against the segments Cap wrote into that recording's own
                  project-config.json - both mouse DOWN and UP events matter)
  zoom motion     two spring-mass-dampers (centre, and amount+activity) stepped
                  at 8ms with the project's screenMovementSpring, CENTER_PREAIM
                  while the amount sits at identity, amount clamped >= 1
  focus           greedy cursor clusters, 50% x 70% of the visible viewport,
                  mapped through calculate_follow_center (edge snap 1/(2*amount)
                  makes travel space the identity - see SKILL.md 8a)
  cursor          shake filter, 60fps decimation, a 60Hz spring with the
                  profile's own lag fed forward, click look-ahead (target snaps
                  to the click 500ms out), a stiffer spring 175ms before a
                  click, hold across idle gaps, the recorded SHAPE per sample,
                  click shrink to 0.8 over 130ms, sized as cursor_height_px
  frame           the display scales over a FIXED wallpaper (Cap does not zoom
                  the background), padding = 10/100 * 0.4 of the long axis,
                  squircle corners (superellipse power 4) at 7.5% of half the
                  short axis, the composite shader's shadow: size 14.4% and
                  blur 3.8% of the card's half short axis times strength 0.736,
                  opacity 0.736 * 0.681, smoothstep falloff, no offset

Not ported, and not claimed: motion blur (screen and cursor), and the cursor's
velocity tilt is applied only if `tilt` is configured below.

Output frames stream straight into ffmpeg; nothing touches the disk between the
source PNGs and the H.264.
"""
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# --------------------------------------------------------------------------
# Cap constants (apps/desktop/src-tauri/src/recording.rs, crates/rendering/src)
# --------------------------------------------------------------------------
PRE_PADDING_MS = 300.0
POST_PADDING_MS = 2500.0
END_CLAMP_PADDING_MS = 800.0
TRAILING_CLICK_IGNORE_MS = 1000.0
MERGE_GAP_MS = 2500.0
START_MIN_MS = 1.0
DEFAULT_AUTO_ZOOM_AMOUNT = 2.0
EDGE_SNAP_RATIO = 0.25

ZOOM_STEP_MS = 8.0
CENTER_PREAIM_MAX_AMOUNT = 1.0005
CLUSTER_WIDTH_RATIO = 0.5
CLUSTER_HEIGHT_RATIO = 0.7
FALLBACK_FOCUS = (0.5, 0.5)

CURSOR_STEP_MS = 1000.0 / 60.0
CLICK_LOOKAHEAD_TARGET_MS = 500.0
CLICK_SPRING_WINDOW_MS = 175.0
SHAKE_THRESHOLD_UV = 0.015
SHAKE_DETECTION_WINDOW_MS = 100.0
DECIMATE_FPS = 60.0
DECIMATE_MIN_DIST_UV = 1.0 / 1920.0
SPRING_SETTLE_EXTRA_MS = 300.0
LEAD_SMOOTHING = 0.12
IDLE_GAP_THRESHOLD_MS = CURSOR_STEP_MS * 4.0
DEFAULT_CLICK_SPRING = (530.0, 1.0, 40.0)   # tension, mass, friction
DRAG_SPRING = (1000.0, 1.0, 40.0)

STANDARD_CURSOR_HEIGHT = 60.0
CURSOR_CLICK_DURATION_MS = 130.0
CLICK_SHRINK_SIZE = 0.8
SCREEN_MAX_PADDING = 0.4
SQUIRCLE_POWER = 4.0

# Cursor shape ids as Cap records them on macOS.
SHAPES = {'0': 'arrow', '1': 'pointing-hand', '2': 'i-beam', '3': 'not-allowed'}


# --------------------------------------------------------------------------
# Spring-mass-damper: analytic solve per step (spring_mass_damper.rs)
# --------------------------------------------------------------------------
REST_VELOCITY_THRESHOLD = 0.0001
REST_DISPLACEMENT_THRESHOLD = 0.00001


def _solve_1d(disp, vel, t, omega0, zeta):
    eps = 0.01
    if zeta < 1.0 - eps:
        omega_d = omega0 * math.sqrt(1.0 - zeta * zeta)
        decay = math.exp(-zeta * omega0 * t)
        c, s = math.cos(omega_d * t), math.sin(omega_d * t)
        a = disp
        b = (vel + disp * zeta * omega0) / max(omega_d, 1e-4)
        return (decay * (a * c + b * s),
                decay * ((b * omega_d - a * zeta * omega0) * c - (a * omega_d + b * zeta * omega0) * s))
    if zeta > 1.0 + eps:
        sq = math.sqrt(zeta * zeta - 1.0)
        s1, s2 = -omega0 * (zeta - sq), -omega0 * (zeta + sq)
        den = s1 - s2
        if abs(den) < 1e-10:
            sa = 0.5 * (s1 + s2)
            decay = math.exp(sa * t)
            nd = decay * (disp + (vel - disp * sa) * t)
            nv = decay * ((vel - disp * sa) + sa * (disp + (vel - disp * sa) * t))
            return nd, nv
        c1 = (vel - disp * s2) / den
        c2 = disp - c1
        e1, e2 = math.exp(s1 * t), math.exp(s2 * t)
        return c1 * e1 + c2 * e2, c1 * s1 * e1 + c2 * s2 * e2
    decay = math.exp(-omega0 * t)
    a = disp
    b = vel + disp * omega0
    return decay * (a + b * t), decay * (b - omega0 * (a + b * t))


class Spring:
    def __init__(self, tension, mass, friction):
        self.set_config(tension, mass, friction)
        self.pos = [0.0, 0.0]
        self.vel = [0.0, 0.0]
        self.target = [0.0, 0.0]

    def set_config(self, tension, mass, friction):
        self.tension, self.mass, self.friction = tension, mass, friction

    def run(self, dt_ms):
        if dt_ms <= 0:
            return self.pos
        t = dt_ms / 1000.0
        mass = max(self.mass, 0.001)
        omega0 = math.sqrt(self.tension / mass)
        zeta = self.friction / (2.0 * math.sqrt(self.tension * mass))
        nd, nv = [], []
        for i in range(2):
            d, v = _solve_1d(self.pos[i] - self.target[i], self.vel[i], t, omega0, zeta)
            nd.append(d)
            nv.append(v)
        self.pos = [self.target[0] + nd[0], self.target[1] + nd[1]]
        self.vel = nv
        if math.hypot(*nd) < REST_DISPLACEMENT_THRESHOLD and math.hypot(*nv) < REST_VELOCITY_THRESHOLD:
            self.pos = list(self.target)
            self.vel = [0.0, 0.0]
        return self.pos


# --------------------------------------------------------------------------
# Zoom segments + clusters + spring timeline (recording.rs, zoom_spring.rs)
# --------------------------------------------------------------------------
def zoom_segments(click_times_ms, duration_ms, amount):
    """Both DOWN and UP events go in. Cap's segment end is anchored to the
    release; feeding only the press made every segment ~140ms short."""
    if duration_ms <= 0:
        return []
    cutoff = duration_ms - TRAILING_CLICK_IGNORE_MS
    end_limit = duration_ms - END_CLAMP_PADDING_MS
    if cutoff <= 0 or end_limit <= START_MIN_MS:
        return []
    iv = []
    for t in sorted(click_times_ms):
        t = math.floor(t)
        if t >= cutoff:
            continue
        s = max(t - PRE_PADDING_MS, START_MIN_MS)
        e = min(t + POST_PADDING_MS, end_limit)
        if e > s:
            iv.append([s, e])
    merged = []
    for s, e in iv:
        if merged and s <= merged[-1][1] + MERGE_GAP_MS:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [{'start': round(s) / 1000.0, 'end': round(e) / 1000.0, 'amount': amount} for s, e in merged]


def build_clusters(moves, start_s, end_s, amount):
    w_lim = CLUSTER_WIDTH_RATIO / max(amount, 1.0)
    h_lim = CLUSTER_HEIGHT_RATIO / max(amount, 1.0)
    s_ms, e_ms = start_s * 1000.0, end_s * 1000.0
    inr = [m for m in moves if s_ms <= m['t'] <= e_ms]
    if not inr:
        fb = None
        for m in reversed(moves):
            if m['t'] <= s_ms:
                fb = m
                break
        if fb is None:
            for m in moves:
                if m['t'] >= s_ms:
                    fb = m
                    break
        return [{'x': fb['x'], 'y': fb['y'], 't': fb['t']}] if fb else []
    out = []
    c = None
    for m in inr:
        if c is None:
            c = {'x0': m['x'], 'x1': m['x'], 'y0': m['y'], 'y1': m['y'], 't': m['t']}
            continue
        nw = max(c['x1'], m['x']) - min(c['x0'], m['x'])
        nh = max(c['y1'], m['y']) - min(c['y0'], m['y'])
        if nw <= w_lim and nh <= h_lim:
            c['x0'], c['x1'] = min(c['x0'], m['x']), max(c['x1'], m['x'])
            c['y0'], c['y1'] = min(c['y0'], m['y']), max(c['y1'], m['y'])
        else:
            out.append(c)
            c = {'x0': m['x'], 'x1': m['x'], 'y0': m['y'], 'y1': m['y'], 't': m['t']}
    out.append(c)
    return [{'x': (k['x0'] + k['x1']) / 2, 'y': (k['y0'] + k['y1']) / 2, 't': k['t']} for k in out]


def cluster_center_at(clusters, t_ms):
    for c in reversed(clusters):
        if c['t'] <= t_ms:
            return c['x'], c['y']
    return (clusters[0]['x'], clusters[0]['y']) if clusters else None


def snap_to_edges(v, r):
    if r <= 0:
        return v
    lo, hi = r, 1.0 - r + 0.0001
    if hi <= lo:
        return 0.5
    return min(1.0, max(0.0, (v - lo) / (hi - lo)))


def follow_center(focus, r):
    return (snap_to_edges(min(1, max(0, focus[0])), r), snap_to_edges(min(1, max(0, focus[1])), r))


def bounds_from(amount, cx, cy):
    amount = max(1.0, amount) if math.isfinite(amount) else 1.0
    cx, cy = min(1, max(0, cx)), min(1, max(0, cy))
    dx, dy = cx * amount - cx, cy * amount - cy
    return (-dx, -dy, amount - dx, amount - dy)      # top_left.x, top_left.y, bottom_right.x, bottom_right.y


def zoom_timeline(segments, moves, duration_s, spring):
    """Precompute at 8ms like Cap; returns arrays amount[], cx[], cy[]."""
    clusters = [build_clusters(moves, s['start'], s['end'], s['amount']) for s in segments]

    def targets_at(t_s, held):
        for i, s in enumerate(segments):
            if s['start'] < t_s <= s['end']:
                focus = cluster_center_at(clusters[i], t_s * 1000.0) or FALLBACK_FOCUS
                cx, cy = follow_center(focus, EDGE_SNAP_RATIO)
                return s['amount'], (cx, cy), 1.0, True
        return 1.0, held, 0.0, False

    total = int(math.ceil(duration_s * 1000.0 / ZOOM_STEP_MS)) + 2
    st, dp, ms = spring
    center = Spring(st, ms, dp)
    aux = Spring(st, ms, dp)
    a0, c0, act0, _ = targets_at(0.0, (0.5, 0.5))
    center.pos = list(c0); center.target = list(c0)
    aux.pos = [a0, act0]; aux.target = [a0, act0]
    held = c0
    amount = np.empty(total); cxs = np.empty(total); cys = np.empty(total)
    amount[0], cxs[0], cys[0] = max(1.0, a0), c0[0], c0[1]
    for k in range(1, total):
        t_s = k * ZOOM_STEP_MS / 1000.0
        a, c, act, active = targets_at(t_s, held)
        if active:
            held = c
        center.target = list(c)
        aux.target = [a, act]
        if aux.pos[0] <= CENTER_PREAIM_MAX_AMOUNT:
            center.pos = list(c)
            center.vel = [0.0, 0.0]
        center.run(ZOOM_STEP_MS)
        aux.run(ZOOM_STEP_MS)
        if aux.pos[0] < 1.0:
            aux.pos[0] = 1.0
            aux.vel[0] = 0.0
        amount[k] = aux.pos[0]
        cxs[k] = min(1, max(0, center.pos[0]))
        cys[k] = min(1, max(0, center.pos[1]))
    return amount, cxs, cys, clusters


def sample_zoom(tl, t_s):
    amount, cxs, cys, _ = tl
    pos = max(0.0, t_s) * 1000.0 / ZOOM_STEP_MS
    i = min(int(pos), len(amount) - 1)
    j = min(i + 1, len(amount) - 1)
    f = min(1.0, max(0.0, pos - i))
    return (amount[i] + (amount[j] - amount[i]) * f,
            cxs[i] + (cxs[j] - cxs[i]) * f,
            cys[i] + (cys[j] - cys[i]) * f)


# --------------------------------------------------------------------------
# Cursor: shake filter, decimation, smoothed timeline (cursor_interpolation.rs)
# --------------------------------------------------------------------------
def filter_shake(moves):
    if len(moves) < 3:
        return moves
    out = [moves[0]]
    i = 1
    while i < len(moves) - 1:
        prev, cur, nxt = out[-1], moves[i], moves[i + 1]
        if cur['id'] != prev['id'] or cur['id'] != nxt['id'] or nxt['t'] - prev['t'] > SHAKE_DETECTION_WINDOW_MS:
            out.append(cur); i += 1; continue
        d1 = (cur['x'] - prev['x'], cur['y'] - prev['y'])
        d2 = (nxt['x'] - cur['x'], nxt['y'] - cur['y'])
        reversal = d1[0] * d2[0] + d1[1] * d2[1] < 0
        small = math.hypot(*d1) < SHAKE_THRESHOLD_UV and math.hypot(*d2) < SHAKE_THRESHOLD_UV
        if reversal and small:
            i += 1; continue
        out.append(cur); i += 1
    out.append(moves[-1])
    return out


def decimate(moves):
    if len(moves) < 2:
        return moves
    frame_ms = math.floor(1000.0 / DECIMATE_FPS)
    out = [moves[0]]
    for i in range(1, len(moves)):
        cur, last = moves[i], out[-1]
        if cur['id'] != last['id']:
            out.append(cur); continue
        if i + 1 >= len(moves):
            out.append(cur); break
        nxt = moves[i + 1]
        if nxt['t'] - last['t'] < frame_ms or math.hypot(cur['x'] - last['x'], cur['y'] - last['y']) < DECIMATE_MIN_DIST_UV:
            continue
        out.append(cur)
    return out


def pos_at(moves, t_ms, hint):
    """Linear between samples, but HOLD across a gap longer than four steps -
    that is how a sparse recording sits still instead of drifting."""
    while hint[0] > 0 and moves[hint[0]]['t'] > t_ms:
        hint[0] -= 1
    while hint[0] + 1 < len(moves) and moves[hint[0] + 1]['t'] <= t_ms:
        hint[0] += 1
    m = moves[hint[0]]
    if hint[0] + 1 < len(moves):
        n = moves[hint[0] + 1]
        if m['t'] <= t_ms < n['t']:
            dt = n['t'] - m['t']
            if dt > IDLE_GAP_THRESHOLD_MS:
                return m['x'], m['y']
            if dt > 1e-9:
                u = (t_ms - m['t']) / dt
                return m['x'] + (n['x'] - m['x']) * u, m['y'] + (n['y'] - m['y']) * u
    return m['x'], m['y']


def cursor_timeline(moves_raw, clicks, base):
    """`base` = (tension, mass, friction). Returns list of (t_ms, x, y, vx, vy, id)."""
    moves = decimate(filter_shake(sorted(moves_raw, key=lambda m: m['t'])))
    if not moves:
        return []
    clicks = sorted(clicks, key=lambda c: c['t'])

    def lag(cfg):
        return (cfg[2] / cfg[0]) * 1000.0 if cfg[0] > 0 else 0.0

    sim = Spring(*base)
    sim.pos = [moves[0]['x'], moves[0]['y']]; sim.target = list(sim.pos)
    end_t = moves[-1]['t']
    settle = end_t + SPRING_SETTLE_EXTRA_MS
    out = [(0.0, moves[0]['x'], moves[0]['y'], 0.0, 0.0, moves[0]['id'])]
    hint_t = [0]; hint_c = [0]
    nxt_click = 0; primary_down = False
    lead = lag(base)
    t = CURSOR_STEP_MS
    while t <= settle:
        ct = min(t, end_t)
        while nxt_click < len(clicks) and clicks[nxt_click]['t'] <= t:
            if clicks[nxt_click].get('num', 1) == 0:
                primary_down = clicks[nxt_click]['down']
            nxt_click += 1
        # profile
        cfg = base
        upcoming = next((c for c in clicks[nxt_click:] if c['t'] > t), None)
        if upcoming and upcoming['t'] - t <= CLICK_SPRING_WINDOW_MS:
            cfg = DEFAULT_CLICK_SPRING
        elif primary_down:
            cfg = DRAG_SPRING
        sim.set_config(*cfg)
        lead += (lag(cfg) - lead) * LEAD_SMOOTHING
        lx, ly = pos_at(moves, min(ct + lead, end_t), hint_t)
        pos_at(moves, ct, hint_c)
        cid = moves[hint_c[0]]['id']
        # click look-ahead: the target snaps to where the click will land
        look = next((c for c in clicks if c['t'] > t), None)
        if look and look['t'] - t <= CLICK_LOOKAHEAD_TARGET_MS:
            tx, ty = pos_at(moves, min(look['t'], end_t), [0])
        else:
            tx, ty = lx, ly
        sim.target = [tx, ty]
        sim.run(CURSOR_STEP_MS)
        out.append((t, sim.pos[0], sim.pos[1], sim.vel[0], sim.vel[1], cid))
        t += CURSOR_STEP_MS
    return out


def sample_cursor(tl, t_ms):
    if not tl:
        return None
    if t_ms <= tl[0][0]:
        e = tl[0]; return e[1], e[2], e[3], e[4], e[5]
    if t_ms >= tl[-1][0]:
        e = tl[-1]; return e[1], e[2], e[3], e[4], e[5]
    step = tl[1][0] - tl[0][0] if len(tl) > 1 else CURSOR_STEP_MS
    i = min(int((t_ms - tl[0][0]) / step), len(tl) - 2)
    a, b = tl[i], tl[i + 1]
    if not (a[0] <= t_ms < b[0]):
        for k in range(len(tl) - 1):
            if tl[k][0] <= t_ms < tl[k + 1][0]:
                a, b = tl[k], tl[k + 1]; break
    dt = b[0] - a[0]
    f = 0.0 if abs(dt) < 1e-6 else min(1.0, max(0.0, (t_ms - a[0]) / dt))
    return (a[1] * (1 - f) + b[1] * f, a[2] * (1 - f) + b[2] * f,
            a[3] * (1 - f) + b[3] * f, a[4] * (1 - f) + b[4] * f, a[5])


def click_t(clicks, t_ms):
    def ss(lo, hi, v):
        u = min(1.0, max(0.0, (v - lo) / (hi - lo)))
        return u * u * (3 - 2 * u)
    nxt = next((c for c in clicks if c['t'] > t_ms), None)
    if nxt:
        if nxt['down'] and nxt['t'] - t_ms <= CURSOR_CLICK_DURATION_MS:
            return ss(0, CURSOR_CLICK_DURATION_MS, nxt['t'] - t_ms)
        if not nxt['down']:
            return 0.0
    prev = next((c for c in reversed(clicks) if c['t'] <= t_ms), None)
    if prev:
        if prev['down']:
            return 0.0
        if t_ms - prev['t'] <= CURSOR_CLICK_DURATION_MS:
            return ss(0, CURSOR_CLICK_DURATION_MS, t_ms - prev['t'])
    return 1.0


# --------------------------------------------------------------------------
# Geometry: squircle SDF, coverage, shadow (composite-video-frame.wgsl)
# --------------------------------------------------------------------------
def sdf_grid(xs, ys, cx, cy, hw, hh, r):
    """Signed distance of grid points to a squircle-cornered rect."""
    px = np.abs(xs[None, :] - cx) - hw + r
    py = np.abs(ys[:, None] - cy) - hh + r
    ox = np.maximum(px, 0.0); oy = np.maximum(py, 0.0)
    norm = np.power(np.power(ox, SQUIRCLE_POWER) + np.power(oy, SQUIRCLE_POWER), 1.0 / SQUIRCLE_POWER)
    return norm + np.minimum(np.maximum(px, py), 0.0) - r


def shadow_alpha(W, H, quad, r, cfg, scale=4):
    """Shadow multiplier map (0..1 darkening) at 1/scale res, upsampled."""
    x0, y0, x1, y1 = quad
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    min_half = min(hw, hh)
    strength = cfg['shadow'] / 100.0
    size = strength * (cfg['size'] / 100.0) * min_half
    blur = strength * (cfg['blur'] / 100.0) * min_half
    opacity = strength * (cfg['opacity'] / 100.0)
    gw, gh = W // scale, H // scale
    xs = (np.arange(gw) + 0.5) * scale
    ys = (np.arange(gh) + 0.5) * scale
    d = np.abs(sdf_grid(xs, ys, cx, cy, hw, hh, r))
    lo, hi = size + blur, -blur
    u = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    a = (u * u * (3 - 2 * u)) * opacity
    im = Image.fromarray((a * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)
    return np.asarray(im, dtype=np.float32) / 255.0


def coverage(xs, ys, cx, cy, hw, hh, r):
    d = sdf_grid(xs, ys, cx, cy, hw, hh, r)
    return np.clip(0.5 - d, 0.0, 1.0)     # 1px anti-aliased edge


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def load_assets(assets_dir):
    meta_p = os.path.join(assets_dir, 'recording-meta.json')
    cursors = {}
    if os.path.exists(meta_p):
        meta = json.load(open(meta_p))
        for cid, c in (meta.get('cursors') or {}).items():
            base = os.path.basename(c['imagePath'])
            # The bundle keeps them under content/cursors/; the copy here keeps
            # them under cursors/. Looking only at the top level loaded nothing,
            # and every shape fell through to the arrow fallback - the recorder
            # had logged a pointing hand at both clicks and the render drew arrows.
            for cand in (os.path.join(assets_dir, 'cursors', base), os.path.join(assets_dir, base)):
                if os.path.exists(cand):
                    cursors[cid] = (Image.open(cand).convert('RGBA'), c['hotspot']['x'], c['hotspot']['y'])
                    break
    # Drawn fallbacks, sized like macOS's own: an arrow, a pointing hand, an
    # I-beam. They are vectors, so nothing that is Apple's or Cap's ships.
    if '0' not in cursors:
        cursors['0'] = (vector_arrow(), 0.17, 0.09)
    if '1' not in cursors:
        cursors['1'] = (vector_hand(), 0.40, 0.12)
    if '2' not in cursors:
        cursors['2'] = (vector_ibeam(), 0.5, 0.5)
    wall = None
    for n in ('desktop-background.jpg', 'desktop-background.png', 'wallpaper.jpg'):
        p = os.path.join(assets_dir, n)
        if os.path.exists(p):
            wall = Image.open(p).convert('RGB'); break
    if wall is None:
        # Cache the converted system wallpaper in the WORK dir, never inside an
        # installed package.
        wall = system_wallpaper(os.path.join(os.environ.get('DEMOKIT_WORK') or os.path.dirname(assets_dir), 'wallpaper'))
    return cursors, wall


# Nothing is shipped: Cap's default is the desktop wallpaper, and Apple's are
# already on every Mac. Read one at runtime (converted once with sips into the
# cache); anywhere else, a quiet gradient. Never redistribute a wallpaper.
SYSTEM_WALLPAPERS = ['Sonoma.heic', 'Sonoma Horizon.heic', 'Sequoia Sunrise.heic', 'Tahoe Day.heic', 'Radial Sky Blue.heic',
                     'Ventura.heic', 'Monterey.heic', 'Big Sur.heic', 'Catalina.heic']


def system_wallpaper(cache_dir):
    d = '/System/Library/Desktop Pictures'
    if not os.path.isdir(d):
        return None
    names = SYSTEM_WALLPAPERS + sorted(n for n in os.listdir(d) if n.lower().endswith('.heic'))
    for n in names:
        src = os.path.join(d, n)
        if not os.path.exists(src):
            continue
        os.makedirs(cache_dir, exist_ok=True)
        out = os.path.join(cache_dir, 'system-' + n.rsplit('.', 1)[0].lower().replace(' ', '-') + '.jpg')
        if not os.path.exists(out):
            try:
                subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', '-Z', '3840', src, '--out', out],
                               check=True, capture_output=True)
            except Exception:
                continue
        try:
            return Image.open(out).convert('RGB')
        except Exception:
            continue
    return None


def title_bar(sample, w, h):
    """macOS window buttons on a bar matched to the tab strip below it.

    The container films a MATE title bar over Linux Chromium's tab strip. The
    WM bar is cropped off and this goes in its place: 12pt lights, 20pt apart,
    20pt in, on a bar the exact median colour of the strip - a different grey
    reads as two stacked bars, which is what the first version looked like.
    """
    a = np.asarray(sample.convert('RGB'))
    band = a[6:max(10, h // 2), int(a.shape[1] * 0.62):int(a.shape[1] * 0.92):7]
    bg = tuple(int(np.median(band[:, :, i])) for i in range(3))
    bar = Image.new('RGB', (w, h), bg)
    from PIL import ImageDraw
    d = ImageDraw.Draw(bar)
    d.line([(0, 0), (w, 0)], fill=tuple(min(255, c + 10) for c in bg))
    dia, gap = h * 12 / 28.0, h * 20 / 28.0
    for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx, cy, r = gap + i * gap, h / 2.0, dia / 2.0
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col,
                  outline=tuple(int(c * 0.82) for c in col), width=max(1, int(h * 0.014)))
    return bar


def _outlined(w, h, draw_fn, stroke=(0, 0, 0, 255), fill=(255, 255, 255, 255), width=10):
    """Draw a shape with a black outline and a white body at 8x, then downsample."""
    from PIL import ImageDraw
    S = 4
    im = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    draw_fn(d, S, stroke, fill, width * S // 4)
    return im.resize((w, h), Image.LANCZOS)


def vector_arrow():
    def f(d, S, stroke, fill, w):
        pts = [(48, 34), (48, 232), (98, 185), (140, 270), (172, 254), (130, 170), (200, 170)]
        pts = [(x * S / 280 * 280 / 280, y * S / 400 * 400 / 400) for x, y in pts]
        pts = [(x * S, y * S) for x, y in [(p[0] / S, p[1] / S) for p in pts]]
        d.polygon(pts, fill=(0, 0, 0, 255))
        d.line(pts + [pts[0]], fill=(255, 255, 255, 255), width=w, joint='curve')
    return _outlined(280, 400, f)


def vector_hand():
    def f(d, S, stroke, fill, w):
        # palm + index finger, the macOS pointing hand read at a glance
        d.rounded_rectangle([18 * S, 30 * S, 46 * S, 60 * S], radius=8 * S, fill=fill, outline=stroke, width=w)
        d.rounded_rectangle([24 * S, 4 * S, 32 * S, 40 * S], radius=4 * S, fill=fill, outline=stroke, width=w)
        d.rounded_rectangle([33 * S, 16 * S, 40 * S, 40 * S], radius=3 * S, fill=fill, outline=stroke, width=w)
        d.rounded_rectangle([41 * S, 20 * S, 47 * S, 42 * S], radius=3 * S, fill=fill, outline=stroke, width=w)
        d.rounded_rectangle([12 * S, 30 * S, 22 * S, 48 * S], radius=4 * S, fill=fill, outline=stroke, width=w)
        d.rounded_rectangle([20 * S, 36 * S, 46 * S, 60 * S], radius=8 * S, fill=fill)
    return _outlined(64, 64, f)


def vector_ibeam():
    def f(d, S, stroke, fill, w):
        cx = 115 * S
        d.rectangle([cx - 8 * S, 24 * S, cx + 8 * S, 196 * S], fill=stroke)
        d.rectangle([cx - 6 * S, 26 * S, cx + 6 * S, 194 * S], fill=fill)
        for y in (24, 196):
            d.rectangle([cx - 34 * S, (y - 8) * S, cx + 34 * S, (y + 8) * S], fill=stroke)
            d.rectangle([cx - 32 * S, (y - 6) * S, cx + 32 * S, (y + 6) * S], fill=fill)
    return _outlined(230, 220, f)


def cover(im, W, H):
    s = max(W / im.width, H / im.height)
    r = im.resize((max(W, int(im.width * s + 0.5)), max(H, int(im.height * s + 0.5))), Image.LANCZOS)
    l, t = (r.width - W) // 2, (r.height - H) // 2
    return r.crop((l, t, l + W, t + H))


def main():
    argv = sys.argv[1:]
    if len(argv) < 2:
        print(__doc__); sys.exit(2)
    shot, out = argv[0], argv[1]

    def opt(n, d):
        return argv[argv.index(n) + 1] if n in argv else d

    W, H, FPS = int(opt('--w', 3840)), int(opt('--h', 2160)), int(opt('--fps', 30))
    work = os.environ.get('DEMOKIT_WORK')
    default_assets = os.path.join(work, 'cap') if work and os.path.isdir(os.path.join(work, 'cap')) else os.path.join(ROOT, '.cache', 'cap')
    assets_dir = opt('--assets', default_assets)
    cfg_p = opt('--config', os.path.join(assets_dir, 'project-config.json'))
    cap = json.load(open(cfg_p)) if os.path.exists(cfg_p) else {}
    bg = cap.get('background', {})
    cur_cfg = cap.get('cursor', {})
    spring = cap.get('screenMovementSpring', {'stiffness': 200.0, 'damping': 40.0, 'mass': 2.25})
    padding = float(bg.get('padding', 10.0))
    rounding = float(bg.get('rounding', 7.5))
    adv = bg.get('advancedShadow') or {'size': 14.4, 'opacity': 68.1, 'blur': 3.8}
    shadow_cfg = {'shadow': float(bg.get('shadow', 73.6)), 'size': float(adv['size']),
                  'opacity': float(adv['opacity']), 'blur': float(adv['blur'])}
    amount = float(cap.get('_autoZoomAmount', DEFAULT_AUTO_ZOOM_AMOUNT))
    cursor_size = float(cur_cfg.get('size', 100))
    rotation_amount = float(cur_cfg.get('rotationAmount', 0.15))
    base_spring = (float(cur_cfg.get('tension', 470.0)), float(cur_cfg.get('mass', 3.0)),
                   float(cur_cfg.get('friction', 70.0)))

    man = json.load(open(os.path.join(shot, 'manifest.json')))
    frames = man['frames']
    if not frames:
        sys.exit('no frames')
    trim = int((man.get('deco') or {}).get('top', 0))
    has_chrome = bool(man.get('chrome'))          # chrome.py drew the window top already
    bar_h = (int(round(man['height'] * 0.0235)) & ~1) if trim > 0 and not has_chrome and '--no-maclights' not in argv else 0
    src_w, src_h = int(man['width']), int(man['height']) - trim + bar_h
    screen_h = float(man.get('screenH') or (man['height'] + 274))   # X display height, for cursor_height_px
    fdir = os.path.join(shot, 'frames-chrome') if os.path.isdir(os.path.join(shot, 'frames-chrome')) else os.path.join(shot, 'frames')
    duration_ms = frames[-1]['ms']

    # ---- events -> Cap's shapes ------------------------------------------
    moves = []
    for p in (man.get('pointer') or man.get('path') or []):
        moves.append({'t': float(p['t']), 'x': p['x'] / src_w, 'y': (p['y'] - trim + bar_h) / src_h,
                      'id': str(p.get('cursor_id', '0'))})
    clicks = []
    for e in man.get('events', []):
        if e.get('kind') not in ('click', 'type'):
            continue
        down = float(e.get('at', e['t']))
        up = float(e.get('up', down + 140.0))
        clicks.append({'t': down, 'down': True, 'num': 1})
        clicks.append({'t': up, 'down': False, 'num': 1})
    clicks.sort(key=lambda c: c['t'])

    segs = zoom_segments([c['t'] for c in clicks], duration_ms, amount)
    ztl = zoom_timeline(segs, moves, duration_ms / 1000.0, (spring['stiffness'], spring['damping'], spring['mass']))
    ctl = cursor_timeline(moves, clicks, base_spring) if moves else []

    # ---- layout: the display at rest, Cap padding, fixed output aspect -----
    pad = max(W, H) * (padding / 100.0) * SCREEN_MAX_PADDING
    aw, ah = W - 2 * pad, H - 2 * pad
    s = min(aw / src_w, ah / src_h)
    disp_w, disp_h = src_w * s, src_h * s
    disp_x, disp_y = (W - disp_w) / 2, (H - disp_h) / 2
    rounding_rest = rounding / 100.0 * 0.5 * min(disp_w, disp_h)

    cursors, wall = load_assets(assets_dir)
    print('caprender: cursor shapes loaded: ' + ', '.join(f"{k}={SHAPES.get(k, k)}" for k in sorted(cursors))
          + ('' if wall else '  (no wallpaper found - flat backdrop)'), file=sys.stderr)
    background = np.asarray(cover(wall, W, H), dtype=np.float32) if wall else np.full((H, W, 3), 24, np.float32)

    # ---- edit.json so pacing / critic / verify see the camera --------------
    _, _, _, clusters = ztl
    chains = []
    for sgi, sg in enumerate(segs):
        tg = []
        for k, c in enumerate(clusters[sgi] or [{'x': 0.5, 'y': 0.5, 't': sg['start'] * 1000}]):
            hw, hh = src_w / (2 * sg['amount']), src_h / (2 * sg['amount'])
            tg.append({'tMs': int(max(sg['start'] * 1000, c['t']) if k else sg['start'] * 1000),
                       'rect': [int(c['x'] * src_w - hw), int(c['y'] * src_h - hh + trim - bar_h), int(2 * hw), int(2 * hh)],
                       'z': sg['amount'], 'reason': 'cap', 'kind': 'cap'})
        chains.append({'startMs': int(sg['start'] * 1000), 'endMs': int(sg['end'] * 1000), 'reason': 'cap: auto zoom', 'targets': tg})
    json.dump({'source': shot, 'durationMs': duration_ms, 'mode': 'cap', 'engine': 'caprender',
               'frame': {'w': man['width'], 'h': man['height']}, 'warnings': [] if chains else ['no usable clicks - the camera will not move'],
               'chains': chains, 'zooms': [t for c in chains for t in c['targets']], 'rejected': []},
              open(os.path.join(shot, 'edit.json'), 'w'), indent=1)

    # ---- encode ---------------------------------------------------------------
    n_out = int(duration_ms / 1000.0 * FPS) + 1
    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
    enc = subprocess.Popen([os.environ.get('DEMOKIT_FFMPEG', 'ffmpeg'), '-y', '-hide_banner', '-loglevel', 'error',
                            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                            '-c:v', 'libx264', '-preset', 'slower', '-crf', '15',
                            '-x264-params', 'aq-mode=3:psy-rd=0.4:deblock=-1,-1',
                            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def push(buf):
        # A broken pipe means ffmpeg is gone. Say why, with its own words, instead
        # of a BrokenPipeError with no context - which is what a missing output
        # directory looked like from a fresh install.
        try:
            enc.stdin.write(buf)
        except BrokenPipeError:
            err = enc.stderr.read().decode('utf-8', 'replace').strip() if enc.stderr else ''
            sys.exit(f'caprender: ffmpeg exited early ({enc.poll()}): {err or "no message"}')

    xs_full = np.arange(W) + 0.5
    ys_full = np.arange(H) + 0.5
    src_cache = {'i': None, 'im': None}
    bar_img = None
    shadow_cache = {'key': None, 'map': None}
    mask_cache = {'key': None, 'mask': None, 'box': None}
    fi = 0

    for k in range(n_out):
        t_ms = k * 1000.0 / FPS
        while fi + 1 < len(frames) and frames[fi + 1]['ms'] <= t_ms:
            fi += 1
        f = frames[fi]
        if src_cache['i'] != f['i']:
            im = Image.open(os.path.join(fdir, 'f%05d.png' % f['i'])).convert('RGB')
            if trim:
                im = im.crop((0, trim, im.width, im.height))
            if bar_h:
                if bar_img is None:
                    bar_img = title_bar(im, im.width, bar_h)
                canvas = Image.new('RGB', (im.width, im.height + bar_h))
                canvas.paste(bar_img, (0, 0))
                canvas.paste(im, (0, bar_h))
                im = canvas
            src_cache = {'i': f['i'], 'im': im}
        src = src_cache['im']

        amt, cx, cy = sample_zoom(ztl, t_ms / 1000.0)
        tlx, tly, brx, bry = bounds_from(amt, cx, cy)
        # display quad in output px (display_bounds in lib.rs)
        qx0 = disp_x + tlx * disp_w
        qy0 = disp_y + tly * disp_h
        qx1 = disp_x + disp_w + (brx - 1.0) * disp_w
        qy1 = disp_y + disp_h + (bry - 1.0) * disp_h
        qw, qh = qx1 - qx0, qy1 - qy0
        r_px = rounding_rest * (qw / disp_w)

        frame = background.copy()
        key = (round(qx0), round(qy0), round(qx1), round(qy1))
        if shadow_cache['key'] != key:
            shadow_cache = {'key': key, 'map': shadow_alpha(W, H, (qx0, qy0, qx1, qy1), r_px, shadow_cfg)}
        frame *= (1.0 - shadow_cache['map'])[:, :, None]

        # visible part of the quad -> source crop -> resize -> composite with squircle coverage
        vx0, vy0 = max(0, int(math.floor(qx0))), max(0, int(math.floor(qy0)))
        vx1, vy1 = min(W, int(math.ceil(qx1))), min(H, int(math.ceil(qy1)))
        if vx1 > vx0 and vy1 > vy0:
            # The visible region is floor/ceil'd to whole pixels, so its edges can
            # sit a fraction outside the quad; clamp the source box to the image.
            u0, u1 = max(0.0, (vx0 - qx0) / qw), min(1.0, (vx1 - qx0) / qw)
            v0, v1 = max(0.0, (vy0 - qy0) / qh), min(1.0, (vy1 - qy0) / qh)
            box = (u0 * src_w, v0 * src_h, max(u0 * src_w + 1, u1 * src_w), max(v0 * src_h + 1, v1 * src_h))
            piece = src.resize((vx1 - vx0, vy1 - vy0), Image.LANCZOS if (vx1 - vx0) < box[2] - box[0] else Image.BICUBIC, box=box)
            pa = np.asarray(piece, dtype=np.float32)
            # Key the mask on the pixel box it covers as well as the quad: two quads
            # that round to the same key can floor/ceil to boxes a pixel apart,
            # and a cached mask of the wrong shape crashed the render at 10.5s.
            mkey = (key, vx0, vy0, vx1, vy1)
            if mask_cache['key'] != mkey:
                cov = coverage(xs_full[vx0:vx1], ys_full[vy0:vy1], (qx0 + qx1) / 2, (qy0 + qy1) / 2, qw / 2, qh / 2, r_px)
                mask_cache = {'key': mkey, 'mask': cov[:, :, None].astype(np.float32), 'box': (vx0, vy0, vx1, vy1)}
            m = mask_cache['mask']
            region = frame[vy0:vy1, vx0:vx1]
            region *= (1.0 - m)
            region += pa * m

        # cursor
        if ctl:
            cs = sample_cursor(ctl, t_ms)
            if cs:
                ux, uy, vx, vy, cid = cs
                cur = cursors.get(cid) or cursors.get('0')
                if cur:
                    img, hx, hy = cur
                    ct = click_t(clicks, t_ms)
                    scale_click = ct * 1.0 + (1.0 - ct) * CLICK_SHRINK_SIZE
                    # cursor_height_px for a display recording collapses to 60px per
                    # 1080px of the DISPLAY as shown (screen_h / crop_h cancel), which
                    # is what keeps the cursor the same share of the card at any capture
                    # resolution - a headless 3200px page and a 4288px X display alike.
                    size = STANDARD_CURSOR_HEIGHT * (qh / 1080.0) * (cursor_size / 100.0) * scale_click
                    asp = img.width / img.height
                    if asp > 1.0:
                        cw, ch = size, size / asp
                    else:
                        cw, ch = size * asp, size
                    cw_i, ch_i = max(1, int(round(cw))), max(1, int(round(ch)))
                    spr = img.resize((cw_i, ch_i), Image.LANCZOS)
                    # Velocity tilt (lib.rs ~3468): the cursor leans into its
                    # horizontal motion over the last 0.4s, 0.03 deg per px of
                    # display travel times rotation_amount, clamped to 20 deg.
                    hot = (hx * cw_i, hy * ch_i)
                    past = sample_cursor(ctl, max(0.0, t_ms - 400.0))
                    if past and rotation_amount > 0:
                        dx_px = (ux - past[0]) * disp_w
                        deg = max(-20.0, min(20.0, dx_px * 0.03 * rotation_amount))
                        if abs(deg) > 0.05:
                            spr = spr.rotate(-deg, resample=Image.BICUBIC, expand=True, center=hot)
                            # rotate(expand=True) shifts the origin; recover where the hotspot went
                            rad = math.radians(-deg)
                            ow, oh = cw_i, ch_i
                            cxr, cyr = ow / 2, oh / 2
                            nx = (hot[0] - cxr) * math.cos(rad) - (hot[1] - cyr) * math.sin(rad) + spr.width / 2
                            ny = (hot[0] - cxr) * math.sin(rad) + (hot[1] - cyr) * math.cos(rad) + spr.height / 2
                            hot = (nx, ny)
                            cw_i, ch_i = spr.width, spr.height
                    px = qx0 + ux * qw - hot[0]
                    py = qy0 + uy * qh - hot[1]
                    ix, iy = int(round(px)), int(round(py))
                    x0c, y0c = max(0, ix), max(0, iy)
                    x1c, y1c = min(W, ix + cw_i), min(H, iy + ch_i)
                    if x1c > x0c and y1c > y0c:
                        sa = np.asarray(spr, dtype=np.float32)[y0c - iy:y1c - iy, x0c - ix:x1c - ix]
                        a = sa[:, :, 3:4] / 255.0
                        reg = frame[y0c:y1c, x0c:x1c]
                        reg *= (1.0 - a)
                        reg += sa[:, :, :3] * a

        push(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
        if k % 60 == 0:
            print(f'caprender: {k}/{n_out}  t={t_ms/1000:.1f}s  zoom {amt:.2f}x', file=sys.stderr)

    enc.stdin.close()
    rc = enc.wait()
    if rc != 0:
        err = enc.stderr.read().decode('utf-8', 'replace').strip() if enc.stderr else ''
        sys.exit(f'caprender: ffmpeg failed ({rc}): {err or "no message"}')
    json.dump({'segments': segs, 'clusters': clusters, 'layout': {'disp': [disp_x, disp_y, disp_w, disp_h], 'pad': pad,
               'rounding_px': rounding_rest}, 'frames': n_out}, open(os.path.join(shot, 'cap-timeline.json'), 'w'), indent=1)
    print(f'caprender: {n_out} frames -> {out}; {len(segs)} zoom segment(s): '
          + ' '.join(f"{s['start']:.2f}-{s['end']:.2f}s" for s in segs))


if __name__ == '__main__':
    main()
