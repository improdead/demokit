---
name: demo-video
description: Plan, record, and verify a product walkthrough with DemoKit. Use for requested browser or terminal demo videos, including repeatable flows and inspection of the exported MP4.
---

# DemoKit product demos

Use DemoKit's CLI to record a real workflow and produce an MP4. It is a CLI plus
this skill, not an MCP server. The optional Playwriter integration supplies browser
control; it is not required for the default headless capture.

## Choose the route

- Start with `demokit --help`. If missing, install `@dekai/demokit` using the
  package manager the user selected. Read the repository's release status first;
  the installation improvements in this branch are not yet on npm.
- For a new setup, `demokit init` creates a small local example. Record it with
  `demokit local demokit-example/flow.json out/example.mp4`.
- For ordinary browser demos, use `demokit local <flow.json> <out.mp4>`.
- For an authenticated app, use the existing authorized browser or
  `demokit login <url>` once, then the local recorder. Do not ask for passwords or
  export an unrelated browser profile. Saved sessions are private credentials.
- If the user or project requires their real Chrome session, use Playwriter and
  the documented `--session` route. It is a legacy capture path with less complete
  automatic feature evidence; do not claim parity with the local recorder.
- For terminals, native apps, and capture limitations, read
  [capture modes](references/capture.md).

## Plan from evidence

1. Read the relevant routes and behavior in the app's code when available. Match
   the user's requested scope, audience, and length; do not invent a marketing claim.
2. Inspect the real page at the intended viewport using `demokit probe <url>` or
   the project's preferred browser tool. A probe loads a URL without clicking;
   it can still cause normal page-load side effects. Treat its empty/auth verdict
   as a heuristic and inspect the page before deciding.
3. Write one sentence describing what the video will prove and a short sequence
   of starting state → action → observable result. Keep the result readable.
4. Record only authorized interactions. Seeding a local/demo environment can
   establish inputs, but never stub the feature's result and present it as live.
   Label fixtures clearly. Ask for missing authorization before mutations outside
   the user's requested scope, not before ordinary read-only inspection.
5. Put stable selectors, waits for actual UI states, and meaningful assertions in
   the flow. Read [the flow format](references/flows.md) before writing it.

## Record and verify

Run `demokit local <flow.json> <out.mp4>`. Files go to `.demokit/shot-<flow-name>`.
The same flow name replaces that take; use a different work directory to retain
multiple takes. Do not run two captures/renders against the same work directory.

Check the recorder's exit status, assertions, and actual source frames. Then run:

```bash
demokit raw .demokit/shot-<name>
demokit verify .demokit/shot-<name> out/demo.mp4
demokit critic .demokit/shot-<name> out/demo.mp4
```

Inspect the images these commands return. A valid MP4, a successful click, or a
geometry check does not prove the promised behavior. Read
[verification and editing](references/verification.md) for interpreting evidence
and choosing between a new recording and a new render.

## Deliver

Return the playable MP4, a short account of what was demonstrated, and any material
limits. Respect the user's output location and sharing preferences. Do not upload
recordings, push captures to GitHub, or publish a link without authorization.

Work directories contain unredacted frames and page text, even if the final video
looks harmless. Keep them untracked. If secrets were captured, stop distribution,
identify the affected artifacts, and coordinate cleanup and credential rotation
with the user. Do not rewrite repository history or delete unrelated recordings.
