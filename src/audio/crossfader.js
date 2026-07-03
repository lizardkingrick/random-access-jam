// @ts-check
/**
 * Equal-power crossfade between the two deck crossfader gains:
 *   gainA = cos(x·π/2), gainB = cos((1−x)·π/2), x ∈ [0, 1]
 * Values are ramped, never snapped, to avoid clicks.
 */

const RAMP_TC = 0.016;

/**
 * @param {import('./engine.js').Engine} engine
 */
export function createCrossfader(engine) {
  const { ctx, xfA, xfB } = engine;
  let x = 0.5;

  /** @param {number} next 0 = full A, 1 = full B */
  function set(next) {
    x = Math.min(Math.max(next, 0), 1);
    const t = ctx.currentTime;
    const gainA = Math.cos((x * Math.PI) / 2);
    const gainB = Math.cos(((1 - x) * Math.PI) / 2);
    xfA.gain.cancelScheduledValues(t);
    xfB.gain.cancelScheduledValues(t);
    xfA.gain.setTargetAtTime(gainA, t, RAMP_TC);
    xfB.gain.setTargetAtTime(gainB, t, RAMP_TC);
  }

  set(x);

  return {
    set,
    get value() {
      return x;
    },
    /** The deck the listener is NOT currently hearing (for queue-next flows). */
    get inactiveDeck() {
      return x <= 0.5 ? 'b' : 'a';
    },
  };
}
