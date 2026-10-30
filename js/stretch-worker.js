// WSOLA time-stretcher + band-limited resampling pitch-shifter for seamless loops.
// Originally written by MuscularCrab for Dream Chamber Studios Remixed; revised to close the
// loop seam, keep onsets on the beat after silences and stop pitch-ups from aliasing.
// In:  { id, channels: Float32Array[], sampleRate, targetLen, pitchRatio }
// Out: { id, channels } with exactly targetLen samples per channel. The output
// is itself a seamless loop: the closing splice is crossfaded into the material
// that precedes the loop start, so the wrap (and bar 1's downbeat) stay clean.

self.onmessage = (e) => {
  const { id, channels, sampleRate, targetLen, pitchRatio } = e.data;
  try {
    let chans = channels;
    if (Math.abs(pitchRatio - 1) > 1e-6) chans = resampleLoop(chans, Math.round(chans[0].length / pitchRatio));
    const out = timeStretch(chans, sampleRate, targetLen);
    self.postMessage({ id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};

// ---------- band-limited loop resampler ----------
// Kaiser-windowed sinc from a polyphase table. The input is read circularly, so
// the output is still a seamless loop. When pitching up, the cutoff drops to the
// new Nyquist so hats and cymbals don't fold back as inharmonic grit.
const RS_ZC = 12;        // sinc zero crossings per side
const RS_BETA = 7;       // Kaiser beta (spurious products around -70 dB)
const RS_CUT = 0.92;     // cutoff as a fraction of the lower Nyquist
const RS_PHASES = 2048;  // fractional-position resolution (nearest phase)

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64 && term > sum * 1e-14; k++) { term *= q / (k * k); sum += term; }
  return sum;
}

// chans: Float32Array[] holding one seamless loop; returns new channels of outLen.
function resampleLoop(chans, outLen) {
  const n = chans[0].length;
  const step = n / outLen;                     // input samples per output sample
  const fc = RS_CUT * Math.min(1, 1 / step);   // cutoff, as a fraction of the input Nyquist
  const half = Math.ceil(RS_ZC / fc);          // taps on each side of the read point
  const taps = 2 * half;
  const table = new Float32Array(RS_PHASES * taps);
  const norm = besselI0(RS_BETA);
  for (let p = 0; p < RS_PHASES; p++) {
    const frac = p / RS_PHASES, row = p * taps;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - frac;        // tap distance from the read point
      const r = x / half;
      const win = r <= -1 || r >= 1 ? 0 : besselI0(RS_BETA * Math.sqrt(1 - r * r)) / norm;
      const arg = Math.PI * fc * x;
      const v = (x === 0 ? 1 : Math.sin(arg) / arg) * win;
      table[row + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) table[row + k] /= sum; // unity DC gain for every phase
  }
  const outs = chans.map(() => new Float32Array(outLen));
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    let base = Math.floor(x);
    let p = Math.round((x - base) * RS_PHASES);
    if (p === RS_PHASES) { p = 0; base++; }
    base -= half - 1;
    const row = p * taps;
    const inside = base >= 0 && base + taps <= n;
    for (let c = 0; c < chans.length; c++) {
      const input = chans[c];
      let acc = 0;
      if (inside) {
        for (let k = 0; k < taps; k++) acc += input[base + k] * table[row + k];
      } else {
        for (let k = 0; k < taps; k++) acc += input[(((base + k) % n) + n) % n] * table[row + k];
      }
      outs[c][i] = acc;
    }
  }
  return outs;
}

// ---------- WSOLA ----------
const SEQ_S = 0.050;  // frame length (hop + crossfade)
const OVL_S = 0.010;  // crossfade length
const SEEK_S = 0.015; // search radius around the nominal position
const CORR_S = 0.010; // similarity window (about the crossfade span, like SoundTouch)
const DEC = 4;        // coarse-search decimation

function timeStretch(channels, sampleRate, targetLen) {
  const inLen = channels[0].length;
  const nCh = channels.length;
  if (targetLen === inLen) return channels.map((c) => c.slice());
  const stretch = targetLen / inLen;
  // Within ~1.7 cents of unity a plain loop resample beats splicing, and unlike
  // wrap/trim it keeps the seam continuous.
  if (Math.abs(stretch - 1) < 0.001) return resampleLoop(channels, targetLen);

  const seqLen = Math.round(SEQ_S * sampleRate);
  const ovl = Math.round(OVL_S * sampleRate);
  const seek = Math.round(SEEK_S * sampleRate);
  const Wd = Math.floor(Math.round(CORR_S * sampleRate) / DEC);
  // Frames tile [0, span) exactly. The last frame's tail, [span, targetLen), is
  // crossfaded into src[inLen - ovl .. inLen), the material that leads into the
  // loop start, so out[targetLen - 1] -> out[0] is a natural continuation.
  const span = targetLen - ovl;
  const closeRef = inLen - ovl;
  const N = Math.max(2, Math.round(span / (seqLen - ovl)));
  const P = (k) => Math.round((k * span) / N);

  // Circularly extended input: frames and references read past inLen.
  const total = inLen + 2 * (seqLen + seek) + Wd * DEC + 4 * DEC;
  const src = [];
  for (let c = 0; c < nCh; c++) {
    const a = new Float32Array(total);
    a.set(channels[c]);
    for (let i = inLen; i < total; i++) a[i] = a[i - inLen];
    src.push(a);
  }
  // Mono sum, plus a decimated copy of 4-sample box sums (a cheap anti-alias
  // filter) for the coarse search.
  const full = (pos) => { let s = 0; for (let c = 0; c < nCh; c++) s += src[c][pos]; return s; };
  const box = (pos) => full(pos) + full(pos + 1) + full(pos + 2) + full(pos + 3);
  const monoLen = Math.floor(total / DEC) - 1;
  const mono = new Float32Array(monoLen);
  for (let i = 0; i < monoLen; i++) mono[i] = box(i * DEC);

  const refA = new Float64Array(Wd), refB = new Float64Array(Wd);
  const ncc = (corr, e1, e2) => corr / (Math.sqrt(e1 * e2) + 1e-12);
  // Similarity with a mild pull toward the nominal position (SoundTouch's
  // heuristic). It keeps layers tight and makes silence, where every candidate
  // scores 0, resolve to the nominal spot instead of the window's first sample.
  const scoreOf = (sim, pos, nominal) => { const u = (pos - nominal) / seek; return (sim + 0.1) * (1 - 0.25 * u * u); };

  // Best input start for a frame whose ideal start is `nominal`, matching the
  // natural continuation `nat` of the previous frame. For the closing frame, its
  // material one hop later must also match the pre-roll at closeRef.
  function search(nominal, nat, hopK, closing) {
    const lo = Math.max(0, Math.round(nominal - seek));
    const hi = Math.round(nominal + seek);
    let eA = 0, eB = 0;
    for (let j = 0; j < Wd; j++) { const v = box(nat + j * DEC); refA[j] = v; eA += v * v; }
    if (closing) for (let j = 0; j < Wd; j++) { const v = box(closeRef + j * DEC); refB[j] = v; eB += v * v; }

    // Coarse: candidates on the decimated grid, running candidate energy.
    const loD = Math.ceil(lo / DEC), hiD = Math.floor(hi / DEC);
    let best = Math.round(nominal), bestScore = -Infinity;
    let eC = 0;
    for (let j = 0; j < Wd; j++) eC += mono[loD + j] * mono[loD + j];
    for (let pD = loD; pD <= hiD; pD++) {
      if (pD > loD) { const a = mono[pD - 1], b = mono[pD + Wd - 1]; eC += b * b - a * a; }
      let corr = 0;
      for (let j = 0; j < Wd; j++) corr += mono[pD + j] * refA[j];
      let sim = ncc(corr, eA, Math.max(eC, 0));
      if (closing) {
        const c0 = pD * DEC + hopK;
        let cb = 0, ec = 0;
        for (let j = 0; j < Wd; j++) { const v = box(c0 + j * DEC); cb += v * refB[j]; ec += v * v; }
        sim = 0.5 * (sim + ncc(cb, eB, ec));
      }
      const sc = scoreOf(sim, pD * DEC, nominal);
      if (sc > bestScore) { bestScore = sc; best = pD * DEC; }
    }

    // Fine: full-rate refinement within one grid step, over the crossfade span.
    let e1 = 0, e1b = 0;
    for (let j = 0; j < ovl; j++) { const r = full(nat + j); e1 += r * r; }
    if (closing) for (let j = 0; j < ovl; j++) { const r = full(closeRef + j); e1b += r * r; }
    let fine = best, fineScore = -Infinity;
    for (let b = Math.max(0, best - DEC + 1); b <= best + DEC - 1; b++) {
      let corr = 0, e2 = 0;
      for (let j = 0; j < ovl; j++) { const v = full(b + j); corr += full(nat + j) * v; e2 += v * v; }
      let sim = ncc(corr, e1, e2);
      if (closing) {
        let cb = 0, ec = 0;
        for (let j = 0; j < ovl; j++) { const v = full(b + hopK + j); cb += full(closeRef + j) * v; ec += v * v; }
        sim = 0.5 * (sim + ncc(cb, e1b, ec));
      }
      const sc = scoreOf(sim, b, nominal);
      if (sc > fineScore) { fineScore = sc; fine = b; }
    }
    return fine;
  }

  // Raised-cosine crossfade: amplitude-complementary like linear (right for
  // aligned, correlated material), but with no slope kinks at its ends.
  const fade = new Float32Array(ovl);
  for (let j = 0; j < ovl; j++) fade[j] = 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / ovl);

  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(targetLen));
  let start = 0, prevStart = 0; // frame 0 plays the loop start verbatim
  for (let k = 0; k < N; k++) {
    const p0 = P(k), hopK = P(k + 1) - p0;
    if (k > 0) start = search(p0 / stretch, prevStart + (p0 - P(k - 1)), hopK, k === N - 1);
    for (let c = 0; c < nCh; c++) {
      const o = out[c], s = src[c];
      let j = 0;
      if (k > 0) for (; j < ovl; j++) o[p0 + j] = o[p0 + j] * (1 - fade[j]) + s[start + j] * fade[j];
      for (; j < hopK + ovl; j++) o[p0 + j] = s[start + j]; // the last frame ends exactly at targetLen
    }
    prevStart = start;
  }
  // Close the loop into the pre-roll; out[targetLen - 1] then leads into src[0] == out[0].
  for (let c = 0; c < nCh; c++) {
    const o = out[c], s = src[c];
    for (let j = 0; j < ovl; j++) o[span + j] = o[span + j] * (1 - fade[j]) + s[closeRef + j] * fade[j];
  }
  return out;
}
