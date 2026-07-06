// @ts-check
/**
 * "Glue" mastering chain so clashing stems sit together:
 *
 *   master gain → glue compressor (gentle: ratio 2.5, soft knee, slow-ish
 *   attack) → limiter (high ratio, fast attack — brickwall-ish) → analyser
 *
 * Spliced between the engine's master gain and analyser. Bypassable via a
 * master toggle (A/B): bypass routes master → analyser directly. All routing
 * changes happen through a tiny crossfade-free reconnect — the nodes carry no
 * state that clicks on rewire at these gain levels.
 */

/**
 * @param {import('./engine.js').Engine} engine
 */
export function createMastering(engine) {
  const { ctx, master, analyser } = engine;

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -18;
  glue.knee.value = 12; // soft knee
  glue.ratio.value = 2.5;
  glue.attack.value = 0.03; // slow-ish: transients breathe, sustains glue
  glue.release.value = 0.25;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  // Gentle makeup so the glued signal A/Bs at comparable loudness.
  const makeup = ctx.createGain();
  makeup.gain.value = 1.12;

  glue.connect(limiter);
  limiter.connect(makeup);

  let enabled = false;

  /** @param {boolean} next */
  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    master.disconnect();
    makeup.disconnect();
    if (enabled) {
      master.connect(glue);
      makeup.connect(analyser);
    } else {
      master.connect(analyser);
    }
  }

  // On by default — the whole point is 4 full positions not clipping.
  setEnabled(true);

  return {
    get enabled() {
      return enabled;
    },
    setEnabled,
    /** Current limiter gain reduction in dB (for meters/debug). */
    get reduction() {
      return glue.reduction + limiter.reduction;
    },
  };
}
