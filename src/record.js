/**
 * Capture a flow as full-resolution PNG frames + a beat log.
 *
 *   bin/demokit flows/example.json out/demo.mp4
 *
 * Two things that are not obvious and cost real time to discover:
 *
 * 1. Playwright's trace screencast is hard-capped at 800x450 JPEG - it exists
 *    to feed the trace viewer. Its metadata reports the PAGE size, which hides
 *    this. Anything built on it is upscaling a thumbnail.
 * 2. Page.startScreencast captures CSS pixels and ignores deviceScaleFactor
 *    (and Playwright re-applies its own metrics on navigate, wiping any
 *    override). To get 2x pixels: a 2x viewport plus `html{zoom:2}`. The page
 *    lays out as if it were `layout` wide but renders at 2x.
 *    getBoundingClientRect returns zoomed coords, so beats stay 1:1 with frame
 *    pixels and need no rescaling downstream.
 */
const fs = require('node:fs');

// playwriter's sandbox does NOT inherit the shell environment (process.env is
// empty), so parameters arrive through a file instead. bin/demokit writes it.
const ARGS = (() => {
  try { return JSON.parse(fs.readFileSync('.cache/args.json', 'utf8')); } catch (e) { return {}; }
})();
const OUT = ARGS.out || '.cache/shot';
const FLOW_PATH = ARGS.flow || 'flows/example.json';

const flow = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
console.log('flow: ' + FLOW_PATH + ' -> ' + OUT);
const ZOOM = flow.zoom ?? 2;
const LW = (flow.layout ?? [1280, 720])[0];
const LH = (flow.layout ?? [1280, 720])[1];
const W = LW * ZOOM, H = LH * ZOOM;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT + '/frames', { recursive: true });

const page = await context.newPage();
state.recordPage = page;
await page.setViewportSize({ width: W, height: H });

// ---- seeding: everything here MUST be installed before the first paint -----
const seed = flow.seed || {};

// Deterministic clock, so timestamps read sensibly and every take matches.
if (seed.clock) {
  await page.addInitScript(`(() => {
    const fixed = new Date(${JSON.stringify(seed.clock)}).getTime();
    const drift = ${seed.clockTicks === false ? 'false' : 'true'};
    const start = Date.now();
    const R = Date;
    function D(...a) { return a.length ? new R(...a) : new R(fixed + (drift ? R.now() - start : 0)); }
    D.now = () => fixed + (drift ? R.now() - start : 0);
    D.parse = R.parse; D.UTC = R.UTC; D.prototype = R.prototype;
    window.Date = D;
  })()`);
}

// Client state before boot. Setting this after load is the classic mistake -
// the app has already read storage and rendered its empty state by then.
if (seed.localStorage || seed.sessionStorage) {
  await page.addInitScript(`(() => {
    const ls = ${JSON.stringify(seed.localStorage || {})};
    const ss = ${JSON.stringify(seed.sessionStorage || {})};
    try { for (const k in ls) localStorage.setItem(k, typeof ls[k] === 'string' ? ls[k] : JSON.stringify(ls[k])); } catch (e) {}
    try { for (const k in ss) sessionStorage.setItem(k, typeof ss[k] === 'string' ? ss[k] : JSON.stringify(ss[k])); } catch (e) {}
  })()`);
}

// API stubs, so an empty environment can be filmed with realistic content.
// `file` keeps fabricated data in one reviewable place instead of inline in the
// flow - a human should be able to read exactly what was made up.
for (const r of seed.routes || []) {
  const bodyFor = () => {
    if (r.file) return fs.readFileSync(r.file, 'utf8');
    if (typeof r.body === 'string') return r.body;
    return JSON.stringify(r.json ?? r.body ?? {});
  };
  const body = bodyFor();   // read once, so take 2 is identical to take 1
  await page.route(r.url, async (route) => {
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    await route.fulfill({
      status: r.status || 200,
      contentType: r.contentType || 'application/json',
      body: body,
    });
  });
  console.log('  stub ' + r.url + (r.file ? ' <- ' + r.file : '') + (r.delayMs ? ' (+' + r.delayMs + 'ms)' : ''));
}
if ((seed.routes || []).length) console.log('seeded ' + seed.routes.length + ' route stub(s)');

await page.goto(flow.url, { waitUntil: flow.waitUntil || 'domcontentloaded' });
await page.waitForTimeout(flow.settleMs ?? 1200);

if (flow.clearStorage !== false) {
  // Pages that persist UI state would otherwise start mid-state on take 2.
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
}
// Hide noise, blur anything sensitive. Done in the page BEFORE capture, so the
// pixels never exist in a frame - safer than blurring a region afterwards.
const css = ['html{zoom:' + ZOOM + '}'];
if (flow.hide && flow.hide.length) css.push(flow.hide.join(',') + '{visibility:hidden !important}');
if (flow.redact && flow.redact.length) css.push(flow.redact.join(',') + '{filter:blur(9px) !important}');
if (flow.stillness !== false) css.push('*,*::before,*::after{scroll-behavior:auto !important}');
await page.addStyleTag({ content: css.join('\n') });
if (flow.hide || flow.redact) {
  console.log('hidden=' + ((flow.hide || []).length) + ' redacted=' + ((flow.redact || []).length));
}
await page.waitForTimeout(500);

const loc = (s) => (s.nth == null ? page.locator(s.sel).first() : page.locator(s.sel).nth(s.nth));
const box = async (s) => await loc(s).boundingBox().catch(() => null);

// ---- preflight: fail loudly BEFORE burning a capture -----------------------
// Steps marked "later": true are expected to be missing now (a drawer, a modal,
// a result that an earlier step creates). Marking them individually keeps every
// OTHER step validated - flow-wide allowMissing silences the genuinely broken
// ones too, and turns a loud correct failure into a short meaningless video.
const missing = [];
for (const s of flow.steps) {
  if (!s.sel || s.later) continue;
  if (!(await box(s))) missing.push(s.do + ' ' + s.sel + (s.nth != null ? ' [nth=' + s.nth + ']' : ''));
}
if (missing.length && !flow.allowMissing) {
  console.log('PREFLIGHT FAILED - these selectors matched nothing:');
  for (const m of missing) console.log('  -', m);
  console.log('If the step only appears later in the flow, mark that step "later": true.');
  console.log('Otherwise fix the selector, or seed the state it needs.');
  await page.close();
} else {

// ---- capture ---------------------------------------------------------------
const cdp = await getCDPSession({ page });
const frames = [];
let n = 0;
let writeErr = null;
let firstAt = null;   // frame timeline starts at the FIRST frame, not at t0
cdp.on('Page.screencastFrame', async (f) => {
  const i = n++;
  if (firstAt === null) firstAt = Date.now() - t0;
  try {
    fs.writeFileSync(OUT + '/frames/f' + String(i).padStart(5, '0') + '.png', Buffer.from(f.data, 'base64'));
    frames.push({ i: i, t: f.metadata.timestamp });
  } catch (e) { writeErr = writeErr || e; }
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
});
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });

const t0 = Date.now();
const beats = [];
const path = [];      // EVERY pointer position, so the drawn cursor can follow
const actions = [];   // presses/releases, for click pulses
const now = () => Date.now() - t0;
const mark = (x, y, label) => beats.push({ x: Math.round(x), y: Math.round(y), t: now(), label: label });
const track = (x, y) => path.push({ x: Math.round(x), y: Math.round(y), t: now() });
const act = (type, x, y, label) => actions.push({ type: type, x: Math.round(x), y: Math.round(y), t: now(), label: label });
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

let curX = W / 2, curY = H / 2;
track(curX, curY);

/** The screencast only emits a frame when the page REPAINTS, and the synthetic
 *  cursor is invisible to the page - so a pointer gliding across a static
 *  screen produces no frames and the drawn cursor freezes, then teleports.
 *  A 1px alpha nudge is a real paint invalidation and costs nothing visually. */
await page.evaluate(() => {
  const e = document.createElement('div');
  e.id = '__dk_pulse';
  e.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;' +
    'background:rgba(0,0,0,0.02);z-index:2147483647;pointer-events:none';
  document.documentElement.appendChild(e);
  window.__dkPulse = () => {
    e.style.background = e.style.background === 'rgba(0, 0, 0, 0.02)'
      ? 'rgba(0, 0, 0, 0.03)' : 'rgba(0, 0, 0, 0.02)';
  };
});
const repaint = async () => { try { await page.evaluate(() => window.__dkPulse && window.__dkPulse()); } catch (e) {} };

/** Move the pointer ourselves so every intermediate position is logged.
 *  page.mouse.move({steps}) interpolates internally and tells us nothing, which
 *  is why the drawn cursor used to detach from whatever was being dragged. */
async function glide(x, y, opts) {
  opts = opts || {};
  const steps = opts.steps ?? 26;
  const perStep = opts.perStep ?? 12;
  const x0 = curX, y0 = curY;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p * p * (3 - 2 * p);            // smoothstep, like a real hand
    const nx = x0 + (x - x0) * e, ny = y0 + (y - y0) * e;
    await page.mouse.move(nx, ny);
    curX = nx; curY = ny;
    track(nx, ny);
    await repaint();                          // force a frame at every sample
    if (perStep) await page.waitForTimeout(perStep);
  }
  curX = x; curY = y;
  track(x, y);
  await repaint();
}

/** Dwell in place, still sampling, so the path has points during pauses. */
async function dwell(ms) {
  const end = Date.now() + ms;
  let lastPulse = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(Math.min(60, Math.max(10, end - Date.now())));
    track(curX, curY);
    // A resting pointer needs far fewer frames than a moving one; ~7fps keeps
    // the timeline populated without writing hundreds of identical PNGs.
    if (Date.now() - lastPulse > 140) { lastPulse = Date.now(); await repaint(); }
  }
}

/** Catch the case where something with a higher z-index covers the target. */
async function occluded(s, x, y) {
  try {
    return await loc(s).evaluate((el, pt) => {
      const hit = document.elementFromPoint(pt.x, pt.y);
      return !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    }, { x: x, y: y });
  } catch (e) { return false; }
}

/** Grab point pushed toward the outside of the page: content layers with a
 *  higher z-index often cover an element's centre out in the gutters. */
function grabPoint(b, outward) {
  const c = centre(b);
  if (!outward) return { x: c.x, y: c.y, dir: 0 };
  const dir = c.x < W / 2 ? -1 : 1;
  return { x: c.x + dir * b.width * 0.32, y: c.y, dir: dir };
}

async function runStep(s, label) {
    if (s.do === 'wait') { await dwell(s.ms ?? 800); return; }
    if (s.do === 'key') { await page.keyboard.press(s.key); await page.waitForTimeout(s.ms ?? 400); return; }
    if (s.do === 'scrollTo') {
      await loc(s).scrollIntoViewIfNeeded();
      await page.waitForTimeout(s.ms ?? 700);
      return;
    }

    const b = await box(s);
    if (!b) { console.log('skip', label); return; }

    if (s.do === 'hover' || s.do === 'move') {
      const c = grabPoint(b, s.outward);
      await glide(c.x, c.y, { steps: s.steps ?? 26 });
      await dwell(s.settleMs ?? 650);
      if (await occluded(s, c.x, c.y)) console.log('NOTE: ' + s.sel + ' is covered at that point');
      if (s.beat !== false) mark(c.x, c.y, label);
      await dwell(s.ms ?? 800);
      return;
    }

    if (s.do === 'click' || s.do === 'type') {
      const c = centre(b);
      await glide(c.x, c.y, { steps: s.steps ?? 26 });
      await dwell(s.settleMs ?? 380);
      if (await occluded(s, c.x, c.y)) console.log('NOTE: ' + s.sel + ' is covered at that point');
      if (s.beat !== false) mark(c.x, c.y, label);
      act('click', c.x, c.y, label);
      await loc(s).click().catch(function () {});
      if (s.do === 'type') {
        await page.keyboard.type(s.text, { delay: s.delay ?? 60 });
      }
      await dwell(s.ms ?? 1400);
      return;
    }

    if (s.do === 'pulse') {           // press+release in place, no navigation
      const c = centre(b);
      await glide(c.x, c.y, { steps: s.steps ?? 26 });
      await dwell(s.settleMs ?? 600);
      if (s.beat !== false) mark(c.x, c.y, label);
      act('click', c.x, c.y, label);
      await page.mouse.down(); await page.mouse.up();
      await dwell(s.ms ?? 1400);
      return;
    }

    if (s.do === 'drag') {
      const g = grabPoint(b, s.outward ?? true);
      const by = (s.by ?? [-180, 90])[1];
      const bxAbs = Math.abs((s.by ?? [-180, 90])[0]);
      const dx = g.dir ? -g.dir * bxAbs : (s.by ?? [-180, 90])[0];
      const before = await loc(s).evaluate((e) => e.style.transform || '');
      await glide(g.x, g.y, { steps: s.steps ?? 26 });
      await dwell(s.settleMs ?? 600);
      if (await occluded(s, g.x, g.y)) console.log('NOTE: ' + s.sel + ' is covered at the grab point');
      if (s.beat !== false) mark(g.x, g.y, label + ' (grab)');
      act('down', g.x, g.y, label);
      await page.mouse.down();
      const N = s.frames ?? 26;
      for (let i = 1; i <= N; i++) {
        const p = i / N, e2 = p * p * (3 - 2 * p);
        const nx = g.x + dx * e2, ny = g.y + by * e2;
        await page.mouse.move(nx, ny);
        curX = nx; curY = ny; track(nx, ny);
        await repaint();
        await page.waitForTimeout(14);
      }
      await page.mouse.up();
      act('up', curX, curY, label);
      await dwell(500);
      const after = await loc(s).evaluate((e) => e.style.transform || '');
      if (after === before) console.log('WARNING: drag on ' + s.sel + ' did not move it');
      else console.log('drag ok: ' + (before || 'none') + ' -> ' + after);
      if (s.beat !== false) mark(g.x + dx, g.y + by, label);
      await dwell(s.ms ?? 1200);
      return;
    }

  console.log('unknown step:', s.do);
}


for (const s of flow.steps) {
  const label = s.label || (s.do + ' ' + (s.sel || '')).trim();
  try {
    await runStep(s, label);
    // Verify the app actually got where the step claimed to take it. A demo of
    // a flow that silently didn't happen is worse than no demo.
    if (s.expect) {
      const target = s.expect.sel || s.expect;
      const ok = await page.locator(target).first()
        .waitFor({ state: 'visible', timeout: s.expect.timeout ?? 8000 })
        .then(() => true).catch(() => false);
      if (!ok) console.log('EXPECT FAILED after "' + label + '": ' + target + ' never appeared');
      else console.log('expect ok: ' + target);
    }
  } catch (e) {
    console.log('step failed (' + label + '): ' + String(e.message || e).slice(0, 120));
  }
}

await dwell(flow.tailMs ?? 1100);
// The screencast only emits a frame when the page REPAINTS. A held payoff -
// the diff on screen, nothing animating - produces no frames at all, so the
// frame timeline ends early and the hold is silently cut from the video.
// Record where capture actually ended and let the renderer hold the last frame.
const endMs = Math.max(0, (Date.now() - t0) - (firstAt || 0));
await cdp.send('Page.stopScreencast');
await page.waitForTimeout(400);

// True frame size from the first PNG's IHDR rather than assuming.
let realW = W, realH = H;
try {
  const hb = fs.readFileSync(OUT + '/frames/f00000.png');
  realW = hb.readUInt32BE(16); realH = hb.readUInt32BE(20);
} catch (e) {}

const base = frames.length ? frames[0].t : 0;
// Beats/path/actions are timed from t0; frames from the first frame. Shift them
// onto the frame clock so the drawn cursor and the ripples land on the frame
// where the click actually happened.
const shift = (a) => a.map((e) => ({ ...e, t: Math.max(0, e.t - (firstAt || 0)) }));
fs.writeFileSync(OUT + '/manifest.json', JSON.stringify({
  width: realW, height: realH, layout: [LW, LH], zoom: ZOOM, dsf: 1,
  endMs: endMs,
  frames: frames.map((f) => ({ i: f.i, ms: Math.round((f.t - base) * 1000) })),
  clicks: shift(beats),
  path: shift(path),
  actions: shift(actions),
}, null, 1));

if (writeErr) console.log('WARNING: some frames failed to write:', String(writeErr.message).slice(0, 100));
const span = frames.length ? Math.round((frames[frames.length - 1].t - base) * 1000) : 0;
console.log('frames=' + frames.length + ' beats=' + beats.length + ' path=' + path.length + ' actions=' + actions.length + ' size=' + realW + 'x' + realH + ' -> ' + OUT);
console.log('timeline: ' + (endMs / 1000).toFixed(1) + 's captured, last repaint at ' + (span / 1000).toFixed(1) + 's' +
  (endMs - span > 400 ? '  (held ' + ((endMs - span) / 1000).toFixed(1) + 's on a static page)' : ''));
await page.close();
}
