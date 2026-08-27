#!/usr/bin/env python3
"""
Draw synthetic macOS + browser chrome around a tab recording.

    python3 src/chrome.py <shotDir> [--url app.example.com] [--title "Findings"]
                                    [--tabs "Findings|Overview|Docs"] [--style mac|browser]

A CDP tab screencast has no traffic lights, no tab strip and no URL bar - the
page rectangle and nothing else. Every reference demo leans on that chrome: it
is what says "this is a real app someone is using" rather than "this is a
screenshot of a div". So we draw it.

It runs after cursor.py and before the compositor, and it rewrites the manifest:
the frames get taller, so every beat and every pointer sample has to shift down
by the chrome height or the cursor detaches and the zoom aims above its target.
"""
import json
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc",
         "/System/Library/Fonts/Supplemental/Arial.ttf"]
MONO = "/System/Library/Fonts/Menlo.ttc"

LIGHT = {
    "bar": (233, 233, 236), "tabbar": (222, 222, 226), "tab": (245, 245, 247),
    "line": (203, 203, 208), "text": (58, 58, 62), "dim": (128, 128, 136),
    "pill": (255, 255, 255), "icon": (110, 110, 118),
}
DARK = {
    "bar": (54, 55, 60), "tabbar": (42, 43, 47), "tab": (66, 67, 72),
    "line": (32, 33, 36), "text": (226, 226, 232), "dim": (150, 150, 158),
    "pill": (32, 33, 36), "icon": (176, 176, 184),
}


def font(size, mono=False):
    for p in ([MONO] if mono else FONTS):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def build_chrome(w, url, title, tabs, theme):
    """Return an RGB strip to sit above the page, and its height."""
    T = DARK if theme == "dark" else LIGHT
    s = w / 2560.0                      # every dimension is tuned at 2560 wide
    tb = round(78 * s)                  # tab strip
    ub = round(74 * s)                  # url toolbar
    h = tb + ub
    im = Image.new("RGB", (w, h), T["tabbar"])
    d = ImageDraw.Draw(im)

    # traffic lights
    r = round(11 * s)
    cy = tb / 2
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = round(34 * s) + i * round(32 * s)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)

    # tabs
    f = font(round(23 * s))
    x = round(150 * s)
    tw = round(430 * s)
    for i, t in enumerate(tabs[:4]):
        active = i == 0
        if active:
            d.rounded_rectangle([x, round(12 * s), x + tw, tb], radius=round(12 * s), fill=T["tab"])
        d.ellipse([x + round(20 * s), cy - round(8 * s), x + round(36 * s), cy + round(8 * s)],
                  fill=T["dim"] if not active else (90, 130, 240))
        label = t if len(t) < 26 else t[:25] + "…"
        d.text((x + round(52 * s), cy), label, font=f,
               fill=T["text"] if active else T["dim"], anchor="lm")
        d.text((x + tw - round(22 * s), cy), "×", font=f, fill=T["dim"], anchor="mm")
        x += tw + round(4 * s)
    d.text((x + round(24 * s), cy), "+", font=font(round(30 * s)), fill=T["dim"], anchor="mm")

    # toolbar
    d.rectangle([0, tb, w, h], fill=T["bar"])
    d.line([0, h - 1, w, h - 1], fill=T["line"], width=max(1, round(s)))
    uy = tb + ub / 2
    nav = font(round(28 * s))
    for i, g in enumerate(["‹", "›", "⟳"]):
        d.text((round(42 * s) + i * round(46 * s), uy), g, font=nav, fill=T["icon"], anchor="mm")

    px0, px1 = round(190 * s), w - round(190 * s)
    d.rounded_rectangle([px0, uy - round(20 * s), px1, uy + round(20 * s)],
                        radius=round(20 * s), fill=T["pill"], outline=T["line"], width=max(1, round(s)))
    d.text((px0 + round(26 * s), uy), "🔒", font=font(round(19 * s)), fill=T["dim"], anchor="lm")
    d.text((px0 + round(58 * s), uy), url, font=font(round(23 * s), mono=True),
           fill=T["text"], anchor="lm")
    for i, g in enumerate(["☆", "⋮"]):
        d.text((w - round(120 * s) + i * round(46 * s), uy), g, font=nav, fill=T["icon"], anchor="mm")
    return im, h


def main():
    shot = sys.argv[1]
    argv = sys.argv[2:]

    def opt(n, d=None):
        return argv[argv.index(n) + 1] if n in argv else d

    man_path = os.path.join(shot, "manifest.json")
    man = json.load(open(man_path))
    if man.get("chrome"):
        print("chrome: already applied")
        return

    src = os.path.join(shot, "frames-cur")
    if not os.path.isdir(src):
        src = os.path.join(shot, "frames")
    out = os.path.join(shot, "frames-chrome")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)

    w = man["width"]
    url = opt("--url", "")
    if not url:
        url = "localhost"
    title = opt("--title", url.split("/")[0])
    tabs = (opt("--tabs") or title).split("|")
    theme = opt("--theme", "light")

    strip, ch = build_chrome(w, url, title, tabs, theme)

    files = sorted(f for f in os.listdir(src) if f.endswith(".png"))
    for name in files:
        page = Image.open(os.path.join(src, name)).convert("RGB")
        im = Image.new("RGB", (page.width, page.height + ch))
        im.paste(strip, (0, 0))
        im.paste(page, (0, ch))
        im.save(os.path.join(out, name))

    # Everything positional moves down by the chrome height, or the cursor
    # detaches from the page and the zoom frames the toolbar instead.
    man["height"] = man["height"] + ch
    man["chrome"] = {"h": ch, "url": url, "theme": theme}
    for key in ("clicks", "path", "actions", "events"):
        for e in man.get(key, []):
            e["y"] = e["y"] + ch
            if "by" in e:            # events carry the element box too
                e["by"] = e["by"] + ch
    json.dump(man, open(man_path, "w"), indent=1)
    print(f"chrome: {len(files)} frames, +{ch}px {theme} chrome, url={url}")


if __name__ == "__main__":
    main()
