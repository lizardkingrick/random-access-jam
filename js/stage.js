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

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw === w && ch === h) return;
    canvas.width = w = cw;
    canvas.height = h = ch;
    arcGrad = g.createLinearGradient(0, 0, w, 0);
    [['#ffc94a', 0], ['#ffb347', 0.2], ['#3ce08c', 0.42], ['#2fd3c6', 0.58], ['#4c7dff', 0.78], ['#b65cff', 1]]
      .forEach(([c, o]) => arcGrad.addColorStop(o, c));
  }

  function frame(now) {
    requestAnimationFrame(frame);
    resize();
    const f = getFrame();
    const m = f.meters;
    const speed = reduce.matches ? 0.25 : 1;
    const dt = Math.min(0.05, (now - last) / 1000) * speed;
    last = now;
    t += dt;
    kick = Math.max(kick * Math.pow(0.02, dt), f.playing && m.beat < 0.12 ? 1 : 0, m.bass);
    ringPhase += dt * (f.playing ? f.bpm / 60 / 4 : 0.06) * (1 + f.fx * 1.5);

    const narrow = w / dpr < 900;
    const fx = narrow ? 0.5 : 0.4;
    const cx = w * fx, cy = h * 0.6, S = Math.min(w, h);

    // backdrop
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = '#020309';
    g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(cx, h * 0.45, 0, cx, h * 0.45, S * 0.9);
    glow.addColorStop(0, `rgba(40, 30, 110, ${0.35 + kick * 0.15})`);
    glow.addColorStop(1, 'rgba(2, 3, 9, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    drawDome(cx, cy, S);
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
    if (pres.texture > 0.01) drawCube(pos.texture[0], pos.texture[1] + bob(0), size('texture', 0.07), lvl.texture);
    if (pres.groove > 0.01) drawWireSphere(pos.groove[0], pos.groove[1] + bob(2), size('groove', 0.085), lvl.groove);
    if (pres.lead > 0.01) drawDisco(pos.lead[0], pos.lead[1] + bob(4), size('lead', 0.075), lvl.lead);

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
    const tilt = Math.sin(t * 0.13) * 0.06;
    for (let k = N; k >= 0; k--) {
      const r = base * Math.pow(growth, k + frac);
      const fadeIn = Math.min(1, (r - base) / (base * 2.5));
      g.globalAlpha = fadeIn * (0.32 + kick * 0.25);
      g.lineWidth = (0.6 + r * 0.0035) * dpr;
      g.beginPath();
      g.ellipse(cx, cy, r * 1.35, r * 0.95, tilt, Math.PI * 1.0, Math.PI * 2.0);
      g.stroke();
    }
    g.globalAlpha = 1;
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

    // amber dot ring chasing the beat
    const D = 48;
    for (let j = 0; j < D; j++) {
      const a = (j / D) * TAU + t * 0.15;
      const lit = m.beatIndex >= 0 && j % 16 === m.beatIndex % 16;
      g.fillStyle = lit ? '#fff2b0' : '#ffb53d';
      g.globalAlpha = lit ? 1 : 0.55;
      g.beginPath();
      g.arc(cx + Math.cos(a) * rx * 0.84, fy + Math.sin(a) * ry * 0.84, (lit ? 4 : 2.6) * dpr, 0, TAU);
      g.fill();
    }
    const cg = g.createRadialGradient(cx, fy - ry * 0.05, 0, cx, fy - ry * 0.05, rx * 0.2);
    cg.addColorStop(0, `rgba(255,255,255,${0.55 + m.bass * 0.45})`);
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cg;
    g.globalAlpha = 1;
    g.beginPath(); g.ellipse(cx, fy - ry * 0.05, rx * 0.2, ry * 0.25, 0, 0, TAU); g.fill();
  }

  function drawWireSphere(x, y, r, level) {
    const ay = t * (0.5 + level), ax = 0.35;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#3cf08f';
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
    for (const pts of lines) {
      let prev = null;
      for (const p0 of pts) {
        const p = rot(p0, ax, ay);
        if (prev) {
          g.globalAlpha = (p[2] + prev[2]) / 2 < 0 ? 0.95 : 0.28;
          g.lineWidth = (1.4 + level * 1.5) * dpr;
          g.beginPath();
          g.moveTo(x + prev[0] * r, y + prev[1] * r);
          g.lineTo(x + p[0] * r, y + p[1] * r);
          g.stroke();
        }
        prev = p;
      }
    }
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
        g.globalAlpha = 0.6 + facing * 0.4;
        g.stroke();
        g.globalAlpha = 1;
      }
    }
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
}
