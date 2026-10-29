// Scans ../Stems/<Song>/<Song> - <Stem> (<Key> <BPM>).wav, writes stems.json and
// transcodes every stem to Ogg Vorbis in webapp/stems-ogg/ (≈6x smaller than WAV).
// Needs ffmpeg on PATH.   Usage:  node tools/build-stems.mjs [--stems <dir>] [--no-transcode]
// (default stems dir: ../Stems next to this repo)
import { readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WEBAPP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stemsArg = process.argv.indexOf('--stems');
const STEMS = stemsArg > 0 ? resolve(process.argv[stemsArg + 1]) : resolve(WEBAPP, '..', 'Stems');
const OUT = join(WEBAPP, 'stems-ogg');
const transcode = !process.argv.includes('--no-transcode');

// Album + track code for each song (code letter: H Homework, D Discovery,
// U Human After All, A Alive 2007, R Random Access Memories, S collabs).
const CATALOG = {
  'Da Funk': ['homework', 'H4'],
  'Around The World': ['homework', 'H7'],
  'Alive': ['homework', 'H15'],
  'One More Time': ['discovery', 'D1'],
  'Digital Love': ['discovery', 'D3'],
  'Harder Better Faster Stronger': ['discovery', 'D4'],
  'Something About Us': ['discovery', 'D9'],
  'Voyager': ['discovery', 'D10'],
  'Too Long': ['discovery', 'D14'],
  'Human After All': ['haa', 'U1'],
  'Robot Rock': ['haa', 'U3'],
  'Technologic': ['haa', 'U9'],
  'Too Long (Alive 2007)': ['alive', 'A4'],
  'Harder Better Faster Stronger (Alive 2007)': ['alive', 'A5'],
  'Give Life Back To Music': ['ram', 'R1'],
  'Giorgio By Moroder': ['ram', 'R3'],
  'Instant Crush': ['ram', 'R5'],
  'Lose Yourself To Dance': ['ram', 'R6'],
  'Get Lucky': ['ram', 'R8'],
  "Doin' It Right": ['ram', 'R12'],
  'Contact': ['ram', 'R13'],
  'Infinity Repeating': ['ram', 'R15'],
  'Starboy': ['weeknd', 'S1'],
  'I Feel It Coming': ['weeknd', 'S18'],
};

const FILE_RE = /^(.*) - (Groove|Lead|Texture|All) \(([A-G][b#]?m?) (\d+)\)\.wav$/i;
const manifest = {};
let wavBytes = 0, oggBytes = 0;

for (const song of readdirSync(STEMS).sort()) {
  const dir = join(STEMS, song);
  if (!statSync(dir).isDirectory()) continue;
  const [album, code] = CATALOG[song] || ['other', song.replace(/\W/g, '').slice(0, 6)];
  const entry = { code, album, key: null, bpm: null, stems: {}, oggs: {} };
  for (const file of readdirSync(dir)) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const type = m[2].toLowerCase();
    entry.key = m[3];
    entry.bpm = Number(m[4]);
    entry.stems[type] = `Stems/${song}/${file}`;
    const ogg = join(OUT, song, file.replace(/\.wav$/i, '.ogg'));
    if (transcode && !existsSync(ogg)) {
      mkdirSync(dirname(ogg), { recursive: true });
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(dir, file),
        '-c:a', 'libvorbis', '-q:a', '5', ogg], { stdio: 'inherit' });
      if (r.status !== 0) { console.error(`ffmpeg failed: ${file}`); continue; }
      console.log(`ok  ${song}/${file}`);
    }
    if (existsSync(ogg)) {
      entry.oggs[type] = `stems-ogg/${song}/${file.replace(/\.wav$/i, '.ogg')}`;
      oggBytes += statSync(ogg).size;
    }
    wavBytes += statSync(join(dir, file)).size;
  }
  if (Object.keys(entry.stems).length) manifest[song] = entry;
}

writeFileSync(join(WEBAPP, 'stems.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${Object.keys(manifest).length} songs. ${(wavBytes / 1e6).toFixed(0)} MB wav -> ${(oggBytes / 1e6).toFixed(0)} MB ogg`);
