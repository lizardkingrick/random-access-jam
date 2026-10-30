// Song catalogue and manifest building. Shared by the app (which builds its song list from the
// local server's folder listing, see tools/serve.ps1) and tools/build-stems.mjs (which writes
// stems.json for the hosted site). Keep this free of DOM / browser globals.

// Album + track code per song (code letter: H Homework, D Discovery, U Human After All,
// A Alive 2007, R Random Access Memories, S The Weeknd collabs). Key and BPM are only a
// fallback for files that don't carry them in their name (the instrument guns).
export const SONGS = {
  'Da Funk': { album: 'homework', code: 'H4', key: 'Gm', bpm: 111 },
  'Around The World': { album: 'homework', code: 'H7', key: 'Em', bpm: 121 },
  'Alive': { album: 'homework', code: 'H15', key: 'Bbm', bpm: 129 },
  'One More Time': { album: 'discovery', code: 'D1', key: 'Bm', bpm: 123 },
  'Digital Love': { album: 'discovery', code: 'D3', key: 'A', bpm: 125 },
  'Harder Better Faster Stronger': { album: 'discovery', code: 'D4', key: 'Gbm', bpm: 123 },
  'Something About Us': { album: 'discovery', code: 'D9', key: 'Dm', bpm: 100 },
  'Voyager': { album: 'discovery', code: 'D10', key: 'Em', bpm: 121 },
  'Too Long': { album: 'discovery', code: 'D14', key: 'Fm', bpm: 127 },
  'Human After All': { album: 'haa', code: 'U1', key: 'Bm', bpm: 136 },
  'Robot Rock': { album: 'haa', code: 'U3', key: 'Dm', bpm: 112 },
  'Technologic': { album: 'haa', code: 'U9', key: 'A', bpm: 127 },
  'Too Long (Alive 2007)': { album: 'alive', code: 'A4', key: 'Fm', bpm: 127 },
  'Harder Better Faster Stronger (Alive 2007)': { album: 'alive', code: 'A5', key: 'Fm', bpm: 123 },
  'Give Life Back To Music': { album: 'ram', code: 'R1', key: 'Am', bpm: 119 },
  'Giorgio By Moroder': { album: 'ram', code: 'R3', key: 'Am', bpm: 113 },
  'Instant Crush': { album: 'ram', code: 'R5', key: 'Bbm', bpm: 110 },
  'Lose Yourself To Dance': { album: 'ram', code: 'R6', key: 'Bbm', bpm: 100 },
  'Get Lucky': { album: 'ram', code: 'R8', key: 'Gbm', bpm: 116 },
  "Doin' It Right": { album: 'ram', code: 'R12', key: 'Ebm', bpm: 89 },
  'Contact': { album: 'ram', code: 'R13', key: 'Bm', bpm: 124 },
  'Infinity Repeating': { album: 'ram', code: 'R15', key: 'Bbm', bpm: 110 },
  'Starboy': { album: 'weeknd', code: 'S1', key: 'Am', bpm: 93 },
  'I Feel It Coming': { album: 'weeknd', code: 'S18', key: 'Cm', bpm: 93 },
};

// Release order of the albums; the instrument-guns page sorts its songs by it.
const ALBUM_ORDER = ['homework', 'discovery', 'haa', 'alive', 'ram', 'weeknd'];

// Remix-station stems: "<Song> - <Groove|Lead|Texture|All> (<Key> <BPM>).wav"
export const STEM_RE = /^(.*) - (Groove|Lead|Texture|All) \(([A-G][b#]?m?) (\d+(?:\.\d+)?)\)\.(wav|ogg|flac)$/i;

// Instrument-gun area loops: "<Song> - <Backing Track|Melody Gun|Rhythm Gun>[ 02].wav". Each part
// becomes a layer: the backing track is the groove, the guns are the lead and the extra.
export const GUN_RE = /^(.*) - (Backing Track|Melody Gun|Rhythm Gun)(?: \d+)?\.(wav|ogg|flac)$/i;
export const GUN_PARTS = { 'backing track': 'groove', 'melody gun': 'lead', 'rhythm gun': 'texture' };
export const GUNS_SUFFIX = ' (Instrument Guns)';

export const fallbackCode = (song) => song.replace(/\W/g, '').slice(0, 6);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Builds the app manifest from a folder listing:
 *   { stems: ['<Song>/<file>.wav', ...], guns: [...], mounts: { stems: 'Stems/', guns: 'Extras/Guns/' } }
 * Each entry: { code, album, key, bpm, stems: { type: id }, src: { type: url }, parts?: { type: label }, order? }
 * `stems` keeps the stems.json-style id ("Stems/<Song>/<file>"); `src` is what the app fetches.
 */
export function manifestFromListing(listing) {
  const manifest = {};
  // Share links name songs by code, so codes must be unique; uncatalogued songs get a short
  // name-based code, numbered when two would clash ('Veridis Quo' vs 'Veridis Quo (Live)').
  const used = new Set(Object.values(SONGS).map((s) => s.code));
  const uniqueCode = (code) => { let c = code, n = 2; while (used.has(c)) c = code + n++; used.add(c); return c; };
  const mounts = listing.mounts || {};
  const stemsBase = mounts.stems || 'Stems/';
  const gunsBase = mounts.guns || 'Extras/Guns/';

  for (const rel of listing.stems || []) {
    const parts = rel.split('/');
    const file = parts.pop();
    const m = STEM_RE.exec(file);
    if (!m) continue;
    const song = parts[parts.length - 1] || m[1]; // the stem's own folder, however deep the listing starts
    const type = m[2].toLowerCase();
    const cat = SONGS[song] || {};
    const entry = manifest[song] ??= {
      code: cat.code || uniqueCode(fallbackCode(song)), album: cat.album || 'other',
      key: m[3], bpm: Number(m[4]), stems: {}, src: {},
    };
    // A wav and an ogg of the same stem: keep the smaller ogg for loading.
    if (entry.src[type] && !/\.ogg$/i.test(file)) continue;
    entry.stems[type] = `Stems/${rel}`;
    entry.src[type] = stemsBase + rel;
  }

  for (const rel of listing.guns || []) {
    const parts = rel.split('/');
    const file = parts.pop();
    const m = GUN_RE.exec(file);
    if (!m) continue;
    const base = parts[parts.length - 1] || m[1];
    const source = manifest[base] || SONGS[base];
    if (!source || !source.key || !source.bpm) continue; // key/BPM unknown: can't sync it
    const cat = SONGS[base] || {};
    const part = m[2].toLowerCase();
    const type = GUN_PARTS[part];
    const albumRank = ALBUM_ORDER.indexOf(cat.album);
    const entry = manifest[base + GUNS_SUFFIX] ??= {
      code: uniqueCode('G' + (cat.code || fallbackCode(base))), album: 'guns', key: source.key, bpm: source.bpm,
      stems: {}, src: {}, parts: {},
      order: (albumRank < 0 ? 99 : albumRank) * 100 + (Number(String(cat.code).replace(/\D/g, '')) || 0),
    };
    entry.stems[type] = `Guns/${rel}`;
    entry.src[type] = gunsBase + rel;
    entry.parts[type] = titleCase(part);
  }
  return manifest;
}
