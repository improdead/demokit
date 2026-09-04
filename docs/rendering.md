# Rendering and capture notes

DemoKit records PNG frames plus a manifest, renders a cursor and composition, then
remaps timing. `manifest.json` stores frame timestamps, actions, camera events,
pointer coordinates and (local capture) per-step proof. `recipe.json` stores
supported flags; `pace.json` maps source time to exported time. `verify.json` and
critic sheets are evidence, not automatic visual signoff.

The default renderer is `src/caprender.py`; its provenance is a release blocker
listed in the audit. The older `--engine ffmpeg` compositor uses different camera
and background settings. Do not assume that every option in the older compositor
changes the default renderer. The Cap path regenerates its camera segments from
manifest events and configuration; editing an older `edit.json` alone is not a
reliable way to change that export.

| Option                               | Unit/purpose                                              |
| ------------------------------------ | --------------------------------------------------------- |
| `--w`, `--h`                         | Output pixels                                             |
| `--fps`                              | Output frames/second                                      |
| `--speed`, `--deadspeed`             | Playback multipliers                                      |
| `--read`                             | Milliseconds protected after a camera-associated action   |
| `--tailhold`, `--headhold`, `--keep` | Seconds                                                   |
| `--cap-config`, `--cap-assets`       | Existing configuration/assets for the Cap-style renderer  |
| `--engine ffmpeg`                    | Older compositor; different option support                |
| `--no-verify`                        | Exploratory rendering without the automatic behavior gate |

Source frames are generated on browser repaints. The recorder forces small paint
invalidations so static holds and pointer motion have frame timestamps. Timing
still requires inspection. The local engine currently uses CSS zoom to increase
resolution, which can distort layouts based on viewport units. A separate
Playwriter capture using deviceScaleFactor=2 was tested on Chrome during the audit;
that does not establish that the packaged default path behaves identically.

No wallpaper, reference recording, authenticated app capture, or upstream vendor
checkout is included in the npm package. The renderer can load the caller's local
assets or use a system wallpaper/gradient. Do not redistribute media without rights.
