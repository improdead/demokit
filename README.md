# demokit

Agent-driven demo videos: drive a browser, record it, and get a customer-ready MP4 that looks
**edited, not raw** — the recording inset on a blurred backdrop with rounded corners and a drop
shadow, a synthetic cursor, click ripples, click-focused zoom, and dead air compressed. No
captions.

```bash
# 1. drive + trace the flow (playwriter). Record at 1920x1080 - see "sharpness".
playwriter -s <session> -e "$(cat flows/example.js)"

# 2. trace.zip -> polished MP4
node src/demo.mjs .cache/flow.zip out.mp4
#   --level 1.4   zoom depth        --inset 0.8   window size in frame
#   --bias 0.4    pull toward centre --gap 1500    merge clicks closer than this
#   --keep 1.35   normal-speed pad   --speed 4     idle speed-up
```

Three passes, in this order:

1. **recast** — cursor overlay + click ripples only.
2. **`src/frame.mjs`** — inset frame, rounded corners, shadow, blurred backdrop, click zoom.
3. **`src/pace.mjs`** — compress the gaps between zooms.

## Why it's built this way

The pieces already existed; almost none of them fit together out of the box.

| Layer | What we use | Why |
| --- | --- | --- |
| Authenticated tab control | **playwriter** (installed) | Extension + CDP into the user's real Chrome. No physical mouse movement, no re-login. |
| Action trace | `context.tracing` **through the playwriter relay** | Verified working — yields a real `trace.zip` with per-click `point{x,y,timestamp}`. |
| Cursor + click ripples | **playwright-recast** (MIT) | These phases work well and are not worth rewriting. |
| Frame, backdrop, zoom | **`src/frame.mjs` (ours)** | recast's zoom phase does not land on an externally-produced trace — see below. |
| Pacing | **`src/pace.mjs` (ours)** | Must run after zoom, and recast's own speed-up runs before it. |

## Findings worth keeping

**1. `crop` has no `eval` option on `ffmpeg-static` 6.0.**
Any renderer built on `crop=w=…:h=…:x=…:y=…:eval=frame` dies with
`Error applying option 'eval' to filter 'crop': Option not found`. Use `zoompan`, whose
`z`/`x`/`y` expressions are evaluated per frame by design.

**2. ffmpeg's `min()` is binary.**
`min(a, b, 1)` is not a clamp — it fails at filter-config time with the deeply unhelpful:

```
Failed to configure output pad on Parsed_zoompan_0
Failed to inject frame into filter network: Invalid argument
```

Nest instead: `min(min(a, b), 1)`. This cost an hour. **The same 3-argument `min` appears in
`demo-agent/packages/review-capture/review_capture/postprocess.py` (`_zoom_filters`)** — worth
checking against whichever ffmpeg that runs on, since it would fail the same way.

**3. zoompan expressions take plain commas.** Do not escape them as `\,`, and do not both quote
and escape — that yields a literal backslash inside the expression and an invalid parse.

**4. Zoom without captions is possible.** `autoZoom()` throws without `subtitles()` because zoom
is stored as `subtitle.zoom`, and the renderer gate is
`trace.subtitles?.some(s => s.zoom && s.zoom.level > 1.0)`. But `burnSubtitles` and
`embedSubtitles` both default off, so synthetic cues that are never drawn give you zoom with a
clean picture.

**5. Speed-up must come *after* zoom.** recast prints click times in pre-speed-up time, so
enabling `speedUp()` in pass 1 desynchronises every zoom keyframe (in testing, 1 of 3 landed).
Idle regions carry no zoom envelope, so compressing them after the zoom pass is safe — that's the
correct order, and why `speedUp()` is currently off.

**6. recast's zoom phase does not land on an external trace.** It logs
`Zoom: zoompan single-pass (3 keyframes, 25fps, easing: ease-in-out)` and exits 0, but the output
is unzoomed. Reproduced with both `autoZoom()` and `enrichZoomFromReport()`, with `fps` pinned,
and with a filter string that is correct when inspected. Cursor overlay and click ripples from the
same run *do* land, so it is isolated to the zoom phase. Hence pass 2.

## Making it look edited

Four things separate this from a raw screen capture, and all four were needed:

**The recording is inset, not full-bleed.** Filling the frame makes a demo read as permanently
zoomed in. At ~80% with a blurred blow-up of itself behind, the rest state reads as a window on a
desk, so the zoom has somewhere to go.

**Smoothstep easing.** The envelope was linear at first, and a linear ramp is exactly what makes a
zoom feel mechanical — it starts and stops abruptly at both ends. `3e² − 2e³` fixes it.

**Clicks closer than `--gap` collapse into one zoom.** Clicking every ~2s with a 2.5s envelope
gives one continuous push and no rest state at all. This was the single biggest cause of "it looks
zoomed in the normal as well".

**Centre bias.** A click on a left-hand nav rail sits at ~0.14 of frame width; zooming straight at
it shoves the window off-screen. `--bias` blends each target toward frame centre.

The crop centre is the **envelope-weighted blend** of all click points, and the level is `max()`
over envelopes rather than a sum, so overlapping zooms don't compound.

## Sharpness

Record at the resolution you intend to output. Playwright's trace screencast captures at **CSS
viewport size and ignores `deviceScaleFactor`** — verified: a 1280×720 viewport at DSF 2 still
yields 1280×720 frames. A 1280 source upscaled into a 1920 frame is visibly soft; a 1920 source
downscaled into the 1536 inset is sharp.

`chrome.tabCapture` via playwriter would be better still (native resolution, true 30fps) but needs
the extension clicked on the tab, and its time base differs from the trace.

## Setup

`ffmpeg` and `ffprobe` are required and are **not** assumed to be on the system — there's no
Homebrew on this machine. They're vendored:

```bash
cd .tools && npm i          # ffmpeg-static, ffprobe-static, playwright-recast
```

`src/zoom.mjs` shells out to whatever `ffmpeg`/`ffprobe` are on `PATH`; symlinks into
`~/.local/bin` are created by the setup above.

## Layout

```
src/frame.mjs    compositor: inset frame, backdrop, shadow, click zoom
src/pace.mjs     idle speed-up (runs after zoom)
src/demo.mjs     trace.zip -> MP4 orchestrator
vendor/          shallow clones: playwriter, playwright-recast, openscreen (reference)
.tools/          vendored ffmpeg + recast
.cache/          traces and renders (gitignored)
```

## Not done yet

- Storyboard / rehearse / per-scene retry. The interesting part, and the part that genuinely
  doesn't exist anywhere — belongs in a skill, not an MCP server, since playwriter already is the
  MCP and CLI layer.
- Redaction. Nothing blurs API keys or customer data yet.
- `chrome.tabCapture` as the video source — see "sharpness".
- A synthetic browser chrome bar (traffic lights + URL pill) above the content. A tab screencast
  has no browser UI, and the reference demos lean on it heavily.
