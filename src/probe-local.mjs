import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DEMOKIT_PW || "playwright-core");
const [url, out] = process.argv.slice(2);
const cache =
  process.env.DEMOKIT_CACHE ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "demokit");
const auth =
  process.env.DEMOKIT_AUTH ||
  join(
    cache,
    "auth",
    new URL(url).host.replace(/[^a-z0-9.-]/gi, "_") + ".json",
  );
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    ...(existsSync(auth) ? { storageState: auth } : {}),
  });
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "probe.js"),
    "utf8",
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("context", "require", "DEMOKIT_ARGS", source)(
    context,
    require,
    { url, probeOut: out },
  );
} finally {
  await browser.close();
}
