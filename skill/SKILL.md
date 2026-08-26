---
name: demo-video
description: Plan and produce a polished demo video of a web app, a CLI, or a native app — probe the target, decide what to prove, seed realistic data when the environment is empty, then record and edit it into an MP4 with a cursor, change-aware zoom, a real backdrop and dead air compressed, and measure the result against objective checks. Use when the user asks for a demo video, a product walkthrough, a screen or terminal recording, a clip to send customers or investors, or wants to show a feature or a command working. Runs on demokit (capture + ffmpeg); browser capture goes through playwriter, terminals are rendered offscreen.
---

# Making a demo video

Works on three sources, all through the same pipeline:

| what you are demoing | command |
| --- | --- |
| a web app | `bin/demokit flows/<name>.json out.mp4` (write a flow — §7) |
| a CLI or a script | `bin/demokit term "<shell command>" out.mp4` |
| a native app or the desktop | `bin/demokit screen out.mp4 --seconds 30` |

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

## 8. Capture — and read the log as evidence

```bash
bin/demokit flows/<name>.json out/demo.mp4
```

Frames land in `.cache/shot-<name>/` — one directory per flow, so capturing a second flow does not
destroy the first one's frames. Budget roughly **6MB of PNG per second** of capture.

**The process exits 0 even when the take is worthless. The exit code is not evidence.**

| In the log | Means | Do |
| --- | --- | --- |
| `PREFLIGHT FAILED` | selectors matched nothing at t=0 | diagnose below — do not reach for `allowMissing` |
| `EXPECT FAILED` | the thing you are demoing did not happen | abandon the take |
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

## 8b. Beats without a cursor

A click is a good beat when there is a cursor to log. A terminal printing
output, a chart redrawing, a build finishing — none of those have one, and the
interesting moment is a *region of pixels changing*. `src/beats.py` finds those
and the zoom pushes into them.

It runs automatically whenever a capture has no click log (`term`, `screen`).
On a browser take, add it to the click beats with `--beats augment`, or turn it
off with `--beats off`. It deliberately finds fewer beats than clicks does on a
browser take, because a hover changes nothing on screen — which is the point.

## 9. Verify — objective checks, not "look at it"

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
