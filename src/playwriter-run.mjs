// Pass structured arguments directly to Playwriter, never through an install-dir file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const [session, mode, first, out] = process.argv.slice(2);
if (!["probe", "record"].includes(mode))
  throw new Error("Invalid Playwriter mode");
const args =
  mode === "probe" ? { url: first, probeOut: out } : { flow: first, out };
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), mode + ".js"),
  "utf8",
);
const r = spawnSync(
  "playwriter",
  [
    "-s",
    session,
    "--timeout",
    "300000",
    "-e",
    `const DEMOKIT_ARGS=${JSON.stringify(args)};\n${source}`,
  ],
  { stdio: "inherit", cwd: process.env.DEMOKIT_CALLER || process.cwd() },
);
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
