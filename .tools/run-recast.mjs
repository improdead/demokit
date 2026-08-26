import { Recast } from 'playwright-recast';

const t0 = Date.now();
await Recast.from('/tmp/demo-trace.zip')
  .parse()
  // Synthetic cues: autoZoom stores zoom on subtitle entries, so the objects are
  // structurally required — but burnSubtitles/embedSubtitles default off, so
  // nothing is ever drawn. Zoom without captions.
  .subtitles((a) => a.method)
  .autoZoom({ clickLevel: 1.85, inputLevel: 1.6, centerBias: 0.2, transitionMs: 450, easing: 'ease-in-out' })
  .cursorOverlay({ size: 28, moveDurationMs: 260, approachMs: 480 })
  .clickEffect({ radius: 34, duration: 420, color: '#4F6B3D', opacity: 0.55 })
  .speedUp({ duringIdle: 4.0, duringUserAction: 1.0, duringNetworkWait: 2.5 })
  .render({ resolution: '1080p', crf: 21 })
  .toFile('/tmp/demo-out.mp4');
console.log('rendered in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
