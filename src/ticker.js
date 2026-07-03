// @ts-check
/**
 * Single shared requestAnimationFrame loop.
 * The visualizer, waveform playheads, and anything else that animates
 * registers a callback here so the app only ever runs one rAF loop.
 */

/** @type {Set<(dt: number, now: number) => void>} */
const callbacks = new Set();
let rafId = 0;
let lastNow = 0;
let running = false;
let suspended = false;

function frame(now) {
  rafId = 0;
  if (!running || suspended) return;
  const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.1) : 0.016;
  lastNow = now;
  for (const cb of callbacks) cb(dt, now / 1000);
  rafId = requestAnimationFrame(frame);
}

function ensureRunning() {
  running = callbacks.size > 0;
  if (running && !suspended && !rafId) {
    lastNow = 0;
    rafId = requestAnimationFrame(frame);
  }
}

/**
 * Register a per-frame callback. Returns an unsubscribe function.
 * @param {(dt: number, now: number) => void} cb
 */
export function onTick(cb) {
  callbacks.add(cb);
  ensureRunning();
  return () => {
    callbacks.delete(cb);
    if (callbacks.size === 0) running = false;
  };
}

/**
 * Suspend or resume the whole loop (e.g. hidden tab with no audio playing).
 * @param {boolean} value
 */
export function setSuspended(value) {
  suspended = value;
  if (!suspended) ensureRunning();
}
