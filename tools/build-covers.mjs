// Makes small square album covers for the app from your own full-size copies.
// Reads ../album_cover/*.jpg|jpeg|png (next to this repo), writes covers/<album>.jpg (256 px)
// and covers/covers.json listing them. Needs ffmpeg on PATH.
// Usage:  node tools/build-covers.mjs [--src <dir>]
import { readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WEBAPP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcArg = process.argv.indexOf('--src');
const SRC = srcArg > 0 ? resolve(process.argv[srcArg + 1]) : resolve(WEBAPP, '..', 'album_cover');
const OUT = join(WEBAPP, 'covers');
const SIZE = 256;

// File name (lower case, without extension, spaces/underscores ignored) -> album id in js/catalog.js.
const ALBUM_FOR = {
  homework: 'homework',
  discovery: 'discovery',
  humanafterall: 'haa',
  alive2007: 'alive',
  randomaccessmemories: 'ram',
  starboy: 'weeknd',
  weeknd: 'weeknd',
  instrumentguns: 'guns',
};

mkdirSync(OUT, { recursive: true });
const made = [];
for (const file of readdirSync(SRC).sort()) {
  if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
  const album = ALBUM_FOR[parse(file).name.toLowerCase().replace(/[\s_-]/g, '')];
  if (!album) { console.warn(`skip ${file}: no album matches its name`); continue; }
  const out = join(OUT, `${album}.jpg`);
  // Centre-crop to a square, then scale down.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(SRC, file),
    '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${SIZE}:${SIZE}:flags=lanczos`, '-q:v', '3', out], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`ffmpeg failed: ${file}`); continue; }
  made.push(album);
  console.log(`ok  ${file} -> covers/${album}.jpg (${(statSync(out).size / 1024).toFixed(0)} KB)`);
}
writeFileSync(join(OUT, 'covers.json'), JSON.stringify([...new Set(made)]));
console.log(`\n${made.length} covers.`);
