import { pathToFileURL } from 'node:url';
const base = process.cwd() + '/node_modules/playwright-recast/dist/parse/trace-parser.js';
const { parseTrace } = await import(pathToFileURL(base).href);
const t = await parseTrace('/tmp/demo-trace.zip');
console.log('top-level keys:', Object.keys(t).join(', '));
const acts = t.actions || [];
console.log('ACTIONS:', acts.length);
for (const a of acts.slice(0, 16)) {
  console.log('  ', JSON.stringify({ method: a.method, pos: a.position, start: a.startMs, page: a.pageId, sel: String(a.selector || '').slice(0, 34) }));
}
console.log('screencastFrames:', (t.screencastFrames || []).length);
console.log('sourceVideoPath:', t.sourceVideoPath);
if (t.viewport) console.log('viewport:', JSON.stringify(t.viewport));
