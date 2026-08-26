# demokit

Agent-driven product demo videos. Point it at a URL with a list of steps; get back a
customer-ready MP4 that looks **edited, not raw** — the recording inset on a blurred backdrop with
rounded corners and a drop shadow, one synthetic cursor, click ripples, click-focused zoom, and
dead air compressed. No captions.

```bash
cd .tools && npm i && cd ..          # vendored ffmpeg/ffprobe (no Homebrew needed)
./bin/demokit probe https://app.example.com     # look before you plan
./bin/demokit flows/example.json out/demo.mp4
```

That is the whole thing: it creates or reuses a headless playwriter session, captures, and renders.
Re-render without re-capturing (frames are already on disk):

```bash
./bin/demokit --render-only .cache/shot-example out/demo.mp4 --level 1.6
```

## What this is

A **CLI** plus a **skill**. Not an MCP server — playwriter is already the MCP layer for browser
control, and rendering is a batch job with no reason to be a tool call.

- `bin/demokit` — the command.
- `skill/SKILL.md` — how an agent *plans* a demo: probe the app, write the claim, write the state
  ledger, seed the preconditions, film, verify against objective checks. Symlinked into
  `.claude/skills/demo-video`, so Claude Code loads it when you ask for a demo video.

Run the session from this directory: playwriter's sandbox scopes file writes to the session's cwd,
so a session created elsewhere cannot write frames here. `bin/demokit` handles that for you.

Three passes: `cursor.py` draws the pointer and click pulses onto the frames, `render.mjs`
composites the framed shot and the zoom, `pace.mjs` compresses the dead air.

## Planning: probe before you write a flow

```
$ ./bin/demokit probe http://127.0.0.1:8893/
--- probe: Trident · Findings ---
headings   : Findings
top actions: (none)
inputs     : 0 | tables: 0 | repeaters: -
api calls  : GET http://127.0.0.1:8893/api/findings
verdict    : empty=true authWalled=false dataSignals=0 stubbable=true
empty hints: No findings yet
```

Read-only — it clicks nothing, so it is safe against production. `.cache/probe.json` also carries
stability-ranked selectors (id → data-testid → aria-label → text → class) for every button, link
and input, which is what you write the flow from.

The verdict is the decision: `empty=true stubbable=true` means the environment has nothing to film
and the API surface is the place to seed it.

## Describing a flow

```json
{
  "claim": "A security engineer will believe Trident writes the patch itself, in two clicks.",
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
capture, rather than a silently empty video ten minutes later. A step whose target legitimately
does not exist yet — a drawer, a generated diff — takes `"later": true`, which excuses that one
step and keeps validating the rest. The flow-wide `"allowMissing"` escape hatch exists but silences
the genuinely broken steps too.

`"expect": {"sel": "…"}` asserts the step actually did something. A click that lands and silently
does nothing otherwise records a confident zoom onto nothing, which is the failure mode this whole
tool exists to avoid.

## Seeding: filming an empty environment honestly

Everything under `seed` is installed as an init script **before the first navigation** — setting it
afterwards is the classic mistake, because the app has already read storage and rendered its empty
state.

```json
"seed": {
  "clock": "2026-08-26T15:41:00Z",
  "localStorage": { "onboarded": "true" },
  "routes": [
    { "url": "**/api/findings*", "file": "fixtures/findings.json", "delayMs": 380 }
  ]
}
```

**The glob is matched against the full URL including the query string.** `**/api/findings` does not
match `/api/findings?status=open` — verified the hard way; the stub silently never fires and the
app renders its empty state. Always suffix `*`.

`file` keeps fabricated data in one committed, reviewable place instead of inline in the flow. The
worked example generates it from a single script so that derived numbers are computed rather than
typed, and take 2 is identical to take 1:

```
fixtures/gen-findings.mjs  ->  fixtures/findings.json  <-  flows/seeded-example.json
```

Run it end to end against `examples/findings-app` — an app whose findings list is genuinely empty
but whose patch generator genuinely works. See `examples/findings-app/README.md`.

The rule the skill enforces: **seed the inputs, never the payoff.** Filling an empty queue with
twelve realistic findings so the product can generate a patch is a demo; stubbing the
generate-patch response is a lie. `hide` (visibility) removes chat widgets and cookie banners;
`redact` (9px blur) exists but substituting a fabricated value beats blurring a real one — a blur
box announces that real customer data is on screen, and the zoom pushes right into it.

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

## The screencast only fires on repaints

`Page.startScreencast` emits a frame when the page **composites a new frame**, not on a clock. That
is efficient and quietly wrong for a demo, because the synthetic cursor is invisible to the page:

- A pointer gliding across a static screen produces **no frames**, so the drawn cursor freezes and
  then teleports when something finally repaints.
- A held payoff — the diff on screen, nothing animating — produces no frames either, so the frame
  timeline just *ends*. Measured on a 13.8s take: the last frame landed at 7.5s and the final beat
  at 10.1s was outside the video entirely. The hold you carefully wrote is silently cut.

Two fixes, both needed. `record.js` nudges the alpha of a 1px fixed element after every pointer
sample (and at ~7fps while dwelling) — a real paint invalidation that costs nothing visually; the
same take went 155 → 260 frames and 7.5s → 13.7s of coverage. And the manifest carries `endMs`, the
true end of capture, so `render.mjs` holds the last frame instead of giving it `1/fps`.

Budget roughly **6MB/s of capture** in full-resolution PNGs at 2560×1440.

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

**The tail after the final beat is not idle.** It is the payoff hold — resting on the outcome is the
whole point of the ending — so `planSegments` keeps `tailHold` (3.5s) of it at normal speed and only
compresses what is beyond. Speeding it up is how a demo ends on a jump cut.

## The cursor

Two cursors, deliberately, and this is the part worth copying:

- **Operating pointer** — resolve a semantic locator, take its bounding box, move and click through
  CDP. Never guessed coordinates.
- **Drawn pointer** — rendered at export from the logged path. Nothing about the real pointer is
  ever captured; a headless screencast has no cursor at all.

The subtlety is what gets logged. Beats and pointer path are also shifted onto the frame clock
before they are written — they are timed from capture start, the frames from the first frame to
arrive, and the difference is enough to put a ripple on the wrong frame.

Recording only the *beats* and reconstructing an eased line
between them looks fine until something is dragged: the page follows the real pointer while the
drawn one takes a different route, and the cursor visibly detaches from the thing it is supposedly
moving. `page.mouse.move({steps})` interpolates internally and reports nothing, so `record.js`
does the interpolation itself and logs **every** intermediate position, including during drags and
while dwelling.

`cursor.py` then interpolates that path at each frame's own timestamp and composites the sprite
with its tip on the exact point. Done in PIL rather than as an ffmpeg overlay because the path is
hundreds of samples and an overlay expression would have to encode all of them as one nested
`if()` chain.

Click pulses come from the action log, so they fire on real presses only — a hover beat gets a zoom
but no ripple. The sprite shrinks slightly between `down` and `up` so a drag reads as held.

`record.js` also checks `document.elementFromPoint` after moving and warns when something with a
higher z-index covers the target — which is exactly how the earlier "the drag selects text instead
of grabbing" bug was found.

## Not using playwright-recast

It was the starting point and is no longer used. Its `cursorOverlay` is fed from trace coordinates
in a different space, so it drew a *second*, drifting cursor beside the real one — and its zoom
phase logs success but never lands on an externally-produced trace (reproduced with `autoZoom()`,
with `enrichZoomFromReport()`, and with `fps` pinned). Drawing the cursor and ripples ourselves from
the recorder's own beat log means there is exactly one cursor and it is always on target.

## Layout

```
examples/        a deliberately empty app to run the worked example against
flows/           flow definitions (JSON)
fixtures/        fabricated data, generated by a script and committed so it can be reviewed
src/probe.js     read-only page recon: what is this, is it empty, what could be stubbed
src/record.js    capture: CDP PNG screencast + dense pointer path (runs inside playwriter)
src/cursor.py    draws cursor + click pulses onto the frames (per-frame, exact)
src/render.mjs   frame, backdrop, shadow, zoom — one ffmpeg graph
src/pace.mjs     idle speed-up (after zoom)
src/demo.mjs     shot dir -> MP4
vendor/          shallow clones kept for reference: playwriter, playwright-recast, openscreen
.tools/          vendored ffmpeg + ffprobe
.cache/shot-<flow>/  frames + manifest, one dir per flow (gitignored)
```

## Not done

- **No browser chrome.** A tab screencast has no traffic lights or URL bar; the reference demos
  lean on it. It would have to be drawn synthetically.
- **No captions, audio, or text cards**, by design — every load-bearing fact has to be legible in
  the UI itself.
- **Streaming responses can't be stubbed.** `route.fulfill` buffers, so an SSE/NDJSON progressive UI
  collapses into one pop. Point the app at a local server instead.
- **Timezone can't be pinned**, only the instant.
- `chrome.tabCapture` (true 30fps, native res) needs the extension clicked on the tab, so headless
  runs can't use it.
