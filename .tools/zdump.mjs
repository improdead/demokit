import { pathToFileURL } from 'node:url';
const p = process.cwd() + '/node_modules/playwright-recast/dist/render/zoom-expression.js';
const { buildZoomFilter, buildSegments } = await import(pathToFileURL(p).href);
const kfs = [
  { atMs: 10600, x: 0.0848, y: 0.3694, level: 1.9, transitionMs: 2000 },
  { atMs: 14891, x: 0.5148, y: 0.1319, level: 1.9, transitionMs: 2000 },
  { atMs: 19192, x: 0.0774, y: 0.4472, level: 1.9, transitionMs: 2000 },
];
const f = buildZoomFilter(kfs, { width: 1280, height: 720 }, { width: 1920, height: 1080 },
  { transitionMs: 400, easing: 'ease-in-out', fps: 25, containInCue: false });
console.log('FILTER LENGTH:', f.length);
console.log(f.slice(0, 900));
console.log('...');
console.log('segments:', JSON.stringify(buildSegments(kfs.map(k=>({atMs:k.atMs,holdMs:2000,x:k.x,y:k.y,level:k.level})), 0.4, false).map(s=>({t:s.type,a:s.startSec,b:s.endSec,lv:s.toLevel??s.level})), null, 0));
