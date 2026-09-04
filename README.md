# DemoKit

Script a product workflow, record it locally, and export an edited MP4 with cursor
motion, zoom, pacing, and evidence that the demonstrated feature worked.

**Release status:** this branch prepares installation and documentation fixes for
0.3.1. npm currently serves 0.3.0; the new `init`, `skill`, and help commands below
are not yet published. A renderer licensing/provenance issue must be resolved before
the next release. See [the audit](docs/AUDIT-2026-09-04.md).

DemoKit is a **CLI and an agent skill**, not an MCP server. The default browser path
uses local headless Chromium. Existing Chrome sessions can use optional Playwriter.
There is no hosted upload requirement, account, narration, or caption generation.

## Install and try it

Requires **Node 20+**, **Python 3 with venv**, and **macOS or Linux**. Windows is not
supported. Linux may require system browser libraries; see troubleshooting below.

For the current published version:

```bash
npm install -g @dekai/demokit@0.3.0
# Supply your own existing flow; see the linked flow reference.
demokit local flow.json out/demo.mp4
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

There are alternatives. [The comparison](docs/ALTERNATIVES.md) covers Cap's
`cap-demo`, Pagecast, ScreenCI, screencli, OpenScreen and Screen Studio, with primary
sources and a research date. DemoKit's useful focus is reproducible local flows
with explicit behavior evidence; that is a design focus, not a claim of exclusivity.

The existing package declares MIT, but `src/caprender.py` explicitly describes a
port of Cap rendering behavior/code. Cap's relevant source is AGPLv3, outside its
listed MIT exceptions. This needs a provenance/licensing resolution before another
release; the audit does **not** certify the current package as cleanly MIT.
