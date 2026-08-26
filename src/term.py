#!/usr/bin/env python3
"""
Record a terminal session OFFSCREEN and render it to frames.

    python3 src/term.py <shotDir> --cmd "bash demo.sh" [--cols 100] [--rows 28]

Screen-recording a terminal window is the obvious approach and the wrong one:
it steals focus, it captures whatever else is on the desktop, it is pinned to
the window's real size, and it needs the screen-recording permission. Instead
this runs the command in a pty, keeps its own model of the screen, and paints
frames with PIL. Nothing is displayed, so it runs in the background while the
machine is being used for something else, and the output is crisp at whatever
resolution you ask for rather than whatever the window happened to be.

Beats come from src/beats.py, which watches what changed - there is no cursor
to log here, which is exactly the case it exists for.
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import termios
import time

from PIL import Image, ImageDraw, ImageFont

# One dark theme, tuned so the ANSI colours stay legible after x264.
THEME = {
    "bg": (22, 24, 30), "fg": (222, 228, 236), "dim": (128, 138, 152),
    "chrome": (32, 35, 43), "title": (150, 158, 170),
    "ansi": [
        (60, 64, 74), (233, 105, 106), (126, 199, 130), (222, 178, 92),
        (109, 163, 232), (186, 137, 226), (95, 191, 197), (200, 206, 214),
        (90, 96, 108), (247, 138, 138), (154, 220, 158), (240, 200, 120),
        (140, 186, 244), (206, 167, 240), (128, 214, 219), (236, 240, 246),
    ],
}
FONT_CANDIDATES = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"]


class Screen:
    """A deliberately small VT subset: enough for scripted command demos.

    Handles printable text, \\r \\n \\b \\t, SGR colours (including 256), cursor
    positioning and the erase sequences. A full-screen TUI (vim, htop) will not
    render correctly and is out of scope - the target is a sequence of commands
    and their output, which is what a demo of a CLI actually is.
    """

    CSI = re.compile(rb"\x1b\[([0-9;?]*)([A-Za-z])")

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.reset_attrs()
        self.clear()

    def reset_attrs(self):
        self.fg, self.bg, self.bold, self.dim = None, None, False, False

    def clear(self):
        self.cells = [[(" ", None, None, False, False) for _ in range(self.cols)]
                      for _ in range(self.rows)]
        self.cx = self.cy = 0

    def snapshot(self):
        return tuple(tuple(r) for r in self.cells)

    def _put(self, ch):
        if self.cx >= self.cols:
            self.cx = 0
            self._newline()
        self.cells[self.cy][self.cx] = (ch, self.fg, self.bg, self.bold, self.dim)
        self.cx += 1

    def _newline(self):
        self.cy += 1
        if self.cy >= self.rows:          # scroll
            self.cells.pop(0)
            self.cells.append([(" ", None, None, False, False) for _ in range(self.cols)])
            self.cy = self.rows - 1

    def _sgr(self, params):
        ps = [int(p) for p in params.split(";") if p != ""] or [0]
        i = 0
        while i < len(ps):
            p = ps[i]
            if p == 0:
                self.reset_attrs()
            elif p == 1:
                self.bold = True
            elif p == 2:
                self.dim = True
            elif p == 22:
                self.bold = self.dim = False
            elif 30 <= p <= 37:
                self.fg = p - 30
            elif 90 <= p <= 97:
                self.fg = p - 90 + 8
            elif 40 <= p <= 47:
                self.bg = p - 40
            elif p == 39:
                self.fg = None
            elif p == 49:
                self.bg = None
            elif p in (38, 48) and i + 2 < len(ps) and ps[i + 1] == 5:
                v = ps[i + 2]
                col = v if v < 16 else None
                if p == 38:
                    self.fg = col
                else:
                    self.bg = col
                i += 2
            i += 1

    def feed(self, data):
        i = 0
        while i < len(data):
            b = data[i:i + 1]
            if b == b"\x1b":
                m = self.CSI.match(data, i)
                if m:
                    params, cmd = m.group(1).decode("ascii", "ignore"), m.group(2)
                    self._csi(params, cmd)
                    i = m.end()
                    continue
                i += 2                     # skip an escape we do not model
                continue
            if b == b"\n":
                self._newline()
                self.cx = 0
            elif b == b"\r":
                self.cx = 0
            elif b == b"\b":
                self.cx = max(0, self.cx - 1)
            elif b == b"\t":
                self.cx = min(self.cols - 1, (self.cx // 8 + 1) * 8)
            elif b >= b" ":
                try:
                    # decode as much valid utf-8 as we can from here
                    ch = data[i:i + 4].decode("utf-8", "ignore")[:1] or " "
                except Exception:
                    ch = " "
                self._put(ch)
                i += len(ch.encode("utf-8")) - 1
            i += 1

    def _csi(self, params, cmd):
        ps = [int(p) for p in params.split(";") if p.isdigit()]
        n = ps[0] if ps else 1
        if cmd == b"m":
            self._sgr(params)
        elif cmd == b"H":
            self.cy = min(self.rows - 1, max(0, (ps[0] if ps else 1) - 1))
            self.cx = min(self.cols - 1, max(0, (ps[1] if len(ps) > 1 else 1) - 1))
        elif cmd == b"A":
            self.cy = max(0, self.cy - n)
        elif cmd == b"B":
            self.cy = min(self.rows - 1, self.cy + n)
        elif cmd == b"C":
            self.cx = min(self.cols - 1, self.cx + n)
        elif cmd == b"D":
            self.cx = max(0, self.cx - n)
        elif cmd == b"G":
            self.cx = min(self.cols - 1, max(0, n - 1))
        elif cmd == b"J":
            mode = ps[0] if ps else 0
            if mode == 2:
                self.clear()
            elif mode == 0:
                for y in range(self.cy + 1, self.rows):
                    self.cells[y] = [(" ", None, None, False, False) for _ in range(self.cols)]
        elif cmd == b"K":
            for x in range(self.cx, self.cols):
                self.cells[self.cy][x] = (" ", None, None, False, False)


def record(cmd, cols, rows, fps, max_seconds):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows),
               PS1="", CLICOLOR="1")
    p = subprocess.Popen(cmd, shell=True, stdin=slave, stdout=slave, stderr=slave,
                         close_fds=True, env=env, preexec_fn=os.setsid)
    os.close(slave)

    scr = Screen(cols, rows)
    snaps, last, t0, sampled = [], None, time.time(), 0.0
    while True:
        now = time.time()
        if now - t0 > max_seconds:
            break
        r, _, _ = select.select([master], [], [], 1.0 / (fps * 2))
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            scr.feed(data)
        if time.time() - sampled >= 1.0 / fps:
            sampled = time.time()
            s = scr.snapshot()
            if s != last:
                snaps.append((int((sampled - t0) * 1000), s))
                last = s
        if p.poll() is not None and not r:
            break
    try:
        os.close(master)
    except OSError:
        pass
    try:
        p.wait(timeout=2)
    except Exception:
        p.kill()
    return snaps, time.time() - t0


def trim(snaps, rows, keep_min=6):
    """Shrink the window to the rows that were ever used.

    A 24-row terminal running an 8-line demo renders a mostly-empty rectangle,
    and the zoom then has to push into a small island of text. Fitting the
    window to the content is the difference between a demo and a screenshot of
    an empty terminal.
    """
    used = 0
    for _ms, grid in snaps:
        for y in range(rows - 1, used - 1, -1):
            if any(c[0] != " " or c[2] is not None for c in grid[y]):
                used = max(used, y + 1)
                break
    used = max(keep_min, min(rows, used + 1))     # +1 blank row for the prompt
    if used == rows:
        return snaps, rows
    return [(ms, grid[:used]) for ms, grid in snaps], used


def render(snaps, out_dir, cols, rows, width, title):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            font_path = path
            break
    else:
        raise SystemExit("term: no monospace font found")

    # Size the glyph so `cols` columns fill the text area exactly.
    pad = round(width * 0.028)
    chrome_h = round(width * 0.021)
    size = 8
    while True:
        f = ImageFont.truetype(font_path, size)
        cw = f.getlength("M")
        if cw * cols > width - pad * 2 or size > 400:
            size -= 1
            break
        size += 1
    font = ImageFont.truetype(font_path, size)
    bold = ImageFont.truetype(font_path, size)      # Menlo.ttc index 0 is regular
    cw = font.getlength("M")
    asc, desc = font.getmetrics()
    ch = asc + desc + max(1, round(size * 0.22))
    height = chrome_h + pad * 2 + int(ch * rows)
    height += (height % 2)
    W = width + (width % 2)

    T = THEME
    for n, (_ms, grid) in enumerate(snaps):
        im = Image.new("RGB", (W, height), T["bg"])
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, W, chrome_h], fill=T["chrome"])
        r = chrome_h * 0.22
        for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            cx = chrome_h * 0.75 + i * chrome_h * 0.62
            d.ellipse([cx - r, chrome_h / 2 - r, cx + r, chrome_h / 2 + r], fill=col)
        tf = ImageFont.truetype(font_path, max(9, round(chrome_h * 0.36)))
        d.text((W / 2, chrome_h / 2), title, font=tf, fill=T["title"], anchor="mm")

        y0 = chrome_h + pad
        for ry, row in enumerate(grid):
            y = y0 + ry * ch
            for rx, (c, fg, bg, bd, dm) in enumerate(row):
                if bg is not None:
                    d.rectangle([pad + rx * cw, y, pad + (rx + 1) * cw, y + ch], fill=T["ansi"][bg])
                if c == " ":
                    continue
                col = T["ansi"][fg] if fg is not None else (T["dim"] if dm else T["fg"])
                d.text((pad + rx * cw, y), c, font=bold if bd else font, fill=col)
        im.save(os.path.join(out_dir, "f%05d.png" % n))
    return W, height


def main():
    shot = sys.argv[1]
    argv = sys.argv[2:]

    def opt(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default

    cmd = opt("--cmd")
    if not cmd:
        raise SystemExit('term: --cmd "…" is required')
    cols, rows = int(opt("--cols", 96)), int(opt("--rows", 26))
    fps = int(opt("--fps", 20))
    width = int(opt("--width", 2560))
    title = opt("--title", "zsh")
    max_seconds = float(opt("--max-seconds", 180))

    shutil.rmtree(shot, ignore_errors=True)
    os.makedirs(os.path.join(shot, "frames"), exist_ok=True)

    print(f"term: running {cmd!r} at {cols}x{rows}, offscreen")
    snaps, dur = record(cmd, cols, rows, fps, max_seconds)
    if not snaps:
        raise SystemExit("term: the command produced no output")
    snaps, used_rows = trim(snaps, rows)
    if used_rows != rows:
        print(f"term: fitted window to {used_rows} used rows (of {rows})")
    w, h = render(snaps, os.path.join(shot, "frames"), cols, used_rows, width, title)

    json.dump({
        "width": w, "height": h, "layout": [w, h], "zoom": 1, "dsf": 1,
        "source": "term",
        "endMs": int(dur * 1000),
        "frames": [{"i": i, "ms": ms} for i, (ms, _) in enumerate(snaps)],
        "clicks": [], "path": [], "actions": [],
    }, open(os.path.join(shot, "manifest.json"), "w"), indent=1)

    print(f"term: {len(snaps)} frames @ {w}x{h}, {dur:.1f}s -> {shot}")


if __name__ == "__main__":
    main()
