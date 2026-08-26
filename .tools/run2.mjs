import { pathToFileURL } from 'node:url';
import { Recast } from 'playwright-recast';
const { parseTrace } = await import(pathToFileURL(process.cwd() + '/node_modules/playwright-recast/dist/parse/trace-parser.js').href);

const TRACE = '/tmp/demo-trace.zip';
const VW = 1280, VH = 720;

// Pull the real click points straight out of the trace.
const t = await parseTrace(TRACE);
const clicks = (t.actions || []).filter(a => a.method === 'click' && a.point);
console.log('clicks with points:', clicks.length);

// enrichZoomFromReport joins positionally against the subtitle cues, so emit
// one cue per click and one zoom step per cue. x/y are 0..1 viewport fractions.
const steps = clicks.map(c => ({
  zoom: { x: +(c.point.x / VW).toFixed(4), y: +(c.point.y / VH).toFixed(4), level: 1.9 },
}));
console.log('zoom steps:', JSON.stringify(steps));

await Recast.from(TRACE)
  .parse()
  .subtitles(a => (a.method === 'click' ? 'click' : undefined))   // cue objects only; never drawn
  .enrichZoomFromReport(steps)
  .cursorOverlay({ size: 30, moveDurationMs: 260 })
  .clickEffect({ radius: 36, duration: 420, color: '#4F6B3D', opacity: 0.6 })
  .render({ resolution: '1080p', crf: 21 })
  .toFile('/tmp/demo2.mp4');
console.log('done');
