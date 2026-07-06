// @ts-check
/**
 * AudioContext owner and master graph.
 *
 *   jam rack (4 positions, summed) → fx input → master → analyser → destination
 *
 * The fx input node is a pass-through gain; the FX chain (fx.js) splices
 * itself between `fxIn` and `master`, and the mastering chain (mastering.js)
 * splices between `master` and `analyser`.
 */

export function createEngine() {
  const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not supported in this browser.');

  /** @type {AudioContext} */
  const ctx = new AC({ latencyHint: 'interactive' });

  const master = ctx.createGain();
  master.gain.value = 0.9;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;

  const fxIn = ctx.createGain();
  fxIn.connect(master);
  master.connect(analyser);
  analyser.connect(ctx.destination);

  return {
    ctx,
    master,
    analyser,
    fxIn,
    get running() {
      return ctx.state === 'running';
    },
    /** Resume the context (must be called from a user gesture at least once). */
    async resume() {
      if (ctx.state !== 'running') await ctx.resume();
    },
  };
}

/** @typedef {ReturnType<typeof createEngine>} Engine */
