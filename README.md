# demokit

Agent-driven product demo videos. Point it at a URL with a list of steps; get back a
customer-ready MP4 that looks **edited, not raw** — the recording inset on a blurred backdrop with
rounded corners and a drop shadow, one synthetic cursor, click ripples, click-focused zoom, and
dead air compressed. No captions.

```bash
cd .tools && npm i && cd ..                 # vendored ffmpeg/ffprobe (no Homebrew needed)
playwriter session new --browser headless   # or use your real Chrome session

DEMOKIT_FLOW=flows/example.json playwriter -s <id> -f src/record.js
node src/demo.mjs .cache/shot out.mp4
```

## Describing a flow

```json
{
  "url": "https://app.example.com/scans",
  "layout": [1280, 720],
  "zoom": 2,
  "steps": [
    { "do": "wait",   "ms": 900 },
    { "do": "click",  "sel": "button:has-text('Run scan')", "label": "kick off a scan" },
    { "do": "wait",   "ms": 4000 },
    { "do": "click",  "sel": "[data-finding]", "nth": 0, "label": "open the finding" },
    { "do": "hover",  "sel": ".patch-diff", "label": "the patch" },
    { "do": "type",   "sel": "input[name=q]", "text": "sql injection", "label": "search" }
  ]
}
```

| step | what it does |
| --- | --- |
| `wait` | `ms` only |
| `hover` / `move` | glide the cursor there and dwell |
| `click` | glide, then click |
| `pulse` | press and release in place (no navigation) |
| `drag` | grab and move by `by: [dx, dy]`, and **verify** the element actually moved |
| `type` | click, then type `text` |
| `scrollTo` | bring the selector into view (no beat) |
| `key` | press `key` |

Every step with a selector becomes a **beat** — a zoom anchor — unless you set `"beat": false`.
`nth` picks among matches. `label` shows up in logs.

**Selectors are preflighted before recording.** If one matches nothing you get a list and no
capture, rather than a silently empty video ten minutes later.

## Render options

```
node src/demo.mjs <shotDir> <out.mp4>
  --level 1.35   zoom depth          --inset 0.84  window size within the frame
  --bias 0.4     pull toward centre  --gap 1500    merge beats closer than this (ms)
  --keep 1.35    normal-speed pad    --speed 4     idle speed-up
  --w 1920 --h 1080                  delivery size
```

## Sharpness — where it actually goes

This took several wrong turns, so the findings are worth keeping.

**Playwright's trace screencast is a thumbnail.** Frames are **800×450 JPEG**, always. The trace
metadata reports the *page* size, which is what makes it so easy to miss — you believe you have HD
frames while upscaling a lossy thumbnail 2.4×. Verified by opening the zip: every `resources/`
entry is `JPEG (800, 450)`.

**`Page.startScreencast` captures CSS pixels and ignores `deviceScaleFactor`.**
`Emulation.setDeviceMetricsOverride` with DSF 2 still yields 1280×720 frames — and Playwright
re-applies its own metrics on navigate, wiping the override anyway. The way to get 2× pixels is a
2× viewport plus `html{zoom:2}`: the page lays out as if it were `layout` wide but renders at 2×.
`getBoundingClientRect` returns zoomed coordinates, so beats stay 1:1 with frame pixels.

**Half of "blurry" was really scale.** A 680px content column inside a 1920 viewport is tiny in
frame, and small type reads as soft however many pixels it has. Hence `layout` — you choose the
*apparent* size, and `zoom` buys the resolution.

**Composite at capture resolution, downscale once.** Building the composite at 1080p and letting
`zoompan` upscale 1.35× throws away the 2560 capture at exactly the moment the viewer is looking
closest. Instead the whole composite is built at 2560×1440, `zoompan` crops from that, and a single
lanczos downscale to 1080p happens last. Measured +46% edge energy on a text region.

## ffmpeg traps

**`crop` has no `eval` option on `ffmpeg-static` 6.0.** Anything built on `crop=…:eval=frame` dies
with `Option not found`. `zoompan` evaluates per frame by design — but it cannot zoom below 1.0,
which is why the downscale is a separate final step.

**`min()` is binary.** `min(a, b, 1)` is not a clamp; it fails at filter-config time with
`Failed to configure output pad`. Nest it: `min(min(a, b), 1)`. This cost an hour. The same
three-argument `min` appears in `demo-agent/packages/review-capture/review_capture/postprocess.py`
(`_zoom_filters`) and would fail the same way.

**zoompan expressions take plain commas.** Don't escape them as `\,`, and never both quote *and*
escape — that puts a literal backslash inside the expression.

## Making it look edited

**Inset, not full-bleed.** Filling the frame reads as permanently zoomed in. At ~84% over a blurred
blow-up of itself, the rest state reads as a window on a desk, so the zoom has somewhere to go.

**Smoothstep easing.** A linear ramp starts and stops abruptly at both ends — that is exactly what
makes a zoom feel mechanical. `3e² − 2e³`.

**Beats closer than `--gap` collapse into one zoom.** Beats every ~2s with a 2.5s envelope give one
continuous push and no rest state at all — the single biggest cause of "it looks zoomed in the
normal state too".

**Centre bias.** A click on a left-hand rail sits at ~0.14 of frame width; zooming straight at it
shoves the window off-screen. `--bias` blends each target toward the centre.

The crop centre is the envelope-weighted blend of all beats, and the level is `max()` over
envelopes rather than a sum, so overlapping zooms don't compound.

**Pacing runs last.** Zoom envelopes live in video time, so compressing first desynchronises every
keyframe. Idle regions carry no envelope, which is why speeding them up afterwards is safe.

## Not using playwright-recast

It was the starting point and is no longer used. Its `cursorOverlay` is fed from trace coordinates
in a different space, so it drew a *second*, drifting cursor beside the real one — and its zoom
phase logs success but never lands on an externally-produced trace (reproduced with `autoZoom()`,
with `enrichZoomFromReport()`, and with `fps` pinned). Drawing the cursor and ripples ourselves from
the recorder's own beat log means there is exactly one cursor and it is always on target.

## Layout

```
flows/           flow definitions (JSON)
src/record.js    capture: CDP PNG screencast + beat log (runs inside playwriter)
src/render.mjs   cursor, ripples, frame, backdrop, zoom — one ffmpeg graph
src/pace.mjs     idle speed-up (after zoom)
src/demo.mjs     shot dir -> MP4
vendor/          shallow clones kept for reference: playwriter, playwright-recast, openscreen
.tools/          vendored ffmpeg + ffprobe
.cache/          frames and renders (gitignored)
```

## Not done

- **No browser chrome.** A tab screencast has no traffic lights or URL bar; the reference demos
  lean on it. It would have to be drawn synthetically.
- Cursor path is reconstructed as an eased travel into each beat rather than logged per move.
- No redaction — nothing blurs API keys or customer data yet.
- `chrome.tabCapture` (true 30fps, native res) needs the extension clicked on the tab, so headless
  runs can't use it.
