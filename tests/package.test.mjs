import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
test("npm ships runnable example, references, and docs without captures or credentials", () => {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }),
  );
  const files = pack.files.map((f) => f.path);
  for (const path of [
    "bin/demokit",
    "src/setup.mjs",
    "examples/quickstart/index.html",
    "examples/findings-app/serve.py",
    "fixtures/findings.json",
    "skill/references/flows.md",
    "docs/ALTERNATIVES.md",
    "docs/AUDIT-2026-09-04.md",
    "CONTRIBUTING.md",
  ])
    assert.ok(files.includes(path), path);
  assert.equal(
    files.some((p) =>
      /(^|\/)(\.demokit|\.cache|vendor|node_modules)\/|\.(mp4|png|tgz)$|cookies|storage-state/.test(
        p,
      ),
    ),
    false,
  );
  assert.ok(pack.unpackedSize < 1000000);
});
test("all bundled skill references exist", () => {
  const skill = readFileSync("skill/SKILL.md", "utf8");
  for (const [, path] of skill.matchAll(/\]\((references\/[^)]+)\)/g))
    assert.ok(readFileSync("skill/" + path, "utf8").length > 50);
  assert.ok(skill.split("\n").length < 120);
});
