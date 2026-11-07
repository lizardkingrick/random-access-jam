// Scans ../Stems/<Song>/<Song> - <Stem> (<Key> <BPM>).wav and writes stems.json, with two
// compressed copies of every stem for the hosted site: Ogg Vorbis in stems-ogg/ (≈6x smaller than
// WAV, what most browsers load) and FLAC in stems-flac/ (lossless, about half the WAV, for browsers
// that can't decode Ogg: Safari and every iOS browser before 18.4). It also measures each stem's
// loudness with js/loudness.js, so the site doesn't have to before a first pick can play, and
// records what a decode of it must match sample for sample (frames and an alignment mark, see mark).
// Needs ffmpeg on PATH.   Usage:  node tools/build-stems.mjs [--stems <dir>] [--no-transcode]
// (default stems dir: ../Stems next to this repo; copies made by an earlier run are kept)
import { readdirSync, existsSync, mkdirSync, writeFileSync, statSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { integratedLoudness } from '../js/loudness.js';

const WEBAPP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stemsArg = process.argv.indexOf('--stems');
const STEMS = stemsArg > 0 ? resolve(process.argv[stemsArg + 1]) : resolve(WEBAPP, '..', 'Stems');
const transcode = !process.argv.includes('--no-transcode');
// stems.json field -> folder and ffmpeg settings. FLAC level 8 is the best compression within the
// FLAC "subset" every decoder must play; ffmpeg's levels 11-12 are ~6% smaller but use longer
// predictors than the subset allows, which Safari's decoder isn't required to handle.
const COPIES = {
  oggs: { dir: 'stems-ogg', ext: '.ogg', args: ['-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg'] },
  flacs: { dir: 'stems-flac', ext: '.flac', args: ['-c:a', 'flac', '-compression_level', '8', '-f', 'flac'] },
};

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
const bytes = { wav: 0, oggs: 0, flacs: 0 };

// A WAV's samples as Float32 channels, the values decodeAudioData gives the app (int / 32768).
function readWav(file) {
  const b = readFileSync(file);
  let fmt = null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('latin1', o, o + 4), size = b.readUInt32LE(o + 4), at = o + 8;
    if (id === 'fmt ') {
      const tag = b.readUInt16LE(at); // 0xfffe (extensible) keeps the real format in its sub-format
      fmt = { n: b.readUInt16LE(at + 2), sr: b.readUInt32LE(at + 4), bits: b.readUInt16LE(at + 14),
        float: (tag === 0xfffe ? b.readUInt16LE(at + 24) : tag) === 3 };
    } else if (id === 'data' && fmt) {
      const { n, bits, float } = fmt, step = bits / 8, frames = Math.floor(Math.min(size, b.length - at) / (n * step));
      const read = float ? (bits === 32 ? (p) => b.readFloatLE(p) : null)
        : bits === 16 ? (p) => b.readInt16LE(p) / 32768 : bits === 24 ? (p) => b.readIntLE(p, 3) / 8388608 : null;
      if (!read) throw new Error(`unsupported WAV (${bits}-bit${float ? ' float' : ''}): ${file}`);
      const chans = Array.from({ length: n }, () => new Float32Array(frames));
      for (let i = 0, p = at; i < frames; i++) for (let c = 0; c < n; c++, p += step) chans[c][i] = read(p);
      return { chans, sr: fmt.sr };
    }
    o = at + size + (size & 1);
  }
  throw new Error(`no audio in ${file}`);
}

// Integrated loudness in LUFS, measured as the app does it (a mono stem counts on both sides).
async function loudness({ chans, sr }) {
  const lufs = await integratedLoudness([0, 1].map((c) => chans[Math.min(c, chans.length - 1)]), sr);
  return Number.isFinite(lufs) ? Math.round(lufs * 100) / 100 : undefined; // silence: the app measures it
}

// An alignment mark: [index, level] of the sample that rises furthest above everything in the
// MARK_W samples before it (by at least 1 dB, and above -26 dBFS), with a level halfway between
// (in dB) the two. In the WAV the first sample at or above that level from MARK_W before the index
// on is the index itself, and a decode that keeps the stem's timing finds it there too (the app
// allows a few samples, see exactDecode in engine.js); one that adds or drops samples ahead of it
// finds it elsewhere or not at all. Copies shifted by 9 to 8192 samples either way are all caught.
// With `ogg` (the shipped Ogg as decoded) the mark must hold on both, rising above the louder of the
// two and reached by the quieter: picked from the WAV alone, the Ogg's coding error left as little
// as 0.13 dB between a sample before the mark and the level on some stems (still found, but one
// re-encode from failing for everyone, who would then all download the FLAC).
const MARK_W = 4096;
function mark(chans, ogg) {
  const n = chans[0].length, env = (cs) => {
    const a = new Float32Array(n);
    for (const c of cs) for (let i = 0; i < Math.min(n, c.length); i++) { const v = Math.abs(c[i]); if (v > a[i]) a[i] = v; }
    return a;
  };
  const lo = env(chans), hi = lo.slice();
  if (ogg) { const b = env(ogg); for (let i = 0; i < n; i++) { if (b[i] < lo[i]) lo[i] = b[i]; if (b[i] > hi[i]) hi[i] = b[i]; } }
  const dq = new Int32Array(n); // indices of the window's falling maxima (a monotonic queue)
  let h = 0, t = 0, best = null;
  for (let i = 0; i < n; i++) {
    while (h < t && dq[h] < i - MARK_W) h++;
    const v = lo[i], ref = Math.max(h < t ? hi[dq[h]] : 0, v / 8);
    if (i >= MARK_W && v >= 0.05 && v > 1.12 * ref && (!best || v / ref > best.ratio)) best = { i, ratio: v / ref, level: Math.round(Math.sqrt(ref * v) * 32768) };
    while (h < t && hi[dq[t - 1]] <= hi[i]) t--;
    dq[t++] = i;
  }
  return best ? [best.i, best.level] : undefined;
}
// The app's test (exactDecode in engine.js): the first sample at or above the level from MARK_W
// before the index is within MARK_TOL of it.
const MARK_TOL = 8;
function holds(chans, [at, level]) {
  for (let i = Math.max(0, at - MARK_W); i <= at + MARK_TOL; i++) if (chans.some((c) => Math.abs(c[i]) >= level / 32768)) return Math.abs(i - at) <= MARK_TOL;
  return false;
}

// The Ogg copy as ffmpeg decodes it (Chrome uses ffmpeg's decoder too; the result matched Chrome's
// sample for sample), or null if there is none.
function decodeOgg(file) {
  if (!existsSync(file)) return null;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '2', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) return null;
  const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length)), n = f.length / 2;
  const chans = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { chans[0][i] = f[2 * i]; chans[1][i] = f[2 * i + 1]; }
  return chans;
}

for (const song of readdirSync(STEMS).sort()) {
  const dir = join(STEMS, song);
  if (!statSync(dir).isDirectory()) continue;
  const [album, code] = CATALOG[song] || ['other', song.replace(/\W/g, '').slice(0, 6)];
  const entry = { code, album, key: null, bpm: null, stems: {}, oggs: {}, flacs: {}, lufs: {}, frames: {}, marks: {} };
  for (const file of readdirSync(dir)) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const type = m[2].toLowerCase(), wav = join(dir, file);
    entry.key = m[3];
    entry.bpm = Number(m[4]);
    entry.stems[type] = `Stems/${song}/${file}`;
    for (const [field, copy] of Object.entries(COPIES)) {
      const rel = `${copy.dir}/${song}/${file.replace(/\.wav$/i, copy.ext)}`, out = join(WEBAPP, rel);
      if (transcode && !existsSync(out)) {
        // Written under a temporary name, so an interrupted run never leaves a cut-off copy to ship.
        mkdirSync(dirname(out), { recursive: true });
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, ...copy.args, out + '.part'], { stdio: 'inherit' });
        if (r.status !== 0) { rmSync(out + '.part', { force: true }); console.error(`ffmpeg failed: ${rel}`); continue; }
        renameSync(out + '.part', out);
        console.log(`ok  ${rel}`);
      }
      if (existsSync(out)) {
        entry[field][type] = rel;
        bytes[field] += statSync(out).size;
      }
    }
    const audio = readWav(wav);
    entry.lufs[type] = await loudness(audio);
    const frames = entry.frames[type] = audio.chans[0].length;
    // An Ogg out of line with its WAV leaves no mark both share (a pad may not either): the WAV's
    // own mark goes in then, and if the Ogg doesn't hold it (or decodes to another length) the app
    // will catch that too and load the FLAC.
    const ogg = entry.oggs[type] && decodeOgg(join(WEBAPP, entry.oggs[type])), both = ogg && mark(audio.chans, ogg);
    const chosen = entry.marks[type] = both || mark(audio.chans);
    if (ogg && (ogg[0].length !== frames || (chosen && !holds(ogg, chosen)))) console.warn(`warning: ${entry.oggs[type]} is out of line with its WAV (${ogg[0].length - frames} samples longer, or its mark moved): the app will load the FLAC`);
    bytes.wav += statSync(wav).size;
  }
  if (Object.keys(entry.stems).length) manifest[song] = entry;
}

writeFileSync(join(WEBAPP, 'stems.json'), JSON.stringify(manifest, null, 2));
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;
// Exits once the line is out: loudness.js keeps a MessageChannel open, which would keep Node running.
process.stdout.write(`\n${Object.keys(manifest).length} songs. ${mb(bytes.wav)} wav -> ${mb(bytes.oggs)} ogg, ${mb(bytes.flacs)} flac\n`,
  () => process.exit(0));
