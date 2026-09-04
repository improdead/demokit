# Contributing

Use Node 20+ and Python 3 on macOS/Linux. Install with `npm ci`. Run `npm test`,
`npm run test:smoke`, and `npm pack --dry-run` before requesting review. For browser
changes, inspect source and delivered frames as well as assertions. Native capture
and real-Chrome flows require separate manual testing; CI cannot certify them.

Never commit `.demokit`, recordings, auth/storage-state files, or `vendor` checkouts.
Use synthetic local fixtures in tests. A filename allowlist controls npm contents;
check the actual tarball, not only `.gitignore`.

## Release checklist

The next release is blocked by the renderer provenance/licensing issue documented
in `docs/AUDIT-2026-09-04.md`. Resolve that explicitly before publishing. Do not
change the project license or rewrite published history as a routine release step.

After resolution:

1. Update package and lockfile versions together and remove the candidate notice.
2. Run CLI/package tests and the end-to-end smoke on the supported platforms.
3. Pack a tarball and install it in a temporary prefix outside the repository.
4. Run help, init, skill installation, and capture/render/verify from an unrelated
   directory with spaces. Inspect the final frames. Ensure no package-directory writes.
5. Review tarball contents and license/notice files. Authenticate to npm without
   placing tokens in commands, logs, docs, or Git. Prefer trusted publishing when configured.
6. Publish only the reviewed version, then verify registry metadata and reinstall
   that exact registry artifact. Create matching GitHub release notes.

No auto-publish workflow is configured. A CI pass is not publishing authorization.
