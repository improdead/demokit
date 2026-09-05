# Capture modes and installation

Prerequisites: Node 20+, Python 3 with `venv`, macOS or Linux. First capture may
install matching Chromium and create a cached Python environment for Pillow/numpy.
FFmpeg/ffprobe come from system binaries or npm dependencies. If npm blocks install
scripts, `ffmpeg-static` may not download its binary; see the main README.

The default local path needs no Playwriter, extension, Docker, account, or hosted
render service. Linux may need Playwright's system libraries installed separately.
Windows is not supported by the Bash entrypoint.

## Authenticated browser

`demokit login https://app.example.com` opens a separate browser for manual sign-in.
Sessions are stored outside the project under `~/.cache/demokit/auth` (or
`DEMOKIT_CACHE/auth`), with mode 0600. Browser session expiry still applies.
`DEMOKIT_AUTH` selects an explicit Playwright storage-state file;
`DEMOKIT_COOKIES` selects a cookies file. Treat both as secrets.

For an existing real Chrome session:

```bash
# Optional dependency and browser extension: https://playwriter.dev
npm install -g playwriter
# Create the session from the directory where the recording should live.
playwriter session new --browser <browser-key>
demokit --session <id> probe https://app.example.com
demokit --session <id> flow.json out/demo.mp4
```

Respect Playwriter's session filesystem scope. Arguments are structured rather than
written inside the installed npm package. This legacy recorder does not emit the
same complete semantic proof as `local`; use the browser and exported frames to
verify the requested behavior, and report automatic evidence as inconclusive. The
verification gate returns nonzero for an inconclusive export; `--no-verify` is an
explicit exploratory option, not a successful verification result.

## Terminal and native capture

- `demokit term "command" out/demo.mp4` **executes** the command in a PTY and draws
  terminal frames. Use only commands within the user's authorized scope.
- `demokit termreal spec.json out/demo.mp4` drives and films Terminal.app. macOS
  only; requires Screen Recording and Accessibility permission and uses the display.
- `demokit screen out/demo.mp4 --seconds 15` records the real macOS screen. Other
  windows and notifications can be captured; choose the intended window/region.
- `demokit box flow.json out/demo.mp4` uses Docker/X11; experimental, separate from
  the tested default path.

The terminal/native/Docker modes have not been certified by this package audit.
Legacy helper commands may still use paths under the package directory; use a
checkout for those modes until their install-path behavior is covered by tests.

## Work files

`DEMOKIT_WORK` selects a directory relative to the caller or an absolute path.
The default `.demokit/` gets an internal `.gitignore`. Output MP4s are wherever the
user requested and need their own ignore rule. A work directory contains frames,
DOM evidence, camera instructions and temporary renders. Do not share it implicitly.
