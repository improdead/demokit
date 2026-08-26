---
name: demo-video
description: Record and edit a polished product demo video by driving a browser — the recording inset on a blurred backdrop with rounded corners, a synthetic cursor, click pulses, click-focused zoom, and dead air compressed. Use when the user asks for a demo video, a product walkthrough, a screen recording of a flow, a clip to send customers, or wants to show a feature working. Runs on demokit (capture + ffmpeg), driving the browser through playwriter.
---

# Making a demo video

Produces a customer-ready MP4 from a browser flow. Load the **playwriter** skill first — it is the
browser-control layer; this skill is the workflow on top of it.

The tool lives at `demokit/`. It is a CLI, not an MCP server: playwriter is already the MCP layer
for browser control, and rendering is a batch job with no reason to be a tool call.

## The shape of it

```
flow JSON  ->  record.js (capture + pointer path)  ->  cursor.py  ->  render.mjs  ->  pace.mjs  ->  MP4
```

You write the flow. Everything after is one command.

## 1. Storyboard before you touch the tool

Ask, or work out from the page: **who is this for, and what one thing should they believe after
watching?** Then pick **3–6 beats**. Not more. A 30–60s demo with four beats lands; the same
content with twelve beats reads as a tour.

Rules that matter more than they sound:

- **Show change, not navigation.** A beat where the page merely scrolls to an anchor is dead
  footage — it is the most common reason a demo feels like nothing happened. Prefer: something
  appears, a value updates, a state flips, a result arrives.
- **One idea per beat.** The zoom pushes in on exactly one point.
- **Space beats ≥2s apart.** Closer than `--gap` and they merge into one continuous zoom with no
  rest state, which reads as "permanently zoomed in".
- **Open on the problem, close on the result.** The middle is the mechanism.

If the product has a slow operation (a scan, a build, an upload), *keep* it and let pacing compress
it — a visibly-working progress state then a result is more convincing than a cut.

## 2. Write the flow

`demokit/flows/<name>.json`:

```json
{
  "url": "https://app.example.com/scans",
  "layout": [1280, 720],
  "zoom": 2,
  "steps": [
    { "do": "wait",  "ms": 900 },
    { "do": "click", "sel": "button:has-text('Run scan')", "label": "kick off a scan" },
    { "do": "wait",  "ms": 6000 },
    { "do": "click", "sel": "[data-finding]", "nth": 0, "label": "open the finding" },
    { "do": "hover", "sel": ".patch-diff", "label": "the suggested patch" }
  ]
}
```

| step | does |
| --- | --- |
| `wait` | `ms` only |
| `hover` / `move` | glide there and dwell |
| `click` | glide, then click |
| `pulse` | press+release in place, no navigation |
| `drag` | grab and move `by: [dx, dy]`, verifying the element moved |
| `type` | click, then type `text` |
| `scrollTo` | bring into view (not a beat) |
| `key` | press `key` |

Every step with a selector is a **zoom beat** unless `"beat": false`. `nth` picks among matches;
`label` appears in logs and warnings.

**`layout` is the apparent size, `zoom` buys resolution.** Choose `layout` so the product's content
fills the frame — a 680px column inside a 1920 layout looks tiny and reads as blurry no matter how
many pixels it has. 1280×720 at `zoom: 2` is the sane default.

## 3. Capture

```bash
cd demokit
playwriter session new --browser headless      # or the user's real Chrome for anything behind auth
DEMOKIT_FLOW=flows/<name>.json playwriter -s <id> -f src/record.js
```

**Create the session from `demokit/`.** playwriter's sandbox scopes file writes to the session's
cwd, so a session made elsewhere cannot write frames and will not resolve relative flow paths.

Selectors are preflighted: a bad one fails immediately with a list rather than producing an empty
video after a long capture. Read the output — it warns when a drag did not move anything, and when
`elementFromPoint` shows a higher z-index element covering your target.

For anything behind a login, use the user's real Chrome session (they may need to click the
playwriter extension icon on the tab). Headless is fine for public or local pages.

## 4. Render

```bash
node src/demo.mjs .cache/shot out.mp4
```

## 5. Actually look at it

Do not hand over a video you have not inspected. Extract frames and view them:

```bash
for ts in 0.8 <each beat time> ; do
  ffmpeg -y -loglevel error -ss $ts -i out.mp4 -frames:v 1 /tmp/f_$ts.png </dev/null
done
```

Beat times are in `.cache/shot/manifest.json`. Check:

- **A rest state exists** — at least one moment at full frame, not zoomed.
- **The cursor is on the thing it is acting on**, especially mid-drag.
- **Text is crisp** at 1:1 crop, not just downscaled to look fine.
- **Something visibly changes** between the first and last beat.
- **Nothing sensitive is on screen** — keys, tokens, customer names, real emails.

For sharpness, measure rather than squint:

```python
from PIL import Image; import numpy as np
a = np.asarray(Image.open('/tmp/f_2.4.png').convert('L').crop(box), float)
print((np.abs(np.diff(a,axis=0)[:,:-1]) + np.abs(np.diff(a,axis=1)[:-1,:])).var())
```

Higher is sharper; compare variants rather than chasing an absolute.

## 6. Tune

| knob | default | raise it when |
| --- | --- | --- |
| `--level` | 1.35 | detail is too small to read at rest |
| `--inset` | 0.84 | the window feels cramped in frame |
| `--bias` | 0.4 | zooms on edge elements push the window off-screen |
| `--gap` | 1500 | beats are merging into one long zoom |
| `--keep` | 1.35 | the cut feels rushed around an action |
| `--speed` | 4 | there is a long wait to compress |

Re-render is cheap and does not need a re-capture — the frames are already on disk. Only re-record
when the flow itself changes.

## Known limits — say these plainly rather than letting them be discovered

- **No browser chrome.** A tab screencast has no traffic lights or URL bar. If the user's reference
  has them, that gap is real and would need drawing synthetically.
- **No redaction.** Nothing blurs secrets automatically. Check frames by eye.
- **No audio or captions** by design.
- Screencast frame rate is variable; timing is preserved via per-frame durations, not a fixed rate.
