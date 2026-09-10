# DemoKit

Script a product workflow, record it locally, and export an edited MP4 with cursor
motion, zoom, pacing, and evidence that the demonstrated feature worked.

<p align="center">
  <a href="https://dekai.me/demokit"><img src="https://dekai.me/media/amazon-task.gif" width="800" alt="DemoKit driving amazon.com: search, filter to four stars and up, open the top result, add to cart, decline the protection-plan upsell, land on the cart. One take, 7/7 verified."></a>
</p>
<p align="center"><sub>
  <code>demokit local flows/amazon-task.json out/amazon.mp4</code> — an errand on amazon.com, one take, <b>7/7 verified</b>. Nothing here is a fixture.
  The MP4 is 3840×2160; this is a GIF of it. <a href="https://dekai.me/media/amazon-hero.mp4">Watch the real file</a> · <a href="https://dekai.me/demokit">read the write-up</a>.
</sub></p>

**Release status:** npm serves **0.4.0**, the first release under the correct licence
(**AGPL-3.0-or-later** — the renderer is ported from Cap; see [provenance](#alternatives-and-provenance)
and [NOTICE](NOTICE)). Versions 0.1.0–0.3.0 shipped under MIT by mistake and are deprecated.

DemoKit is a **CLI and an agent skill**, not an MCP server. The default browser path
uses local headless Chromium. Existing Chrome sessions can use optional Playwriter.
There is no hosted upload requirement, account, narration, or caption generation.

## Install and try it

Requires **Node 20+**, **Python 3 with venv**, and **macOS or Linux**. Windows is not
supported. Linux may require system browser libraries; see troubleshooting below.

```bash
npm install -g @dekai/demokit
# Try one of the bundled public flows, or supply your own; see the flow reference.
demokit local flows/research-trail.json out/trail.mp4
```

To test the improvements in this branch:

```bash
git clone --branch codex/demokit-install-audit https://github.com/improdead/demokit.git
cd demokit
npm ci
./bin/demokit --help
./bin/demokit init
./bin/demokit local demokit-example/flow.json out/demo.mp4
```

`init` creates a self-contained task-board example; no server, account, fixture
download, or API is needed. Clicking its button actually updates the example UI.
The first recording may download Chromium and install Pillow/numpy into a cached
Python environment. Network access and disk space are needed for those downloads.
FFmpeg/ffprobe are used from the system or installed npm dependencies.

The release-candidate package also supports global installation or
`npx @dekai/demokit@<released-version>` after publication. Do not assume `npx` of
0.3.0 has the commands introduced here.

## Install the agent skill

With this branch's CLI, copy the bundled skill and its references to your agent:

```bash
# Codex; use your configured CODEX_HOME instead if customized
./bin/demokit skill install ~/.codex/skills/demo-video
# Claude Code
./bin/demokit skill install ~/.claude/skills/demo-video
# Cursor
./bin/demokit skill install ~/.cursor/skills/demo-video
```

Use `demokit` without `./bin/` after global installation. Existing destination
folders are never overwritten. Move the old installation explicitly before an
update. `demokit skill path` prints the bundled directory for other integrations.
The skill is not automatically installed by npm and no MCP configuration is needed.
Then ask your agent to record a specific workflow and inspect the resulting video.

## Record your app

```bash
demokit probe http://localhost:3000
demokit local flows/signup.json out/signup.mp4
# On this branch, omitting `local` is equivalent:
demokit flows/signup.json out/signup.mp4
```

A probe loads the URL and reports selectors, text and request metadata without
clicking. It does not guarantee that a page load is side-effect-free or that an
empty/auth heuristic is correct. Check the real UI before writing a flow.

[Flow reference](skill/references/flows.md) ·
[Capture modes and authentication](skill/references/capture.md) ·
[Verification and editing](skill/references/verification.md)

Primary flow, shot, and output paths resolve from your working directory, including
spaces. Supply absolute paths for optional renderer config/assets and critic patches. Fixture
paths inside a flow resolve from the flow file. Work files go to `./.demokit/` or
`DEMOKIT_WORK`; an internal ignore file protects new captures from accidental Git
adds. Add your exported-video directory to `.gitignore` too. Captures contain raw
frames and page text; don't publish them implicitly. A repeated flow name replaces
its take, and simultaneous jobs need separate work directories.

## Sign in once

```bash
demokit login https://app.example.com
demokit local flows/app.json out/app.mp4
```

Sign in in the browser window. DemoKit saves a Playwright storage state under
`~/.cache/demokit/auth/<host>.json`, outside your project, with mode 0600. Subsequent
local captures reuse it until the app expires the session. Set `DEMOKIT_CACHE` to
change the cache location, or `DEMOKIT_AUTH` to choose a storage-state file.
`DEMOKIT_COOKIES` and `login --from-cookies <file>` support existing cookie exports;
these files are credentials and must remain private.

To inspect or record through **your existing Chrome**, install Playwriter and its
extension separately, create a session in the intended work directory, then use
`demokit --session <id> probe <url>` or `demokit --session <id> flow.json out.mp4`.
See [Playwriter](https://playwriter.dev). This legacy path has less complete
semantic verification than `local`; inspect the browser and exported frames. Its
automatic result can be inconclusive (nonzero exit). Use `--no-verify` only for an
explicit exploratory render, and report that manual verification is still needed.

## Verify and re-render

```bash
demokit raw .demokit/shot-signup
demokit verify .demokit/shot-signup out/signup.mp4
demokit critic .demokit/shot-signup out/signup.mp4
demokit --render-only .demokit/shot-signup out/signup.mp4 --tailhold 3
```

Verification combines DOM assertions, source pixels, and delivered frames.
`verified`, `failed`, and `inconclusive` are different results. The contact sheets
still need human/agent visual review. Encoding successfully does not prove the app
worked. The updated local pipeline exits nonzero when browser verification fails
or is inconclusive; `--no-verify` is an explicit exploratory-render option.

The renderer draws a cursor and window presentation; it is not a recording of the
physical pointer. No audio, subtitles, or motion blur are generated. The local
recorder's CSS magnification can alter viewport-unit/fullscreen layouts, so inspect
capture geometry. Full-document navigation can drop presentation decorations.
See [rendering notes](docs/rendering.md) for engine differences and units.

## Example flows against public sites

These ship in `flows/` and run with no login — the same recordings shown on the
[write-up](https://dekai.me/demokit). Each one drives a real, third-party site and
verifies every step; nothing is a fixture.

<table>
  <tr>
    <td width="50%"><a href="https://dekai.me/media/gh-review-long.mp4"><img src="https://dekai.me/media/gh-review-long-poster.jpg" alt="A whole PR review on vercel/next.js"></a><br><sub><b>github-review-long</b> · 8 steps, 42s, one take · <code>8/8 verified</code></sub></td>
    <td width="50%"><a href="https://dekai.me/media/research-trail.mp4"><img src="https://dekai.me/media/research-trail-poster.jpg" alt="A research trail on Wikipedia"></a><br><sub><b>research-trail</b> · a goal, not a script: Lovelace → the Difference Engine · <code>5/5 verified</code></sub></td>
  </tr>
  <tr>
    <td><a href="https://dekai.me/media/maps-directions.mp4"><img src="https://dekai.me/media/maps-directions-poster.jpg" alt="Directions on Google Maps"></a><br><sub><b>maps-directions</b> · A to B on a WebGL canvas, driving then walking · <code>4/4 verified, twice</code></sub></td>
    <td><a href="https://dekai.me/media/grafana-dash.mp4"><img src="https://dekai.me/media/grafana-dash-poster.jpg" alt="Grafana's public playground"></a><br><sub><b>grafana-dashboard</b> · dark theme, virtualised search, panels that draw late · <code>2/2 verified</code></sub></td>
  </tr>
</table>

<p align="center"><a href="https://dekai.me/media/gh-review-long.mp4"><img src="https://dekai.me/media/gh-review-long.gif" width="800" alt="The 42-second GitHub review take"></a></p>

```bash
demokit local flows/github-review-long.json out/review.mp4   # 8 steps, ~42s: a whole PR review
demokit local flows/research-trail.json      out/trail.mp4    # a goal-directed research task: Lovelace -> the Difference Engine
demokit local flows/github-pr.json           out/pr.mp4       # a merged PR: commits, then the diff
demokit local flows/wikipedia-search.json    out/wiki.mp4     # type a query, open the article
demokit local flows/google-maps.json         out/maps.mp4     # a WebGL map: pins, then filters
demokit local flows/maps-directions.json     out/dir.mp4      # a task on that map: A to B, driving, then walking turn-by-turn
demokit local flows/grafana-dashboard.json   out/grafana.mp4  # a live observability dashboard
demokit local flows/amazon-task.json         out/amazon.mp4   # an errand: search, filter 4-star+, read reviews, add to cart, decline the upsell
demokit local flows/wikipedia-refused.json   out/nope.mp4     # meant to FAIL: one step proves nothing
```

`wikipedia-refused.json` is the instructive one: it clicks a control that changes
nothing, DemoKit reports `outcome: failed`, and no file is written. Live sites drift,
so a selector may need refreshing; the run tells you which step and why.

## Troubleshooting

- **`ffmpeg` missing:** npm must allow `ffmpeg-static`'s install script to download
  its binary, or provide `ffmpeg` and `ffprobe` on PATH. With npm versions that block
  scripts, review/approve that dependency using npm's install-script controls and
  reinstall it. Do not blindly enable all dependency scripts.
- **Python setup fails:** install Python with `venv`/pip support. On macOS, Homebrew
  Python works. On Debian/Ubuntu, `python3-venv` may be a separate system package.
  DemoKit's first-run setup needs network access; it does not bundle Python.
- **Linux Chromium cannot launch:** install its OS libraries. From this checkout:
  `node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell`.
  This can require administrator access. Merely downloading Chromium is insufficient.
- **Authentication expired:** rerun `demokit login <url>`. Session storage and
  special SSO/browser-profile requirements may need the existing Chrome route.
- **A step fails:** inspect the selector and result at the recorded viewport. Use
  `later: true` only when an earlier step creates the target. Don't weaken evidence
  to hide a broken behavior.
- **Large work folder:** source PNGs can consume hundreds of MB. Keep desired takes
  for re-rendering and remove only your own discarded captures.

## Development and release

```bash
npm ci
npm test                 # CLI, paths, package content
npm run test:smoke       # capture, render, and verify the bundled example
npm pack --dry-run      # inspect precisely what npm will ship
```

CI checks macOS/Linux CLI behavior and runs the Linux end-to-end example. See
[contributing and release checks](CONTRIBUTING.md). Dependencies may perform network
downloads during a clean smoke run. Capture artifacts and auth state are never
uploaded by CI.

## Alternatives and provenance

This is a crowded shelf. [The comparison](docs/ALTERNATIVES.md) covers the tools
that were cloned and run head-to-head — Vercel Labs' WebReel (Apache-2.0) and
aidemo (MIT) are the closest — plus Playwright's `recordVideo`, Screen Studio, Loom,
Skyvern and Browser Use, with primary sources and dates. The one axis DemoKit is
alone on is verification: three checks per step, and no file when they disagree.
Everything else — scripted flows, auto-zoom, a rendered cursor, an agent skill — one
or more of them already do, some of them better. That is a design focus, not a claim
of exclusivity.

`src/caprender.py` ports Cap's rendering (segment generation, spring solve, cursor
interpolation, the composite shader's rounding). Cap's MIT exception covers only its
`cap-camera*` and `scap-*` crates; `crates/rendering` has no override and is AGPLv3.
DemoKit is therefore **AGPL-3.0-or-later**, and [NOTICE](NOTICE) names every ported
function and constant against the Cap file it came from. Versions 0.1.0–0.3.0 shipped
under MIT by mistake and are deprecated on npm; 0.4.0 is the first release under the
correct licence.
