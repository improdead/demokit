import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve("bin/demokit");
function run(args, cwd) {
  return spawnSync(cli, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DEMOKIT_WORK: join(cwd, ".demokit") },
  });
}
for (const flag of ["--help", "--version"])
  test(`${flag} works without provisioning or writing files`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "demokit-cli-"));
    try {
      const r = run([flag], cwd);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.trim());
      assert.equal(existsSync(join(cwd, ".demokit")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
test("init gives a self-contained flow and refuses to overwrite it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "demokit-cli-"));
  try {
    const r = run(["init", "demo with spaces"], cwd);
    assert.equal(r.status, 0, r.stderr);
    const dir = join(cwd, "demo with spaces");
    const flow = JSON.parse(readFileSync(join(dir, "flow.json")));
    assert.ok(existsSync(new URL(flow.url)));
    assert.match(readFileSync(join(dir, "index.html"), "utf8"), /Create task/);
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.demokit/);
    const again = run(["init", "demo with spaces"], cwd);
    assert.notEqual(again.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "flow.json"))), flow);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("skill installation copies references and never overwrites an existing skill", () => {
  const cwd = mkdtempSync(join(tmpdir(), "demokit-cli-"));
  try {
    const dest = join(cwd, "skills", "demo-video");
    const r = run(["skill", "install", dest], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dest, "SKILL.md")));
    assert.ok(existsSync(join(dest, "references", "flows.md")));
    assert.notEqual(run(["skill", "install", dest], cwd).status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
