// @ts-check
/**
 * Fullscreen 2D-canvas scene: a neon tunnel of concentric rings receding to a
 * vanishing point. In idle mode it breathes on a slow internal oscillator;
 * once audio is wired (reactive milestone) ring energy follows the analyser.
 */

import { onTick } from '../ticker.js';

const RING_COUNT = 26;

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

  /** Blend deck A (teal, hue 160) and deck B (violet, hue 250) hues. */
  function hue() {
    return 160 + (250 - 160) * palette;
  }

  function drawStatic() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    g.addColorStop(0, `hsl(${hue()}, 60%, 10%)`);
    g.addColorStop(1, '#05060a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
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
    beatPulse = Math.max(0, beatPulse - dt * 2.4);

    const speed = 0.16 + low * 0.35;

    for (let i = 0; i < RING_COUNT; i++) {
      // Rings travel outward from the vanishing point; t in (0, 1].
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
    /** Kick from the beat detector. */
    onBeat() {
      beatPulse = 1;
    },
    /** @param {number} x crossfader position 0..1 */
    setPalette(x) {
      palette = Math.min(Math.max(x, 0), 1);
    },
  };
}
