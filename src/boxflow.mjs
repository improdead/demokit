#!/usr/bin/env node
/**
 * Run a flow against Chromium inside Screenbox, over CDP, while moving the
 * container's REAL X11 pointer to the same coordinates.
 *
 *   node src/boxflow.mjs <flow.json> <containerName> <dockerBin>
 *
 * The split matters. CDP resolves the selector and gives a bounding box in PAGE
 * coordinates - the only honest way to know where a thing is. xdotool moves the
 * pointer in SCREEN coordinates. Converting between them is the whole job: the
 * browser's own chrome sits above the viewport, so page (0,0) is not screen
 * (0,0), and getting that offset wrong puts the visible cursor a tab-strip's
 * height away from what it clicks.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// ESM `import` ignores NODE_PATH, so a playwright that lives in the npx cache
// (which is where playwriter's copy is) cannot be imported by name. createRequire
// against an explicit path can.
const req = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = req('playwright-core'));
} catch {
  const p = process.env.DEMOKIT_PW;
  if (!p) {
    console.error('boxflow: no playwright-core. Set DEMOKIT_PW to its directory, '
      + 'or run: (cd .tools && npm i playwright-core)');
    process.exit(2);
  }
  ({ chromium } = req(p));
}

const run = promisify(execFile);
const [, , flowPath, name, bin, winXs, winYs, dsfs, mode] = process.argv;
const PREPARE = mode === 'prepare';
const winX = Number(winXs || 0), winY = Number(winYs || 0);
// X11 works in DEVICE pixels; CDP bounding boxes are in CSS pixels. With a
// device scale factor those differ by exactly dsf, and forgetting it puts the
// pointer at half the distance from the origin that it should be.
const DSF = Number(dsfs || 1);
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));

const xdo = (args) => run(bin, ['exec', '-e', 'DISPLAY=:99', name, 'xdotool', ...args]).catch(() => {});

// The relay exposes CDP, but the browser still advertises its websocket as
// 127.0.0.1:9222 - which from out here is this machine, not the container. Fetch
// the endpoint and rewrite the host before connecting.
const ver = await (await fetch('http://localhost:9223/json/version')).json();
const ws = String(ver.webSocketDebuggerUrl).replace(/\/\/[^/]+\//, '//localhost:9223/');
const browser = await chromium.connectOverCDP(ws);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
// Carry an authenticated session into the container without ever handling a
// password: the cookies are set over CDP before the first real navigation, and
// nothing is written anywhere except the gitignored file they came from.
const cookieFile = process.env.DEMOKIT_COOKIES;
if (cookieFile && existsSync(cookieFile)) {
  const raw = JSON.parse(readFileSync(cookieFile, 'utf8'));
  const cookies = raw.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : undefined,
  }));
  await ctx.addCookies(cookies);
  console.log(`boxflow: injected ${cookies.length} cookie(s)`);
  if (flow.url) await page.goto(flow.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
}
await page.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(flow.settleMs ?? 3000);

if (PREPARE) {
  // 1. Do not start recording on a sign-in page. Cookies are injected before the
  //    first navigation, but the app still renders its auth screen for a beat
  //    while it validates them - and those seconds became the opening shot.
  const authed = async () => page.evaluate(() =>
    !/sign in|welcome back|log in|continue with/i.test(document.body.innerText.slice(0, 600)));
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    ok = await authed().catch(() => false);
    if (!ok) await page.waitForTimeout(700);
  }
  if (!ok) {
    console.log('BOX PREFLIGHT FAILED: still on a sign-in page after 14s.');
    console.log('  The injected cookies did not authenticate. Re-export them from a signed-in browser.');
    process.exit(3);
  }
  console.log('boxflow: authenticated');

  // 2. Preflight the selectors HERE, where the browser path already does it.
  //    A step that silently matches nothing produced a video from three-fifths
  //    of a flow, and the director then chained unrelated moments into one pan.
  const missing = [];
  for (const st of flow.steps) {
    if (!st.sel || st.later) continue;
    const l = st.nth == null ? page.locator(st.sel).first() : page.locator(st.sel).nth(st.nth);
    // Be generous here and nowhere else. Preflight is not on the recorded clock,
    // and a table that is still fetching its rows is not a broken selector - the
    // 2.5s budget the RUN uses was rejecting flows that would have worked.
    const b = await l.boundingBox({ timeout: Math.max(st.findMs ?? 0, 12000) }).catch(() => null);
    if (!b) missing.push(`${st.do} ${st.sel}`);
  }
  if (missing.length && !flow.allowMissing) {
    console.log('BOX PREFLIGHT FAILED - these matched nothing at this viewport:');
    for (const m of missing) console.log('  - ' + m);
    console.log('  A different viewport lays the page out differently; re-probe and fix the flow.');
    process.exit(4);
  }
  console.log(`boxflow: ${flow.steps.filter((x) => x.sel && !x.later).length} selector(s) preflighted`);
  await browser.close().catch(() => {});
  process.exit(0);
}

// Page (0,0) in DISPLAY coordinates = where the window is + how tall its chrome
// is. Both terms matter: drop the window origin and every click lands offset by
// wherever the window happens to sit; drop the chrome height and the visible
// pointer sits a tab-strip above whatever it clicks.
const chromeY = await page.evaluate(() => (window.outerHeight - window.innerHeight)) * DSF;
const chromeX = await page.evaluate(() => Math.max(0, (window.outerWidth - window.innerWidth) / 2)) * DSF;
console.log(`boxflow: window at ${winX},${winY} + chrome offset ${chromeX},${chromeY}`);

const toScreen = (x, y) => [Math.round(winX + chromeX + x * DSF), Math.round(winY + chromeY + y * DSF)];
const smooth = (p) => p * p * p * (10 - 15 * p + 6 * p * p);

// The container path produced no event stream, so the director had nothing to
// reason about and every take came back "nothing happens". Record what the flow
// did, in the same shape record.js emits, and write it beside the frames.
// A visual sync mark, and the reason for it: the FRAME clock starts when ffmpeg
// does, this clock starts here - after the CDP connect, the cookie injection,
// the navigation and the settle - and until now nothing connected the two. The
// gap is about nine seconds, which meant every camera move in every take fired
// nine seconds before the thing it was framing. It looked plausible only because
// the page before a click and the page after it are the same list.
//
// An estimate from wall clocks is good to about a second. A flash the capture
// can SEE is exact to a frame, and screenbox trims it back off.
await page.evaluate(() => {
  const d = document.createElement('div');
  d.id = '__dk_sync__';
  // Magenta, not white: a page part-way through loading is white, and the first
  // attempt at this locked onto the navigation flash instead of the mark.
  // Nothing in a real UI renders a full-viewport #ff00ff.
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ff00ff;pointer-events:none';
  document.documentElement.appendChild(d);
}).catch(() => {});
const t0 = Date.now();
const events = [], path = [], actions = [];
const now = () => Date.now() - t0;
await new Promise((r) => setTimeout(r, 240));
await page.evaluate(() => document.getElementById('__dk_sync__')?.remove()).catch(() => {});
await new Promise((r) => setTimeout(r, 160));


// ---------------------------------------------------------------------------
// Proof that the feature worked.
//
// Everything above this line verifies the CAMERA. None of it can tell you the
// product did anything: a click that lands on a dead button, a filter that
// filters nothing, a page that renders the same list it already had - all of it
// films perfectly. The demo then passes every geometric check and shows nothing.
//
// So each step carries its own falsifiable claim, and the state either differs
// across the action or it does not. This is deliberately cheap and comparable
// rather than faithful: url, title, a count of visible rows, and a digest of the
// page's text. Two of those disagreeing is evidence; all four agreeing after a
// click is the failure nobody catches by watching.
// ---------------------------------------------------------------------------
const PROBE = flow.probe || '[role="row"], tbody tr, [data-testid*="row"], li[role="option"]';
const proof = [];

async function snapshot() {
  return page.evaluate((sel) => {
    const onscreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight;
    };
    let rows = null;
    try { rows = [...document.querySelectorAll(sel)].filter(onscreen).length; } catch { rows = null; }
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    let digest = 0;
    for (let i = 0; i < text.length; i++) digest = (digest * 31 + text.charCodeAt(i)) | 0;
    // Word shingles, not a positional hash. "Something differs" is a useless
    // answer - a ticking counter differs. What matters is HOW MUCH of the page
    // is new, and a hash over fixed offsets cannot say, because inserting two
    // characters at the top shifts every block after it and reports 100%.
    const words = text.toLowerCase().split(' ').slice(0, 4000);
    const shingles = [];
    for (let i = 0; i + 2 < words.length; i++) {
      const g = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
      let h = 0;
      for (let j = 0; j < g.length; j++) h = (h * 31 + g.charCodeAt(j)) | 0;
      shingles.push(h);
    }
    return { url: location.href, title: document.title, rows, chars: text.length, digest, text, shingles };
  }, PROBE).catch(() => null);
}

const has = (st, t) => String(st.text || '').toLowerCase().includes(String(t).toLowerCase());

/** Compare two snapshots against what the step said it would prove. */
function judge(kind, before, after, prove) {
  const out = [];
  const add = (check, ok, detail) => out.push({ check, ok, detail });
  if (!before || !after) { add('evidence', null, 'page state could not be read'); return out; }
  const p = prove || {};
  const A = new Set(before.shingles || []), B = new Set(after.shingles || []);
  let inter = 0;
  for (const h of B) if (A.has(h)) inter++;
  const union = A.size + B.size - inter;
  // Share of the page's content that is NOT common to both states.
  const novel = union ? 1 - inter / union : (before.digest === after.digest ? 0 : 1);
  const navigated = before.url !== after.url;
  const listMoved = before.rows != null && after.rows != null && before.rows !== after.rows;
  const min = p.minChange ?? 0.08;
  const substantive = navigated || listMoved || novel >= min;

  // The default assertion, and the one that catches the failure everybody ships.
  // Note what it does NOT accept: "some bytes differ". A counter ticking over is
  // a difference and proves nothing - the first take through this pass came back
  // with a filter click that moved 2 characters out of 13,379 and would have
  // passed a plain inequality. The question is whether a VIEWER would see it.
  // Hover is exempt: its effect is a shadow or a tint, which lives in the pixels
  // and not in the text - verify.mjs judges that one from the frames.
  if (p.changes !== false && (kind === 'click' || kind === 'type')) {
    const how = `${(novel * 100).toFixed(1)}% of the page content is new`
      + `, rows ${before.rows}->${after.rows}, url ${navigated ? 'changed' : 'same'}`;
    add('the step visibly changed the product', substantive, substantive ? how
      : `${how} - below ${(min * 100).toFixed(0)}%, so nothing a viewer would notice happened here`);
  }
  // A row probe that matched nothing is not a failed feature, it is a failed
  // measurement. Saying "narrowed: no" because the selector was wrong is the
  // same lie as saying "fine" because nothing was checked.
  const counted = before.rows != null && after.rows != null;
  if (p.rowsDrop) add('the list narrowed', counted ? after.rows < before.rows : null,
    counted ? `${before.rows} -> ${after.rows} visible rows` : 'the row probe matched nothing - set "probe" in the flow');
  if (p.rowsRise) add('the list grew', counted ? after.rows > before.rows : null,
    counted ? `${before.rows} -> ${after.rows} visible rows` : 'the row probe matched nothing - set "probe" in the flow');
  if (p.urlChanges) add('it navigated', before.url !== after.url,
    before.url === after.url ? `still ${after.url}` : `-> ${after.url}`);
  for (const t of [].concat(p.textAppears || [])) {
    const was = has(before, t), is = has(after, t);
    add(`"${t}" appears`, is && !was,
      !is ? 'never appeared' : (was ? 'it was already on screen before the step - this proves nothing' : 'on screen now'));
  }
  for (const t of [].concat(p.textGone || [])) {
    const was = has(before, t), is = has(after, t);
    add(`"${t}" is gone`, was && !is,
      !was ? 'it was not there to begin with - this proves nothing' : (is ? 'still on screen' : 'cleared'));
  }
  return out;
}

let curX = winX + 40, curY = winY + 40;
async function glide(x, y) {
  const d = Math.hypot(x - curX, y - curY);
  const steps = Math.max(8, Math.min(48, Math.round(d / 28)));
  const x0 = curX, y0 = curY;
  for (let i = 1; i <= steps; i++) {
    const e = smooth(i / steps);
    const nx = x0 + (x - x0) * e, ny = y0 + (y - y0) * e;
    await xdo(['mousemove', String(Math.round(nx)), String(Math.round(ny))]);
    path.push({ x: Math.round(nx - winX), y: Math.round(ny - winY), t: now() });
    await page.waitForTimeout(14);
  }
  curX = x; curY = y;
}

for (const s of flow.steps) {
  const label = s.label || s.do;
  try {
    if (s.do === 'wait') { await page.waitForTimeout(s.ms ?? 800); continue; }
    if (!s.sel) continue;
    const loc = s.nth == null ? page.locator(s.sel).first() : page.locator(s.sel).nth(s.nth);
    const b = await loc.boundingBox({ timeout: s.findMs ?? 2500 }).catch(() => null);
    if (!b) {
      console.log(`STEP SKIPPED (${label}): ${s.sel} matched nothing`);
      // A step that never ran must not vanish. Silence here is what let a video
      // come back from three-fifths of a flow looking complete.
      proof.push({ label, kind: s.do, tMs: now(), afterMs: now(), region: null,
        shows: s.shows || null, prove: s.prove || null, before: null, after: null,
        checks: [{ check: 'the step ran', ok: false, detail: `${s.sel} matched nothing - it was never performed` }] });
      continue;
    }
    const [sx, sy] = toScreen(b.x + b.width / 2, b.y + b.height / 2);
    const before = await snapshot();
    await glide(sx, sy);
    await page.waitForTimeout(s.settleMs ?? 380);
    // Coordinates are stored relative to the captured WINDOW, because that is
    // what the frames contain - the desktop around it is never recorded.
    const ev = {
      kind: s.do === 'hover' || s.do === 'move' ? 'hover' : (s.do === 'type' ? 'type' : 'click'),
      t: now(), label,
      x: Math.round(sx - winX), y: Math.round(sy - winY),
      w: Math.round(b.width * DSF), h: Math.round(b.height * DSF),
      bx: Math.round(b.x * DSF + chromeX), by: Math.round(b.y * DSF + chromeY),
    };
    if (s.do === 'hover' || s.do === 'move') {
      if (s.beat !== false) events.push(ev);
      const tAct = now();
      await page.waitForTimeout(s.ms ?? 900);
      const afterH = await snapshot();
      proof.push({ label, kind: 'hover', tMs: tAct, afterMs: now(),
        region: [ev.bx, ev.by, ev.w, ev.h], shows: s.shows || null,
        prove: s.prove || null, before, after: afterH,
        checks: judge('hover', before, afterH, s.prove) });
      continue;
    }
    if (s.beat !== false && !s.beatAfter) events.push(ev);
    const tAct = now();
    actions.push({ type: 'click', x: ev.x, y: ev.y, t: tAct, label });
    // The real pointer is already there, so let xdotool deliver the click too -
    // one event, visible and effective, instead of a drawn one and a dispatched
    // one that have to be trusted to agree.
    await xdo(['click', '1']);
    if (s.do === 'type') {
      await page.waitForTimeout(200);
      await xdo(['type', '--delay', String(s.delay ?? 135), s.text]);
      await page.waitForTimeout(s.settleAfterMs ?? 900);
    }
    await page.waitForTimeout(s.ms ?? 1400);
    if (s.beat !== false && s.beatAfter) {
      const nb = await loc.boundingBox({ timeout: 1200 }).catch(() => null);
      if (nb) {
        ev.x = Math.round(toScreen(nb.x + nb.width / 2, nb.y + nb.height / 2)[0] - winX);
        ev.y = Math.round(toScreen(nb.x + nb.width / 2, nb.y + nb.height / 2)[1] - winY);
        ev.w = Math.round(nb.width * DSF); ev.h = Math.round(nb.height * DSF);
        ev.bx = Math.round(nb.x * DSF + chromeX); ev.by = Math.round(nb.y * DSF + chromeY);
      }
      ev.t = now();
      events.push(ev);
    }
    let expect = null;
    if (s.expect) {
      const t = s.expect.sel || s.expect;
      const ok = await page.locator(t).first().waitFor({ state: 'visible', timeout: s.expect.timeout ?? 8000 })
        .then(() => true).catch(() => false);
      expect = { sel: t, ok };
      console.log(ok ? `expect ok: ${t}` : `EXPECT FAILED after "${label}": ${t}`);
    }
    const after = await snapshot();
    const checks = judge(s.do === 'type' ? 'type' : 'click', before, after, s.prove);
    proof.push({ label, kind: s.do === 'type' ? 'type' : 'click', tMs: tAct, afterMs: now(),
      region: [ev.bx, ev.by, ev.w, ev.h], shows: s.shows || null,
      prove: s.prove || null, expect, before, after, checks });
    for (const c of checks) {
      if (c.ok === false) console.log(`PROOF FAILED (${label}): ${c.check} - ${c.detail}`);
      else if (c.ok === null) console.log(`PROOF INCONCLUSIVE (${label}): ${c.detail}`);
    }
  } catch (e) {
    console.log(`step failed (${label}): ${String(e.message || e).slice(0, 120)}`);
  }
}
await page.waitForTimeout(flow.tailMs ?? 2000);
const out = process.env.DEMOKIT_EVENTS;
if (out) {
  const trim = (st) => (st ? { ...st, text: String(st.text || '').slice(0, 900), shingles: undefined } : null);
  const slim = proof.map((p) => ({ ...p, before: trim(p.before), after: trim(p.after) }));
  writeFileSync(out, JSON.stringify({ events, path, actions, proof: slim,
    startedAt: t0, endedAt: Date.now(), endMs: now() }));
  const bad = slim.flatMap((p) => p.checks.filter((c) => c.ok === false)).length;
  console.log(bad ? `boxflow: ${bad} PROOF FAILURE(S) - the video will show a feature that did not work`
                  : `boxflow: every step changed the page it claimed to change`);
  console.log(`boxflow: ${events.length} event(s), ${path.length} pointer samples -> ${out}`);
}
await browser.close().catch(() => {});
console.log('boxflow: done');
