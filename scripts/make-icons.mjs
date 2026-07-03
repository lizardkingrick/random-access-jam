// Generates public/icons/icon-192.png and icon-512.png procedurally
// (rounded dark tile + neon gradient rings) so no binary assets live in git
// history unaccounted for. Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- minimal PNG encoder (RGBA, 8-bit) ----------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- icon drawing ----------

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const smooth = (edge, width, d) => clamp01((edge - d) / width + 0.5); // 1 inside, 0 outside
const lerp = (a, b, t) => a + (b - a) * t;

// neon gradient stops: teal → cyan → violet
const STOPS = [
  [45, 226, 166],
  [53, 201, 255],
  [122, 107, 255],
];
function neon(t) {
  const x = clamp01(t) * (STOPS.length - 1);
  const i = Math.min(Math.floor(x), STOPS.length - 2);
  const f = x - i;
  return [0, 1, 2].map((c) => lerp(STOPS[i][c], STOPS[i + 1][c], f));
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const cornerR = size * 0.22;
  const aa = Math.max(1, size / 128); // anti-alias width in px

  const ringDefs = [
    { r: size * 0.3125, w: size * 0.039, alpha: 1 },
    { r: size * 0.203, w: size * 0.0195, alpha: 0.55 },
  ];
  const dotR = size * 0.0625;
  const needle = { x: c, y0: size * 0.1875, y1: size * 0.297, w: size * 0.039 / 2 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-square mask
      const qx = Math.abs(x - c) - (c - cornerR);
      const qy = Math.abs(y - c) - (c - cornerR);
      const dCorner = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
      const mask = smooth(cornerR, aa, dCorner); // 1 inside the rounded tile, 0 outside
      if (mask <= 0) continue;

      // background: dark radial gradient
      const dc = Math.hypot(x - c, y - (c - size * 0.08));
      const g = clamp01(dc / (size * 0.75));
      let R = lerp(16, 5, g);
      let G = lerp(26, 6, g);
      let B = lerp(46, 10, g);

      // gradient parameter follows position diagonal
      const t = clamp01((x + y) / (2 * size));
      const [nr, ng, nb] = neon(t);

      const dRing = Math.hypot(x - c, y - c);
      let glow = 0;
      for (const ring of ringDefs) {
        const dist = Math.abs(dRing - ring.r);
        const line = smooth(ring.w / 2, aa, dist) * ring.alpha;
        const halo = Math.exp(-(dist * dist) / (2 * (size * 0.035) ** 2)) * 0.35 * ring.alpha;
        glow = Math.max(glow, line + halo);
      }
      // center dot
      glow = Math.max(glow, smooth(dotR, aa, dRing) + Math.exp(-(dRing * dRing) / (2 * (size * 0.05) ** 2)) * 0.3);
      // needle at top
      if (y > needle.y0 - needle.w && y < needle.y1 + needle.w) {
        const dN = Math.max(Math.abs(x - needle.x) , 0);
        const inY = y >= needle.y0 && y <= needle.y1 ? 0 : Math.min(Math.abs(y - needle.y0), Math.abs(y - needle.y1));
        glow = Math.max(glow, smooth(needle.w, aa, Math.hypot(dN, inY)));
      }

      glow = clamp01(glow);
      R = lerp(R, nr, glow);
      G = lerp(G, ng, glow);
      B = lerp(B, nb, glow);

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(R);
      rgba[idx + 1] = Math.round(G);
      rgba[idx + 2] = Math.round(B);
      rgba[idx + 3] = Math.round(mask * 255);
    }
  }
  return rgba;
}

for (const size of [192, 512]) {
  const png = encodePng(size, draw(size));
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
