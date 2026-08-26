# demokit

Agent-driven demo videos: drive your **real logged-in Chrome tab**, record it, and get a
customer-ready MP4 with click-focused zoom, a synthetic cursor, click ripples and idle
speed-up. No captions.

```bash
# 1. drive + trace the flow (playwriter, in your authenticated Chrome)
playwriter -s <session> -e "$(cat flows/example.js)"

# 2. trace.zip -> polished MP4
node src/demo.mjs /tmp/demo-trace.zip out.mp4 --level 1.9 --viewport 1280x720
```

## Why it's built this way

The pieces already existed; almost none of them fit together out of the box.

| Layer | What we use | Why |
| --- | --- | --- |
| Authenticated tab control | **playwriter** (installed) | Extension + CDP into the user's real Chrome. No physical mouse movement, no re-login. |
| Action trace | `context.tracing` **through the playwriter relay** | Verified working — yields a real `trace.zip` with per-click `point{x,y,timestamp}`. |
| Cursor, click ripples, speed-up | **playwright-recast** (MIT) | These phases work well and are not worth rewriting. |
| Click-focused zoom | **`src/zoom.mjs` (ours)** | recast's zoom phase does not land on an externally-produced trace — see below. |

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

## The zoom

`src/zoom.mjs` applies a smooth trapezoid per click — ease in, hold, ease out — where the crop
centre is the **envelope-weighted blend** of all click points, so the active click stays framed and
overlapping clicks don't compound (`max()` over envelopes, not sum).

Unlike the 12-event cap in `postprocess.py`, the expression here is linear in click count and has
been run without trouble at the sizes a 45-second demo produces.

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
src/zoom.mjs     click-focused zoom pass (standalone, importable)
src/demo.mjs     trace.zip -> MP4 orchestrator
vendor/          shallow clones: playwriter, playwright-recast, openscreen (reference)
.tools/          vendored ffmpeg + recast
```

## Not done yet

- Idle speed-up as a third pass, after zoom. Straightforward: trim/`setpts`/concat over the gaps
  between zoom envelopes, the same shape as playwriter's `speedUpSections`.
- Storyboard / rehearse / per-scene retry. The interesting part, and the part that genuinely
  doesn't exist anywhere — belongs in a skill, not an MCP server, since playwriter already is the
  MCP and CLI layer.
- Redaction. Nothing blurs API keys or customer data yet.
- Using playwriter's `chrome.tabCapture` recording (true 30fps) as the video source instead of the
  trace's variable-rate screencast frames. recast will pick up a `.webm` sitting next to the trace,
  but the two time bases differ and recast auto-trims blank lead frames, so this needs alignment
  work.
