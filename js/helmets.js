// Optional Daft Punk helmet holograms for the stage. The models are game assets, so they never
// ship with the app: the local server (tools/serve.ps1) lists any it finds next to the stems
// ("3D Helmets/*.obj") and the stage draws them; without them nothing changes.
// Each mesh becomes an even point cloud sampled over its surface, with a normal per point.

const POINTS = 4200; // per helmet; plenty for the look, cheap on a software-rendered canvas

// Seeded PRNG so the sampling (and the look) is the same on every load.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseObj(text) {
  const v = [], tris = [];
  for (const line of text.split('\n')) {
    if (line.charCodeAt(0) !== 118 && line.charCodeAt(0) !== 102) continue; // 'v' / 'f'
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') v.push(+parts[1], +parts[2], +parts[3]);
    else if (parts[0] === 'f') {
      const n = v.length / 3;
      const idx = parts.slice(1).map((p) => { const i = parseInt(p, 10); return i < 0 ? n + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  return { v, tris };
}

// Area-weighted surface sampling, centred and scaled to a unit-ish height (y up, -z = face front).
function samplePoints({ v, tris }, count, seed) {
  const nt = tris.length / 3;
  const area = new Float64Array(nt), nrm = new Float32Array(nt * 3);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[t * 3] = nx / len; nrm[t * 3 + 1] = ny / len; nrm[t * 3 + 2] = nz / len;
    total += area[t] = len / 2;
  }
  // Bounds for centring / scaling.
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
    minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    minZ = Math.min(minZ, v[i + 2]); maxZ = Math.max(maxZ, v[i + 2]);
  }
  const centre = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const scale = 1 / (maxY - minY || 1);

  // Cumulative areas -> pick triangles by area with a binary search.
  const cum = new Float64Array(nt);
  let acc = 0;
  for (let t = 0; t < nt; t++) cum[t] = acc += area[t];
  const rand = rng(seed);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const target = rand() * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    const a = tris[lo * 3] * 3, b = tris[lo * 3 + 1] * 3, c = tris[lo * 3 + 2] * 3;
    let r1 = rand(), r2 = rand();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    for (let k = 0; k < 3; k++) {
      const p = v[a + k] + r1 * (v[b + k] - v[a + k]) + r2 * (v[c + k] - v[a + k]);
      pos[i * 3 + k] = (p - centre[k]) * scale;
      nor[i * 3 + k] = nrm[lo * 3 + k];
    }
  }
  return { pos, nor, count, depth: (maxZ - minZ) * scale, width: (maxX - minX) * scale };
}

/**
 * Loads up to two helmet clouds from the local listing: { tb3, gm08 } (either may be missing).
 * Prefers the detailed "Fortnite" meshes, falls back to any TB3 / GM08 .obj.
 */
export async function loadHelmets(local) {
  const files = (local && local.helmets) || [];
  const base = (local && local.mounts && local.mounts.helmets) || 'Extras/Helmets/';
  const pick = (id) => files.find((f) => new RegExp(`^${id} Fortnite\\.obj$`, 'i').test(f))
    || files.find((f) => new RegExp(`^${id}\\b.*\\.obj$`, 'i').test(f));
  const out = {};
  await Promise.all([['tb3', 'TB3', 7], ['gm08', 'GM08', 11]].map(async ([key, id, seed]) => {
    const file = pick(id);
    if (!file) return;
    try {
      const res = await fetch(encodeURI(base + file).replace(/#/g, '%23'));
      if (!res.ok) return;
      const mesh = parseObj(await res.text());
      if (mesh.tris.length) out[key] = samplePoints(mesh, POINTS, seed);
    } catch (err) { console.warn('helmet model failed to load:', file, err); }
  }));
  return out;
}
