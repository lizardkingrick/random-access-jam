/* Lookahead true-peak limiter (AudioWorklet), the last stage of the mix and the export.
   Peaks are sensed on 4x-oversampled audio, so the peaks between samples that a DAC or a lossy
   encoder will produce count too. The gain each peak needs is held for the lookahead window,
   released over ~120 ms, and smoothed by a moving average one window long, so it is already
   down when the delayed peak arrives: the output never goes over the ceiling, and quiet
   passages pass untouched instead of being squeezed all the time like a compressor does.
   Stereo-linked, so the image doesn't shift. Latency is exactly `lookahead` samples. */

const PHASES = 4, HALF = 6; // 4x interpolation, 12 taps per phase (the interpolator delays HALF samples)

// Windowed-sinc taps for the three in-between points of each sample interval.
const TAPS = [1, 2, 3].map((p) => {
  const f = p / PHASES, taps = new Float64Array(2 * HALF);
  for (let k = 0; k < 2 * HALF; k++) {
    const t = f - (k - HALF + 1); // distance from the point to the k-th sample in the window
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    taps[k] = sinc * (0.5 + 0.5 * Math.cos(Math.PI * t / HALF));
  }
  const sum = taps.reduce((a, v) => a + v, 0);
  return taps.map((v) => v / sum); // unity gain at DC
});

// Nothing on the audio thread allocates per block: garbage collected there can overrun a quantum
// on a slow phone, which is heard as a dropout in the whole mix.
const SILENT = new Float32Array(128); // stands in for an unconnected input

class TruePeakLimiter extends AudioWorkletProcessor {
  constructor({ processorOptions: o = {} } = {}) {
    super();
    this.latency = Math.max(HALF + 1, Math.round(o.lookahead ?? 0.005 * sampleRate));
    this.win = this.latency - HALF + 1; // hold and smoothing window, in samples
    // Aimed 0.05 dB under the ceiling: the short interpolator reads a peak up to ~0.03 dB lower
    // than a full-length true-peak meter does (measured).
    this.ceiling = Math.pow(10, ((o.ceiling ?? -1) - 0.05) / 20);
    this.decay = Math.exp(-1 / ((o.release ?? 0.12) * sampleRate));
    this.hist = [new Float64Array(4 * HALF), new Float64Array(4 * HALF)]; // last 2*HALF inputs, stored twice
    this.hpos = 0;
    this.qPrev = 0;
    this.delay = [new Float32Array(this.latency), new Float32Array(this.latency)];
    this.dpos = 0;
    // Sliding minimum of the required gain (a monotonic queue) and the smoothing average.
    this.qVal = new Float64Array(this.win + 1); this.qIdx = new Float64Array(this.win + 1);
    this.qHead = 0; this.qLen = 0; this.n = 0;
    this.ring = new Float64Array(this.win).fill(1); this.rpos = 0; this.sum = this.win;
    this.rel = 1;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const x0 = inp[0] || SILENT, x1 = inp[1] || x0, y0 = out[0], y1 = out[1] || out[0];
    const { hist, delay, ceiling, decay, win, latency, qVal, qIdx, ring } = this;
    const span = 2 * HALF, cap = win + 1;
    for (let i = 0; i < n; i++) {
      const a = x0[i] || 0, b = x1[i] || 0;
      // Interpolator input: the newest sample sits at hpos + span - 1 .. read contiguously.
      const w = this.hpos;
      hist[0][w] = hist[0][w + span] = a;
      hist[1][w] = hist[1][w + span] = b;
      this.hpos = (w + 1) % span;
      const base = this.hpos; // oldest of the last `span` samples
      // Peak of the interval ending at the window's centre sample, both channels.
      let q = Math.max(Math.abs(hist[0][base + HALF]), Math.abs(hist[1][base + HALF]));
      for (let p = 0; p < 3; p++) {
        const t = TAPS[p];
        let l = 0, r = 0;
        for (let k = 0; k < span; k++) { l += t[k] * hist[0][base + k]; r += t[k] * hist[1][base + k]; }
        q = Math.max(q, Math.abs(l), Math.abs(r));
      }
      // A sample owns the intervals on both sides of it; the gain it needs to stay under the ceiling.
      const peak = Math.max(q, this.qPrev);
      this.qPrev = q;
      const need = peak > ceiling ? ceiling / peak : 1;
      // Hold: the lowest gain needed anywhere in the window.
      const m = this.n++;
      while (this.qLen && qVal[(this.qHead + this.qLen - 1) % cap] >= need) this.qLen--;
      qVal[(this.qHead + this.qLen) % cap] = need; qIdx[(this.qHead + this.qLen) % cap] = m; this.qLen++;
      while (qIdx[this.qHead] <= m - win) { this.qHead = (this.qHead + 1) % cap; this.qLen--; }
      const held = qVal[this.qHead];
      // Down at once, back up slowly.
      this.rel = held < this.rel ? held : held + (this.rel - held) * decay;
      // The moving average starts each reduction a full window early, so it lands smoothly in time.
      this.sum += this.rel - ring[this.rpos];
      ring[this.rpos] = this.rel;
      this.rpos = (this.rpos + 1) % win;
      if (this.rpos === 0) { // drop rounding drift once a window
        let sum = 0;
        for (let k = 0; k < win; k++) sum += ring[k];
        this.sum = sum;
      }
      const g = Math.min(1, this.sum / win);
      const d = this.dpos;
      y0[i] = delay[0][d] * g;
      y1[i] = delay[1][d] * g;
      delay[0][d] = a; delay[1][d] = b;
      this.dpos = (d + 1) % latency;
    }
    return true;
  }
}

registerProcessor('true-peak-limiter', TruePeakLimiter);
