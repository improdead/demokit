#!/usr/bin/env node
/**
 * Record a flow with a headless Chromium that demokit launches itself.
 *
 *   node src/localcap.mjs <flow.json> <shotDir> [--cookies file]
 *
 * No Docker, no browser extension, no display. This is the default capture
 * path for anyone who installs the package.
 *
 * What the container used to provide, and why it is no longer needed:
 *
 *   a real X11 pointer     the Cap engine DRAWS the cursor from the recorded
 *                          path, with the recorded shape - the X11 one was
 *                          switched off at capture anyway
 *   real window chrome     the engine draws a macOS bar; chrome.py draws the
 *                          tab strip and URL bar for a page-only recording
 *   background recording   headless Chromium has no window to hijack
 *   Linux fonts            headless Chromium on macOS renders with the
 *                          machine's own fonts, which is BETTER than the
 *                          container's Liberation set
 *
 * Two things that are not obvious (from record.js, which this replaces):
 *
 * 1. Page.startScreencast captures CSS pixels and ignores deviceScaleFactor.
 *    To get 2x pixels: a 2x viewport plus `html{zoom:2}`. The page lays out
 *    as if it were `layout` wide but renders at 2x, and getBoundingClientRect
 *    returns zoomed coords, so every recorded position is 1:1 with frame px.
 * 2. The screencast only emits a frame when the page REPAINTS. A 1px alpha
 *    nudge on every pointer sample is a real invalidation and costs nothing.
 *
 * Emits the same shot format as screenbox: frames/, and a manifest with
 * events (press `at`, release `up`), a pointer track carrying the cursor SHAPE
 * per sample, and a per-step proof of what the product did.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const req = createRequire(import.meta.url);

function loadPlaywright() {
  const cands = [
    process.env.DEMOKIT_PW,
    join(ROOT, 'node_modules', 'playwright-core'),
    join(ROOT, '.tools', 'node_modules', 'playwright-core'),
    'playwright-core',
  ].filter(Boolean);
  for (const c of cands) {
    try { return { chromium: req(c).chromium, from: c }; } catch { /* next */ }
  }
  console.error('localcap: playwright-core not found. Run `npm install` in the demokit directory.');
  process.exit(2);
}

const [, , flowPath, shotDir, ...rest] = process.argv;
if (!flowPath || !shotDir) {
  console.error('usage: localcap.mjs <flow.json> <shotDir> [--cookies file]');
  process.exit(2);
}
const argOf = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
const supportedSteps = new Set(['wait','key','scrollTo','hover','move','click','type','pulse']);
if (!Array.isArray(flow.steps) || flow.steps.some(s => !supportedSteps.has(s.do))) {
  console.error('localcap: unsupported step; local supports wait, key, scrollTo, hover, move, click, type, pulse'); process.exit(2);
}
// The screencast captures CSS pixels, so resolution comes from html{zoom}. A flow
// written for the container path says zoom 1 because the container had a 2x
// display; here that would record 1440x810 and upscale it to 4K. Never below 2.
const ZOOM = flow.localZoom ?? Math.max(2, flow.zoom ?? 2);
const [LW, LH] = flow.layout ?? [1600, 900];
const W = LW * ZOOM, H = LH * ZOOM;

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(join(shotDir, 'frames'), { recursive: true });

const { chromium, from } = loadPlaywright();
let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (e) {
  const msg = String(e.message || e).split('\n')[0];
  if (/Executable doesn't exist/i.test(msg)) {
    console.error('localcap: Chromium is not downloaded yet. Run once:');
    console.error(`  node ${join(dirname(from.endsWith('playwright-core') ? from : join(ROOT, 'node_modules', 'playwright-core')), 'cli.js')} install chromium-headless-shell`);
    process.exit(5);
  }
  throw e;
}
// A session saved by `demokit login` (Playwright storageState: cookies +
// localStorage + IndexedDB) is loaded by host, automatically. It is the seamless
// path: no extension, no cookie export, one sign-in per app.
const authDir = join(process.env.DEMOKIT_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'demokit'), 'auth');
const host = new URL(flow.url).host.replace(/[^a-z0-9.-]/gi, '_');
const authFile = argOf('auth', process.env.DEMOKIT_AUTH || join(authDir, host + '.json'));
const useAuth = existsSync(authFile);
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
  ...(useAuth ? { storageState: authFile } : {}),
});
if (useAuth) console.log(`localcap: using the saved session for ${host} (${authFile})`);

// The older path: cookies exported from a signed-in browser, injected before the
// first navigation. Kept for CI and for `demokit login --from-cookies`.
const cookieFile = argOf('cookies', process.env.DEMOKIT_COOKIES);
if (!useAuth && cookieFile && existsSync(cookieFile)) {
  const raw = JSON.parse(readFileSync(cookieFile, 'utf8'));
  await context.addCookies(raw.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : undefined,
  })));
  console.log(`localcap: injected ${raw.length} cookie(s)`);
}

const page = await context.newPage();

// ---- seeding: everything here must be installed before the first paint ------
const seed = flow.seed || {};
if (seed.clock) {
  await page.addInitScript(`(() => {
    const fixed = new Date(${JSON.stringify(seed.clock)}).getTime();
    const drift = ${seed.clockTicks === false ? 'false' : 'true'};
    const start = Date.now(); const R = Date;
    function D(...a) { return a.length ? new R(...a) : new R(fixed + (drift ? R.now() - start : 0)); }
    D.now = () => fixed + (drift ? R.now() - start : 0);
    D.parse = R.parse; D.UTC = R.UTC; D.prototype = R.prototype; window.Date = D;
  })()`);
}
if (seed.localStorage || seed.sessionStorage) {
  await page.addInitScript(`(() => {
    const ls = ${JSON.stringify(seed.localStorage || {})}, ss = ${JSON.stringify(seed.sessionStorage || {})};
    try { for (const k in ls) localStorage.setItem(k, typeof ls[k] === 'string' ? ls[k] : JSON.stringify(ls[k])); } catch (e) {}
    try { for (const k in ss) sessionStorage.setItem(k, typeof ss[k] === 'string' ? ss[k] : JSON.stringify(ss[k])); } catch (e) {}
  })()`);
}
for (const r of seed.routes || []) {
  const body = r.file ? readFileSync(resolve(dirname(flowPath), r.file), 'utf8') : (typeof r.body === 'string' ? r.body : JSON.stringify(r.json ?? r.body ?? {}));
  await page.route(r.url, async (route) => {
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    await route.fulfill({ status: r.status || 200, contentType: r.contentType || 'application/json', body });
  });
  console.log(`  stub ${r.url}${r.file ? ' <- ' + r.file : ''}`);
}

await page.goto(flow.url, { waitUntil: flow.waitUntil || 'domcontentloaded' });
await page.waitForTimeout(flow.settleMs ?? 1200);
if (flow.clearStorage === true) {
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
}

// Do not start on a sign-in page.
const authed = await page.evaluate(() => !/sign in|welcome back|log in|continue with/i.test(document.body.innerText.slice(0, 600))).catch(() => true);
if (!authed) {
  console.log(`PREFLIGHT FAILED: the page is a sign-in screen. Run once:  demokit login ${flow.url}`);
  await browser.close(); process.exit(3);
}

const css = [`html{zoom:${ZOOM}}`];
if (flow.hide?.length) css.push(flow.hide.join(',') + '{visibility:hidden !important}');
if (flow.redact?.length) css.push(flow.redact.join(',') + '{filter:blur(9px) !important}');
if (flow.stillness !== false) css.push('*,*::before,*::after{scroll-behavior:auto !important}');
await page.addStyleTag({ content: css.join('\n') });
await page.waitForTimeout(500);

const loc = (s) => (s.nth == null ? page.locator(s.sel).first() : page.locator(s.sel).nth(s.nth));
const box = async (s, ms) => await loc(s).boundingBox({ timeout: s.findMs ?? ms ?? 2500 }).catch(() => null);

// ---- preflight ---------------------------------------------------------------
const missing = [];
for (const s of flow.steps) {
  if (!s.sel || s.later) continue;
  if (!(await box(s, Math.max(s.findMs ?? 0, 12000)))) missing.push(`${s.do} ${s.sel}`);
}
if (missing.length && !flow.allowMissing) {
  console.log('PREFLIGHT FAILED - these matched nothing at this viewport:');
  for (const m of missing) console.log('  - ' + m);
  console.log('  Mark a step "later": true if an earlier step creates its target; otherwise fix the selector.');
  await browser.close(); process.exit(4);
}
console.log(`localcap: ${flow.steps.filter((x) => x.sel && !x.later).length} selector(s) preflighted`);

// ---- proof: what the product did, measured (from boxflow) ----------------------
const PROBE = flow.probe || '[role="row"], tbody tr, [data-testid*="row"], li[role="option"]';
const proof = [];
async function snapshot() {
  return page.evaluate((sel) => {
    const onscreen = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight; };
    let rows = null;
    try { rows = [...document.querySelectorAll(sel)].filter(onscreen).length; } catch { rows = null; }
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    let digest = 0; for (let i = 0; i < text.length; i++) digest = (digest * 31 + text.charCodeAt(i)) | 0;
    const words = text.toLowerCase().split(' ').slice(0, 4000); const shingles = [];
    for (let i = 0; i + 2 < words.length; i++) { const g = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]; let h = 0; for (let j = 0; j < g.length; j++) h = (h * 31 + g.charCodeAt(j)) | 0; shingles.push(h); }
    return { url: location.href, title: document.title, rows, chars: text.length, digest, text, shingles };
  }, PROBE).catch(() => null);
}
const has = (st, t) => String(st.text || '').toLowerCase().includes(String(t).toLowerCase());
function judge(kind, before, after, prove) {
  const out = []; const add = (check, ok, detail) => out.push({ check, ok, detail });
  if (!before || !after) { add('evidence', null, 'page state could not be read'); return out; }
  const p = prove || {};
  const A = new Set(before.shingles || []), B = new Set(after.shingles || []);
  let inter = 0; for (const h of B) if (A.has(h)) inter++;
  const union = A.size + B.size - inter;
  const novel = union ? 1 - inter / union : (before.digest === after.digest ? 0 : 1);
  const navigated = before.url !== after.url;
  const listMoved = before.rows != null && after.rows != null && before.rows !== after.rows;
  const min = p.minChange ?? 0.08;
  const substantive = navigated || listMoved || novel >= min;
  if (p.changes !== false && (kind === 'click' || kind === 'type')) {
    const how = `${(novel * 100).toFixed(1)}% of the page content is new, rows ${before.rows}->${after.rows}, url ${navigated ? 'changed' : 'same'}`;
    add('the step visibly changed the product', substantive, substantive ? how : `${how} - below ${(min * 100).toFixed(0)}%, so nothing a viewer would notice happened here`);
  }
  const counted = before.rows != null && after.rows != null;
  if (p.rowsDrop) add('the list narrowed', counted ? after.rows < before.rows : null, counted ? `${before.rows} -> ${after.rows} visible rows` : 'the row probe matched nothing - set "probe" in the flow');
  if (p.rowsRise) add('the list grew', counted ? after.rows > before.rows : null, counted ? `${before.rows} -> ${after.rows} visible rows` : 'the row probe matched nothing - set "probe" in the flow');
  if (p.urlChanges) add('it navigated', navigated, navigated ? `-> ${after.url}` : `still ${after.url}`);
  for (const t of [].concat(p.textAppears || [])) { const was = has(before, t), is = has(after, t); add(`"${t}" appears`, is && !was, !is ? 'never appeared' : (was ? 'it was already on screen before the step - this proves nothing' : 'on screen now')); }
  for (const t of [].concat(p.textGone || [])) { const was = has(before, t), is = has(after, t); add(`"${t}" is gone`, was && !is, !was ? 'it was not there to begin with - this proves nothing' : (is ? 'still on screen' : 'cleared')); }
  return out;
}
const trim = (st) => (st ? { ...st, text: String(st.text || '').slice(0, 900), shingles: undefined } : null);

// ---- capture ---------------------------------------------------------------------
const cdp = await context.newCDPSession(page);
const frames = []; let n = 0; let firstAt = null;
cdp.on('Page.screencastFrame', async (f) => {
  const i = n++;
  if (firstAt === null) firstAt = Date.now() - t0;
  try {
    writeFileSync(join(shotDir, 'frames', `f${String(i).padStart(5, '0')}.png`), Buffer.from(f.data, 'base64'));
    frames.push({ i, t: f.metadata.timestamp });
  } catch (e) { console.log('frame write failed: ' + e.message); }
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
});
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });

const t0 = Date.now();
const now = () => Date.now() - t0;
const events = [], path = [], actions = [];
let curX = W / 2, curY = H / 2, curShape = '0';
const track = (x, y) => path.push({ x: Math.round(x), y: Math.round(y), t: now(), cursor_id: curShape });
track(curX, curY);

await page.evaluate(() => {
  const e = document.createElement('div'); e.id = '__dk_pulse';
  e.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;background:rgba(0,0,0,0.02);z-index:2147483647;pointer-events:none';
  document.documentElement.appendChild(e);
  window.__dkPulse = () => { e.style.background = e.style.background === 'rgba(0, 0, 0, 0.02)' ? 'rgba(0, 0, 0, 0.03)' : 'rgba(0, 0, 0, 0.02)'; };
});
const repaint = async () => { try { await page.evaluate(() => window.__dkPulse && window.__dkPulse()); } catch {} };
const rand = (a, b) => a + Math.random() * (b - a);

/** Human pointing: Fitts timing, minimum-jerk profile, a slight arc, overshoot on long moves. */
async function glide(x, y, opts = {}) {
  const x0 = curX, y0 = curY, dx = x - x0, dy = y - y0, dist = Math.hypot(dx, dy);
  if (dist < 1.5) { curX = x; curY = y; track(x, y); await repaint(); return; }
  const tw = opts.targetW || 90;
  const ms = opts.ms ?? Math.min(1150, 190 + 170 * Math.log2(1 + dist / tw));
  const steps = Math.max(10, Math.min(56, Math.round(ms / 16)));
  const side = Math.random() < 0.5 ? -1 : 1;
  const bow = side * Math.min(46, dist * rand(0.035, 0.075));
  const px = -dy / dist, py = dx / dist;
  const over = dist > 320 ? rand(0.02, 0.055) : 0;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps, e = p * p * p * (10 - 15 * p + 6 * p * p);
    const shoot = over ? Math.sin(Math.min(1, p * 1.18) * Math.PI) * over : 0;
    const arc = Math.sin(p * Math.PI) * bow;
    const nx = x0 + dx * (e + shoot) + px * arc + rand(-0.4, 0.4);
    const ny = y0 + dy * (e + shoot) + py * arc + rand(-0.4, 0.4);
    await page.mouse.move(nx, ny); curX = nx; curY = ny; track(nx, ny); await repaint();
    await page.waitForTimeout(Math.round((ms / steps) * rand(0.75, 1.25)));
  }
  curX = x; curY = y; track(x, y); await repaint();
}
async function dwell(ms) {
  const end = Date.now() + ms; let lastPulse = 0; const hx = curX, hy = curY;
  while (Date.now() < end) {
    await page.waitForTimeout(Math.min(60, Math.max(10, end - Date.now())));
    curX = hx + rand(-0.7, 0.7); curY = hy + rand(-0.7, 0.7); track(curX, curY);
    if (Date.now() - lastPulse > 140) { lastPulse = Date.now(); await repaint(); }
  }
}
/** The cursor SHAPE the page asks for under the pointer: pointer -> hand, text/input -> I-beam. */
async function shapeAt(x, y) {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py); let nd = el;
    while (nd) { const c = getComputedStyle(nd).cursor; if (c && c !== 'auto' && c !== 'default') return c.startsWith('pointer') ? '1' : c === 'text' ? '2' : c === 'not-allowed' ? '3' : '0'; nd = nd.parentElement; }
    return el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) ? '2' : '0';
  }, [x, y]).catch(() => '0');
}
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

async function runStep(s, label) {
  if (s.do === 'wait') { await dwell(s.ms ?? 800); return; }
  if (s.do === 'key') { await page.keyboard.press(s.key); await page.waitForTimeout(s.ms ?? 400); return; }
  if (s.do === 'scrollTo') { await loc(s).scrollIntoViewIfNeeded(); await page.waitForTimeout(s.ms ?? 700); return; }
  let b = await box(s);
  if (!b) {
    console.log(`STEP SKIPPED (${label}): ${s.sel} matched nothing at this point`);
    proof.push({ label, kind: s.do, tMs: now(), afterMs: now(), region: null, shows: s.shows || null, prove: s.prove || null,
      before: null, after: null, checks: [{ check: 'the step ran', ok: false, detail: `${s.sel} matched nothing - it was never performed` }] });
    return;
  }
  let c = centre(b);
  const before = await snapshot();
  await glide(c.x, c.y, { targetW: Math.max(20, b.width) });
  await dwell(s.settleMs ?? 380);
  // Re-measure before committing: a page still settling moves things while the pointer travels.
  const b2 = await box(s, 1200);
  if (b2) { const c2 = centre(b2); if (Math.hypot(c2.x - c.x, c2.y - c.y) > 6) { console.log(`re-aimed (${label}): the target moved ${Math.round(Math.hypot(c2.x - c.x, c2.y - c.y))}px`); await glide(c2.x, c2.y); await dwell(180); } b = b2; c = c2; }
  curShape = await shapeAt(c.x, c.y); track(c.x, c.y);
  const ev = { kind: s.do === 'hover' || s.do === 'move' ? 'hover' : (s.do === 'type' ? 'type' : 'click'), t: now(), label,
    x: Math.round(c.x), y: Math.round(c.y), w: Math.round(b.width), h: Math.round(b.height), bx: Math.round(b.x), by: Math.round(b.y) };

  if (s.do === 'hover' || s.do === 'move') {
    if (s.beat !== false) events.push(ev);
    const tAct = now(); await dwell(s.ms ?? 900);
    const afterH = await snapshot();
    proof.push({ label, kind: 'hover', tMs: tAct, afterMs: now(), region: [ev.bx, ev.by, ev.w, ev.h], shows: s.shows || null, prove: s.prove || null,
      before: trim(before), after: trim(afterH), checks: judge('hover', before, afterH, s.prove) });
    curShape = '0'; return;
  }

  // Press and release as two events with a human-length press between them.
  if (s.beat !== false && !s.beatAfter) events.push(ev);
  await page.mouse.down(); ev.at = now(); actions.push({ type: 'click', x: ev.x, y: ev.y, t: ev.at, label });
  await page.waitForTimeout(105 + Math.round(Math.random() * 55));
  await page.mouse.up(); ev.up = now();
  if (s.do === 'type') {
    curShape = '2'; track(c.x, c.y);
    await page.waitForTimeout(200);
    await page.keyboard.type(s.text, { delay: s.delay ?? 135 });
    await dwell(s.settleAfterMs ?? 900);
  }
  await dwell(s.ms ?? 1400);
  if (s.beat !== false && s.beatAfter) { ev.t = now(); events.push(ev); }
  let expect = null;
  if (s.expect) {
    const t = s.expect.sel || s.expect;
    const ok = await page.locator(t).first().waitFor({ state: 'visible', timeout: s.expect.timeout ?? 8000 }).then(() => true).catch(() => false);
    expect = { sel: t, ok }; console.log(ok ? `expect ok: ${t}` : `EXPECT FAILED after "${label}": ${t}`);
  }
  const after = await snapshot();
  const checks = judge(s.do === 'type' ? 'type' : 'click', before, after, s.prove);
  proof.push({ label, kind: s.do === 'type' ? 'type' : 'click', tMs: ev.at, afterMs: now(), region: [ev.bx, ev.by, ev.w, ev.h],
    shows: s.shows || null, prove: s.prove || null, expect, before: trim(before), after: trim(after), checks });
  for (const k of checks) {
    if (k.ok === false) console.log(`PROOF FAILED (${label}): ${k.check} - ${k.detail}`);
    else if (k.ok === null) console.log(`PROOF INCONCLUSIVE (${label}): ${k.detail}`);
  }
  curShape = '0';
}

for (const s of flow.steps) {
  const label = s.label || `${s.do} ${s.sel || ''}`.trim();
  try { await runStep(s, label); } catch (e) { console.log(`step failed (${label}): ${String(e.message || e).slice(0, 120)}`); proof.push({label,kind:s.do,tMs:now(),afterMs:now(),checks:[{check:'the step ran',ok:false,detail:String(e.message||e)}]}); }
}
await dwell(flow.tailMs ?? 1800);
const endMs = Math.max(0, now() - (firstAt || 0));
await cdp.send('Page.stopScreencast').catch(() => {});
await page.waitForTimeout(400);

let realW = W, realH = H;
try { const hb = readFileSync(join(shotDir, 'frames', 'f00000.png')); realW = hb.readUInt32BE(16); realH = hb.readUInt32BE(20); } catch {}
const base = frames.length ? frames[0].t : 0;
const shift = (a) => a.map((e) => ({ ...e, t: Math.max(0, e.t - (firstAt || 0)),
  ...(e.at != null ? { at: Math.max(0, e.at - (firstAt || 0)) } : {}), ...(e.up != null ? { up: Math.max(0, e.up - (firstAt || 0)) } : {}) }));
const shiftProof = (a) => a.map((p) => ({ ...p, tMs: Math.max(0, p.tMs - (firstAt || 0)), afterMs: Math.max(0, p.afterMs - (firstAt || 0)) }));
const evs = shift(events);
writeFileSync(join(shotDir, 'manifest.json'), JSON.stringify({
  width: realW, height: realH, layout: [LW, LH], zoom: ZOOM, dsf: 1, source: 'local',
  pageTitle: await page.title().catch(() => ''), pageUrl: page.url(),
  screenW: realW, screenH: realH, deco: { top: 0, left: 0 }, endMs,
  frames: frames.map((f) => ({ i: f.i, ms: Math.round((f.t - base) * 1000) })),
  events: evs, clicks: evs, actions: shift(actions),
  pointer: shift(path), path: [],            // the engine draws Cap's cursor from `pointer`
  proof: shiftProof(proof),
}, null, 1));
const bad = proof.filter(p => p.expect?.ok === false || p.checks.some(c => c.ok === false)).length;
console.log(`localcap: ${frames.length} frames @ ${realW}x${realH}, ${evs.length} event(s), ${path.length} pointer samples, ${(endMs / 1000).toFixed(1)}s -> ${shotDir}`);
console.log(bad ? `localcap: ${bad} PROOF FAILURE(S) - the video will show a feature that did not work` : 'localcap: every step changed the page it claimed to change');
await browser.close();

if (bad || !frames.length) process.exitCode = 2;
