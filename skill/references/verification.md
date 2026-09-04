# Verify behavior before judging the edit

The local recorder records before/after DOM evidence. `verify` compares that with
source pixels and, when supplied an MP4, delivered frames at mapped timestamps.
Outcomes are `verified`, `failed`, or `inconclusive`. Inspect `verify.json` rather
than reducing the result to a green command. `verify` exits nonzero on failure;
inconclusive evidence must still be reported. The complete local render pipeline
fails on failed/inconclusive browser verification unless explicitly using
`--no-verify` for an exploratory render. Never call an unchecked render verified.

1. Check the capture log and `manifest.json`: expected target, action, result,
   final URL and timing. Missing selectors or failed assertions require fixing the
   flow/app. A skipped or throwing step is a failed step.
2. Run `demokit raw <shotDir>` and inspect `raw-sheet.png`. Ensure the sequence
   demonstrates the claim. Static scene/idle labels are heuristic; examine pixels.
3. Run `demokit verify <shotDir> <out.mp4>`, inspect the per-step source/delivered
   strips, and distinguish missing evidence from a demonstrated product failure.
4. Run `demokit critic <shotDir> <out.mp4>` and inspect opening, camera peaks,
   transitions, and ending. Check readable text, visible result, and enough time
   to understand it. Geometry checks cannot replace watching these frames.

## Edit or record again?

- Wrong app, missing result, fabricated output, obstructed payoff: fix the flow or
  app and capture again.
- Correct source, poor pacing/framing: `demokit --render-only <shotDir> <out.mp4>`.
  Keep the original manifest and record intentional camera-only changes separately.
- `recipe.json` persists supported render flags. The Cap renderer derives its own
  camera segments; arbitrary edits to the older `edit.json` format may not affect it.
  Confirm a changed option actually changed the exported pixels.

Common render flags: `--w 1920 --h 1080 --fps 30`, `--speed 2`, `--deadspeed 3`,
`--tailhold 3`, `--read 1800`, `--keep 0.65`. **`read` is milliseconds; `tailhold`
and `keep` are seconds.** `--cap-config <file>` supplies the Cap-style renderer's
configuration; `--engine ffmpeg` selects the older compositor, whose framing and
background knobs are different. Consult `docs/rendering.md` in the repository for
maintainer details. Do not promise that every legacy flag affects both engines.

Return the actual MP4. Summarize what was verified and any limits; do not present
"pending vision", inconclusive checks, or successful encoding as full signoff.
