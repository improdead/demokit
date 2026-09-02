# demokit

## Install

```bash
npm install -g @dekai/demokit      # Node 18+; ships a static ffmpeg
pip3 install pillow numpy              # the renderer is Python
```

That is the whole install. No Docker, no browser extension. The first recording
downloads a headless Chromium (~100MB) once.

```bash
demokit local flows/example.json out/demo.mp4          # record + render + verify
DEMOKIT_COOKIES=cookies.json demokit local flows/app.json out/demo.mp4   # behind a login
```

Work files (frames, the edit, the pace map, verification strips) land in `./.demokit/` next to
where you ran it — add it to `.gitignore`. Set `DEMOKIT_WORK` to put them elsewhere.

For anything behind a login, export cookies from a browser that is already
signed in and point `DEMOKIT_COOKIES` at the file. They are injected before the
first navigation; no password is ever handled.

Three capture paths, one renderer:

| path | what it records | needs |
| --- | --- | --- |
| `demokit local` | a headless Chromium demokit launches itself — the default | nothing extra |
| `demokit box` | Chromium inside a Linux container with a real X11 pointer | Docker (2GB image) — only if you want it |
| `demokit termreal` | your real Terminal.app, filmed | macOS, Screen Recording + Accessibility |

Everything downstream of capture is the same: the Cap-style renderer (spring zoom
on clicks, the recorded cursor shape, wallpaper, squircle, shadow), dead-air
fast-forward, and a verification pass that checks the *feature* worked before
anyone judges the film. The renderer ships no wallpaper and no cursor bitmaps:
on a Mac it reads one of Apple's own wallpapers from disk at run time and draws
the cursors as vectors; drop a Cap recording's `cursors/` and
`desktop-background.jpg` into `.cache/cap/` to use those instead.


Agent-driven product demo videos. Point it at a URL with a list of steps; get back a
customer-ready MP4 that looks **edited, not raw** — the recording inset on a blurred backdrop with
rounded corners and a drop shadow, one synthetic cursor, click ripples, click-focused zoom, and
dead air compressed. No captions.

```bash
cd .tools && npm i && cd ..                      # vendored ffmpeg/ffprobe (no Homebrew needed)
./bin/demokit probe https://app.example.com      # look before you plan
./bin/demokit flows/example.json out/demo.mp4    # a web app
./bin/demokit term "pytest -q" out/tests.mp4     # a CLI, rendered offscreen
./bin/demokit screen out/app.mp4 --seconds 30    # a native app / the desktop
./bin/demokit review .cache/shot-example out/demo.mp4 --fix
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
  --bg auto      backdrop            --w 1920 --h 1080   delivery size
```

## The backdrop

`--bg` takes a preset (`dusk` `ember` `tide` `slate` `noir` `linen`), a hex colour, an image path,
or `blur`. Default is `auto`: it measures the first frame's mean luminance and picks a ground that
*separates* from the recording — dark app gets `dusk`, light app gets `noir`, mid gets `slate`.

The original default blurred the recording behind itself, which is the one option Screen Studio
does **not** ship (it is an open feature request there, next to the colour-extraction alternative).
The reason is visible the moment you try it on a dark app: the window dissolves into the smear and
the drop shadow has nothing to fall on.

The presets are mesh gradients — a few colour points blended by inverse-square distance, rendered
at 96×54 and upscaled with lanczos, which is how you get a smooth wallpaper without banding. Grain
is added last, because a flat gradient bands badly at 8-bit once x264 has been at it.

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

## Three capture sources, one pipeline

Everything downstream only reads the **manifest** — `frames[]`, `clicks[]`,
`path[]`, `endMs` — so any recorder that writes one gets the cursor, zoom,
backdrop and pacing for free.

| source | how | cursor | beats |
| --- | --- | --- | --- |
| `record.js` | CDP screencast of a browser tab | drawn from the logged path | from clicks |
| `term.py` | runs the command in a pty, paints frames itself | none needed | from change detection |
| `screen.mjs` | macOS `screencapture -v` | the real one, in the pixels | from change detection |

**A terminal should not be screen-recorded.** The obvious approach — put a
Terminal window on screen and film it — steals focus, captures whatever else is
on the desktop, is pinned to the window's real size, and needs the
screen-recording permission. `term.py` runs the command in a pty, keeps its own
model of the screen (a small VT subset: SGR colour, cursor moves, erase) and
paints frames with PIL. Nothing is displayed. It also draws its own window
chrome — traffic lights and a title bar — which closes half the "no browser
chrome" gap below, and it fits the window to the rows actually used so an
8-line demo is not a mostly-empty rectangle.

ffmpeg's `avfoundation` input is not used: it is killed on this machine
(exit 137) even though the screen-recording permission is granted and
`screencapture` works fine with it.

## Recording decides nothing

```
record → events ──┐
                  ├─> edit.mjs (director) ─> edit.json ─┐
frames ───────────┘                                     ├─> render ─> review
                                     recipe.json ───────┘
```

`record.js` used to call `mark()` while it drove the browser, so every hover
became a zoom anchor - the edit was committed before a single frame existed, by
whoever wrote the flow, blind. Everything downstream just executed it. That is
recording with the edit pre-baked, and it is why the camera moved for no reason
and never quite framed anything: the anchor was a POINT and the depth a
SEPARATE global number, so the framing could not be accurate even in principle.

Now recording emits events and the director decides the camera afterwards, from
the events plus the frames, into an editable `edit.json`:

```
$ bin/demokit edit .cache/shot-trident
edit: 5 camera move(s) covering 6 target(s) over 52.5s
  13.6s-15.4s  hold
        13.9s  3070x60   type: narrow to one asset (+8.8% of frame changed)
  20.3s-24.4s  pan
        20.6s   864x60   click: open the critical
        22.9s   139x48   hover: CVSS 9.8 · CWE-798
```

- **A zoom needs a reason** - a click, a keystroke, a measured change, or a
  hover the flow author explicitly labelled. It prints what it rejected too, so
  the decision is auditable rather than silent.
- **A zoom targets a rect**, and the renderer solves the crop that CONTAINS it.
  A 3070px search bar gets ~1.06x; a 139px badge gets 1.6x.
- **Nearby targets chain into one camera move** - zoom in, pan between them,
  zoom out. A push-and-release per beat is what made the camera bob.
- **The framing is pre-aimed.** While the zoom is ~1x the viewport covers
  everything, so the centre moves for free - and must, or the camera slides
  sideways into its target instead of scaling straight at it.
- `edit.json` and `recipe.json` are plain files. Edit either and re-render; the
  footage is untouched.

Borrowed, with thanks: the document-not-recording split and `cursorAnchor`
(median pointer position over a zoom's span, which immediately caught a zoom
framing a rect the pointer was 1400px from) come from **OpenScreen**; zoom
chains from **pagecast**; the recipe-beside-the-take and loud unknown-key
warnings from **DemoTape**; pre-aim from **Cap**.

## Beats from change, not just clicks

`src/beats.py` diffs consecutive frames at ~8fps, thresholds, clusters the
result in time, and puts a beat at the energy-weighted centroid of each cluster.
That is what lets the zoom follow a line of terminal output appearing, or a
panel filling in, with no cursor involved at all.

It runs by default whenever `clicks` is empty. On a browser take, `--beats
augment` adds change beats that landed away from any click. On a browser take it
finds *fewer* beats than clicks does — a hover changes nothing on screen — which
is the correct answer, not a bug.

## An agent that watches it

```
bin/demokit critic .cache/shot-<name> out/demo.mp4
```

`review.mjs` measures. It cannot answer "does this look right", and pretending
it can is how a demo of the wrong thing passes eight green checks. The critic
builds the pack an agent actually watches: frames chosen from the EDIT (the
opening, then before / peak / after for every camera move, then the ending),
each labelled with what it is SUPPOSED to show, on one contact sheet.

It also runs geometric invariants, because vision and arithmetic fail in
different directions. DemoTape has the story that makes this concrete: a take
where the camera held on the left of a text field while the sentence grew out of
frame passed every assertion AND their vision gate - only a measured invariant
caught it. So the critic checks that each zoom's target is inside the frame it
produces, that no two moves land on the same place, and that the pointer really
tracks a typing run.

Three outcomes, never two: `verified`, `failed`, and `inconclusive` - the gate
could not run. Treating "I could not look" as "it is fine" is the one result
that quietly ships a bad demo.

What the agent decides goes back as a patch, and unknown keys are named rather
than ignored:

```bash
echo '{"dropZooms":[12800],"recipe":{"deep":"2.2"}}' > /tmp/p.json
bin/demokit critic .cache/shot-x out/demo.mp4 --apply /tmp/p.json
```

## Zoom the footage, then frame it

The zoom used to run on the finished composite - window inset on the backdrop,
then crop the lot. That let the crop wander off the window and clamp against the
canvas edge, so a peak framed a third of wallpaper with the window sliced
through the middle. No amount of clamping fixes it, because the crop was never
constrained to the content.

Zooming the recording BEFORE insetting it removes the whole class of bug: the
window cannot move, and the content zooms inside it. That is also what the
reference demos do - the frame stays put, the screen inside it pushes in.

It also decides the depth/sharpness trade-off. At 4K delivery every zoom
upscales, so the depth cap has to stay low, and a 1.6x "zoom" showing 91% of the
window frames nothing. Delivering 1080p from a 4K capture makes 1.9x a
*downscale*, so the camera can be decisive and stay sharp:

| zoom | crop px | % of window | to 4K | to 1080p |
|---|---|---|---|---|
| 1.60 | 2400 | 91% | 1.60x | 0.80x |
| 1.90 | 2021 | 77% | 1.90x | 0.95x |
| 2.20 | 1745 | 66% | 2.20x | 1.10x |

## Reviewing its own output

```
$ bin/demokit review .cache/shot-trident out/trident.mp4
  PASS  duration           21.7s (want 20-75)
  PASS  zoom lands         range 68px
  PASS  rest state         51% unzoomed (want >=12%)
  PASS  payoff hold        3.25s at rest at the end (want >=2.5)
  PASS  something changed  max 90.03 mean-luma vs frame 0 (want >=6)
  PASS  no dead air        longest still stretch 1.25s (want <=2.6)
```

None of these asks "does this look good" — that is the one question the thing
that made the video cannot answer honestly about itself. Each is a number with a
threshold. `--fix` re-renders with adjusted framing flags and re-measures, and
stops as soon as a round improves nothing.

Two things it gets right that are easy to get wrong:

- **The window is found by detail, not brightness.** Thresholding luminance to
  locate the inset window reports a bright gradient backdrop as content and
  measures every frame as unzoomed. A smooth gradient has almost no vertical
  gradient; UI content has plenty.
- **Dead air excludes the tail.** The stall at the end is the payoff hold, which
  is required to be 3-5s. Counting it as dead air makes two checks contradict
  each other and no flag can satisfy both — the autotuner just raises `--speed`
  forever against a stretch that pacing deliberately protects.

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
src/term.py      offscreen terminal recorder: pty -> VT subset -> frames
src/screen.mjs   desktop/region capture via macOS screencapture
src/beats.py     beats from what changed, for captures with no click log
src/review.mjs   objective checks on a finished video, and --fix to re-render
src/demo.mjs     shot dir -> MP4
vendor/          shallow clones kept for reference: playwriter, playwright-recast, openscreen
.tools/          vendored ffmpeg + ffprobe
.cache/shot-<flow>/  frames + manifest, one dir per flow (gitignored)
```

## Not done

- **No browser chrome.** A tab screencast has no traffic lights or URL bar; the reference demos
  lean on it. It would have to be drawn synthetically — `term.py` already does this for terminals.
- **`term.py` models a VT subset**, not a terminal. Scripted commands and their output render
  correctly; a full-screen TUI (vim, htop) will not.
- **`screen` is macOS only**, and unlike `term` it records the real display.
- **No captions, audio, or text cards**, by design — every load-bearing fact has to be legible in
  the UI itself.
- **Streaming responses can't be stubbed.** `route.fulfill` buffers, so an SSE/NDJSON progressive UI
  collapses into one pop. Point the app at a local server instead.
- **Timezone can't be pinned**, only the instant.
- `chrome.tabCapture` (true 30fps, native res) needs the extension clicked on the tab, so headless
  runs can't use it.
