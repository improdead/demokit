# Alternatives researched on 2026-09-04

DemoKit is not the only agent-driven demo-video tool. This is a comparison of
public primary-source documentation, not a hands-on benchmark of competitors or
proof that every possible alternative has been found. Product capabilities change.

| Tool                                                                                            | Documented overlap                                                                                                                            | Relevant distinction                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cap `cap-demo`](https://github.com/CapSoftware/Cap/blob/main/apps/cli/skill/cap-demo/SKILL.md) | Agent skill that scouts a URL, records with virtual input and Cap's CLI, adds camera/background/music treatment, and exports video.           | The documented skill assumes Apple Silicon macOS and Cap installation/permissions. This is a particularly close alternative, not merely a manual recorder. |
| [Pagecast](https://github.com/mcpware/pagecast)                                                 | Browser recording and interaction through MCP; cinematic/tooltip zoom, GIF and MP4 export, platform presets.                                  | An actual MCP server. Its documented setup requires Node, FFmpeg, and a browser installation.                                                              |
| [ScreenCI](https://screenci.com/)                                                               | Scripted Playwright recordings, agent skill, auto-zoom, narration, and repeatable product videos.                                             | Records locally and renders in the cloud; its site says raw recordings and timing data are uploaded. Compare that model with DemoKit's local rendering.    |
| [screencli](https://screencli.sh/docs/cli)                                                      | Agent-friendly CLI with assertion-first verification, pass/fail/inconclusive results, recording, auto-zoom, cursor effects and idle trimming. | Strong overlap with DemoKit's evidence focus. Its offering also includes hosted recording links/GitHub integration; the CLI is documented as open source.  |
| [OpenScreen](https://github.com/getopenscreen/openscreen)                                       | Desktop recording, automatic/manual zooms, cursor effects and editing/export.                                                                 | A desktop editor workflow; broader interactive editing than DemoKit's JSON-driven pipeline. Consult its current platform-specific release notes.           |
| [Screen Studio](https://screen.studio/guide/auto-zoom)                                          | Automatically focuses zooms around clicks and supports manual zoom editing.                                                                   | A polished macOS recording/editor workflow, rather than DemoKit's local flow-and-evidence CLI.                                                             |

## Defensible positioning

DemoKit combines deterministic local flows, a planning skill, rendered cursor/zoom
presentation, and inspection of DOM, source pixels and exported frames. That
combination is useful, but **verification is not exclusive**: screencli explicitly
documents assertion-first verification. Neither are AI-driven recording, auto-zoom,
skills, or repeatable scripts exclusive. "No alternatives" and "the only tool" are
unsupported claims.

The present advantage should be judged from reproducible output quality, clearer
installation, understandable evidence, local-data handling and maintainable code.
No comparative performance or quality ranking was established by this audit.
(Licensing is resolved: DemoKit is AGPL-3.0-or-later as of 0.4.0 — see the README.)

## Hands-on, cloned and run — 2026-09-07

The tools above were read from documentation. These two were cloned and run against
the same task (open a merged `vercel/next.js` PR, then its diff) on this machine.

- **[WebReel](https://github.com/vercel-labs/webreel) — Apache-2.0.** `npm i webreel`,
  a JSON config, `npx webreel record`. Ran clean in ~20s, auto-downloading its own
  chrome-headless-shell and ffmpeg to `~/.webreel`. Output is h264 1080p60 at about
  1 Mbit/s with a keystroke HUD, click sound effects and an animated cursor. No zoom,
  and **no verification** — it films what the script says and trusts it. Targets by
  visible `text` or CSS selector.
- **[aidemo](https://github.com/tandryukha/aidemo) — MIT.** The closest peer, and the
  most capable authoring tool of the set: an MCP server plus CLI, `inspect` (ranks
  unique selectors on a live page), `lint` (forecasts scene freeze/overrun before a
  take), narration, synced captions, auto-zoom, and `probe --golden` (a baseline diff).
  It would not launch here — it hardcodes `chromium.launch({channel:"chrome"})` and so
  needs Google Chrome installed, which this machine lacks. Its check is *drift*
  (changed since the committed baseline), not *truth* (ever worked).

**What DemoKit should learn from them:** aidemo's `inspect` and `lint` are better
authoring aids than anything here, and WebReel's keystroke HUD is a nice touch. All
are polish and authoring; none close the "did the feature actually work" gap, which
remains DemoKit's one distinct axis.

- **Playwright `recordVideo`.** WebM/VP8 only; the Chromium target bitrate `-b:v 1M`
  is hardcoded and only `mode` and `size` are configurable
  ([microsoft/playwright#31424](https://github.com/microsoft/playwright/issues/31424),
  closed as a duplicate of #17217, `P3-collecting-feedback`); **no cursor is drawn in
  the frame**. It asserts the test, never the video.
- **Screen Studio / Loom** are human-driven recorders (Screen Studio: macOS-only,
  auto-zoom + cursor smoothing; Loom: cross-platform, no auto-detected zoom).
  **Skyvern / Browser Use** are LLM browser agents whose session replay is for
  debugging, not presentation.
