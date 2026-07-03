// @ts-check
/**
 * Fullscreen 2D-canvas scene behind the HUD:
 *   - neon tunnel: concentric rings receding to a vanishing point, breathing
 *     with low-band energy and beat pulses
 *   - particle streams: pooled dots (hard cap, zero per-frame allocation)
 *     orbiting outward, speed/brightness following mid/high bands
 *   - floating props: original wireframe shapes (icosahedron, cube,
 *     octahedron) in 2D projection, scale-bouncing on beats
 *   - palette blends Deck A hue ↔ Deck B hue with the crossfader
 * Reduced motion swaps everything for a static gradient with a slow pulse.
 */

import { onTick } from '../ticker.js';

const RING_COUNT = 26;
const PARTICLE_COUNT = 300; // hard cap; objects are pooled below
const HUE_A = 160;
const HUE_B = 250;

// ---------- wireframe geometry (unit-ish scale, precomputed) ----------

const PHI = (1 + Math.sqrt(5)) / 2;

/** @type {{ verts: number[][], edges: number[][] }} */
const ICOSAHEDRON = (() => {
  const v = [];
  for (const s of [-1, 1]) {
    for (const t of [-PHI, PHI]) {
      v.push([0, s, t], [s, t, 0], [t, 0, s]);
    }
  }
  const norm = Math.hypot(1, PHI);
  const verts = v.map((p) => p.map((c) => c / norm));
  const edges = [];
  // connect every pair at the icosahedron's edge length (2/norm)
  const edgeLen = 2 / norm;
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const d = Math.hypot(
        verts[i][0] - verts[j][0],
        verts[i][1] - verts[j][1],
        verts[i][2] - verts[j][2]
      );
      if (Math.abs(d - edgeLen) < 1e-6) edges.push([i, j]);
    }
  }
  return { verts, edges };
})();

const CUBE = {
  verts: [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map((p) => p.map((c) => c * 0.72)),
  edges: [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ],
};

const OCTAHEDRON = {
  verts: [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ],
  edges: [
    [0, 2], [0, 3], [0, 4], [0, 5],
    [1, 2], [1, 3], [1, 4], [1, 5],
    [2, 4], [2, 5], [3, 4], [3, 5],
  ],
};

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createVisualizer(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false }));

  let w = 0;
  let h = 0;
  let dpr = 1;
  let time = 0;
  let unsubscribe = /** @type {(() => void) | null} */ (null);

  // Audio-reactive inputs; idle defaults until the engine feeds real values.
  const levels = { low: 0, mid: 0, high: 0 };
  let beatPulse = 0;
  let palette = 0.5; // 0 = deck A hue, 1 = deck B hue

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- particle pool (allocated once) ----------
  const particles = new Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles[i] = {
      angle: Math.random() * Math.PI * 2,
      t: Math.random(), // 0 = vanishing point, 1 = screen edge
      speed: 0.05 + Math.random() * 0.1,
      size: 0.8 + Math.random() * 1.8,
      swirl: (Math.random() - 0.5) * 1.6,
    };
  }

  // ---------- floating props ----------
  const props = [
    { geo: ICOSAHEDRON, x: -0.3, y: -0.22, size: 0.085, rot: [0.21, 0.33, 0.12], phase: 0, bounce: 0 },
    { geo: CUBE, x: 0.34, y: 0.24, size: 0.07, rot: [0.17, -0.26, 0.31], phase: 2.1, bounce: 0 },
    { geo: OCTAHEDRON, x: 0.05, y: -0.34, size: 0.06, rot: [-0.28, 0.19, 0.23], phase: 4.2, bounce: 0 },
  ];
  const projected = /** @type {number[][]} */ (Array.from({ length: 12 }, () => [0, 0]));

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (reducedMotion.matches) drawStatic();
  }
  window.addEventListener('resize', resize);
  resize();

  /** Blend deck A and deck B hues per crossfader position. */
  function hue() {
    return HUE_A + (HUE_B - HUE_A) * palette;
  }

  function drawStatic() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    g.addColorStop(0, `hsl(${hue()}, 60%, 10%)`);
    g.addColorStop(1, '#05060a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** @param {typeof props[0]} prop @param {number} baseHue */
  function drawProp(prop, baseHue) {
    const { verts, edges } = prop.geo;
    const t = time + prop.phase;
    const rx = t * prop.rot[0];
    const ry = t * prop.rot[1];
    const rz = t * prop.rot[2];
    const cosX = Math.cos(rx), sinX = Math.sin(rx);
    const cosY = Math.cos(ry), sinY = Math.sin(ry);
    const cosZ = Math.cos(rz), sinZ = Math.sin(rz);

    const bob = Math.sin(t * 0.6) * 0.02;
    const cx = w * (0.5 + prop.x) ;
    const cy = h * (0.5 + prop.y + bob);
    const scale = Math.min(w, h) * prop.size * (1 + prop.bounce * 0.3);

    for (let i = 0; i < verts.length; i++) {
      let [x, y, z] = verts[i];
      // rotate X, then Y, then Z
      let y1 = y * cosX - z * sinX;
      let z1 = y * sinX + z * cosX;
      let x2 = x * cosY + z1 * sinY;
      let z2 = -x * sinY + z1 * cosY;
      const x3 = x2 * cosZ - y1 * sinZ;
      const y3 = x2 * sinZ + y1 * cosZ;
      const persp = 3 / (3 + z2);
      projected[i][0] = cx + x3 * scale * persp;
      projected[i][1] = cy + y3 * scale * persp;
    }

    ctx.strokeStyle = `hsla(${baseHue + 18}, 85%, 68%, ${0.18 + levels.high * 0.35 + prop.bounce * 0.3})`;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (const [a, b] of edges) {
      ctx.moveTo(projected[a][0], projected[a][1]);
      ctx.lineTo(projected[b][0], projected[b][1]);
    }
    ctx.stroke();
  }

  /** @param {number} dt */
  function draw(dt) {
    time += dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (reducedMotion.matches) {
      // Gentle static gradient with a very slow pulse only.
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.4);
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, `hsl(${hue()}, 55%, ${8 + pulse * 3}%)`);
      g.addColorStop(1, '#05060a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Fade instead of clear for subtle trails.
    ctx.fillStyle = 'rgba(5, 6, 10, 0.5)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(w, h) * 0.62;
    const baseHue = hue();

    const idle = 0.14 + 0.05 * Math.sin(time * 0.9);
    const low = Math.max(levels.low, idle);
    const mid = Math.max(levels.mid, idle * 0.5);
    const high = Math.max(levels.high, idle * 0.35);
    beatPulse = Math.max(0, beatPulse - dt * 2.4);

    // ----- tunnel rings -----
    const speed = 0.16 + low * 0.35;
    for (let i = 0; i < RING_COUNT; i++) {
      const t = ((i / RING_COUNT + time * speed) % 1 + 1) % 1;
      const depth = t * t; // ease outward — perspective feel
      const r = 8 + depth * maxR;
      const jitter = 1 + (low * 0.14 + beatPulse * 0.1) * Math.sin(time * 5 + i * 1.7);
      const alpha = Math.min(0.7, (0.12 + low * 0.5 + beatPulse * 0.35) * (0.25 + depth));
      const light = 45 + depth * 20 + beatPulse * 15;

      ctx.beginPath();
      ctx.arc(cx, cy, r * jitter, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${baseHue + i * 1.4}, 90%, ${light}%, ${alpha})`;
      ctx.lineWidth = 1 + depth * 2.2 + beatPulse * 1.2;
      ctx.stroke();
    }

    // ----- particle streams -----
    const pSpeed = 0.35 + mid * 1.4;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particles[i];
      p.t += dt * p.speed * pSpeed;
      if (p.t >= 1) {
        p.t -= 1;
        p.angle = Math.random() * Math.PI * 2;
      }
      const depth = p.t * p.t;
      const a = p.angle + time * 0.12 * p.swirl + depth * p.swirl;
      const r = 10 + depth * maxR;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.96;
      const alpha = (0.1 + high * 0.6 + beatPulse * 0.2) * (0.2 + depth * 0.8);
      const size = p.size * (0.5 + depth * 1.6);
      ctx.fillStyle = `hsla(${baseHue + 24}, 95%, ${62 + high * 20}%, ${Math.min(alpha, 0.85)})`;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }

    // ----- floating props -----
    for (const prop of props) {
      prop.bounce = Math.max(0, prop.bounce - dt * 2.8);
      drawProp(prop, baseHue);
    }

    // Vanishing-point core glow.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 90 + low * 120);
    core.addColorStop(0, `hsla(${baseHue}, 90%, 62%, ${0.16 + low * 0.25 + beatPulse * 0.2})`);
    core.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    ctx.fillStyle = core;
    ctx.fillRect(cx - 220, cy - 220, 440, 440);
  }

  return {
    canvas,
    start() {
      if (!unsubscribe) unsubscribe = onTick((dt) => draw(dt));
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      drawStatic();
    },
    /** @param {{ low?: number, mid?: number, high?: number }} next 0..1 each */
    setLevels(next) {
      if (next.low !== undefined) levels.low = next.low;
      if (next.mid !== undefined) levels.mid = next.mid;
      if (next.high !== undefined) levels.high = next.high;
    },
    /** Kick from the beat detector: rings flash, props bounce. */
    onBeat() {
      beatPulse = 1;
      for (const prop of props) prop.bounce = 1;
    },
    /** @param {number} x crossfader position 0..1 */
    setPalette(x) {
      palette = Math.min(Math.max(x, 0), 1);
    },
  };
}
