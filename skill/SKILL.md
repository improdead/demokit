---
name: demo-video
description: Plan and produce a polished demo video of a web app, a CLI, or a native app — probe the target, decide what to prove, seed realistic data when the environment is empty, then record and edit it into an MP4 with a cursor, change-aware zoom, a real backdrop and dead air compressed, and measure the result against objective checks. Use when the user asks for a demo video, a product walkthrough, a screen or terminal recording, a clip to send customers or investors, or wants to show a feature or a command working. Runs on demokit (capture + ffmpeg); browser capture goes through playwriter, terminals are rendered offscreen.
---

# Making a demo video

Works on three sources, all through the same pipeline:

| what you are demoing | command |
| --- | --- |
| a web app | `bin/demokit flows/<name>.json out.mp4` (write a flow — §7) |
| a web app, with a **real cursor** | `bin/demokit box flows/<name>.json out.mp4` — needs Docker |
| a CLI or a script | `bin/demokit term "<shell command>" out.mp4` |
| a native app or the desktop | `bin/demokit screen out.mp4 --seconds 30` |

For anything behind a login, `box` needs the session carried in — it starts with
an empty profile. Export the cookies from a browser that is already signed in and
point `DEMOKIT_COOKIES` at the file; they are injected over CDP before the first
navigation, so no password is ever handled and nothing is written outside the
gitignored `.cache`.

`box` is the best of the three when Docker is available: Chromium inside a
container with Xvfb and a window manager, so the pointer is a **real X11 cursor**
moved by xdotool and the chrome is a **real browser window** — nothing is drawn,
and it still runs in the background because the display does not physically
exist. The flow is driven over CDP (a bounding box is the only honest way to
know where a thing is) while xdotool puts the visible pointer on the same
coordinates, so the cursor you see and the click that lands are one event.

`term` runs the command in a pty and paints the frames itself — nothing is
displayed, so it records in the background while the machine is being used, and
the output is crisp at any resolution instead of being pinned to a window's
size. `screen` uses macOS `screencapture`, which does record the real display.

A demo is an argument, not a recording. It proves **one claim** by walking a path through
application states. You cannot argue about a product you have not looked at, and you cannot look at
it with your imagination.

**Probe → claim → ledger → seed → film → verify.** Do not skip to the flow file; every bad demo
this tool has produced came from writing steps before deciding what was being proved.

Load the **playwriter** skill first — it is the browser-control layer under this one. The tool
lives at `demokit/` and is a CLI, not an MCP server.

```
flow JSON → record.js (frames + pointer path) → cursor.py → render.mjs → pace.mjs → MP4
```

You write the flow. Everything after it is one command.

---

## 1. Probe first. No probe, no flow file.

```bash
cd demokit && bin/demokit probe <url>     # read-only, clicks nothing, safe against production
```

Read `.cache/probe.json`, not just the summary line. Probe at the geometry you will record at
(1280×720 default) — an above-the-fold judgement made at another size is wrong.

| From | You learn |
| --- | --- |
| `title`, `headings`, `navLinks`, `textSample` | what this is, and whether the URL you were handed is even the right page |
| `buttons` — mutating vs navigational | which actions can carry a beat. Only mutating ones can |
| `verdict.looksEmpty`, `dataSignals`, `emptyHints`, `tables[].rows` | whether the opening state exists yet |
| `verdict.stubbable`, `api[]` | your seeding surface if it does not |
| `verdict.looksAuthWalled` | whether headless can even reach it |

If `navLinks` names a page that sounds closer to the payoff than the one you were given, probe that
one too and record whichever has higher `dataSignals` and the more visual result. Two extra probes
cost thirty seconds; recording the wrong page costs a full cycle.

If the user described the product, **still probe**. Use their description to interpret the
evidence, never to replace it. Where the two disagree, ask.

## 2. Write the claim, from the probe

One sentence. Put it in the flow JSON as `"claim"` (the recorder ignores it; it is there so the
next person can check the video against it):

> A `<role>` who today `<painful workaround>` will believe that `<product>` `<does this specific
> thing>` in `<the effort it actually takes>`.

Two cheap tests:

- **Substitution.** Swap in a competitor's name. Still true? Then it is a category claim, not a
  claim. Sharpen it.
- **Falsifiability.** Name the single frame that would disprove it. If you cannot, it is a mood.

**If the claim needs an "and" to cover a second buyer or a second workflow, that is two videos** —
never one longer one. **If no button on the probed page performs the claim's action, either the
page is wrong or the claim is.** Fix that now, not at frame review.

## 3. Write the state ledger

Four to six lines, in prose, before any JSON:

```
S0  queue of 12 open findings, 3 critical, none triaged   <- the viewer's own pain, on screen
S1  finding open, the offending request visible           <- click the row
S2  patch generated, diff on screen                       <- click "Generate fix"   ** PAYOFF **
S3  PR opened, finding drops out of the queue             <- click "Open pull request"
```

- **Every beat is a state transition.** If S(n) and S(n+1) differ only in scroll position or which
  tab is highlighted, cut it or mark it `"beat": false`. Navigation is not change, and it is the
  single most common reason a demo feels like nothing happened.
- **Deletion test.** For each beat, delete it: is the claim still proved? If yes, leave it deleted.
  Stop when removing the next one breaks the proof.
- **Never hold a zoom over a dead screen.** The camera may stay pushed in while
  something is happening; the moment the screen stops changing it should come
  out. A 4.8s held pan with a 2.2s static gap in the middle is the viewer
  waiting, pushed in, for nothing. The director splits a chain rather than hold
  across dead time, and ends a hold shortly after the last thing that moved.
- **Mark exactly one state the payoff.** Open on the state just before it; hold longest on it.
- **Prefer a case with a real slow operation** — a visible working state and then a result is far
  more convincing than a cut, and `--speed` compresses the wait afterwards.
- **One *document* per flow.** `record.js` injects `html{zoom}`, `hide` and `redact` in a single
  `addStyleTag` after load, so a **full-document** navigation drops all three at once: resolution
  silently halves and the rest of the take is un-redacted. Client-side routing does **not** — a
  Next.js soft nav from a list to a detail route keeps every injected style (verified against a
  live Next.js app: `zoom` and the style tags both survived a route change). So a multi-page flow
  is fine inside an SPA and fatal across a real page load. If you are not sure which one the app
  does, check before writing the flow:
  ```bash
  playwriter -s <id> -e 'const p=await context.newPage();
    await p.goto(URL); await p.addStyleTag({content:"html{zoom:1.25}"});
    await p.locator(SEL).click(); await p.waitForTimeout(3000);
    console.log(await p.evaluate(()=>getComputedStyle(document.documentElement).zoom));'
  ```
  `1.25` means client-side routing and the flow is safe; `1` (or `normal`) means a real navigation,
  so split it into two videos.

## 4. Guarantee the preconditions

Everything below lives in the flow's `seed` block, installed as init scripts **before `page.goto`**.
Init scripts survive the `clearStorage` reload; anything you do with `page.evaluate` after load
does not.

**Session.** `verdict.looksAuthWalled` → record through the user's real Chrome, and pass the
session explicitly:

```bash
playwriter session new                    # from demokit/ — the user clicks the extension on an authed tab
bin/demokit --session <id> probe <url>
bin/demokit --session <id> flows/<name>.json out/demo.mp4
```

Without `--session` the CLI makes its own headless session, which is logged out. Also set
**`"clearStorage": false`**.
Otherwise the recorder clears `sessionStorage` and reloads, silently logging out any app that keeps
its token there — which presents as every selector missing, and gets misdiagnosed as a selector bug.

**Data.** `verdict.looksEmpty` → seed it. See §5.

**Time.** `seed.clock` to a fixed ISO instant and derive every fixture timestamp from it. Leave
`clockTicks` alone so `Date` still advances from the frozen base; freezing it dead stops spinners,
debounces and CSS-driven animation mid-flight. Timezone cannot be pinned — if wall-clock time is
load-bearing on your chosen screen, choose a different screen.

**Noise.** `"hide": [sel]` for chat widgets, cookie banners, notification bells, "3 days left in
trial". It sets `visibility:hidden`, so layout does not reflow.

## 5. Mock data — the policy

**Trigger.** `verdict.looksEmpty`, or a production tenant with nothing in it. If real data exists,
film the real data. If the product is *legitimately* sparse — three projects, one workspace — and
that sparseness is the honest before-state, film it and say so.

**The line, and it is absolute: seed the INPUTS, never fabricate the PAYOFF.**
Filling an empty queue with twelve realistic findings so the product can generate a patch is a
demo. Stubbing the generate-patch response is a lie, and this skill does not do it. **If the payoff
would have to be stubbed for the video to work, the product cannot yet do the thing — pick another
case and tell the user why.**

**Fidelity ladder, take the highest rung you can reach:**

1. A real demo tenant or a real local backend with data in it.
2. Point the app at a local server you run. **Required for anything streaming** — SSE, NDJSON,
   chunked — because `route.fulfill` cannot stream and collapses a progressive UI into one pop,
   which is usually the exact moment you are selling.
3. `seed.routes` stubs.
4. DOM text surgery. Only for chrome that never re-renders; React will overwrite app state mid-take.

**Mechanics that bite:**

- **The glob is matched against the full URL including the query string.** `"**/api/items"` does
  **not** match `/api/items?page=1`. Always suffix `*`. Under-matching gives you a populated first
  page and an empty second one, and you will not notice until frame review.
- `delayMs: 250–600` on payoff routes. Data that appears with no loading state reads as a mock.
- **Generate the fixture set once, from one script, into a committed JSON file**, and point the
  stub at it with `"file"`. Derived numbers get computed rather than typed, take 2 matches take 1,
  and a human can review exactly what was fabricated. Worked example:
  `fixtures/gen-findings.mjs` → `fixtures/findings.json` ← `flows/seeded-example.json`.

**What reads as fake is uniformity, not any single value:**

- Non-round at the app's own precision: `1,047` not `1,000`; `$9,840` not `$10,000`; `43.8%` not `50%`.
- Bursty relative times derived from `seed.clock` — `[14, 17, 23, 58, 184, 402]` minutes, never
  `[5, 10, 15, 20]`.
- Ids in the app's real shape and non-contiguous. Names like `Priya Raghunathan`, `M. Okonkwo`;
  inconsistent email local parts on a domain you invented.
- **Referential integrity, computed not typed.** The KPI equals the rows beneath it; a "12 open"
  badge sits above 12 rows; one person's name, initials, avatar and email agree on every screen the
  flow visits. This is the error viewers actually catch.
- **One ugly row** — a failure, an overdue item, a title long enough to truncate — placed *outside*
  the frame of the beat you are selling. An all-green board reads staged.

**Never on camera:** live credentials, tokens, JWTs, an org-scoped install command; another
tenant's data; a security product's raw evidence blob (these routinely contain a real
`Authorization` header — seed a synthetic finding instead); real customer names, logos or
subdomains; real people's email addresses; a real company inside a fabricated incident. **Never a
password in a `type` step** — it is typed on camera *and* committed to git.

**Substitute, do not blur.** A fabricated name survives zoom and leaks nothing; a blur box
announces "there is real customer data here", and `--level` pushes in on it. `redact` (9px blur)
stays available for stray chrome, but blur over a known web font at short string lengths is
recoverable — for anything genuinely secret, replace the string or hide the element.

Safe placeholders: TEST-NET ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`;
visibly-fake `sk_test_`-shaped keys; invented company and domain names.

**Disclose on handover, unprompted, every time:** what was fabricated, by which mechanism, which
fixture file holds it, what was hidden or redacted, and **what the product genuinely did unaided**.
Point at the fixture file so the user can verify rather than trust.

## 6. Beats and pacing

```
0:00–0:03  BEFORE STATE, inside the UI, already in motion.
           Never a logo, a title card, a login screen, an empty dashboard, or settings.
0:03–0:08  THE TRIGGER — one click or one paste. The zoom settles 0.3–0.5s BEFORE it fires.
0:08–0:22  WORK HAPPENING. Never more than ~2s of visual stasis.
0:22–0:38  THE RESULT, HELD 3–5s. The longest hold in the video. This is what proves the claim.
0:38–0:52  ONE LAYER PEELED BACK — the diff, the audit trail, the number that changed.
0:52–1:00  Rest on the outcome.
```

45–75 seconds, 4–6 beats, one idea per beat, beats ≥2s apart or the zooms merge into one continuous
push with no rest state. Over six beats or past 75s, cut a beat or split into a second video —
never compress the payoff hold.

demokit renders **no captions, no audio, no text cards**. Every load-bearing fact must be legible in
the UI itself. If the claim only lands with a sentence of narration, this tool cannot make that
demo, and saying so is the right answer.

## 6b. A demo is actions, not hovers

The single biggest way a flow goes wrong is filling up with `hover` steps. A
hover is cheap to write and it looks like a beat in the flow file, but on screen
**nothing happens** — and a camera move onto a screen where nothing is happening
is exactly what makes a demo feel arbitrary.

A take that was four hovers, one click and one keystroke over 52 seconds read as
a tour, not a demo. `bin/demokit edit` refuses to be quiet about it now:

```
! 4 hovers vs 2 actions - this is a tour, not a demo.
  Replace hovers with clicks that change something.
```

**Rules:**

- **Actions must outnumber hovers.** Aim for at least two clicks/keystrokes for
  every hover. If a step cannot change the screen, it is narration you cannot
  hear — cut it.
- **A hover earns its place only when the thing it points at is the payoff** —
  a number, a diff, a badge that the click just produced. One or two per demo.
- **Never two hovers in a row.** That is thirty seconds of a cursor drifting.
- If the product genuinely has nothing to click on the page you chose, that is
  the page being wrong, not the flow.

## 6c. Typing

`type` used to run at 60ms/char, which puts a search term on screen in half a
second — that reads as a paste, not as a person. Worse, the flow moved on before
the results had landed, so the thing the typing was *for* was never held.

- Default is **135ms/char** now, and every `type` step settles for **900ms**
  afterwards before its own `ms` dwell. Override with `delay` / `settleAfterMs`.
- **Type short strings.** `corvel` is six characters and takes ~0.8s. A 30
  character query takes four seconds of watching a text field fill up.
- **The beat belongs after the result, not the keystroke** — `"beatAfter": true`
  on every `type` step.

## 7. Write the flow

`flows/<name>.json`, beats mapping one-to-one onto ledger transitions:

```json
{
  "claim": "A security engineer who triages Dependabot noise by hand will believe Trident finds the exploitable one and writes the patch itself, in two clicks.",
  "url": "https://app.example.com/findings",
  "layout": [1280, 720],
  "zoom": 2,
  "seed": {
    "clock": "2026-08-26T15:41:00Z",
    "routes": [
      { "url": "**/api/findings*", "file": "fixtures/findings.json", "delayMs": 380 }
    ]
  },
  "hide": ["#intercom-container", ".cookie-banner"],
  "steps": [
    { "do": "wait",  "ms": 1100 },
    { "do": "hover", "sel": ".kpi:nth-child(2)", "label": "3 critical, untriaged" },
    { "do": "click", "sel": "tr[data-row=\"0\"]", "label": "open the SQL injection",
      "expect": { "sel": "#drawer.open pre" } },
    { "do": "click", "sel": "#generate-fix", "later": true, "label": "generate the fix",
      "ms": 2600, "expect": { "sel": "#diff", "timeout": 9000 } },
    { "do": "hover", "sel": "#diff", "later": true, "label": "the patch", "ms": 2600 }
  ]
}
```

| step | does |
| --- | --- |
| `wait` | `ms` only |
| `hover` / `move` | glide there and dwell |
| `click` | glide, then click |
| `pulse` | press and release in place, no navigation |
| `drag` | grab and move `by: [dx, dy]`, verifying the element actually moved |
| `type` | click, then type `text` |
| `scrollTo` | bring into view — not a beat |
| `key` | press `key` |

Every step with a selector is a zoom beat unless `"beat": false`. `nth` picks among matches;
`label` appears in the log and in warnings.

Non-obvious fields, all of which exist because a take was wasted without them:

- **`"expect": { "sel": "…", "timeout": 8000 }` on every step that is supposed to change
  something.** A click that lands and silently does nothing still records a confident zoom onto
  nothing. `expect` is the only thing that catches it.
- **`"later": true`** on a step whose target does not exist yet at t=0 — a drawer, a modal, a
  generated result. Preflight skips just that step and keeps validating everything else. Prefer it
  to flow-wide `"allowMissing"`, which silences the genuinely broken steps too and converts a loud
  correct failure into a short meaningless video.
- **`"beat": false`** on plumbing — scrollTo, dismissing a modal — so the zoom only lands on meaning.
- **`layout` is the apparent size; `zoom` buys resolution.** Choose `layout` so the product's
  content fills the frame: a 680px column inside a 1920 layout is unreadable however many pixels it
  has. 1280×720 at `zoom: 2` is the sane default.
- `settleMs` ≥380 so the cursor lands and the zoom settles before the click fires.
- **The payoff hold is the last beat's `ms`, plus `tailMs`** — pacing leaves ~3.5s after the final
  beat at normal speed and compresses only what is beyond it, so a 3–5s hold has to be *recorded*.
  You cannot add it at render time.

Take selectors from the probe's `sel` fields — they are already ranked by stability
(id → data-testid → aria-label → text → class).

### Every step declares what it proves

A step without a falsifiable claim cannot be verified, only watched. Give each
one a `prove` block and a one-line `shows`:

```json
{ "do": "type", "sel": "[aria-label*=\"Search\"]", "text": "corvel",
  "label": "narrow to one asset",
  "shows": "one asset, and the list collapses to a handful",
  "prove": { "rowsDrop": true } }
```

| key | asserts |
|---|---|
| *(default)* | a click or type must visibly change the product — ≥8% of page content, or rows/url move |
| `minChange` | override that 8% for a step that legitimately changes little |
| `changes: false` | this step is not supposed to change anything (say why in `shows`) |
| `rowsDrop` / `rowsRise` | the visible row count moved in that direction |
| `urlChanges` | it navigated |
| `textAppears` / `textGone` | a string crossed onto or off the screen — and was **not** already there |

Set `probe` at the flow level to whatever a row is in this app; a probe that
matches nothing reports `inconclusive`, never `false`. A failed measurement and
a failed feature are different answers.

## 8. Capture — and read the log as evidence

```bash
bin/demokit flows/<name>.json out/demo.mp4
```

Frames land in `.cache/shot-<name>/` — one directory per flow, so capturing a second flow does not
destroy the first one's frames. Budget roughly **6MB of PNG per second** of capture.

**The process exits 0 even when the take is worthless. The exit code is not evidence.**

**Two clocks, and they must be tied together.** Frames are timestamped from when
the recorder started; events are timestamped from when the flow began — after the
CDP connect, the cookie injection, the navigation and the settle. That gap is
about nine seconds, and for a long time nothing connected the two: every camera
move fired nine seconds before the thing it framed. It looked plausible for the
worst possible reason — the page before a click and the page after it are the
same list. The flow now paints a full-viewport magenta mark at its own zero and
the capture finds it, exact to a frame. (Magenta, not white: a page mid-navigation
is white, and the first attempt locked onto the page load instead of the mark.)
Everything before the mark is dead pre-roll and gets trimmed.

| In the log | Means | Do |
| --- | --- | --- |
| `PREFLIGHT FAILED` | selectors matched nothing at t=0 | diagnose below — do not reach for `allowMissing` |
| `EXPECT FAILED` | the thing you are demoing did not happen | abandon the take |
| `PROOF FAILED` | the step ran and the product did not visibly respond (§9) | fix the flow — it is a dead beat, not a framing problem |
| `NO SYNC FLASH FOUND` | the event clock could not be tied to the frame clock; camera timing is an estimate | re-record; if it persists the mark is being covered or the capture dropped its first seconds |
| `NOTE: <sel> is covered` | something overlaps your target; the click may have gone to it | `hide` it, re-record |
| `step failed`, `WARNING: drag did not move it` | abandon the take |
| `beats=N` lower than the beats you wrote | a step was silently skipped | abandon the take |
| `timeline: Xs captured, last repaint at Ys (held Zs…)` with Z over ~1s | the repaint heartbeat is gone — almost always a full-document navigation, which also dropped `zoom`/`hide`/`redact` | split into two videos (§3) |

Preflight has three causes and three different fixes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| everything missing, `authHints` in the probe | auth wall | `--session <id>` + `"clearStorage": false` |
| row/list selectors missing, `looksEmpty` | S0 does not exist | seed it (§4–5) |
| only later-step selectors missing | that state is not rendered yet | `"later": true` on those steps |

## 8. The render engine — a port of Cap's, checked against a Cap recording

The user recorded the reference (`~/Downloads/cloud.mp4`) with Cap, and Cap
keeps every recording's bundle in `~/Library/Application Support/so.cap.desktop/
recordings/*.cap`: `project-config.json` (the exact background, padding,
rounding, shadow, cursor and spring settings), `recording-meta.json` (cursor
shapes with hotspots), `content/segments/*/cursor.json` (every move and click),
and `assets/current-desktop-background.jpg` (the wallpaper at record time).
That bundle, not the pixels, is what "the same as Cap" means. Read it first;
the measurements only confirmed it.

`src/caprender.py` renders a take the way `crates/rendering` does, in one
Python pass that streams frames to ffmpeg. `--engine ffmpeg` is the old
zoompan graph.

| what | Cap's rule | where |
|---|---|---|
| zoom segments | press-300ms to **release**+2500ms, merge within 2500ms, ignore the last 1s, end 800ms early, amount 2.0 | `recording.rs` |
| zoom motion | two spring-mass-dampers (centre; amount+activity), 8ms steps, stiffness 200 / damping 40 / mass 2.25; centre tracks its target for free while amount ≤ 1.0005; amount clamped ≥ 1 | `zoom_spring.rs` |
| focus | greedy cursor clusters boxed at 50%×70% of the *visible* viewport; `calculate_follow_center` with edge snap 0.25 | `zoom_spring.rs` |
| what scales | the **display** scales over a **fixed** wallpaper — Cap never zooms the background | `display_bounds` in `lib.rs` |
| padding | `10/100 × 0.4` of the long axis, each side | `SCREEN_MAX_PADDING` |
| corners | superellipse power 4, radius `7.5/100 × 0.5 × min(display axis)` | `composite-video-frame.wgsl` |
| shadow | size `14.4%` and blur `3.8%` of the card's half short axis, × strength `0.736`; opacity `0.736 × 0.681`; `smoothstep(size+blur, -blur, |sdf|)`; no offset | same shader |
| cursor | the **recorded shape** per sample (arrow / pointing hand / I-beam), hotspot from meta; `cursor_height_px = 60 × screen_h/1080 × display_h/crop_h × size/100`; shrinks to 0.8 over 130ms around a click; leans `0.03°/px × 0.15` of its 0.4s x-travel, ±20° | `layers/cursor.rs` |
| cursor motion | shake filter, 60fps decimation, 60Hz spring (mellow 470/3/70) fed its own lag ahead, target snaps to a click 500ms out, stiffer spring (530/1/40) 175ms before it, **hold** across gaps > 66ms | `cursor_interpolation.rs` |

**Verified, not assumed.** Fed that recording's own `cursor.json`, the ported
segment generator reproduces all five of Cap's segments to the millisecond —
*once both press and release events go in.* Press-only came out ~140ms short
on every segment, which is how the recorder came to log `at` and `up`
separately with a 118–162ms human press between them.

**Not ported, and not claimed:** motion blur (screen and cursor). If the motion
still feels off, that is the gap.

Two recorder consequences: every pointer sample carries a `cursor_id` (the
page's computed `cursor` style under the pointer — `pointer` → hand, an input →
I-beam), and `screenH` is in the manifest because the cursor is sized from the
*display's* height, not the window's.

## 8a. The camera — Cap's auto-zoom, ported

Three cameras were written here before this one and all three were rejected: the
full director (defensible zooms that read as arbitrary), one push per click at a
computed depth, and the same anchored precisely on the pointer. The last was
accurate — push on the cursor, starting on the click, both measured — and still
not wanted. So the camera is now a port of the one that ships in a product
people use: `generate_zoom_segments_from_clicks_impl` in Cap's
`apps/desktop/src-tauri/src/recording.rs`, with the focus logic from
`crates/rendering/src/zoom_spring.rs`.

| constant | value | what it buys |
|---|---|---|
| `CLICK_PRE_PADDING_MS` | 300 | the push starts just before the click |
| `CLICK_POST_PADDING_MS` | 2500 | and holds 2.5s after it |
| `MERGE_GAP_MS` | 2500 | **clicks within 2.5s become ONE segment** |
| `TRAILING_CLICK_IGNORE_MS` | 1000 | a take never ends mid-push |
| `CLICK_END_CLAMP_PADDING_MS` | 800 | segments stop before the video does |
| `DEFAULT_AUTO_ZOOM_AMOUNT` | 2.0 | one depth, always |

**Merging is the part that matters most.** A burst of clicks is one sustained
push, not the camera pumping in and out on each. That is most of why Cap's zooms
read as calm.

Inside a segment the focus **follows the cursor**: pointer samples are grouped
into greedy bounding boxes limited to 50% x 70% of the *visible* viewport
(`CLUSTER_WIDTH_RATIO / amount`), and the active cluster's centre is the aim. So
the deeper the push, the less the cursor may wander before the camera re-aims.

**On `edge_snap_ratio`.** Cap maps the focus through travel space rather than
clamping, and this was rejected here once with a measurement showing it
decentred a click by 279px. That measurement was real and the conclusion was
wrong: `edge_snap_ratio = 1/(2 x amount)` makes travel space **exactly the
identity** — focus dead-centre in the interior, pinned at the edges. Cap ships
0.25 against amount 2.0, which is precisely that. It was tested here at 0.25
against amount 1.85 *and* a window inset, which decalibrates it, and the formula
took the blame. Clamping to the window is the same function, calibrated.

**Not ported:** the spring (stiffness 200, damping 40, mass 2.25, stepped at
125Hz). Reproducing it means baking a per-frame table into an ffmpeg expression.
The smoothstep envelope stands in — an approximation, not a port.

`--still` for a camera that never moves; `--zoom-clicks` for the older one-push-
per-click; `--smart` for the full director.

## 8a0. The camera (superseded)

**One push per click, centred on the cursor, then out. That is the whole rule.**

```
still ──▶ click ──▶ push in on the pointer ──▶ hold ──▶ out ──▶ still
```

The elaborate director — change detection, hover intent, chaining, scene
rejection — is still there behind `--smart`, and every zoom it produced could be
justified individually. It still read as arbitrary, because *defensible* and
*legible* are not the same thing. A viewer cannot see the reasoning. They see a
camera that moves when they clicked and is still the rest of the time, or they
see one that wanders.

- **If the camera cannot frame it, it does not move.** A click near a window edge
  cannot be centred at any sensible depth — the crop would hang off the window
  and fill with backdrop — and past `--maxoff` (5.5% of frame width) the push
  visibly misses its own subject. A still frame beats that. Depth does not
  rescue it either: a deeper zoom has *more* reach, and the depth needed in the
  case that prompted this was about 5x.
- `--zoom 2.2` sets the depth. Every push is the same distance, so the rhythm is
  predictable rather than a series of different-sized surprises.
- Two clicks closer than `minGapMs` produce one push, not two.
- Hovers, keystrokes and page changes move nothing. If the demo needs the camera
  somewhere, **click there**.

### The push starts ON the click, never before it

The zoom envelope used to begin `ramp` seconds *before* its start time, and the
aim envelope led by `ramp * 2.2` on top. With the start set to the click, that
meant the camera began moving **1.2 seconds before the click** — it was
literally predicting the thing that caused it, which is the whole of "it zooms
in before I click".

Both envelopes now begin at the click. The aim still leads the zoom, but *within*
the push: it ramps at `0.45x` the duration, so the centre is in place at
click+0.25s and depth arrives at click+0.55s — the camera scales straight in
instead of sliding sideways into its target.

Measure it rather than trusting it: sample the finished cut at 30fps around the
click and print the frame-to-frame difference. Motion must read 0.00 up to the
click frame.

### The camera follows the cursor, and depth is what lets it

Anchor on the **pointer**, never on the element box. The box moves when the page
does: `beatAfter` re-measured the selector after the click, and after a click
that navigates the selector matches a different element somewhere else entirely.
One click anchored at y=340, up in the breadcrumb, because the finding's title
had moved into the detail header. The camera was framing where the text ended
up. That is what "zooms somewhere random" actually was.

Then **depth is not a taste setting — it is what buys centring.** The crop can
only move within `window − canvas/z`, so:

| `--zoom` | can centre a click within |
|---|---|
| 1.85 | the middle **20%** of the frame |
| 2.2 | the middle **35%** |
| 2.5 | the middle **42%** |

At 1.85 almost every click is outside that band, so the framing silently clamps
to the window edge and lands short of the cursor. It was not aiming wrong, it was
*unable* to aim. When the clamp binds, the render says so by name rather than
leaving an unexplained offset.

**Why not Cap's travel space.** Cap maps the focus proportionally across the set
of in-bounds framings (`from_amount_center` in `crates/rendering/src/zoom.rs`),
with an edge-snap band on top. That is right for what Cap does — follow a cursor
cluster drifting across a whole segment, corners reachable, no post-correction.
It is wrong for a single click, because proportional mapping systematically
decentres a point: measured on one take, a cursor 39% across the window framed
279px off centre, and 313px with edge snapping. Centre on the focus and clamp
only at the edge. `--edgesnap 0.25` restores Cap's behaviour if a flow wants it.

Two more things that were quietly wrong:

- **`--bias` defaulted to 0.4** — the aim was blended 40% of the way from the
  cursor toward the middle of the window. It is 0 now. The cursor is the subject.
- **The crop was clamped to the canvas, not the window**, so a target near an
  edge could produce a frame holding 600px of backdrop with the window sliced
  down the middle.

### The cursor is real, and it has to be visible

The container path records with `x11grab -draw_mouse 1`, so the cursor in the
frames is the actual X11 cursor at the actual position — and it shows the right
*shape*, pointer over links and I-beam over inputs, which a drawn arrow never
does. What it was not, was visible: the default 24px cursor on a 4288x2560
display is 1% of the frame height. `XCURSOR_THEME=Adwaita` and `XCURSOR_SIZE`
at ~2.8% of display height fix that, and Chromium reads both at startup, so they
have to be set on its launch line.

## 8c1. Two terminal paths, and they are not the same thing

| | `demokit term` | `demokit termreal` |
|---|---|---|
| the window | **drawn** by term.py with PIL | **filmed** — the real Terminal.app |
| the output | real: a real pty, a real command | identical |
| the chrome, font, prompt | drawn to macOS measurements | genuinely macOS pixels |
| runs in the background | yes | **no — it takes the screen** |
| needs | nothing | Screen Recording + Accessibility |

Say which one a video is. "A real terminal" means different things across that
line, and the difference is not visible in the result.

`termreal` drives the window with System Events keystrokes at human speed, in
**one** AppleScript for the whole session — osascript costs ~50ms of process
setup per call, which is the same mistake that made the container's pointer take
four seconds to cross a window.

Three traps, all of which produced a broken take before they were fixed:

- **Target one window by id.** A bare `activate` raises whichever Terminal window
  is frontmost; with more than one open, the staging sizes one window while the
  keystrokes go into another, and the take films a region larger than the window
  with the desktop showing behind it.
- **One `do script`.** Two of them racing on the same tty produced
  `zsh: command not found: trclear`.
- **Opaque background.** The stock Pro profile is semi-transparent, so whatever
  is behind the window bleeds through the text.

Those last two mean editing the user's *profile* — Terminal has no per-window
override and no scriptable way to make a throwaway one. So every property is
read first and put back afterwards, the same way `stage.mjs` restores window
bounds. Recording a video is not a reason to leave someone's terminal a
different colour.

## 8c2. When the terminal window is drawn, it has to be drawn correctly

A terminal capture is a REAL pty running the REAL command — every character is
that command's actual output, nothing is simulated. What is drawn is the window
around it: `src/term.py` paints the chrome with PIL rather than screen-recording
Terminal.app, because a real recording brings the desktop, the notch, whatever
tabs are open, and a font size chosen for reading rather than filming.

Drawn chrome only works if the proportions are right. macOS measurements, all
against a 28pt title bar:

| part | value |
|---|---|
| traffic lights | 12pt across, 20pt apart, first centre 20pt from the left |
| light colours | `#FF5F57` `#FEBC2E` `#28C840`, each with a ~18%-darker ring |
| title | SF Pro at 13pt — never the terminal's own monospace font |
| title bar | **lighter** than the window body in dark mode, with a top highlight and a hairline separator below |
| body font | SF Mono, which is what Terminal.app actually renders in |

That inversion — the bar being lighter than the body, not darker — is most of
what makes a drawn window read as a Mac.

One trap: SF Mono has no `❯` (U+276F), so the prompt character of most shells
renders as *nothing at all*. Glyph coverage is checked per character with a
fallback to Menlo rather than picking one font and losing glyphs either way.

## 8c. The frame — a window floating on a ground

The look is a real window, centred, with room around it, sitting on a saturated
ground. Three settings carry it, and all three have a wrong value that looks
almost right:

| flag | default | the failure |
|---|---|---|
| `--w` / `--h` | **3840x2160** | 1080p was the default; every 4K take needed two flags nobody remembers, so what shipped was 1080p described as 4K |
| `--inset` | **0.72** | at 0.86 the window fills the frame edge to edge and the backdrop stops existing; below ~0.6 the UI is too small to read |
| `--bg` | `auto` | see below |

**`auto` uses the macOS Sonoma wallpaper, under light and dark apps alike.** The
generated gradients (`dusk`, `linen`, `tide`) are the fallback when no wallpaper
is on disk.

The usual advice — a light app needs a dark ground — was tried and produced the
worse picture: the dark radial fan behind a white UI blurs to a flat navy smear,
while Sonoma behind the same UI is vivid and still leaves the window as the
subject. Separation comes from the shadow and the blur, not from darkening the
ground.

**Blur hard, and never desaturate.** The ground is a surface, not a picture. An
earlier version of this rejected the macOS wallpapers as muddy — which was true
of the image it was producing and false of the wallpaper: it was blurring 0.4%,
desaturating to 0.82 and dimming to 0.92, and that turns any photograph into grey
soup. At `--bgblur 0.016 --bgsat 1.12 --bgdim 1.0` the same file reads as a macOS
desktop. Defaults now.

Still true: **a photograph with shapes in it competes with the window.**
`paint-harbour` behind a findings table reads as a second subject, and blurring
is what stops a wallpaper doing the same. The window is the subject.

The shadow and corner radius scale with the source width, so they hold at 4K
without being touched.

## 8a2. Two chromes sit above the page, and both must be counted

In the container the pointer is moved by xdotool in SCREEN coordinates while CDP
reports element boxes in PAGE coordinates. Converting between them means adding
everything that sits above the page:

```
page (0,0) in the captured frame
  = the window manager's title bar        <- _NET_FRAME_EXTENTS
  + Chromium's own chrome                 <- (outerHeight - innerHeight) x dsf
```

The second term is the obvious one and was the only one being added. Chromium
does not know about the WM's title bar, so `outerHeight` excludes it — but the
captured frame *starts* at the top of it. That put **every click 32 device
pixels too high**.

Which is exactly the kind of bug that hides. A 48px filter chip absorbs a 32px
error and still registers, so three takes in a row looked fine. A 16px
disclosure button does not, and the take filmed a click that did nothing.

It also produced a false accusation about the product: the verification pass
correctly reported that clicking a filter chip changed nothing on screen, and
the conclusion drawn was that the chip might be broken. The chip was fine. **A
verified "this step did nothing" says the pixels did not move — it does not say
whose fault that is.** Check the click landed before blaming the app: draw the
recorded click point and the measured element box onto the frame at that
timestamp and look at whether they agree with what is rendered.

## 8b. Beats without a cursor

A click is a good beat when there is a cursor to log. A terminal printing
output, a chart redrawing, a build finishing — none of those have one, and the
interesting moment is a *region of pixels changing*. `src/beats.py` finds those
and the zoom pushes into them.

It runs automatically whenever a capture has no click log (`term`, `screen`).
On a browser take, add it to the click beats with `--beats augment`, or turn it
off with `--beats off`. It deliberately finds fewer beats than clicks does on a
browser take, because a hover changes nothing on screen — which is the point.

## 8d. Look at the RAW take before you look at the edit

```bash
bin/demokit raw .cache/shot-<name>      # the take, with no edit applied
bin/demokit still .cache/shot-<name>    # where nothing is happening
```

Every other review surface inherits the edit's opinion. `critic` samples before /
peak / after for each camera move — so a move that should never have existed
gets three frames devoted to it, and a stretch the director ignored gets none.
`raw` samples evenly and labels each frame with its source time, whether the
screen was frozen there, and which step was running.

Read it first, because it answers the question the rest cannot: **is there
anything in this recording?** The take that prompted this was **85% frozen** —
20.1 of 23.8 seconds with not one pixel changing — and every camera-and-framing
check passed on it. If it is boring in `raw`, no camera fixes it.

**Dead air is measured, not inferred.** The pacing used to reason from the event
log: a camera move is running, the pointer is travelling, so keep it at normal
speed. That is a guess about whether anything is *on screen*, and a flow's own
`ms` waits routinely hold a "protected" window open across ten frozen seconds.
Any stretch over `--still` (3s) with no measured change is fast-forwarded at
`--deadspeed`, whatever the event log thinks — except inside a camera move, and
except the head and tail holds.

## 9. Verify — first that the FEATURE worked, then that the film is good

Every check in this section used to be about the video. None of them can catch
the failure that matters most: a take that is framed perfectly on a product
doing nothing. A click that lands on a dead control, a filter that filters
nothing, a detail view that was already open — all of it films beautifully and
passes every geometric assertion. That demo is worthless and nothing here
noticed, because everything here was measuring the film.

So the first question is not "does this look right", it is **did the product
do the thing**. Answer it three ways and require agreement:

| evidence | what it can prove | how it lies |
|---|---|---|
| **DOM** | the app's state before and after differ, and by how much | a counter ticks over and calls it a change; changes without rendering |
| **source pixels** | something visibly moved, and *where* | a spinner spun; a caret blinked |
| **delivered cut** | the viewer sees the before and the after | a moving camera makes every step look eventful |

Each is wrong in a different direction, which is exactly why all three run.

```bash
bin/demokit verify .cache/shot-<name> out/demo.mp4
```

It runs automatically at the end of every build. Do not skip it, and do not
treat a missing result as a pass — the outcomes are `verified`, `failed` and
`inconclusive`, and the third is a real answer meaning *the gate could not run*.
Collapsing it into "fine" is how a broken demo ships.

**The measurements, and why they are shaped this way:**

- **"Something differs" is not evidence.** The first take through this pass had a
  filter click that changed 2 characters out of 13,379 and passed a plain
  inequality. What matters is the share of the page that is new — word shingles,
  not a positional hash, because inserting two characters at the top shifts every
  block after it and reports 100%. Below 8%, nothing a viewer would notice
  happened.
- **Measure where it changed, not where you clicked.** A filter chip changes the
  *list*; a search box changes the rows below it. So take the bounding box of the
  pixels that actually differ. The evidence strips draw both: red for what was
  clicked, green for what moved. If there is no green box, the beat is dead.
- **Sample the delivered cut where the camera is at rest.** A version of this
  compared frames across the zoom and reported "the viewer sees it happen" for a
  step whose product change was 1% of the page — the 53-point difference it
  measured was the push, not the feature.
- **A skipped step must not vanish.** Silence is what let a video come back from
  three-fifths of a flow looking complete.

**Then think, because none of the numbers can:**

1. Does the sequence of after-states tell the story the claim makes, or only touch its parts?
2. Is there a step whose evidence is real but whose payoff is off-screen or never opened?
3. Which step would a sceptic say proves nothing, and are they right?
4. If a step is inconclusive, what would have to be recorded to settle it?

**A failed step is a flow problem. Never fix it at the framing layer.** A beat
that changes nothing should not be in the demo; do not zoom harder at it.

## 9a. Then the film — objective checks, not "look at it"

Extract frame 0, 0.8s, every `clicks[].t` from `.cache/shot/manifest.json`, and the last frame:

```bash
ffmpeg -y -loglevel error -ss $ts -i out/demo.mp4 -frames:v 1 /tmp/f_$ts.png </dev/null
```

Most of this is automated. Run it first, and only inspect by eye what it cannot judge:

```bash
bin/demokit review .cache/shot-<name> out/demo.mp4          # measure
bin/demokit review .cache/shot-<name> out/demo.mp4 --fix    # measure, re-render, re-measure
```

`--fix` only ever moves **framing** flags, and it stops as soon as a round fixes
nothing rather than grinding. If `something changed` fails it says so explicitly
and refuses to tune: that is a story failure, and no knob repairs a demo of the
wrong thing.

The checks below are what it measures, plus the four it cannot — 1, 6, 8 and 10
still need you:

1. **Ledger replay.** For every S(n) in §3, name the timestamp where that state is visible. A state
   you cannot point at is a failed demo, not a pacing problem.
2. **Beat count.** `beats=N` equals the number of beat-bearing steps you wrote, and the log is
   clean of `skip`, `covered`, `step failed`, `EXPECT FAILED`.
3. **Change magnitude.** If frame 0 and the payoff frame are near-identical, nothing happened:
   ```bash
   python3 -c "
   import sys,numpy as np;from PIL import Image
   a,b=[np.asarray(Image.open(p).convert('L').resize((160,90)),float) for p in sys.argv[1:]]
   print('meandiff', round(abs(a-b).mean(),2))" /tmp/f_0.png /tmp/f_<payoff>.png
   ```
4. **Reproducibility.** Re-run the capture. Take 2 must show the same data, the same timestamps and
   the same ordering. If it does not, a precondition is unseeded and every check below is
   meaningless.
5. **Duration and hold.** 45–75s. Payoff hold 3–5s and the longest in the video. No stretch over 2s
   with zero visual change. At least one unzoomed rest moment.
6. **Fixture arithmetic.** Every count badge equals its rows; every KPI sums what it claims to sum;
   one person's identity agrees on every screen visited.
7. **Uniformity scan.** No round numbers, no evenly-spaced timestamps, no sequential ids, no
   `Test User` / `asdf` / lorem, no all-green board.
8. **Secret sweep at zoom.** Check the *zoomed* beat frames specifically — `--level` makes legible
   what was safely illegible at rest — plus frame 0, the last frame, and any toast that fired after
   preflight.
9. **Redaction persistence.** Confirm `hide`/`redact` and full resolution still hold in the **last**
   frame, not only the first.
10. **Cold eye.** Frame 0 beside the payoff frame: could someone who has never seen this product say
    what changed, and what kind of product it is, from the first three seconds alone?

## 10. When a take is bad, fix it at the right layer

Tuning is the cheapest action and therefore the tempting one. Picking the wrong layer is the most
common way this goes wrong.

| Diagnosis | Layer | Action |
| --- | --- | --- |
| Nothing meaningful changed; it is a feature tour; the claim was not proved; a stranger would not know what happened | **Story** | Rewrite the ledger, pick a different case, **throw the take away and re-record.** Do not touch `--level`. No knob fixes a demo of the wrong thing. |
| Empty table, spinner at the end, logged out, occluded target, wrong element got the beat, implausible data on screen | **State** | Fix `seed` / `clearStorage` / `hide` / the flow, re-record. |
| Too small to read, cramped, edge-clipped, zooms merging, rushed cut, long dead wait | **Framing** | `bin/demokit --render-only .cache/shot-<name> out/demo.mp4 --level 1.5 --gap 2000 --speed 4`. The frames are on disk; re-capturing is wasted work. |

| knob | default | raise it when |
| --- | --- | --- |
| `--bg` | `auto` | the ground fights the UI — see below |
| `--level` | 1.35 | detail is too small to read |
| `--inset` | 0.84 | the window feels cramped in frame |
| `--bias` | 0.4 | zooms on edge elements push the window off-screen |
| `--gap` | 1500 | beats are merging into one long zoom |
| `--keep` | 1.35 | the cut feels rushed around an action |
| `--speed` | 4 | there is a long wait to compress |

**Backdrop.** `auto` reads the recording's own brightness and picks a ground that separates from
it: a dark app gets `dusk`, a light one gets `noir`, anything in between gets `slate`. Override with
`--bg dusk|ember|tide|slate|noir|linen`, `--bg '#101014'`, `--bg path/to/wallpaper.png`, or
`--bg blur` for the old blur-behind-itself. Pick a ground that **contrasts** with the app — a dark
app on a dark ground has no edge and the whole frame reads as murk. Match the product's accent
colour only if it does not also match its background.

**If any frame ever contained a live credential, treat it as compromised.** Tell the user to rotate
it, and delete `.cache/shot-<name>/frames` — those are full-resolution unredacted PNGs, and deleting
the MP4 is not cleanup because `--render-only` reproduces it from them.

## Known limits — state these plainly rather than letting them be discovered

- **No browser chrome.** A tab screencast has no traffic lights or URL bar; it would have to be
  drawn synthetically.
- **No audio, no captions, no text cards.** By design.
- **Streaming responses cannot be stubbed** — `route.fulfill` buffers. Use a local server.
- **Timezone cannot be pinned**, only the instant.
- Screencast frame rate is variable; timing is preserved via per-frame durations, not a fixed rate.
- **Capture is repaint-driven**, so the recorder forces a paint on every pointer sample. Without it
  a cursor gliding across a static screen produces no frames at all. It is automatic — but it is
  another reason a full-document navigation mid-flow ruins a take.
