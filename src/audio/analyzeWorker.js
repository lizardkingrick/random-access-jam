// @ts-check
/**
 * Analysis worker: BPM via onset-envelope autocorrelation, musical key via a
 * Krumhansl-Schmuckler chroma estimate. Pure JS (no WASM) — deliberately a
 * lightweight fallback-quality detector; results pre-fill the intake form and
 * the user can always override.
 *
 * Receives: { samples: Float32Array, sampleRate: number }
 * Replies:  { bpm?: number, key?: string }
 */

/** In-place iterative radix-2 FFT (real+imag arrays, length = power of 2). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * BPM: energy-flux onset envelope → autocorrelation over 60–200 BPM lags,
 * folded into 70–180, scored with a slight preference for the 85–150 band.
 * @param {Float32Array} samples @param {number} sampleRate
 */
function detectBpm(samples, sampleRate) {
  const hop = 512;
  const frames = Math.floor(samples.length / hop) - 1;
  if (frames < 64) return undefined;

  // Onset envelope: half-wave-rectified energy flux per hop.
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) e += samples[start + i] * samples[start + i];
    const flux = e - prev;
    env[f] = flux > 0 ? flux : 0;
    prev = e;
  }
  // Remove DC / slow trend.
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += env[f];
  mean /= frames;
  for (let f = 0; f < frames; f++) env[f] -= mean;

  const fps = sampleRate / hop; // envelope frames per second
  const minLag = Math.floor((60 / 200) * fps); // 200 BPM
  const maxLag = Math.ceil((60 / 60) * fps); // 60 BPM
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < frames / 2; lag++) {
    let acc = 0;
    for (let f = 0; f < frames - lag; f++) acc += env[f] * env[f + lag];
    acc /= frames - lag;
    const bpm = (60 * fps) / lag;
    // Mild prior toward common tempo band so half/double picks sanely.
    const foldedBpm = bpm < 85 ? bpm * 2 : bpm > 170 ? bpm / 2 : bpm;
    const prior = foldedBpm >= 85 && foldedBpm <= 150 ? 1.08 : 1;
    if (acc * prior > bestScore) {
      bestScore = acc * prior;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return undefined;
  let bpm = (60 * fps) / bestLag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 2) / 2;
}

// Krumhansl-Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Pearson correlation. @param {number[]} a @param {number[] | Float64Array} b */
function correlate(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Key: average chroma over FFT frames, correlated against rotated K-S profiles.
 * @param {Float32Array} samples @param {number} sampleRate
 */
function detectKey(samples, sampleRate) {
  const N = 4096;
  const hopped = N * 4; // sparse frames are plenty for a whole-loop average
  const chroma = new Float64Array(12);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // Hann

  let frames = 0;
  for (let start = 0; start + N <= samples.length; start += hopped) {
    for (let i = 0; i < N; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let bin = 1; bin < N / 2; bin++) {
      const freq = (bin * sampleRate) / N;
      if (freq < 60 || freq > 2200) continue;
      const mag = Math.hypot(re[bin], im[bin]);
      if (mag < 1e-6) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
    frames++;
  }
  if (frames === 0) return undefined;

  let best = { score: -Infinity, key: 'C major' };
  for (let root = 0; root < 12; root++) {
    const rotate = (/** @type {number[]} */ profile) =>
      profile.map((_, i) => profile[((i - root) % 12 + 12) % 12]);
    const maj = correlate(rotate(MAJOR_PROFILE), chroma);
    const min = correlate(rotate(MINOR_PROFILE), chroma);
    if (maj > best.score) best = { score: maj, key: `${ROOTS[root]} major` };
    if (min > best.score) best = { score: min, key: `${ROOTS[root]} minor` };
  }
  return best.key;
}

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  /** @type {{ bpm?: number, key?: string }} */
  const result = {};
  try {
    result.bpm = detectBpm(samples, sampleRate);
  } catch {
    // best-effort
  }
  try {
    result.key = detectKey(samples, sampleRate);
  } catch {
    // best-effort
  }
  self.postMessage(result);
};
