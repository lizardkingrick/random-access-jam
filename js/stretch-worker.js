// WSOLA time-stretcher + band-limited resampling pitch-shifter for seamless loops.
// Originally written by MuscularCrab for Dream Chamber Studios Remixed; revised to close the
// loop seam, pin attacks to the beat and stop pitch-ups from aliasing.
// In:  { id, channels: Float32Array[], sampleRate, targetLen, pitchRatio, type }
//      type is the stem type ('groove', 'lead', 'texture', 'all'; may be missing). It sets
//      how firmly attacks are pinned to their stretched times (see ANCHOR).
// Out: { id, channels } with exactly targetLen samples per channel. The output
// is itself a seamless loop: the closing splice is crossfaded into the material
// that precedes the loop start, so the wrap (and bar 1's downbeat) stay clean.

self.onmessage = (e) => {
  const job = e.data;
  try {
    // The message is the only holder of the input, so replacing it with the resampled copy
    // lets the original be freed. The copy gets the tail room timeStretch extends it into.
    let padded = false;
    if (Math.abs(job.pitchRatio - 1) > 1e-6) {
      const n = job.channels[0].length;
      job.channels = resampleLoop(job.channels, Math.round(n / job.pitchRatio), tailRoom(job.sampleRate), true);
      padded = true;
    }
    const out = timeStretch(job, padded);
    self.postMessage({ id: job.id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id: job.id, error: String((err && err.stack) || err) });
  }
};

// ---------- band-limited loop resampler ----------
// Kaiser-windowed sinc from a polyphase table. The input is read circularly, so
// the output is still a seamless loop. When pitching up, the cutoff drops to the
// new Nyquist so hats and cymbals don't fold back as inharmonic grit.
const RS_ZC = 12;        // sinc zero crossings per side
const RS_BETA = 7;       // Kaiser beta (spurious products around -70 dB)
const RS_CUT = 0.92;     // cutoff as a fraction of the lower Nyquist
// Pitching down leaves nothing to alias, only images above the old Nyquist to remove, so a
// twice-as-long filter can cut closer to it and keep the hats' air.
const RS_DOWN_ZC = 24, RS_DOWN_CUT = 0.97;
const RS_PHASES = 2048;  // fractional-position resolution (pitch jobs interpolate between rows)

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64 && term > sum * 1e-14; k++) { term *= q / (k * k); sum += term; }
  return sum;
}

// Polyphase table plus each row's step to the next (for interpolating between phases). Cached:
// a key change re-renders every layer at the same ratio, and a table costs tens of ms.
const kernels = new Map();
function kernel(fc, half) {
  const key = fc + '/' + half;
  const hit = kernels.get(key);
  if (hit) return hit;
  const taps = 2 * half;
  const table = new Float32Array((RS_PHASES + 1) * taps); // row RS_PHASES (frac = 1) closes the interpolation
  const norm = besselI0(RS_BETA);
  for (let p = 0; p <= RS_PHASES; p++) {
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
  const delta = new Float32Array(RS_PHASES * taps);
  for (let i = 0; i < delta.length; i++) delta[i] = table[i + taps] - table[i];
  if (kernels.size >= 4) kernels.delete(kernels.keys().next().value);
  const k = { table, delta };
  kernels.set(key, k);
  return k;
}

// chans: Float32Array[] holding one seamless loop; returns new channels of outLen, each with
// `room` spare samples after it in its buffer. `fine` (pitch jobs) interpolates between
// table phases (11-22 dB less error at 10-14 kHz) and uses the longer filter on pitch-downs;
// without it the output is exactly what the near-unity tempo path has always produced.
function resampleLoop(chans, outLen, room = 0, fine = false) {
  const n = chans[0].length;
  const step = n / outLen;                     // input samples per output sample
  const down = fine && step < 1;
  const fc = (down ? RS_DOWN_CUT : RS_CUT) * Math.min(1, 1 / step); // fraction of the input Nyquist
  const half = Math.ceil((down ? RS_DOWN_ZC : RS_ZC) / fc);         // taps on each side of the read point
  const taps = 2 * half;
  const { table, delta } = kernel(fc, half);
  const lerp = new Float32Array(taps);
  const outs = chans.map(() => new Float32Array(outLen + room).subarray(0, outLen));
  const stereo = chans.length === 2, [in0, in1] = chans, [out0, out1] = outs;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    let base = Math.floor(x), w = table, row;
    if (fine) {
      const f = (x - base) * RS_PHASES, p = Math.floor(f), t = f - p, r0 = p * taps;
      base -= half - 1;
      if (stereo && base >= 0 && base + taps <= n) { // the common case, in one pass
        let a0 = 0, a1 = 0;
        for (let k = 0; k < taps; k++) { const v = table[r0 + k] + t * delta[r0 + k]; a0 += in0[base + k] * v; a1 += in1[base + k] * v; }
        out0[i] = a0; out1[i] = a1;
        continue;
      }
      for (let k = 0; k < taps; k++) lerp[k] = table[r0 + k] + t * delta[r0 + k];
      w = lerp; row = 0; base += half - 1;
    } else {
      let p = Math.round((x - base) * RS_PHASES);
      if (p === RS_PHASES) { p = 0; base++; }
      row = p * taps;
    }
    base -= half - 1;
    const inside = base >= 0 && base + taps <= n;
    for (let c = 0; c < chans.length; c++) {
      const input = chans[c];
      let acc = 0;
      if (inside) {
        for (let k = 0; k < taps; k++) acc += input[base + k] * w[row + k];
      } else {
        for (let k = 0; k < taps; k++) acc += input[(((base + k) % n) + n) % n] * w[row + k];
      }
      outs[c][i] = acc;
    }
  }
  return outs;
}

// ---------- WSOLA ----------
const SEQ_S = 0.050;  // frame length (hop + crossfade)
const OVL_S = 0.010;  // crossfade length
const SEEK_S = 0.025; // search radius between pinned attacks (the anchors stop the wide search drifting off the beat)
const CORR_S = 0.010; // similarity window (about the crossfade span, like SoundTouch)
const DEC = 4;        // coarse-search decimation

// How attacks are found and pinned, per stem type. rise: dB jump in high-passed energy over
// the previous ~23 ms; level: dB below the stem's loudest block; tol: search allowed at a
// pinned attack, in seconds (it moves the hit by at most that much). Each pinned attack costs
// a constrained splice, so legato leads and pads only pin hard, isolated hits.
const ANCHOR = {
  groove: { rise: 8, level: 35, tol: 0.003 },
  lead: { rise: 14, level: 25, tol: 0.003 },
  texture: { rise: 14, level: 25, tol: 0.003 },
};
const MIN_GAP_S = 0.060;  // attacks closer than this are one event
const GUARD_S = 0.020;    // frames after an attack start at least this far past it (no re-struck hits)
const JUMP_FRAMES = 3, JUMP_NCC = 0.5; // see the frame loop

const lens = (sr) => {
  const seqLen = Math.round(SEQ_S * sr), seek = Math.round(SEEK_S * sr);
  const Wd = Math.floor(Math.round(CORR_S * sr) / DEC);
  return { seqLen, seek, Wd, tail: 2 * (seqLen + seek) + Wd * DEC + 4 * DEC };
};
const tailRoom = (sr) => lens(sr).tail;

// Attack times (in samples) on the mono sum: 128-sample blocks of first-difference energy
// (an HF emphasis, so bass swells don't count) that jump `rise` dB over the previous ~23 ms,
// refined to the first sample of the jump.
function findOnsets(src, inLen, sr, a) {
  const nCh = src.length, B = 128, nb = Math.floor(inLen / B), look = Math.max(2, Math.round(0.023 * sr / B));
  const mono = (i) => { let m = 0; for (let c = 0; c < nCh; c++) m += src[c][(i + inLen) % inLen]; return m; };
  const E = new Float64Array(nb);
  let prev = mono(-1), peak = 0;
  for (let b = 0, i = 0; b < nb; b++) {
    let e = 0;
    for (const end = i + B; i < end; i++) {
      let m = src[0][i];
      for (let c = 1; c < nCh; c++) m += src[c][i];
      const d = m - prev; prev = m; e += d * d;
    }
    E[b] = e;
    if (e > peak) peak = e;
  }
  const floor = peak * 10 ** (-a.level / 10), rise = 10 ** (a.rise / 10), gap = MIN_GAP_S * sr;
  const onsets = [];
  let ref = 0, last = -Infinity;
  for (let b = 0; b < nb; b++) {
    if (b >= look) {
      const avg = Math.max(0, ref / look); // the running sum can round to just below 0 in silence
      if (E[b] > floor && E[b] > rise * avg && b * B - last >= gap) {
        const lo = Math.max(1, (b - 1) * B), hi = Math.min(inLen, (b + 1) * B);
        let m = 0;
        for (let i = lo; i < hi; i++) m = Math.max(m, Math.abs(mono(i) - mono(i - 1)));
        const thr = Math.max(0.2 * m, 2 * Math.sqrt(avg / B));
        let t = lo;
        while (t < hi - 1 && Math.abs(mono(t) - mono(t - 1)) < thr) t++;
        onsets.push(t);
        last = t;
      }
    }
    ref += E[b];
    if (b >= look) ref -= E[b - look];
  }
  return onsets;
}

function timeStretch(job, padded) {
  let channels = job.channels;
  job.channels = null;
  const { sampleRate, targetLen } = job;
  const inLen = channels[0].length;
  const nCh = channels.length;
  if (targetLen === inLen) return channels.map((c) => c.slice());
  const stretch = targetLen / inLen;
  // Within ~1.7 cents of unity a plain loop resample beats splicing, and unlike
  // wrap/trim it keeps the seam continuous.
  if (Math.abs(stretch - 1) < 0.001) return resampleLoop(channels, targetLen);

  const { seqLen, seek, Wd, tail } = lens(sampleRate);
  const ovl = Math.round(OVL_S * sampleRate);
  const hopN = seqLen - ovl;
  // Frames tile [0, span) exactly. The last frame's tail, [span, targetLen), is
  // crossfaded into src[inLen - ovl .. inLen), the material that leads into the
  // loop start, so out[targetLen - 1] -> out[0] is a natural continuation.
  const span = targetLen - ovl;
  const closeRef = inLen - ovl;

  // Circularly extended input: frames and references read past inLen. A resampled input
  // already has the room in its buffer, so it is extended in place instead of copied.
  const total = inLen + tail;
  const src = channels.map((c) => {
    const a = padded ? new Float32Array(c.buffer, c.byteOffset, total) : new Float32Array(total);
    if (!padded) a.set(c);
    for (let i = inLen; i < total; i++) a[i] = a[i - inLen];
    return a;
  });
  channels = null;
  // Mono sum, plus a decimated copy of 4-sample box sums (a cheap anti-alias
  // filter) for the coarse search.
  const full = (pos) => { let s = 0; for (let c = 0; c < nCh; c++) s += src[c][pos]; return s; };
  const box = (pos) => full(pos) + full(pos + 1) + full(pos + 2) + full(pos + 3);
  const monoLen = Math.floor(total / DEC) - 1;
  const mono = new Float32Array(monoLen);
  for (let i = 0; i < monoLen; i++) mono[i] = box(i * DEC);

  const refA = new Float64Array(Wd), refB = new Float64Array(Wd), atHop = new Float64Array(Math.ceil(2 * seek / DEC) + Wd + 2);
  const ncc = (corr, e1, e2) => corr / (Math.sqrt(e1 * e2) + 1e-12);
  // Similarity with a mild pull toward the nominal position (SoundTouch's
  // heuristic). It keeps layers tight and makes silence, where every candidate
  // scores 0, resolve to the nominal spot instead of the window's first sample.
  // The pull bottoms out at 0.1 so it never zeroes or flips the ranking: a capped window
  // can reach several radii from nominal, and similarity must still decide there.
  const scoreOf = (sim, pos, nominal, radius) => { const u = (pos - nominal) / radius; return (sim + 0.1) * Math.max(0.1, 1 - 0.25 * u * u); };

  // Best input start in [lo, hi] for a frame whose ideal start is `nominal`, matching the
  // natural continuation `nat` of the previous frame. A frame that hands over to a pinned
  // attack (or the loop end) at input `closeAt` must also match it one hop later. Leaves the
  // chosen start's similarity to `nat` in `rho`, for the crossfade gain.
  let rho = 1;
  function search(nominal, nat, hopK, closeAt, lo, hi, radius) {
    const closing = closeAt >= 0;
    let eA = 0, eB = 0;
    for (let j = 0; j < Wd; j++) { const v = box(nat + j * DEC); refA[j] = v; eA += v * v; }
    if (closing) for (let j = 0; j < Wd; j++) { const v = box(closeAt + j * DEC); refB[j] = v; eB += v * v; }

    // Coarse: candidates on the decimated grid, running candidate energy.
    const loD = Math.ceil(lo / DEC), hiD = Math.floor(hi / DEC);
    let best = Math.min(hi, Math.max(lo, Math.round(nominal))), bestScore = -Infinity;
    // Material one hop after each candidate, decimated once for the whole window.
    if (closing) for (let k = 0; k <= hiD - loD + Wd; k++) atHop[k] = box((loD + k) * DEC + hopK);
    let eC = 0;
    for (let j = 0; j < Wd; j++) eC += mono[loD + j] * mono[loD + j];
    for (let pD = loD; pD <= hiD; pD++) {
      if (pD > loD) { const a = mono[pD - 1], b = mono[pD + Wd - 1]; eC += b * b - a * a; }
      let corr = 0;
      for (let j = 0; j < Wd; j++) corr += mono[pD + j] * refA[j];
      let sim = ncc(corr, eA, Math.max(eC, 0));
      if (closing) {
        const c0 = pD - loD;
        let cb = 0, ec = 0;
        for (let j = 0; j < Wd; j++) { const v = atHop[c0 + j]; cb += v * refB[j]; ec += v * v; }
        sim = 0.5 * (sim + ncc(cb, eB, ec));
      }
      const sc = scoreOf(sim, pD * DEC, nominal, radius);
      if (sc > bestScore) { bestScore = sc; best = pD * DEC; }
    }

    // Fine: full-rate refinement within one grid step, over the crossfade span.
    let e1 = 0, e1b = 0;
    for (let j = 0; j < ovl; j++) { const r = full(nat + j); e1 += r * r; }
    if (closing) for (let j = 0; j < ovl; j++) { const r = full(closeAt + j); e1b += r * r; }
    let fine = best, fineScore = -Infinity;
    const fLo = Math.max(lo, best - DEC + 1), fHi = Math.min(hi, best + DEC - 1);
    for (let b = fLo; b <= fHi; b++) {
      let corr = 0, e2 = 0;
      for (let j = 0; j < ovl; j++) { const v = full(b + j); corr += full(nat + j) * v; e2 += v * v; }
      const s1 = ncc(corr, e1, e2);
      let sim = s1;
      if (closing) {
        let cb = 0, ec = 0;
        for (let j = 0; j < ovl; j++) { const v = full(b + hopK + j); cb += full(closeAt + j) * v; ec += v * v; }
        sim = 0.5 * (sim + ncc(cb, e1b, ec));
      }
      const sc = scoreOf(sim, b, nominal, radius);
      if (sc > fineScore) { fineScore = sc; fine = b; rho = s1; }
    }
    return fine;
  }
  const simAt = (a, b) => {
    let corr = 0, e1 = 0, e2 = 0;
    for (let j = 0; j < ovl; j++) { const u = full(a + j), v = full(b + j); corr += u * v; e1 += u * u; e2 += v * v; }
    return ncc(corr, e1, e2);
  };

  // Raised-cosine crossfade: amplitude-complementary like linear (right for aligned,
  // correlated material), but with no slope kinks at its ends. Its gain follows the splice's
  // correlation r: 1 when the two sides match, rising to equal power when they don't, so
  // noisy material (cymbal wash, reverb) no longer dips by 1-2 dB at every splice.
  const fade = new Float32Array(ovl), fOut = new Float32Array(ovl), fIn = new Float32Array(ovl);
  for (let j = 0; j < ovl; j++) fade[j] = 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / ovl);
  const setFade = (r) => {
    r = Math.min(1, Math.max(0, r));
    for (let j = 0; j < ovl; j++) {
      const f = fade[j], g = 1 / Math.sqrt((1 - f) * (1 - f) + f * f + 2 * r * f * (1 - f));
      fOut[j] = (1 - f) * g; fIn[j] = f * g;
    }
  };

  // Anchors pin input positions to output positions: the loop start, each strong attack at
  // its stretched time, and the closing pre-roll at span. An attack's anchor sits `pre`
  // samples ahead of it, so the splice into it is over before the hit even when the anchor
  // moves by its tolerance. Each attack then plays verbatim from its anchor: it lands on the
  // beat and is neither doubled nor dropped. The frames between anchors are searched.
  const cfg = ANCHOR[job.type] || ANCHOR.groove;
  const tol = Math.round(cfg.tol * sampleRate), pre = ovl + tol + 32, minGap = 2 * ovl;
  const anchors = [[0, 0]];
  for (const t of findOnsets(src, inLen, sampleRate, cfg)) {
    const aIn = t - pre, aOut = Math.round(t * stretch) - pre, [pIn, pOut] = anchors[anchors.length - 1];
    if (aIn - pIn >= minGap + tol && aOut - pOut >= minGap && closeRef - aIn >= minGap + tol && span - aOut >= minGap) anchors.push([aIn, aOut]);
  }
  anchors.push([closeRef, span]);

  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(targetLen));
  const guard = Math.round(GUARD_S * sampleRate);
  let start = 0, prevStart = 0, prevHop = 0;
  for (let a = 0; a + 1 < anchors.length; a++) {
    const [inA, outA] = anchors[a], [inB, outB] = anchors[a + 1];
    const G = outB - outA, gin = inB - inA;
    // Enough frames that none is much longer than a normal hop and the anchor frame never
    // plays into the next attack. On slow-downs the frames in between must also fit between
    // the guard after this attack and the next one, so tight gaps get shorter frames.
    let m = Math.max(1, Math.round(G / hopN), Math.ceil(G / Math.max(minGap, gin - tol)));
    if (m > 1) m = Math.max(m, Math.ceil(G / Math.max(minGap, gin - pre - guard)));
    const q = (i) => outA + Math.round((i * G) / m);
    const floorIn = inA + pre + guard;
    let first = 0, last = 0, aligned = false; // nominal starts of the first and last frames after the anchor
    for (let i = 0; i < m; i++) {
      const p0 = q(i), hopK = q(i + 1) - p0, nat = prevStart + prevHop;
      if (a === 0 && i === 0) start = 0; // the loop start plays verbatim
      else if (i === 0) start = search(inA, nat, hopK, -1, inA - tol, inA + tol, Math.max(1, tol));
      else if (aligned) { start = nat; rho = 1; }
      else {
        if (i === 1) { first = start + prevHop; last = inB - (outB - q(m - 1)); }
        const nominal = m === 2 ? 0.5 * (first + last) : first + ((last - first) * (i - 1)) / (m - 2);
        // The frames must arrive at the next anchor in step with it. Rather than force that
        // in the last frame alone (a poor splice about half the time), each of the last few
        // frames first tries stepping onto the anchor's own timeline and takes it when the
        // splice there is decent; the frames after it are then plain continuations.
        const al = inB - (outB - p0);
        if (i < m - 1 && i >= m - 1 - JUMP_FRAMES && al - tol >= floorIn) {
          const s = search(al, nat, hopK, -1, al - tol, al + tol, Math.max(1, tol));
          if (rho >= JUMP_NCC) { start = s; aligned = true; }
        }
        if (!aligned) {
          // Never play into the next attack at full gain (its own anchor plays it) and never
          // start on the attack just played.
          const hi = Math.min(Math.round(nominal + seek), inB - hopK);
          const lo = Math.max(0, Math.min(hi, Math.max(floorIn, Math.round(nominal - seek))));
          start = search(nominal, nat, hopK, i === m - 1 ? inB : -1, lo, Math.max(lo, hi), seek);
        }
      }
      for (let c = 0; c < nCh; c++) {
        const o = out[c], s = src[c];
        let j = 0;
        if (p0 > 0) {
          if (c === 0) setFade(rho);
          for (; j < ovl; j++) o[p0 + j] = o[p0 + j] * fOut[j] + s[start + j] * fIn[j];
        }
        for (; j < hopK + ovl; j++) o[p0 + j] = s[start + j]; // the last frame ends exactly at targetLen
      }
      prevStart = start; prevHop = hopK;
    }
  }
  // Close the loop into the pre-roll; out[targetLen - 1] then leads into src[0] == out[0].
  setFade(simAt(prevStart + prevHop, closeRef));
  for (let c = 0; c < nCh; c++) {
    const o = out[c], s = src[c];
    for (let j = 0; j < ovl; j++) o[span + j] = o[span + j] * fOut[j] + s[closeRef + j] * fIn[j];
  }
  return out;
}
