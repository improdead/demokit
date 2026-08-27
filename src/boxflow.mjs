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
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const [, , flowPath, name, bin] = process.argv;
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));

const xdo = (args) => run(bin, ['exec', '-e', 'DISPLAY=:99', name, 'xdotool', ...args]).catch(() => {});

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(flow.settleMs ?? 3000);

// Page (0,0) in screen coordinates: the browser chrome's height.
const chromeY = await page.evaluate(() => window.outerHeight - window.innerHeight);
const chromeX = await page.evaluate(() => Math.max(0, (window.outerWidth - window.innerWidth) / 2));
console.log(`boxflow: chrome offset ${chromeX},${chromeY}`);

const toScreen = (x, y) => [Math.round(x + chromeX), Math.round(y + chromeY)];
const smooth = (p) => p * p * p * (10 - 15 * p + 6 * p * p);

let curX = 40, curY = 40;
async function glide(x, y) {
  const d = Math.hypot(x - curX, y - curY);
  const steps = Math.max(8, Math.min(48, Math.round(d / 28)));
  const x0 = curX, y0 = curY;
  for (let i = 1; i <= steps; i++) {
    const e = smooth(i / steps);
    const nx = x0 + (x - x0) * e, ny = y0 + (y - y0) * e;
    await xdo(['mousemove', String(Math.round(nx)), String(Math.round(ny))]);
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
    if (!b) { console.log(`STEP SKIPPED (${label}): ${s.sel} matched nothing`); continue; }
    const [sx, sy] = toScreen(b.x + b.width / 2, b.y + b.height / 2);
    await glide(sx, sy);
    await page.waitForTimeout(s.settleMs ?? 380);
    if (s.do === 'hover' || s.do === 'move') { await page.waitForTimeout(s.ms ?? 900); continue; }
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
    if (s.expect) {
      const t = s.expect.sel || s.expect;
      const ok = await page.locator(t).first().waitFor({ state: 'visible', timeout: s.expect.timeout ?? 8000 })
        .then(() => true).catch(() => false);
      console.log(ok ? `expect ok: ${t}` : `EXPECT FAILED after "${label}": ${t}`);
    }
  } catch (e) {
    console.log(`step failed (${label}): ${String(e.message || e).slice(0, 120)}`);
  }
}
await page.waitForTimeout(flow.tailMs ?? 2000);
await browser.close().catch(() => {});
console.log('boxflow: done');
