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

// The interpolation, folded: phases 1 and 3 are each other's mirror image and phase 2 is its own,
// so with the window folded about its centre (sums and differences of mirrored samples) the three
// points take 18 multiplies per channel instead of 36, the outer two as their sum (FOLD) and
// difference (TWIST). And no point can be louder than the loudest sample in its window times BOUND
// (its taps' summed size), so while every sample in the window is under ceiling / BOUND no
// interpolation is needed at all, and the gain comes out exactly the same. Measured on three-layer
// mixes: 6-7% of samples still need it, and the output is bit-identical in 2.6-2.9x less time.
const FOLD = new Float64Array(HALF), TWIST = new Float64Array(HALF), MID = new Float64Array(HALF);
for (let k = 0; k < HALF; k++) {
  FOLD[k] = TAPS[0][k] + TAPS[0][2 * HALF - 1 - k];
  TWIST[k] = TAPS[0][k] - TAPS[0][2 * HALF - 1 - k];
  MID[k] = TAPS[1][k];
}
const BOUND = Math.max(...TAPS.map((t) => t.reduce((a, v) => a + Math.abs(v), 0)));

class TruePeakLimiter extends AudioWorkletProcessor {
  constructor({ processorOptions: o = {} } = {}) {
    super();
    this.latency = Math.max(HALF + 1, Math.round(o.lookahead ?? 0.005 * sampleRate));
    this.win = this.latency - HALF + 1; // hold and smoothing window, in samples
    // Aimed 0.05 dB under the ceiling: the short interpolator reads a peak up to ~0.03 dB lower
    // than a full-length true-peak meter does (measured).
    this.ceiling = Math.pow(10, ((o.ceiling ?? -1) - 0.05) / 20);
    this.quiet = this.ceiling / BOUND;
    this.loud = 0; // how many more windows hold a sample over `quiet`
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

  // The state lives in locals while a block runs (a phone's audio thread pays for every property
  // read), and indices wrap by comparison rather than division.
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const x0 = inp[0] || SILENT, x1 = inp[1] || x0, y0 = out[0], y1 = out[1] || out[0];
    const { hist, delay, ceiling, quiet, decay, win, latency, qVal, qIdx, ring } = this;
    const h0 = hist[0], h1 = hist[1], d0 = delay[0], d1 = delay[1], span = 2 * HALF, cap = win + 1;
    let { hpos, qPrev, dpos, qHead, qLen, n: m, rpos, sum, rel, loud } = this;
    for (let i = 0; i < n; i++) {
      const a = x0[i] || 0, b = x1[i] || 0;
      // Interpolator input: the newest sample sits at hpos + span - 1 .. read contiguously.
      h0[hpos] = h0[hpos + span] = a;
      h1[hpos] = h1[hpos + span] = b;
      if (++hpos === span) hpos = 0;
      const base = hpos; // oldest of the last `span` samples
      // Peak of the interval ending at the window's centre sample, both channels.
      let q = Math.max(Math.abs(h0[base + HALF]), Math.abs(h1[base + HALF]));
      if (a > quiet || a < -quiet || b > quiet || b < -quiet) loud = span;
      if (loud) {
        loud--;
        let s0 = 0, t0 = 0, m0 = 0, s1 = 0, t1 = 0, m1 = 0;
        for (let k = 0, j = base + span - 1; k < HALF; k++, j--) {
          const u0 = h0[base + k] + h0[j], v0 = h0[base + k] - h0[j];
          const u1 = h1[base + k] + h1[j], v1 = h1[base + k] - h1[j];
          s0 += FOLD[k] * u0; t0 += TWIST[k] * v0; m0 += MID[k] * u0;
          s1 += FOLD[k] * u1; t1 += TWIST[k] * v1; m1 += MID[k] * u1;
        }
        // The outer points are (sum + difference) / 2 and (sum - difference) / 2: the larger is
        // (|sum| + |difference|) / 2.
        q = Math.max(q, 0.5 * (Math.abs(s0) + Math.abs(t0)), 0.5 * (Math.abs(s1) + Math.abs(t1)), Math.abs(m0), Math.abs(m1));
      }
      // A sample owns the intervals on both sides of it; the gain it needs to stay under the ceiling.
      const peak = q > qPrev ? q : qPrev;
      qPrev = q;
      const need = peak > ceiling ? ceiling / peak : 1;
      // Hold: the lowest gain needed anywhere in the window.
      let tail = qHead + qLen - 1;
      if (tail >= cap) tail -= cap;
      while (qLen && qVal[tail] >= need) { qLen--; if (--tail < 0) tail += cap; }
      if (++tail >= cap) tail -= cap;
      qVal[tail] = need; qIdx[tail] = m; qLen++;
      while (qIdx[qHead] <= m - win) { if (++qHead === cap) qHead = 0; qLen--; }
      m++;
      const held = qVal[qHead];
      // Down at once, back up slowly.
      rel = held < rel ? held : held + (rel - held) * decay;
      // The moving average starts each reduction a full window early, so it lands smoothly in time.
      sum += rel - ring[rpos];
      ring[rpos] = rel;
      if (++rpos === win) { // drop rounding drift once a window
        rpos = 0;
        sum = 0;
        for (let k = 0; k < win; k++) sum += ring[k];
      }
      const g = sum < win ? sum / win : 1;
      y0[i] = d0[dpos] * g;
      y1[i] = d1[dpos] * g;
      d0[dpos] = a; d1[dpos] = b;
      if (++dpos === latency) dpos = 0;
    }
    this.hpos = hpos; this.qPrev = qPrev; this.dpos = dpos; this.qHead = qHead; this.qLen = qLen;
    this.n = m; this.rpos = rpos; this.sum = sum; this.rel = rel; this.loud = loud; // (an object here would be garbage every block)
    return true;
  }
}

registerProcessor('true-peak-limiter', TruePeakLimiter);
