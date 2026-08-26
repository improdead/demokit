import { pathToFileURL } from 'node:url';
const { parseTrace } = await import(pathToFileURL(process.cwd() + '/node_modules/playwright-recast/dist/parse/trace-parser.js').href);
const t = await parseTrace('/tmp/demo-trace.zip');
console.log('cursorPositions:', (t.cursorPositions || []).length);
console.log(JSON.stringify((t.cursorPositions || []).slice(0, 6), null, 1));
const click = (t.actions || []).find(a => a.method === 'click');
console.log('\nFULL click action keys:', Object.keys(click || {}).join(', '));
console.log(JSON.stringify(click, (k, v) => (k === 'frameReader' ? '[fr]' : v), 1).slice(0, 1200));
console.log('\nframes:', (t.frames || []).length, '| first frame keys:', Object.keys((t.frames || [])[0] || {}).join(','));
