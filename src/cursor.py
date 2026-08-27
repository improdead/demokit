"""
Draw the cursor and click pulses onto the captured frames.

Done here rather than as an ffmpeg overlay because the pointer path is dense
(hundreds of samples) and ffmpeg overlay expressions would have to encode all of
it as one nested if() chain. Interpolating per frame in PIL is exact, and it is
what keeps the cursor attached to whatever is being dragged.
"""
import json, os, sys, math
from multiprocessing import Pool, cpu_count
from PIL import Image, ImageDraw, ImageFilter

SHOT = sys.argv[1]
OUT = os.path.join(SHOT, "frames-cur")
MAN = json.load(open(os.path.join(SHOT, "manifest.json")))

SCALE = MAN["width"] / 1920.0
CUR_H = max(28, int(round(34 * SCALE)))
RIPPLE_MS = 460
RIPPLE_MAX = max(18, int(round(34 * SCALE)))
ACCENT = (79, 107, 61)


def make_cursor(h):
    """Arrow with the tip at a known hotspot. Returns (sprite, hx, hy)."""
    s = h / 32.0
    pad = max(3, int(4 * s))
    pts = [(0, 0), (0, 22), (5.5, 16.8), (9, 27), (12.6, 25.4), (9.2, 15.8), (16, 15.8)]
    pts = [(pad + x * s, pad + y * s) for x, y in pts]
    W = int(18 * s) + pad * 2
    H = int(29 * s) + pad * 2
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 1.5 * s, y + 1.8 * s) for x, y in pts], fill=(0, 0, 0, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(max(1.2, 1.6 * s)))
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.polygon(pts, fill=(255, 255, 255, 255))
    d.line(pts + [pts[0]], fill=(26, 26, 30, 255), width=max(1, int(round(1.7 * s))), joint="curve")
    return Image.alpha_composite(sh, im), pad, pad


CURSOR, HX, HY = make_cursor(CUR_H)
PRESSED = CURSOR.resize((int(CURSOR.width * 0.88), int(CURSOR.height * 0.88)), Image.LANCZOS)

PATH = MAN.get("path") or []
ACTIONS = MAN.get("actions") or []
TIMES = [p["t"] for p in PATH]


def at(ms):
    """Pointer position at a moment, linearly interpolated between samples."""
    if not PATH:
        return None
    if ms <= TIMES[0]:
        return PATH[0]["x"], PATH[0]["y"]
    if ms >= TIMES[-1]:
        return PATH[-1]["x"], PATH[-1]["y"]
    lo, hi = 0, len(PATH) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if TIMES[mid] <= ms:
            lo = mid
        else:
            hi = mid
    a, b = PATH[lo], PATH[hi]
    span = max(1, b["t"] - a["t"])
    f = (ms - a["t"]) / span
    return a["x"] + (b["x"] - a["x"]) * f, a["y"] + (b["y"] - a["y"]) * f


CLICK_PRESS_MS = 150      # how long the pointer reads as held on a click


def press_amount(ms):
    """0 = up, 1 = fully pressed.

    A drag has explicit down/up so the pointer stays held between them. A click
    was recorded as a single instant, so the pointer never visibly pressed at
    all - the ripple fired but the cursor itself did not react, which is why
    clicks read as the pointer floating over things rather than hitting them.
    A click now presses for CLICK_PRESS_MS and eases back.
    """
    down = None
    for a in ACTIONS:
        if a["t"] > ms:
            break
        if a["type"] == "down":
            down = a["t"]
        elif a["type"] == "up":
            down = None
    if down is not None:
        return 1.0
    for a in ACTIONS:
        if a["type"] != "click":
            continue
        dt = ms - a["t"]
        if 0 <= dt <= CLICK_PRESS_MS:
            # quick down, slower release
            p = dt / CLICK_PRESS_MS
            return 1.0 - (p * p) if p > 0.35 else 1.0
    return 0.0


def one(job):
    idx, ms = job
    src = os.path.join(SHOT, "frames", "f%05d.png" % idx)
    dst = os.path.join(OUT, "f%05d.png" % idx)
    im = Image.open(src).convert("RGBA")

    # click pulses: expanding ring, fading
    layer = None
    for a in ACTIONS:
        if a["type"] == "up":
            continue
        dt = ms - a["t"]
        if 0 <= dt <= RIPPLE_MS:
            f = dt / RIPPLE_MS
            r = 6 * SCALE + (RIPPLE_MAX - 6 * SCALE) * (f ** 0.6)
            alpha = int(165 * (1 - f) ** 1.5)
            if alpha > 3:
                if layer is None:
                    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
                w = max(2, int(round((5 - 3 * f) * SCALE)))
                ImageDraw.Draw(layer).ellipse(
                    [a["x"] - r, a["y"] - r, a["x"] + r, a["y"] + r],
                    outline=ACCENT + (alpha,), width=w)
    if layer is not None:
        im = Image.alpha_composite(im, layer)

    p = at(ms)
    if p is not None:
        amt = press_amount(ms)
        if amt > 0.02:
            k = 1.0 - 0.12 * amt          # shrink toward the press
            spr = CURSOR.resize((max(1, int(CURSOR.width * k)), max(1, int(CURSOR.height * k))), Image.LANCZOS)
            hx, hy = HX * k, HY * k
        else:
            spr, hx, hy = CURSOR, HX, HY
        im.alpha_composite(spr, (int(round(p[0] - hx)), int(round(p[1] - hy))))

    im.convert("RGB").save(dst, compress_level=1)
    return idx


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    jobs = [(f["i"], f["ms"]) for f in MAN["frames"]]
    with Pool(max(2, cpu_count() - 1)) as pool:
        for _ in pool.imap_unordered(one, jobs, chunksize=8):
            pass
    print("cursor pass: %d frames, path=%d samples, actions=%d"
          % (len(jobs), len(PATH), len(ACTIONS)))
