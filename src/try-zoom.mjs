import { applyZoom } from './zoom.mjs';
// click points are in PAGE viewport space (1280x720); times are output-video ms
const clicks = [
  { x: 108.53, y: 266, atMs: 7971 },
  { x: 659,    y: 95,  atMs: 14891 },
  { x: 99.06,  y: 322, atMs: 19192 },
];
const r = await applyZoom({ input: '/tmp/demo3.mp4', output: '/tmp/demo-zoom.mp4',
  clicks, srcW: 1280, srcH: 720, level: 1.9 });
console.log(JSON.stringify(r));
