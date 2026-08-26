/**
 * Capture a flow as full-resolution PNG frames + an exact click log.
 *
 * Run inside playwriter:  playwriter -s <id> -f src/record.js
 *
 * Why not Playwright's trace screencast: it is hard-capped at 800x450 JPEG
 * (it exists to feed the trace viewer). The `frames` metadata reports the page
 * size, which is misleading - the stored images are 800px. Anything built on
 * it is upscaling a lossy thumbnail.
 *
 * CDP Page.startScreencast with format:'png' and explicit maxWidth/maxHeight
 * gives lossless frames at the real viewport size, and we ack each frame so
 * Chrome keeps sending them.
 */
const fs = require('node:fs');

const OUT = process.env.DEMOKIT_OUT || '.cache/shot';
// Capture at 2x the layout we want, then apply CSS zoom so the page lays out
// as if it were LAYOUT_W wide. Two problems solved at once:
//   - resolution: frames are 2560x1440, downscaled to 1080p on output
//   - scale: content fills the frame instead of a 680px column floating in 1920
// Note: Page.startScreencast captures CSS pixels and IGNORES deviceScaleFactor,
// so setDeviceMetricsOverride does not help here - CSS zoom does.
const ZOOM = Number(process.env.DEMOKIT_ZOOM || 2);
const LAYOUT_W = Number(process.env.DEMOKIT_W || 1280);
const LAYOUT_H = Number(process.env.DEMOKIT_H || 720);
const W = LAYOUT_W * ZOOM;
const H = LAYOUT_H * ZOOM;
const URL = process.env.DEMOKIT_URL || 'http://localhost:8891/';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/frames`, { recursive: true });

state.page2 = await context.newPage();
const page = state.page2;
await page.setViewportSize({ width: W, height: H });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// Start from a clean slate: the page persists dragged sticker positions.
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
await page.addStyleTag({ content: `html{zoom:${ZOOM}}` });
await page.waitForTimeout(600);
const cdp = await getCDPSession({ page });

const frames = [];
let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const i = n++;
  fs.writeFileSync(`${OUT}/frames/f${String(i).padStart(5, '0')}.png`, Buffer.from(f.data, 'base64'));
  frames.push({ i, t: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
});

await cdp.send('Page.startScreencast', {
  format: 'png', maxWidth: W, maxHeight: H, everyNthFrame: 1,
});

const t0 = Date.now();
const clicks = [];

/** Mark a beat: where the cursor is and when, so the renderer can zoom to it. */
function mark(x, y, label) { clicks.push({ x: Math.round(x), y: Math.round(y), t: Date.now() - t0, label }); }

async function glide(x, y, steps = 30) {
  await page.mouse.move(x, y, { steps });
}

async function at(sel) {
  const b = await page.locator(sel).first().boundingBox().catch(() => null);
  return b && { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

// A flow that actually shows the page DOING something: a sticker lights up and
// gets dragged, the terminal field reacts to the cursor, then a nav jump.
// Grab the sticker OFF-CENTRE, toward the outside of the page: the content
// column sits above the marginalia layer (z-index) and overlaps the gutter at
// this width, so a press at the sticker's centre lands on the text instead.
let dragged = false;
const stickers = await page.locator('.sticker').all().catch(() => []);
for (const el of stickers) {
  const b = await el.boundingBox().catch(() => null);
  if (!b) continue;
  const outward = b.x + b.width / 2 < W / 2 ? -1 : 1;      // push away from centre
  const gx = Math.round(b.x + b.width / 2 + outward * b.width * 0.32);
  const gy = Math.round(b.y + b.height / 2);
  const before = await el.evaluate((e) => e.style.transform || '');

  await glide(gx, gy);
  await page.waitForTimeout(700);
  mark(gx, gy, 'hover sticker');
  await page.waitForTimeout(800);

  await page.mouse.down();
  for (let i = 1; i <= 26; i++) {
    await page.mouse.move(gx + outward * i * -7, gy + i * 3.4);
    await page.waitForTimeout(13);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await el.evaluate((e) => e.style.transform || '');
  if (after !== before) {
    dragged = true;
    mark(gx + outward * -182, gy + 88, 'drag sticker');
    console.log('dragged ok', before, '->', after);
    await page.waitForTimeout(1200);
    break;
  }
  console.log('drag did not take on this sticker, trying next');
}
if (!dragged) console.log('WARNING: no sticker drag registered');

const band = await at('.ascii-band');
if (band) {
  await page.locator('.ascii-band').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  const b2 = await at('.ascii-band');
  if (b2) {
    await glide(b2.x, b2.y, 34);
    await page.waitForTimeout(650);          // glyphs surface under the cursor
    mark(b2.x, b2.y, 'scan noise');
    await page.mouse.down(); await page.mouse.up();   // ring pulse
    await page.waitForTimeout(1500);
  }
}

const career = await at('.rail a[href="#career"]');
if (career) {
  await glide(career.x, career.y, 30);
  await page.waitForTimeout(380);
  mark(career.x, career.y, 'career');
  await page.locator('.rail a[href="#career"]').first().click().catch(() => {});
  await page.waitForTimeout(1500);
}

await cdp.send('Page.stopScreencast');
await page.waitForTimeout(400);

// Read the true frame size out of the first PNG's IHDR rather than assuming
// the override took effect.
let realW = W, realH = H;
try {
  const b = fs.readFileSync(`${OUT}/frames/f00000.png`);
  realW = b.readUInt32BE(16); realH = b.readUInt32BE(20);
} catch {}

// Frame timestamps are CDP monotonic seconds; rebase to ms from capture start.
const base = frames.length ? frames[0].t : 0;
const manifest = {
  // frames are DEVICE pixels; clicks are CSS px, so the renderer scales by dsf
  // getBoundingClientRect already returns zoomed coordinates, so clicks are
  // in frame space 1:1 - no extra scaling in the renderer.
  width: realW, height: realH, layout: [LAYOUT_W, LAYOUT_H], zoom: ZOOM, dsf: 1,
  frames: frames.map((f) => ({ i: f.i, ms: Math.round((f.t - base) * 1000) })),
  clicks,
};
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`frames=${frames.length} clicks=${clicks.length} size=${realW}x${realH} -> ${OUT}`);
