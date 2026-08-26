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
const W = Number(process.env.DEMOKIT_W || 1920);
const H = Number(process.env.DEMOKIT_H || 1080);
const URL = process.env.DEMOKIT_URL || 'http://localhost:8891/';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/frames`, { recursive: true });

state.page2 = await context.newPage();
const page = state.page2;
await page.setViewportSize({ width: W, height: H });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

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

async function step(sel, label) {
  const loc = page.locator(sel).first();
  const b = await loc.boundingBox().catch(() => null);
  if (!b) { console.log('skip', label); return; }
  const cx = Math.round(b.x + b.width / 2);
  const cy = Math.round(b.y + b.height / 2);
  // Smooth travel so the drawn cursor has a real path to follow.
  await page.mouse.move(cx, cy, { steps: 30 });
  await page.waitForTimeout(420);
  clicks.push({ x: cx, y: cy, t: Date.now() - t0, label });
  await loc.click().catch(() => {});
  await page.waitForTimeout(1500);
  console.log('click', label, cx, cy);
}

await page.waitForTimeout(900);
await step('.rail a[href="#software"]', 'Software');
await step('.software li:first-child a.entry', 'Trident');
await step('.rail a[href="#career"]', 'Career');
await page.waitForTimeout(1000);

await cdp.send('Page.stopScreencast');
await page.waitForTimeout(400);

// Frame timestamps are CDP monotonic seconds; rebase to ms from capture start.
const base = frames.length ? frames[0].t : 0;
const manifest = {
  width: W, height: H,
  frames: frames.map((f) => ({ i: f.i, ms: Math.round((f.t - base) * 1000) })),
  clicks,
};
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`frames=${frames.length} clicks=${clicks.length} -> ${OUT}`);
