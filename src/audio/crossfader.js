// @ts-check
/**
 * Equal-power crossfade between two gain nodes:
 *   gainA = cos(x·π/2), gainB = cos((1−x)·π/2), x ∈ [0, 1]
 * Values are ramped, never snapped, to avoid clicks.
 *
 * NOTE: retired from the core signal path — the jam is a 4-position rack, not
 * a two-deck crossfade. Kept unwired as an optional later feature (e.g. fading
 * between two whole rack states).
 */

const RAMP_TC = 0.016;

/**
 * @param {AudioContext} ctx
 * @param {GainNode} gainNodeA
 * @param {GainNode} gainNodeB
 */
export function createCrossfader(ctx, gainNodeA, gainNodeB) {
  let x = 0.5;

  /** @param {number} next 0 = full A, 1 = full B */
  function set(next) {
    x = Math.min(Math.max(next, 0), 1);
    const t = ctx.currentTime;
    const gainA = Math.cos((x * Math.PI) / 2);
    const gainB = Math.cos(((1 - x) * Math.PI) / 2);
    gainNodeA.gain.cancelScheduledValues(t);
    gainNodeB.gain.cancelScheduledValues(t);
    gainNodeA.gain.setTargetAtTime(gainA, t, RAMP_TC);
    gainNodeB.gain.setTargetAtTime(gainB, t, RAMP_TC);
  }

  set(x);

  return {
    set,
    get value() {
      return x;
    },
  };
}
