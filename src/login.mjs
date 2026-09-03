#!/usr/bin/env node
/**
 * Log in once, record forever.
 *
 *   demokit login <url>                      opens a real browser window; you sign in; done
 *   demokit login <url> --from-cookies f.json   convert a cookie export instead (CI, no window)
 *
 * Why this exists, and why it is shaped this way:
 *
 *  - Attaching to the user's OWN running Chrome is no longer possible. Since
 *    Chrome 136, --remote-debugging-port is ignored on the default profile, on
 *    purpose: malware was using it to lift cookies. The only way in is a browser
 *    extension (that is what playwriter is), which is a thing to install.
 *  - Sharing one browser PROFILE between a headed login and a headless recording
 *    is a known, unfixed Playwright bug on macOS (#35466): the headless run
 *    cannot read the cookies and leaves the profile locked and corrupt.
 *  - So this does what Playwright's own auth guide says to do: sign in once in a
 *    real window, save the storage state (cookies + localStorage + IndexedDB)
 *    to a file, and load that file into every later context. It is a plain JSON
 *    document, independent of which browser build produced it.
 *
 * The headed window is the user's installed Google Chrome when there is one -
 * nothing to download, and a window they recognise - otherwise Playwright's full
 * Chromium (the headless shell cannot open a window).
 *
 * The saved file can impersonate the user. It is written 0600 under
 * ~/.cache/demokit/auth/<host>.json and never inside a project.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const req = createRequire(import.meta.url);

const [, , url, ...rest] = process.argv;
if (!url || url.startsWith('--')) {
  console.error('usage: demokit login <url> [--from-cookies cookies.json] [--out file.json]');
  process.exit(2);
}
const argOf = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };

export function authDir() {
  return join(process.env.DEMOKIT_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'demokit'), 'auth');
}
export function authFileFor(u) {
  return join(authDir(), new URL(u).host.replace(/[^a-z0-9.-]/gi, '_') + '.json');
}

const out = argOf('out', authFileFor(url));
mkdirSync(dirname(out), { recursive: true });

// ---- path 1: convert a cookie export (no window; for CI or a headless box) ---
const fromCookies = argOf('from-cookies', null);
if (fromCookies) {
  const raw = JSON.parse(readFileSync(fromCookies, 'utf8'));
  const cookies = raw.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.expires && c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
  writeFileSync(out, JSON.stringify({ cookies, origins: [] }, null, 1));
  chmodSync(out, 0o600);
  console.log(`login: ${cookies.length} cookie(s) -> ${out}`);
  process.exit(0);
}

// ---- path 2: a real window ------------------------------------------------------
function loadPlaywright() {
  for (const c of [process.env.DEMOKIT_PW, join(ROOT, 'node_modules', 'playwright-core'),
    join(ROOT, '.tools', 'node_modules', 'playwright-core'), 'playwright-core'].filter(Boolean)) {
    try { return req(c).chromium; } catch { /* next */ }
  }
  console.error('login: playwright-core not found. Run `npm install` in the demokit directory.');
  process.exit(2);
}
const chromium = loadPlaywright();

let browser = null, using = '';
for (const attempt of [
  { channel: 'chrome', label: 'your installed Google Chrome' },
  { channel: 'msedge', label: 'your installed Microsoft Edge' },
  { label: "Playwright's Chromium" },
]) {
  try {
    browser = await chromium.launch({ headless: false, ...(attempt.channel ? { channel: attempt.channel } : {}) });
    using = attempt.label; break;
  } catch (e) {
    if (!attempt.channel) {
      const m = String(e.message || e).split('\n')[0];
      if (/Executable doesn't exist/i.test(m)) {
        console.error('login: no browser can open a window here. Either install Google Chrome, or run once:');
        console.error(`  node ${join(ROOT, 'node_modules', 'playwright-core', 'cli.js')} install chromium`);
        console.error('  (or export cookies from a signed-in browser and use --from-cookies)');
        process.exit(5);
      }
      throw e;
    }
  }
}

const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log(`login: opened ${url} in ${using}.`);
console.log('login: sign in there. When the app is showing you your own data, come back here and press Enter.');
console.log('       (Nothing is recorded during this. The window closes when you press Enter.)');

// Enter finishes; so does the window being closed by hand.
await new Promise((res) => {
  const rl = createInterface({ input: process.stdin });
  rl.once('line', () => { rl.close(); res(); });
  // A piped or closed stdin never produces a line; do not hang on it.
  rl.once('close', () => res());
  page.once('close', () => { rl.close(); res(); });
  browser.once('disconnected', () => { rl.close(); res(); });
});

let state = null;
try { state = await context.storageState(); } catch (e) {
  console.error('login: the browser closed before the session could be saved. Run it again and press Enter while the window is still open.');
  process.exit(6);
}
// Warn when it plainly did not work: no cookies for the host is not a session.
const host = new URL(url).host;
const forHost = state.cookies.filter((c) => host.endsWith(c.domain.replace(/^\./, '')) || c.domain.replace(/^\./, '').endsWith(host.split('.').slice(-2).join('.')));
writeFileSync(out, JSON.stringify(state, null, 1));
chmodSync(out, 0o600);
console.log(`login: saved ${state.cookies.length} cookie(s), ${state.origins.length} origin(s) of local storage -> ${out}`);
if (!forHost.length) console.log(`login: WARNING - none of those cookies are for ${host}. Did the sign-in complete?`);
console.log(`login: \`demokit local\` will use it automatically for ${host}. It expires when the app's session does; run login again then.`);
await browser.close().catch(() => {});
