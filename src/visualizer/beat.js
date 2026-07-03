// @ts-check
/**
 * Low-band energy beat detector: flags a beat when the current low-band level
 * pops above its recent running average, with a refractory interval so one
 * kick can't double-trigger.
 */

const HISTORY = 45; // ~0.75s of frames at 60fps

/**
 * @param {{ minInterval?: number, sensitivity?: number, floor?: number }} [opts]
 */
export function createBeatDetector(opts = {}) {
  const { minInterval = 0.24, sensitivity = 1.4, floor = 0.1 } = opts;
  const history = new Float32Array(HISTORY);
  let idx = 0;
  let filled = 0;
  let sum = 0;
  let sinceLast = 10;

  return {
    /**
     * Feed one frame of low-band energy (0..1). Returns true on a beat.
     * @param {number} low @param {number} dt seconds since last frame
     */
    update(low, dt) {
      sinceLast += dt;
      const avg = filled > 0 ? sum / filled : 0;

      sum += low - history[idx];
      history[idx] = low;
      idx = (idx + 1) % HISTORY;
      if (filled < HISTORY) filled++;

      if (filled > 15 && low > floor && low > avg * sensitivity && sinceLast >= minInterval) {
        sinceLast = 0;
        return true;
      }
      return false;
    },
    reset() {
      history.fill(0);
      idx = 0;
      filled = 0;
      sum = 0;
      sinceLast = 10;
    },
  };
}
