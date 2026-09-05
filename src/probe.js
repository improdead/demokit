/**
 * Look at a page and report what it is, so a demo can be PLANNED from evidence
 * rather than guessed.
 *
 *   bin/demokit probe https://app.example.com
 *
 * Writes .cache/probe.json and prints a summary. It never clicks anything - a
 * probe must be safe to run against production.
 */
const fs = require('node:fs');

// The bridge injects structured arguments; retain the old file as a compatibility fallback.
const ARGS = typeof DEMOKIT_ARGS !== "undefined" ? DEMOKIT_ARGS : (() => {
  try { return JSON.parse(fs.readFileSync('.cache/args.json', 'utf8')); } catch (e) { return {}; }
})();
const URL_ = ARGS.url;
const OUT = ARGS.probeOut || '.cache/probe.json';
const LW = Number(ARGS.w || 1280);
const LH = Number(ARGS.h || 720);
if (!URL_) throw new Error('no url: write {"url": "..."} to .cache/args.json (bin/demokit probe <url> does this)');

const page = await context.newPage();
await page.setViewportSize({ width: LW, height: LH });

// Watch the API surface: what could be stubbed if this environment is empty.
const calls = [];
page.on('response', (r) => {
  try {
    const u = new URL(r.url());
    const type = r.request().resourceType();
    if (type === 'xhr' || type === 'fetch') {
      calls.push({ method: r.request().method(), status: r.status(), url: u.origin + u.pathname });
    }
  } catch (e) {}
});

await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);   // let client-rendered content arrive

const report = await page.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const txt = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) return `[${a}="${CSS.escape(v)}"]`;
    }
    const t = txt(el);
    if (t && t.length < 32 && /^[\w\s&'’.,-]+$/.test(t)) return `${el.tagName.toLowerCase()}:has-text("${t}")`;
    const cls = (el.className || '').toString().trim().split(/\s+/).filter((c) => c && !/^(is|has)-/.test(c))[0];
    return cls ? `${el.tagName.toLowerCase()}.${CSS.escape(cls)}` : el.tagName.toLowerCase();
  };
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };

  const all = [...document.querySelectorAll('*')];

  const buttons = all
    .filter((e) => (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' ||
      (e.tagName === 'A' && /btn|button|cta|primary/i.test(e.className || ''))) && vis(e) && txt(e))
    .map((e) => ({ text: txt(e), sel: sel(e), area: Math.round(area(e)), top: Math.round(e.getBoundingClientRect().top) }))
    .sort((a, b) => b.area - a.area).slice(0, 14);

  const navLinks = all
    .filter((e) => e.tagName === 'A' && vis(e) && txt(e) && e.getAttribute('href'))
    .map((e) => ({ text: txt(e), href: e.getAttribute('href'), sel: sel(e) }))
    // dedupe on href+text: SPA nav is often all href="#", and collapsing on
    // href alone reports a five-item sidebar as one link.
    .filter((l, i, arr) => arr.findIndex((x) => x.href === l.href && x.text === l.text) === i).slice(0, 24);

  const inputs = all
    .filter((e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && vis(e) && e.type !== 'hidden')
    .map((e) => ({ type: e.type || e.tagName.toLowerCase(), name: e.name || e.id || '', ph: e.placeholder || '', sel: sel(e) }))
    .slice(0, 16);

  // Data density: is there anything to demo against?
  const tables = [...document.querySelectorAll('table')].filter(vis)
    .map((t) => ({ rows: t.querySelectorAll('tbody tr').length, sel: sel(t) }));
  const lists = all.filter((e) => vis(e) && e.children.length >= 3 &&
      ['UL', 'OL'].includes(e.tagName)).map((e) => ({ items: e.children.length, sel: sel(e) })).slice(0, 8);
  const repeated = {};
  all.filter(vis).forEach((e) => {
    const c = (e.className || '').toString().trim().split(/\s+/)[0];
    if (c && e.children.length) repeated[c] = (repeated[c] || 0) + 1;
  });
  const repeaters = Object.entries(repeated).filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => ({ cls: c, count: n }));

  const bodyText = (document.body.innerText || '').slice(0, 6000);
  const emptyHints = (bodyText.match(/\b(no [a-z ]{2,24}(yet|found)?|nothing (here|yet|published)|get started|create your first|you (don'?t|do not) have|empty|0 results?)\b/gi) || []).slice(0, 8);
  const authHints = /sign in|log in|password|continue with (google|github|sso)/i.test(bodyText);

  return {
    title: document.title,
    url: location.href,
    headings: [...document.querySelectorAll('h1,h2')].filter(vis).map(txt).filter(Boolean).slice(0, 12),
    buttons, navLinks, inputs, tables, lists, repeaters,
    emptyHints, authHints,
    textSample: bodyText.slice(0, 900),
    scrollHeight: document.documentElement.scrollHeight,
  };
});

report.viewport = [LW, LH];
report.api = calls.filter((c, i, a) => a.findIndex((x) => x.url === c.url && x.method === c.method) === i).slice(0, 24);

// A crude read on whether this environment has anything worth filming.
const dataSignals =
  report.tables.reduce((n, t) => n + t.rows, 0) +
  report.lists.reduce((n, l) => n + l.items, 0) +
  report.repeaters.reduce((n, r) => n + r.count, 0);
report.verdict = {
  looksAuthWalled: report.authHints && report.inputs.some((i) => i.type === 'password'),
  looksEmpty: dataSignals < 6 || report.emptyHints.length >= 2,
  dataSignals: dataSignals,
  stubbable: report.api.length > 0,
};

fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('--- probe: ' + report.title + ' ---');
console.log('headings   :', report.headings.slice(0, 5).join(' | ') || '(none)');
console.log('top actions:', report.buttons.slice(0, 6).map((b) => b.text).join(' | ') || '(none)');
console.log('nav        :', report.navLinks.slice(0, 8).map((l) => l.text).join(' | ') || '(none)');
console.log('inputs     :', report.inputs.length, '| tables:', report.tables.length,
            '| repeaters:', report.repeaters.map((r) => r.cls + 'x' + r.count).join(',') || '-');
console.log('api calls  :', report.api.length ? report.api.slice(0, 6).map((c) => c.method + ' ' + c.url).join('\n             ') : '(none seen)');
console.log('verdict    : empty=' + report.verdict.looksEmpty + ' authWalled=' + report.verdict.looksAuthWalled +
            ' dataSignals=' + report.verdict.dataSignals + ' stubbable=' + report.verdict.stubbable);
if (report.emptyHints.length) console.log('empty hints:', report.emptyHints.join(' | '));
console.log('wrote ' + OUT);
await page.close();
