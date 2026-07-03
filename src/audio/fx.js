// @ts-check
/**
 * Hold-to-activate "breakdown" FX chain, spliced between the fx bus and the
 * master gain:  fxIn → lowpass filter → duck gain (+ LFO) → master.
 *
 * While held: the filter sweeps down with rising resonance and a rhythmic LFO
 * ducks the level for a pumping breakdown feel. On release everything sweeps
 * back over ~300ms. All parameter moves are ramped (setTargetAtTime).
 */

const FILTER_OPEN = 18000;
const FILTER_CLOSED = 240;
const LFO_HZ = 4; // 8th notes at 120 BPM
const ATTACK_TC = 0.07; // fast enough to feel instant on press
const RELEASE_TC = 0.09; // ~95% recovered around 300ms

/**
 * @param {import('./engine.js').Engine} engine
 */
export function createFx(engine) {
  const { ctx, fxIn, master } = engine;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = FILTER_OPEN;
  filter.Q.value = 0.8;

  const duck = ctx.createGain();
  duck.gain.value = 1;

  // Splice into the master chain (engine wired fxIn → master as pass-through).
  fxIn.disconnect();
  fxIn.connect(filter);
  filter.connect(duck);
  duck.connect(master);

  // Rhythmic duck: LFO output sums into duck.gain around its base value.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = LFO_HZ;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth);
  lfoDepth.connect(duck.gain);
  lfo.start();

  let held = false;

  /** @param {boolean} next */
  function setHeld(next) {
    if (next === held) return;
    held = next;
    const t = ctx.currentTime;
    for (const p of [filter.frequency, filter.Q, duck.gain, lfoDepth.gain]) {
      p.cancelScheduledValues(t);
    }
    if (held) {
      filter.frequency.setTargetAtTime(FILTER_CLOSED, t, ATTACK_TC);
      filter.Q.setTargetAtTime(7, t, ATTACK_TC);
      duck.gain.setTargetAtTime(0.68, t, ATTACK_TC);
      lfoDepth.gain.setTargetAtTime(0.3, t, ATTACK_TC);
    } else {
      filter.frequency.setTargetAtTime(FILTER_OPEN, t, RELEASE_TC);
      filter.Q.setTargetAtTime(0.8, t, RELEASE_TC);
      duck.gain.setTargetAtTime(1, t, RELEASE_TC);
      lfoDepth.gain.setTargetAtTime(0, t, RELEASE_TC);
    }
  }

  return {
    setHeld,
    get held() {
      return held;
    },
  };
}
