// Exercise the packed artifact from outside the repository, including spaced paths.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const root = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "demokit-smoke-"));
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--pack-destination", temp, "--json"], {
    encoding: "utf8",
  }),
);
const prefix = join(temp, "install");
execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    join(temp, pack.filename),
  ],
  { stdio: "inherit" },
);
const cwd = join(temp, "user directory with spaces");
mkdirSync(cwd);
const cli = join(prefix, "node_modules", ".bin", "demokit");
const work = join(cwd, ".demokit");
const env = { ...process.env, DEMOKIT_WORK: work };
function run(args) {
  return spawnSync(cli, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });
}
function ok(args) {
  const r = run(args);
  assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r;
}
ok(["--help"]);
ok(["--version"]);
ok(["init", "example"]);
ok(["skill", "install", join(cwd, "skills", "demo-video")]);
const flow = JSON.parse(readFileSync(join(cwd, "example", "flow.json")));
const probe = ok(["probe", flow.url]);
assert.match(probe.stdout, /Task board/);
assert.ok(existsSync(join(work, "probe.json")));
ok([
  "local",
  "example/flow.json",
  "out/example.mp4",
  "--w",
  "1280",
  "--h",
  "720",
  "--fps",
  "15",
]);
const manifest = JSON.parse(
  readFileSync(join(work, "shot-flow", "manifest.json")),
);
assert.ok(manifest.frames.length > 2);
assert.ok(
  manifest.proof.length > 0 &&
    manifest.proof.every(
      (p) => p.expect?.ok !== false && p.checks.every((c) => c.ok !== false),
    ),
);
ok(["verify", ".demokit/shot-flow", "out/example.mp4"]);
const first = readFileSync(join(cwd, "out/example.mp4"));
assert.ok(first.length > 1000);
// Relative render-only paths used to resolve inside node_modules.
ok([
  "--render-only",
  ".demokit/shot-flow",
  "out/second.mp4",
  "--w",
  "1280",
  "--h",
  "720",
  "--fps",
  "15",
]);
assert.ok(existsSync(join(cwd, "out/second.mp4")));
// A failed assertion must be reflected by a nonzero capture status.
flow.steps[0].expect = { sel: "#does-not-exist", timeout: 200 };
writeFileSync(join(cwd, "example", "bad.json"), JSON.stringify(flow));
const bad = run(["local", "example/bad.json", "out/should-not-exist.mp4"]);
assert.notEqual(bad.status, 0, bad.stdout);
assert.equal(existsSync(join(cwd, "out/should-not-exist.mp4")), false);
assert.ok(
  !readdirSync(join(prefix, "node_modules", "@dekai", "demokit")).some((x) =>
    [".cache", ".assets", ".demokit"].includes(x),
  ),
);
console.log(
  JSON.stringify(
    {
      result: "passed",
      output: join(cwd, "out/example.mp4"),
      shot: join(work, "shot-flow"),
      package: pack.filename,
    },
    null,
    2,
  ),
);
