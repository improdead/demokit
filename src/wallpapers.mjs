#!/usr/bin/env node
/**
 * Wallpapers for the backdrop.
 *
 *   node src/wallpapers.mjs list          what is available, local and remote
 *   node src/wallpapers.mjs fetch         download the curated set (4K, free licence)
 *   node src/wallpapers.mjs local         convert the macOS ones already on disk
 *
 * Nothing is committed. Wallpapers land in .cache/wallpapers/, which is
 * gitignored: the Unsplash set is free to use but redistributing a pile of
 * other people's photographs from a repo is a different thing from using them,
 * and the macOS ones are Apple's.
 *
 * The curated Unsplash ids are painterly abstracts chosen to RECEDE - a demo
 * backdrop that competes with the UI is worse than no backdrop. The loud ones
 * in the same collection are deliberately not here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

// Unsplash licence: free to use, commercial included, no attribution required.
export const CURATED = {
  'paint-terracotta': 'photo-1531056416665-266c4099c928',
  'paint-blossom': 'photo-1533158388470-9a56699990c6',
  'paint-graphite': 'photo-1583591900414-7031eb309cb6',
  'paint-harbour': 'photo-1618331833071-ce81bd50d300',
  'paint-slate': 'photo-1618331835717-801e976710b2',
  'paint-ink': 'photo-1567095761054-7a02e69e5c43',
  'paint-marble': 'photo-1595878715977-2e8f8df18ea8',
  'paint-canvas': 'photo-1541512416146-3cf58d6b27cc',
};

const MAC_DIRS = ['/System/Library/Desktop Pictures', '/Library/Desktop Pictures'];

export function wallpaperDir(root) {
  const d = join(root, '.cache', 'wallpapers');
  mkdirSync(d, { recursive: true });
  return d;
}

/** macOS ships 6016x6016 wallpapers. They are already on disk and free. */
export async function convertLocal(dir) {
  const out = [];
  for (const md of MAC_DIRS) {
    if (!existsSync(md)) continue;
    for (const f of readdirSync(md).filter((f) => f.endsWith('.heic'))) {
      const name = 'mac-' + f.replace(/\.heic$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const p = join(dir, name + '.png');
      if (!existsSync(p)) {
        try { await run('sips', ['-s', 'format', 'png', join(md, f), '--out', p]); }
        catch { continue; }
      }
      out.push(p);
    }
  }
  return out;
}

export async function fetchCurated(dir, only = null) {
  const out = [];
  for (const [name, id] of Object.entries(CURATED)) {
    if (only && name !== only) continue;
    const p = join(dir, name + '.jpg');
    if (existsSync(p) && statSync(p).size > 10000) { out.push(p); continue; }
    const url = `https://images.unsplash.com/${id}?w=3840&q=82&fm=jpg&fit=max`;
    try {
      await run('curl', ['-sL', '--max-time', '60', '-o', p, url]);
      if (statSync(p).size > 10000) { out.push(p); console.log('  fetched ' + name); }
    } catch { /* offline: skip, the generated canvases still work */ }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(new URL('.', import.meta.url).pathname, '..');
  const dir = wallpaperDir(root);
  const cmd = process.argv[2] || 'list';

  if (cmd === 'fetch' || cmd === 'all') {
    console.log('fetching curated 4K wallpapers (Unsplash licence: free, no attribution)...');
    await fetchCurated(dir, process.argv[3] || null);
  }
  if (cmd === 'local' || cmd === 'all') {
    console.log('converting macOS wallpapers already on this machine...');
    const l = await convertLocal(dir);
    console.log(`  ${l.length} converted`);
  }

  const have = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|heic)$/i.test(f)) : [];
  console.log(`\n${have.length} wallpaper(s) in ${dir}`);
  for (const f of have.sort()) console.log('  ' + join(dir, f));
  if (!have.length) {
    console.log('  (none yet — run: bin/demokit wallpapers all)');
  }
  console.log('\nUse one with:  bin/demokit --render-only <shot> out.mp4 --bg <path>');
  console.log('Generated painterly grounds need no download: --bg canvas-garden|canvas-dusk|canvas-tide|canvas-ember|canvas-slate');
}
