/**
 * Capture a flow as full-resolution PNG frames + a beat log.
 *
 *   DEMOKIT_FLOW=flows/example.json playwriter -s <id> -f src/record.js
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

const OUT = process.env.DEMOKIT_OUT || '.cache/shot';
const FLOW_PATH = process.env.DEMOKIT_FLOW || 'flows/example.json';

const flow = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
const ZOOM = flow.zoom ?? 2;
const LW = (flow.layout ?? [1280, 720])[0];
const LH = (flow.layout ?? [1280, 720])[1];
const W = LW * ZOOM, H = LH * ZOOM;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT + '/frames', { recursive: true });

const page = await context.newPage();
state.recordPage = page;
await page.setViewportSize({ width: W, height: H });
await page.goto(flow.url, { waitUntil: flow.waitUntil || 'domcontentloaded' });
await page.waitForTimeout(flow.settleMs ?? 1200);

if (flow.clearStorage !== false) {
  // Pages that persist UI state would otherwise start mid-state on take 2.
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
}
await page.addStyleTag({ content: 'html{zoom:' + ZOOM + '}' });
await page.waitForTimeout(500);

const loc = (s) => (s.nth == null ? page.locator(s.sel).first() : page.locator(s.sel).nth(s.nth));
const box = async (s) => await loc(s).boundingBox().catch(() => null);

// ---- preflight: fail loudly BEFORE burning a capture -----------------------
const missing = [];
for (const s of flow.steps) {
  if (!s.sel) continue;
  if (!(await box(s))) missing.push(s.do + ' ' + s.sel + (s.nth != null ? ' [nth=' + s.nth + ']' : ''));
}
if (missing.length && !flow.allowMissing) {
  console.log('PREFLIGHT FAILED - these selectors matched nothing:');
  for (const m of missing) console.log('  -', m);
  console.log('Fix the flow, or set "allowMissing": true to skip them.');
  await page.close();
} else {

// ---- capture ---------------------------------------------------------------
const cdp = await getCDPSession({ page });
const frames = [];
let n = 0;
let writeErr = null;
cdp.on('Page.screencastFrame', async (f) => {
  const i = n++;
  try {
    fs.writeFileSync(OUT + '/frames/f' + String(i).padStart(5, '0') + '.png', Buffer.from(f.data, 'base64'));
    frames.push({ i: i, t: f.metadata.timestamp });
  } catch (e) { writeErr = writeErr || e; }
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
});
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1 });

const t0 = Date.now();
const beats = [];
const mark = (x, y, label) => beats.push({ x: Math.round(x), y: Math.round(y), t: Date.now() - t0, label: label });
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Grab point pushed toward the outside of the page: content layers with a
 *  higher z-index often cover an element's centre out in the gutters. */
function grabPoint(b, outward) {
  const c = centre(b);
  if (!outward) return { x: c.x, y: c.y, dir: 0 };
  const dir = c.x < W / 2 ? -1 : 1;
  return { x: c.x + dir * b.width * 0.32, y: c.y, dir: dir };
}

for (const s of flow.steps) {
  const label = s.label || (s.do + ' ' + (s.sel || '')).trim();
  try {
    if (s.do === 'wait') { await page.waitForTimeout(s.ms ?? 800); continue; }
    if (s.do === 'key') { await page.keyboard.press(s.key); await page.waitForTimeout(s.ms ?? 400); continue; }
    if (s.do === 'scrollTo') {
      await loc(s).scrollIntoViewIfNeeded();
      await page.waitForTimeout(s.ms ?? 700);
      continue;
    }

    const b = await box(s);
    if (!b) { console.log('skip', label); continue; }

    if (s.do === 'hover' || s.do === 'move') {
      const c = grabPoint(b, s.outward);
      await page.mouse.move(c.x, c.y, { steps: s.steps ?? 30 });
      await page.waitForTimeout(s.settleMs ?? 650);
      if (s.beat !== false) mark(c.x, c.y, label);
      await page.waitForTimeout(s.ms ?? 800);
      continue;
    }

    if (s.do === 'click' || s.do === 'type') {
      const c = centre(b);
      await page.mouse.move(c.x, c.y, { steps: s.steps ?? 30 });
      await page.waitForTimeout(s.settleMs ?? 380);
      if (s.beat !== false) mark(c.x, c.y, label);
      await loc(s).click().catch(function () {});
      if (s.do === 'type') {
        await page.keyboard.type(s.text, { delay: s.delay ?? 60 });
      }
      await page.waitForTimeout(s.ms ?? 1400);
      continue;
    }

    if (s.do === 'pulse') {           // press+release in place, no navigation
      const c = centre(b);
      await page.mouse.move(c.x, c.y, { steps: s.steps ?? 30 });
      await page.waitForTimeout(s.settleMs ?? 600);
      if (s.beat !== false) mark(c.x, c.y, label);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForTimeout(s.ms ?? 1400);
      continue;
    }

    if (s.do === 'drag') {
      const g = grabPoint(b, s.outward ?? true);
      const by = (s.by ?? [-180, 90])[1];
      const bxAbs = Math.abs((s.by ?? [-180, 90])[0]);
      const dx = g.dir ? -g.dir * bxAbs : (s.by ?? [-180, 90])[0];
      const before = await loc(s).evaluate((e) => e.style.transform || '');
      await page.mouse.move(g.x, g.y, { steps: s.steps ?? 30 });
      await page.waitForTimeout(s.settleMs ?? 600);
      if (s.beat !== false) mark(g.x, g.y, label + ' (grab)');
      await page.mouse.down();
      const N = s.frames ?? 26;
      for (let i = 1; i <= N; i++) {
        await page.mouse.move(g.x + (dx * i) / N, g.y + (by * i) / N);
        await page.waitForTimeout(13);
      }
      await page.mouse.up();
      await page.waitForTimeout(500);
      const after = await loc(s).evaluate((e) => e.style.transform || '');
      if (after === before) console.log('WARNING: drag on ' + s.sel + ' did not move it');
      else console.log('drag ok: ' + (before || 'none') + ' -> ' + after);
      if (s.beat !== false) mark(g.x + dx, g.y + by, label);
      await page.waitForTimeout(s.ms ?? 1200);
      continue;
    }

    console.log('unknown step:', s.do);
  } catch (e) {
    console.log('step failed (' + label + '):', String(e.message || e).slice(0, 120));
  }
}

await page.waitForTimeout(flow.tailMs ?? 1100);
await cdp.send('Page.stopScreencast');
await page.waitForTimeout(400);

// True frame size from the first PNG's IHDR rather than assuming.
let realW = W, realH = H;
try {
  const hb = fs.readFileSync(OUT + '/frames/f00000.png');
  realW = hb.readUInt32BE(16); realH = hb.readUInt32BE(20);
} catch (e) {}

const base = frames.length ? frames[0].t : 0;
fs.writeFileSync(OUT + '/manifest.json', JSON.stringify({
  width: realW, height: realH, layout: [LW, LH], zoom: ZOOM, dsf: 1,
  frames: frames.map((f) => ({ i: f.i, ms: Math.round((f.t - base) * 1000) })),
  clicks: beats,
}, null, 1));

if (writeErr) console.log('WARNING: some frames failed to write:', String(writeErr.message).slice(0, 100));
console.log('frames=' + frames.length + ' beats=' + beats.length + ' size=' + realW + 'x' + realH + ' -> ' + OUT);
await page.close();
}
