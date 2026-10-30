// Background stage: a neon dome of arcs flying toward the viewer, orbiting dot
// strands, a turntable floor, and one floating object per active layer
// (Groove = green wire sphere, Lead = disco sphere, Extra = gold speaker cube).
// Everything is plain 2D canvas with a tiny bit of hand-rolled 3D projection.

const TAU = Math.PI * 2;

function rot([x, y, z], ax, ay) {
  const cy = Math.cos(ay), sy = Math.sin(ay);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  const cx = Math.cos(ax), sx = Math.sin(ax);
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  return [x, y, z];
}
const easeOutBack = (p) => 1 + 2.4 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2);

export function createStage(canvas, getFrame) {
  const g = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, dpr = 1, arcGrad = null;
  let ringPhase = 0, t = 0, last = performance.now(), kick = 0;
  const pres = { groove: 0, lead: 0, texture: 0 };
  const lvl = { groove: 0, lead: 0, texture: 0 };
  let helmets = null; // optional point clouds from helmets.js
  const holo = { canvas: null, ctx: null, img: null, px: null, w: 0, h: 0 };

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw === w && ch === h) return;
    canvas.width = w = cw;
    canvas.height = h = ch;
    arcGrad = g.createLinearGradient(0, 0, w, 0);
    [['#ffc94a', 0], ['#ffb347', 0.2], ['#3ce08c', 0.42], ['#2fd3c6', 0.58], ['#4c7dff', 0.78], ['#b65cff', 1]]
      .forEach(([c, o]) => arcGrad.addColorStop(o, c));
    if (w && h) paintBackdrop();
  }

  // The backdrop (base colour + violet glow) only changes with the kick, so it is painted once
  // per size at the quiet and at the loudest glow and cross-faded each frame. Re-filling a
  // full-screen gradient every frame cost ~6 ms on software-rendered machines.
  const backdrop = [document.createElement('canvas'), document.createElement('canvas')];
  function paintBackdrop() {
    const cx = w * (w / dpr < 900 ? 0.5 : 0.4), S = Math.min(w, h);
    backdrop.forEach((c, k) => {
      c.width = w;
      c.height = h;
      const bg = c.getContext('2d');
      bg.fillStyle = '#020309';
      bg.fillRect(0, 0, w, h);
      const glow = bg.createRadialGradient(cx, h * 0.45, 0, cx, h * 0.45, S * 0.9);
      glow.addColorStop(0, `rgba(40, 30, 110, ${k ? 0.5 : 0.35})`);
      glow.addColorStop(1, 'rgba(2, 3, 9, 0)');
      bg.fillStyle = glow;
      bg.fillRect(0, 0, w, h);
    });
  }

  let lastDraw = 0, lastRaf = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const f = getFrame(); // every frame: it also polls the controller
    // Pace the drawing: ~60 fps while playing, 30 when idle, 10 behind the help dialog. A
    // 120-144 Hz screen would otherwise draw (and cost) two or three times as much. Half a
    // refresh of slack, so a 75 or 144 Hz screen doesn't drop to every other frame.
    const minGap = f.paused ? 100 : f.playing || f.fx ? 1000 / 60 : 1000 / 30;
    const refresh = Math.min(50, now - lastRaf);
    lastRaf = now;
    if (now - lastDraw < minGap - refresh / 2) return;
    lastDraw = now;
    resize();
    if (!w || !h) return; // not laid out yet
    const m = f.meters;
    const still = reduce.matches;
    const dt = Math.min(0.1, (now - last) / 1000) * (still ? 0.25 : 1);
    last = now;
    t += dt;
    // Reduced motion: no beat flashes or zooming dome, just a slow glow that follows the bass.
    if (still) kick += (Math.min(0.3, m.bass) - kick) * Math.min(1, dt * 2);
    else kick = Math.max(kick * Math.pow(0.02, dt), f.playing && m.beat < 0.12 ? 1 : 0, m.bass);
    if (!still) ringPhase += dt * (f.playing ? f.bpm / 60 / 4 : 0.06) * (1 + f.fx * 1.5);

    const narrow = w / dpr < 900;
    const fx = narrow ? 0.5 : 0.4;
    const cx = w * fx, cy = h * 0.6, S = Math.min(w, h);

    // backdrop: the glow brightens with the kick (0.35 -> 0.5 alpha)
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.drawImage(backdrop[0], 0, 0);
    if (kick > 0.01) {
      g.globalAlpha = Math.min(1, kick);
      g.drawImage(backdrop[1], 0, 0);
      g.globalAlpha = 1;
    }

    drawDome(cx, cy, S);
    if (helmets) drawHelmets(f, S, narrow);
    drawStrands(cx, h * 0.5, S, m);
    drawFloor(cx, h, S, m);

    for (const id of ['groove', 'lead', 'texture']) {
      pres[id] += ((f.active[id] ? 1 : 0) - pres[id]) * Math.min(1, dt * 4);
      lvl[id] += (m[id] - lvl[id]) * Math.min(1, dt * 18);
    }
    // Objects float in the open area left of the wheel (f.zone = its width as a fraction of the screen).
    const bob = (k) => Math.sin(t * 0.9 + k) * S * 0.015;
    const zw = narrow ? w * 0.6 : w * f.zone, zx = narrow ? cx : zw / 2;
    const pos = {
      texture: [zx - zw * 0.3, h * (narrow ? 0.2 : 0.25)],
      groove: [zx, h * (narrow ? 0.16 : 0.22)],
      lead: [zx + zw * 0.3, h * (narrow ? 0.26 : 0.36)],
    };
    const size = (id, k) => S * k * easeOutBack(pres[id]) * (1 + lvl[id] * 0.28) * (narrow ? 0 : 1); // phones: no room
    if (!narrow) { // phones: no room, and no point computing invisible geometry
      if (pres.texture > 0.01) drawCube(pos.texture[0], pos.texture[1] + bob(0), size('texture', 0.07), lvl.texture);
      if (pres.groove > 0.01) drawWireSphere(pos.groove[0], pos.groove[1] + bob(2), size('groove', 0.085), lvl.groove);
      if (pres.lead > 0.01) drawDisco(pos.lead[0], pos.lead[1] + bob(4), size('lead', 0.075), lvl.lead);
    }

    if (f.fx > 0) { // FX held: tint the scene
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = f.fx * 0.18;
      g.fillStyle = f.fxX < 0 ? '#5b2cff' : '#00e0ff';
      g.fillRect(0, 0, w, h);
      g.globalAlpha = 1;
    }
  }

  function drawDome(cx, cy, S) {
    const base = S * 0.06, growth = 1.16, N = 26;
    const frac = ringPhase % 1;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = arcGrad;
    const tilt = Math.sin(t * 0.13) * 0.06, ct = Math.cos(tilt), st = Math.sin(tilt);
    const alpha = 0.32 + kick * 0.25;
    // Rings fade in near the centre; the rest share one alpha, so they're stroked in a few
    // batches of similar width instead of one stroke per ring.
    let batch = null, batchW = 0;
    const flush = () => { if (batch) { g.globalAlpha = alpha; g.lineWidth = batchW; g.stroke(batch); batch = null; } };
    const rMax = Math.hypot(Math.max(cx, w - cx) / 1.35, cy / 0.95) + 20 * dpr; // beyond: off-screen
    for (let k = N; k >= 0; k--) {
      const r = base * Math.pow(growth, k + frac);
      if (r > rMax) continue;
      const fadeIn = Math.min(1, (r - base) / (base * 2.5));
      const lw = Math.round((0.6 + r * 0.0035) * dpr * 4) / 4;
      if (fadeIn < 1) {
        flush();
        g.globalAlpha = fadeIn * alpha;
        g.lineWidth = lw;
        g.beginPath();
        g.ellipse(cx, cy, r * 1.35, r * 0.95, tilt, Math.PI, Math.PI * 2);
        g.stroke();
        continue;
      }
      if (lw !== batchW) { flush(); batch = new Path2D(); batchW = lw; }
      batch.moveTo(cx - r * 1.35 * ct, cy - r * 1.35 * st); // the arc's start, so rings don't join up
      batch.ellipse(cx, cy, r * 1.35, r * 0.95, tilt, Math.PI, Math.PI * 2);
    }
    flush();
    g.globalAlpha = 1;
  }

  // Helmet holograms: giant dotted projections of Thomas's (silver) and Guy-Man's (gold)
  // helmets behind the stage objects. They turn slowly, nod on the beat and glow with the
  // bass. The dots go straight into a pixel buffer that is added to the stage in one
  // drawImage: about 4x cheaper than thousands of rects on a software-rendered canvas.
  const LIGHT = (() => { const l = [-0.5, 0.6, 0.65], n = Math.hypot(...l); return l.map((x) => x / n); })();
  const HOLO = [['tb3', -1, [196, 226, 255]], ['gm08', 1, [255, 205, 96]]];
  function drawHelmets(f, S, narrow) {
    const H = Math.round(S * (narrow ? 0.28 : 0.36)); // on-screen helmet height
    const both = !!(helmets.tb3 && helmets.gm08);
    const bw = Math.ceil(H * (both ? 2.7 : 1.7)), bh = Math.ceil(H * 1.35);
    if (holo.w !== bw || holo.h !== bh) {
      holo.canvas ??= document.createElement('canvas');
      holo.canvas.width = holo.w = bw;
      holo.canvas.height = holo.h = bh;
      holo.ctx = holo.canvas.getContext('2d');
      holo.img = holo.ctx.createImageData(bw, bh);
      holo.px = new Uint32Array(holo.img.data.buffer);
    }
    const px = holo.px;
    px.fill(0);
    const gain = Math.min(1, (f.playing ? 0.5 : 0.36) + kick * 0.3) * 255;
    const pitch = reduce.matches ? 0 : -0.07 * kick; // nod forward on the kick
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (const [key, side, [r, gr, b]] of HOLO) {
      const cloud = helmets[key];
      if (!cloud) continue;
      const rgb = (b << 16) | (gr << 8) | r; // ImageData is RGBA in memory: little-endian ABGR
      const yaw = side * 0.28 + Math.sin(t * 0.3 + (side > 0 ? 1.4 : 0)) * 0.38;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw);
      const ox = bw / 2 + (both ? side * H * 0.62 : 0);
      const oy = bh * 0.55 + Math.sin(t * 0.9 + side) * S * 0.01;
      const P = cloud.pos, N = cloud.nor;
      for (let j = 0; j < cloud.count * 3; j += 3) {
        // yaw about y, then pitch about x; the camera looks from +z
        const x1 = P[j] * cyw + P[j + 2] * syw, z1 = -P[j] * syw + P[j + 2] * cyw;
        const y2 = P[j + 1] * cp - z1 * sp, z2 = P[j + 1] * sp + z1 * cp;
        const s = H * 3 / (3 - z2);
        const x = (ox + x1 * s) | 0, y = (oy - y2 * s) | 0;
        if (x < 0 || y < 0 || x >= bw - 1 || y >= bh - 1) continue;
        const nx = N[j] * cyw + N[j + 2] * syw, nz1 = -N[j] * syw + N[j + 2] * cyw;
        const ny = N[j + 1] * cp - nz1 * sp, nz = N[j + 1] * sp + nz1 * cp;
        const rim = 1 - Math.abs(nz);
        const lit = nz > 0 ? 0.28 + Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) * 0.5 + rim * rim * 0.45 : 0.1;
        const a = Math.min(255, lit * gain) | 0;
        const v = ((a << 24) | rgb) >>> 0;
        // 2x2 dot; where dots overlap the brighter one wins, so the back never covers the front
        const o = y * bw + x;
        if (px[o] >>> 24 < a) px[o] = v;
        if (px[o + 1] >>> 24 < a) px[o + 1] = v;
        if (px[o + bw] >>> 24 < a) px[o + bw] = v;
        if (px[o + bw + 1] >>> 24 < a) px[o + bw + 1] = v;
      }
    }
    holo.ctx.putImageData(holo.img, 0, 0);
    const zx = narrow ? w * 0.5 : (w * f.zone) / 2, zy = h * 0.3;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 1;
    g.drawImage(holo.canvas, Math.round(zx - bw / 2), Math.round(zy - bh * 0.55));
  }

  function drawStrands(cx, cy, S, m) {
    const R = S * 0.36, M = 64;
    g.globalCompositeOperation = 'lighter';
    [['#ffc94a', 0, 0.35], ['#3cf08f', 2.1, -0.28]].forEach(([color, ph, tiltX]) => {
      g.fillStyle = color;
      for (let j = 0; j < M; j++) {
        const th = (j / M) * TAU + t * 0.25 + ph;
        const p = rot([R * Math.cos(th), R * 0.16 * Math.sin(3 * th + t), R * Math.sin(th)], tiltX, 0);
        const s = 900 / (900 + p[2] * 1.2 / dpr);
        const trail = ((j / M - t * 0.08 + ph) % 1 + 1) % 1;
        g.globalAlpha = Math.pow(trail, 1.5) * s * 0.9;
        const r = (1.6 + 2.2 * s) * dpr * (1 + m.high * 0.8);
        g.beginPath();
        g.arc(cx + p[0] * s, cy + p[1] * s - S * 0.06, r, 0, TAU);
        g.fill();
      }
    });
    g.globalAlpha = 1;
  }

  function drawFloor(cx, H, S, m) {
    const fy = H * 0.97, rx = Math.min(w * 0.46, S * 0.95), ry = rx * 0.2;
    g.globalCompositeOperation = 'source-over';
    const disc = g.createRadialGradient(cx, fy, 0, cx, fy, rx);
    disc.addColorStop(0, '#16182a');
    disc.addColorStop(1, '#07080f');
    g.fillStyle = disc;
    g.beginPath(); g.ellipse(cx, fy, rx, ry, 0, 0, TAU); g.fill();

    g.globalCompositeOperation = 'lighter';
    g.setLineDash([22 * dpr, 14 * dpr]);
    [[0.95, '#ff3fb4', 1], [0.72, '#ff5cc8', -1], [0.5, '#35e0ff', 1], [0.3, '#ff3fb4', -1]].forEach(([k, c, dir]) => {
      g.strokeStyle = c;
      g.globalAlpha = 0.45 + kick * 0.3;
      g.lineWidth = 2 * dpr;
      g.lineDashOffset = -t * 40 * dir * dpr;
      g.beginPath(); g.ellipse(cx, fy, rx * k, ry * k, 0, 0, TAU); g.stroke();
    });
    g.setLineDash([]);

    // amber dot ring chasing the beat (unlit and lit dots each go in one path)
    const D = 48, dots = new Path2D(), litDots = new Path2D();
    for (let j = 0; j < D; j++) {
      const a = (j / D) * TAU + t * 0.15;
      const lit = m.beatIndex >= 0 && j % 16 === m.beatIndex % 16;
      const x = cx + Math.cos(a) * rx * 0.84, y = fy + Math.sin(a) * ry * 0.84, r = (lit ? 4 : 2.6) * dpr;
      const p = lit ? litDots : dots;
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, TAU);
    }
    g.fillStyle = '#ffb53d'; g.globalAlpha = 0.55; g.fill(dots);
    g.fillStyle = '#fff2b0'; g.globalAlpha = 1; g.fill(litDots);
    const cg = g.createRadialGradient(cx, fy - ry * 0.05, 0, cx, fy - ry * 0.05, rx * 0.2);
    cg.addColorStop(0, `rgba(255,255,255,${0.55 + m.bass * 0.45})`);
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cg;
    g.globalAlpha = 1;
    g.beginPath(); g.ellipse(cx, fy - ry * 0.05, rx * 0.2, ry * 0.25, 0, 0, TAU); g.fill();
  }

  // Unit-sphere polylines for the wire sphere (5 latitudes, 12 longitudes), built once.
  const SPHERE_LINES = (() => {
    const lines = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let k = 0; k <= 32; k++) {
        const a = (k / 32) * TAU, la = lat * Math.PI / 180;
        pts.push([Math.cos(la) * Math.cos(a), Math.sin(la), Math.cos(la) * Math.sin(a)]);
      }
      lines.push(pts);
    }
    for (let lo = 0; lo < 12; lo++) {
      const pts = [];
      for (let k = 0; k <= 24; k++) {
        const la = -Math.PI / 2 + (k / 24) * Math.PI, a = (lo / 12) * TAU;
        pts.push([Math.cos(la) * Math.cos(a), Math.sin(la), Math.cos(la) * Math.sin(a)]);
      }
      lines.push(pts);
    }
    return lines;
  })();

  function drawWireSphere(x, y, r, level) {
    const ay = t * (0.5 + level), ax = 0.35;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#3cf08f';
    g.lineWidth = (1.4 + level * 1.5) * dpr;
    // Front and back runs go in one path each: two strokes instead of ~450.
    const front = new Path2D(), back = new Path2D();
    for (const pts of SPHERE_LINES) {
      let prev = null, side = null;
      for (const p0 of pts) {
        const p = rot(p0, ax, ay);
        if (prev) {
          const path = (p[2] + prev[2]) / 2 < 0 ? front : back;
          if (path !== side) { path.moveTo(x + prev[0] * r, y + prev[1] * r); side = path; }
          path.lineTo(x + p[0] * r, y + p[1] * r);
        }
        prev = p;
      }
    }
    g.globalAlpha = 0.28; g.stroke(back);
    g.globalAlpha = 0.95; g.stroke(front);
    g.globalAlpha = 1;
  }

  function drawDisco(x, y, r, level) {
    const ay = t * (0.35 + level * 0.6), ax = -0.25;
    g.globalCompositeOperation = 'source-over';
    const halo = g.createRadialGradient(x, y, r * 0.8, x, y, r * 1.6);
    halo.addColorStop(0, `rgba(255, 63, 200, ${0.35 + level * 0.4})`);
    halo.addColorStop(1, 'rgba(255, 63, 200, 0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(x, y, r * 1.6, 0, TAU); g.fill();

    const LAT = 9, LON = 16;
    const sp = (i, j) => {
      const la = -Math.PI / 2 + (i / LAT) * Math.PI, a = (j / LON) * TAU;
      return rot([Math.cos(la) * Math.cos(a), Math.sin(la), Math.cos(la) * Math.sin(a)], ax, ay);
    };
    g.lineWidth = 1.6 * dpr;
    g.strokeStyle = '#ff4fd8';
    const edges = [new Path2D(), new Path2D()]; // tile outlines, grazing and facing: two strokes
    for (let i = 0; i < LAT; i++) {
      for (let j = 0; j < LON; j++) {
        const c = rot((() => {
          const la = -Math.PI / 2 + ((i + 0.5) / LAT) * Math.PI, a = ((j + 0.5) / LON) * TAU;
          return [Math.cos(la) * Math.cos(a), Math.sin(la), Math.cos(la) * Math.sin(a)];
        })(), ax, ay);
        if (c[2] > 0.05) continue; // back face
        const q = [sp(i, j), sp(i, j + 1), sp(i + 1, j + 1), sp(i + 1, j)];
        const facing = -c[2];
        const sparkle = ((i * 7 + j * 13 + Math.floor(t * 6)) % 23 === 0) ? 0.5 + level : 0;
        g.fillStyle = `rgba(${40 + facing * 60 + sparkle * 200}, ${10 + sparkle * 180}, ${80 + facing * 90 + sparkle * 160}, 1)`;
        g.beginPath();
        q.forEach((p, k) => (k ? g.lineTo : g.moveTo).call(g, x + p[0] * r, y + p[1] * r));
        g.closePath();
        g.fill();
        const e = edges[facing > 0.5 ? 1 : 0];
        q.forEach((p, k) => (k ? e.lineTo : e.moveTo).call(e, x + p[0] * r, y + p[1] * r));
        e.closePath();
      }
    }
    g.globalAlpha = 0.7; g.stroke(edges[0]);
    g.globalAlpha = 0.95; g.stroke(edges[1]);
    g.globalAlpha = 1;
    g.lineWidth = 3 * dpr;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
  }

  const CUBE_V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const CUBE_F = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7]];
  function drawCube(x, y, r, level) {
    const ax = 0.5 + Math.sin(t * 0.3) * 0.3, ay = t * (0.4 + level * 0.5);
    const v = CUBE_V.map((p) => rot(p, ax, ay)).map(([px, py, pz]) => {
      const s = 1 / (1 + pz * 0.12);
      return [x + px * r * s, y + py * r * s, pz];
    });
    g.globalCompositeOperation = 'source-over';
    const faces = CUBE_F.map((f) => ({ f, z: f.reduce((a, i) => a + v[i][2], 0) / 4 })).sort((a, b) => b.z - a.z);
    for (const { f, z } of faces) {
      const [a, b, , d] = f.map((i) => v[i]); // painter's order: far faces get covered
      const shade = Math.max(0.35, Math.min(1, 0.75 - z * 0.35));
      g.fillStyle = `rgb(${Math.round(225 * shade)}, ${Math.round(160 * shade)}, ${Math.round(40 * shade)})`;
      g.strokeStyle = '#4a2f05';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      f.forEach((i, k) => (k ? g.lineTo : g.moveTo).call(g, v[i][0], v[i][1]));
      g.closePath();
      g.fill();
      g.stroke();
      // speaker cone, drawn in the face's own (affine) coordinates
      g.save();
      g.setTransform(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1], a[0], a[1]);
      g.lineWidth = 0.05;
      g.strokeStyle = `rgba(70, 40, 5, ${shade})`;
      g.beginPath(); g.arc(0.5, 0.5, 0.38, 0, TAU); g.stroke();
      g.fillStyle = `rgba(40, 24, 3, ${shade})`;
      g.beginPath(); g.arc(0.5, 0.5, 0.28 + level * 0.04, 0, TAU); g.fill();
      g.strokeStyle = `rgba(255, 210, 110, ${shade})`;
      g.lineWidth = 0.035;
      g.beginPath(); g.arc(0.5, 0.5, 0.18 + level * 0.05, 0, TAU); g.stroke();
      g.fillStyle = `rgba(230, 170, 50, ${shade})`;
      g.beginPath(); g.arc(0.5, 0.5, 0.08 + level * 0.04, 0, TAU); g.fill();
      g.restore();
    }
  }

  requestAnimationFrame(frame);
  return {
    setHelmets(clouds) { helmets = clouds && (clouds.tb3 || clouds.gm08) ? clouds : null; },
  };
}
