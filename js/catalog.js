// Album pages for the wheel (LB/RB in Fortnite) and the little badge art.
// The art is original abstract SVG — no real cover artwork is bundled.

export const ALBUMS = [
  { id: 'homework', name: 'Homework', year: 1997 },
  { id: 'discovery', name: 'Discovery', year: 2001 },
  { id: 'haa', name: 'Human After All', year: 2005 },
  { id: 'alive', name: 'Alive 2007', year: 2007 },
  { id: 'ram', name: 'Random Access Memories', year: 2013 },
  { id: 'weeknd', name: 'The Weeknd Collabs', year: 2016 },
];

export const albumById = (id) => ALBUMS.find((a) => a.id === id) || { id, name: 'Other', year: 0 };

export function songsForAlbum(manifest, albumId) {
  const num = (song) => Number(manifest[song].code.replace(/\D/g, '')) || 0;
  return Object.keys(manifest).filter((s) => manifest[s].album === albumId).sort((a, b) => num(a) - num(b));
}

// "Harder Better Faster Stronger (Alive 2007)" → the album page already says Alive.
export const displayName = (song) => song.replace(/\s*\(Alive 2007\)$/, '');

const ART = {
  homework: `
    <rect width="100" height="100" fill="#0b0a09"/>
    <rect width="100" height="100" fill="url(#hwSheen)"/>
    <circle cx="50" cy="50" r="26" fill="none" stroke="#d9b45a" stroke-width="3"/>
    <circle cx="50" cy="50" r="17" fill="#1a1610" stroke="#8c6f2e" stroke-width="1.5"/>
    <path d="M40 58 L50 38 L60 58 Z" fill="#d9b45a"/>
    <defs><linearGradient id="hwSheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a2620"/><stop offset=".5" stop-color="#0b0a09"/><stop offset="1" stop-color="#1c1915"/></linearGradient></defs>`,
  discovery: `
    <rect width="100" height="100" fill="url(#dcBg)"/>
    <path d="M-10 70 C 20 40, 50 90, 110 30 L110 50 C 60 100, 25 55, -10 90 Z" fill="url(#dcChrome)" opacity=".95"/>
    <path d="M-10 40 C 25 15, 60 55, 110 5 L110 18 C 60 70, 25 30, -10 58 Z" fill="url(#dcChrome)" opacity=".55"/>
    <defs>
      <linearGradient id="dcBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121a3a"/><stop offset="1" stop-color="#05070f"/></linearGradient>
      <linearGradient id="dcChrome" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6c7a99"/><stop offset=".35" stop-color="#f2f6ff"/><stop offset=".6" stop-color="#8b97b3"/><stop offset="1" stop-color="#e4ecff"/></linearGradient></defs>`,
  haa: `
    <rect width="100" height="100" fill="#0a0506"/>
    <rect x="17" y="22" width="66" height="52" rx="10" fill="#1a0b0d" stroke="#5b2a2f" stroke-width="3"/>
    <rect x="25" y="29" width="50" height="38" rx="6" fill="#ff2a3d"/>
    <g stroke="#7d0010" stroke-width="2" opacity=".75"><path d="M25 35h50M25 41h50M25 47h50M25 53h50M25 59h50"/></g>
    <path d="M38 80h24" stroke="#5b2a2f" stroke-width="4" stroke-linecap="round"/>`,
  alive: `
    <rect width="100" height="100" fill="#04050a"/>
    <path d="M50 20 L84 78 H16 Z" fill="none" stroke="#ffcf5c" stroke-width="3" stroke-linejoin="round"/>
    <path d="M50 34 L72 72 H28 Z" fill="none" stroke="#35e0ff" stroke-width="2" stroke-linejoin="round" opacity=".85"/>
    <path d="M50 48 L61 66 H39 Z" fill="#ff3fb4" opacity=".9"/>`,
  ram: `
    <rect width="100" height="100" fill="url(#ramBg)"/>
    <path d="M24 66 C 22 36, 36 20, 50 20 C 64 20, 78 36, 76 66 Z" fill="url(#ramHelm)"/>
    <path d="M28 46 C 34 40, 66 40, 72 46 L72 60 C 64 64, 36 64, 28 60 Z" fill="#05060a"/>
    <path d="M32 50 C 40 46, 60 46, 68 50" stroke="#59d8ff" stroke-width="1.6" fill="none" opacity=".7"/>
    <rect x="22" y="66" width="56" height="8" rx="3" fill="#565d6b"/>
    <defs>
      <radialGradient id="ramBg" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#1b2140"/><stop offset="1" stop-color="#05060b"/></radialGradient>
      <linearGradient id="ramHelm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6f8ff"/><stop offset=".45" stop-color="#9aa3b8"/><stop offset="1" stop-color="#3b4152"/></linearGradient></defs>`,
  weeknd: `
    <rect width="100" height="100" fill="#0a0507"/>
    <path d="M50 16 L57 43 L84 50 L57 57 L50 84 L43 57 L16 50 L43 43 Z" fill="#ff2340"/>
    <circle cx="50" cy="50" r="6" fill="#0a0507"/>`,
  other: `<rect width="100" height="100" fill="#111"/>`,
};

export const albumArt = (id) =>
  `<svg viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="xMidYMid slice">${(ART[id] || ART.other)}</svg>`;

// SVG ids inside inline art must be unique per instance, or the second copy
// of a gradient silently resolves to the first one's (possibly hidden) defs.
let artSeq = 0;
export function albumArtUnique(id) {
  const n = ++artSeq;
  return albumArt(id).replace(/id="(\w+)"/g, `id="$1_${n}"`).replace(/url\(#(\w+)\)/g, `url(#$1_${n})`);
}

// Layer icons — Groove: pulse line, Lead: zigzag in a ring, Extra: slashes.
export const LAYER_ICONS = {
  groove: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M3 26h9l4-12 7 22 6-17 4 7h12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lead: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="3.5" stroke-dasharray="7 4.3"/><path d="M13 30l7-12 6 10 6-10 4 7" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  texture: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 26 24 10M10 38 34 14M22 40 40 22" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>`,
};
