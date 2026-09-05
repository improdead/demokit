# Flow format (local recorder)

A flow is JSON. Paths under `seed.routes[].file` resolve relative to the flow file.
Input/output paths on the CLI resolve relative to the caller's working directory.

```json
{
  "claim": "Creating a task adds it to the board.",
  "url": "http://localhost:3000/tasks",
  "layout": [1280, 720],
  "zoom": 2,
  "probe": "#tasks li",
  "settleMs": 1000,
  "tailMs": 2400,
  "steps": [
    {
      "do": "click",
      "sel": "button[data-testid='create-task']",
      "label": "Create task",
      "ms": 1600,
      "expect": { "sel": "#tasks li", "timeout": 8000 },
      "shows": "A new task appears in the board.",
      "prove": { "rowsRise": true, "textAppears": "Review the demo" }
    }
  ]
}
```

## Steps

| `do`              | Fields and behavior                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `click` / `pulse` | `sel`, optional `nth`; move then press/release                                               |
| `type`            | `sel`, `text`, optional `delay`; types into the existing value, does not clear automatically |
| `hover` / `move`  | `sel`, optional `nth`; move and dwell                                                        |
| `scrollTo`        | `sel`; scroll into view                                                                      |
| `key`             | `key`, e.g. `ControlOrMeta+A` or `Escape`                                                    |
| `wait`            | `ms`; dwell without an action                                                                |

`ms` controls time after the action; `findMs` controls target lookup.
Set `later: true` when a preceding step creates a target. Other selector targets
are checked before recording. `beat: false` suppresses its automatic camera anchor,
but does not skip the action. `expect` asserts that its target becomes visible.
Do not use `allowMissing` to turn a broken flow into a successful result.

The local recorder rejects `drag` and unknown step types. The legacy Playwriter
recorder has different capabilities; do not copy a legacy flow without checking.
Keyboard/scroll/wait actions are captured but do not themselves have complete
per-step semantic evidence. Verify their outcome through a subsequent asserted step
and visual inspection.

## Evidence

| `prove` key                | Meaning                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| default                    | For clicks/typing, text novelty ≥8%, row-count movement, or URL change                   |
| `minChange`                | Different text-novelty threshold, justified by the actual behavior                       |
| `changes: false`           | Skip generic novelty when it is unsuitable; provide a specific assertion and explain why |
| `rowsRise` / `rowsDrop`    | Visible count of the CSS selector in flow-level `probe` changes                          |
| `urlChanges`               | Page URL changes                                                                         |
| `textAppears` / `textGone` | A string or list of strings changes presence                                             |

These are heuristics. Expanding a graph can preserve all its text, while a spinner
can change pixels without delivering a result. Use explicit `expect` selectors and
inspect the source and exported frames; do not lower thresholds just to get green.
A custom canvas-area assertion is not part of the published flow schema.

## Inputs and presentation

`seed.localStorage`, `seed.sessionStorage`, and `seed.clock` are installed before
navigation. `seed.routes` accepts `{url, file}` or `{url, json}`, plus optional
`status`, `contentType`, and `delayMs`. Match query strings using an appropriate URL
glob, e.g. `**/api/tasks*`. `route.fulfill` buffers responses; it cannot simulate
streaming faithfully. Fixtures establish demo inputs, not a fabricated result.

`hide` is a list of CSS selectors hidden with `visibility:hidden`; `redact` blurs
matched elements. Prefer demo accounts without sensitive data. These decorations
are currently applied after initial navigation; full-document navigation can lose
them. Do not rely on them to protect credentials.

The current local recorder obtains extra pixels with a larger viewport and CSS
zoom. Viewport-unit/fullscreen layouts may therefore differ from normal browsing.
Verify the actual capture; Playwriter with device-scale capture was tested separately
but is not yet the packaged local recorder. No audio, narration, or caption track
is produced. Responsive behavior should be tested independently of the film.
