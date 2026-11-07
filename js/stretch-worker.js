// Time-stretcher and pitch-shifter for seamless loops: onset-anchored WSOLA (fast), a phase-locked
// phase vocoder hybrid (hq), formant correction, a band-limited loop resampler and rate converter.
// Originally written by MuscularCrab for Dream Chamber Studios Remixed; revised to close the
// loop seam, pin attacks to the beat, stop pitch-ups from aliasing, and to add the hq and formant paths.
// In:  { id, channels, sampleRate, srcRate, targetLen, pitchRatio, type, inLen, quality, formant }
//      channels: Float32Array[] or Int16Array[] (the stems' own 16-bit values: float = int / 32768).
//      inLen: the loop length (default channels[0].length); anything after it is spare room this
//      worker may overwrite. type: the stem type ('groove', 'lead', 'texture', 'all'; may be
//      missing); it sets how firmly attacks are pinned (see ANCHOR) and whether hq helps (HQ).
//      quality: 'fast' (default) or 'hq', 5-15x slower (1.5-4 s for a 60-70 s stem in desktop
//      Chrome). formant: keep a voice's formants in place when pitchRatio != 1. srcRate: the
//      input's sample rate (default sampleRate, the output's); targetLen counts output samples.
// Out: { id, channels, quality, formant } with exactly targetLen samples per channel; quality and
// formant say what was actually done (an hq request that gets 'fast' back got exactly the fast
// render, as hq would not have been better). The output is itself a seamless loop: the closing
// splice is crossfaded into the material that precedes the loop start, so the wrap (and bar 1's
// downbeat) stay clean. Attacks land on the same stretched times on both paths.

self.onmessage = (e) => {
  const job = e.data;
  try {
    const res = run(job);
    self.postMessage({ id: job.id, ...res }, [...new Set(res.channels.map((c) => c.buffer))]);
  } catch (err) {
    self.postMessage({ id: job.id, error: String((err && err.stack) || err) });
  }
};

// Stem types the hq path serves, chosen by measurement on the stems: leads, textures and the full
// mix come out clearly closer to the input. Grooves mostly did too, but with their hits softened:
// the vocoder smears the bass line's share of each hit into the time just ahead of it (on Da Funk
// 20-32% of the hits got 6 dB or more of it, against 1-4% on the fast path), so grooves keep the
// fast path.
const HQ = { lead: true, texture: true, all: true };

function run(job) {
  const { sampleRate: sr, targetLen, pitchRatio, type } = job;
  // Output samples per input sample before any stretch: the originals keep their own rate
  // (srcRate) and a phone or Safari plays at its own (sampleRate), so the loop is converted here,
  // read circularly like a pitch shift, instead of by the browser's decoder, which treats the
  // file as a one-off and rings at both ends (a tick at every wrap).
  const rate = sr / (job.srcRate || sr), converting = Math.abs(rate - 1) > 1e-9;
  let chans = job.channels;
  job.channels = null; // the message is the only holder of the input, so it can go once it's copied
  const n = job.inLen || chans[0].length;
  const scale = chans[0] instanceof Int16Array ? 1 / 32768 : 1;
  const fast = (channels, formant = false) => ({ channels, quality: 'fast', formant });
  const pitched = Math.abs(pitchRatio - 1) > 1e-6;
  if (!pitched && !converting) {
    if (targetLen === n) return fast(chans.map((c) => (scale === 1 && c.length === n ? c : toFloat(c, n, scale))));
    if (Math.abs(targetLen - n) <= NUDGE_MAX && canNudge(n, targetLen)) return fast(nudgeLoop(chans, n, targetLen, scale));
  }
  // Pitch and rate first, in one resample: the copy (with the tail room WSOLA extends it into)
  // replaces the input. Played at sr, len samples sound pitchRatio higher than the original.
  let x = chans, len = n;
  const formant = !!job.formant && pitched;
  if (pitched || converting) {
    len = Math.round((n * rate) / pitchRatio);
    // A loop that then needs only a nudge (within 1.7 cents, as timeStretch would resample it in
    // a second pass) goes straight to its length; at its own tempo that is the whole job.
    if (converting && Math.abs(targetLen / len - 1) < 0.001) len = targetLen;
    const done = len === targetLen && !formant, room = done ? 0 : tailRoom(sr);
    if (pitched) {
      if (scale !== 1) chans = chans.map((c) => toFloat(c, n, scale));
      // The filter follows the pitch, not the step: at 48 kHz a semitone up still reads under one
      // input sample per output sample, which picked the pitch-down's twice-as-long filter (+45%
      // time) with no top octave to keep. At srcRate == sampleRate the two rules agree.
      x = resampleLoop(chans, n, len, room, pitchRatio < 1 ? 'down' : 'up');
    } else x = convertLoop(chans, n, len, room, scale, job.srcRate >= 44100 && rate >= CV_RATE);
    chans = null;
    if (done) return fast(x);
  }
  const ratio = formant ? pitchRatio : 1;
  if (job.quality === 'hq' && HQ[type] && Math.abs(targetLen / len - 1) >= 0.001) {
    if (x[0] instanceof Int16Array) x = x.map((c) => toFloat(c, n, scale));
    return { channels: hqStretch(x, len, targetLen, sr, type, ratio), quality: 'hq', formant };
  }
  if (formant) x = formantPass(x, len, sr, ratio, tailRoom(sr));
  return fast(timeStretch(x, len, targetLen, sr, type, pitched || converting ? 1 : scale), formant);
}

// Float copy of c[0, n) (scaled from 16-bit), with `room` spare samples after it.
function toFloat(c, n, scale, room = 0) {
  const a = new Float32Array(n + room);
  if (scale === 1) a.set(c.length === n ? c : c.subarray(0, n));
  else for (let i = 0; i < n; i++) a[i] = c[i] * scale;
  return a;
}

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
function kernel(fc, half, phases = RS_PHASES) {
  const key = fc + '/' + half + '/' + phases;
  const hit = kernels.get(key);
  if (hit) return hit;
  const taps = 2 * half;
  const table = new Float32Array((phases + 1) * taps); // row `phases` (frac = 1) closes the interpolation
  const norm = besselI0(RS_BETA);
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases, row = p * taps;
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
  const delta = new Float32Array(phases === RS_PHASES ? phases * taps : 0); // only interpolated tables use it
  for (let i = 0; i < delta.length; i++) delta[i] = table[i + taps] - table[i];
  if (kernels.size >= 4) kernels.delete(kernels.keys().next().value);
  const k = { table, delta };
  kernels.set(key, k);
  return k;
}

// chans: Float32Array[] whose first n samples are one seamless loop; returns new channels of
// outLen + room samples (the loop, then spare room). `mode` 'up' or 'down' (pitch jobs)
// interpolates between table phases (11-22 dB less error at 10-14 kHz), with the longer filter on
// pitch-downs; without it the output is exactly what the near-unity tempo path has always produced.
function resampleLoop(chans, n, outLen, room = 0, mode = false) {
  const step = n / outLen;                     // input samples per output sample
  const fine = !!mode, down = mode === 'down';
  const fc = (down ? RS_DOWN_CUT : RS_CUT) * Math.min(1, 1 / step); // fraction of the input Nyquist
  const half = Math.ceil((down ? RS_DOWN_ZC : RS_ZC) / fc);          // taps on each side of the read point
  const taps = 2 * half;
  const { table, delta } = kernel(fc, half);
  const lerp = new Float32Array(taps);
  const outs = chans.map(() => new Float32Array(outLen + room));
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
    if (stereo && base >= 0 && base + taps <= n) { // the same sums as below, both channels in one pass
      let a0 = 0, a1 = 0;
      for (let k = 0; k < taps; k++) { const v = w[row + k]; a0 += in0[base + k] * v; a1 += in1[base + k] * v; }
      out0[i] = a0; out1[i] = a1;
      continue;
    }
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

// ---------- rate conversion ----------
// The originals keep their own rate and a phone or Safari plays at its own (usually 48 kHz), so
// a stem's first pick at its own tempo is a rate conversion and nothing else, and it decides how
// soon the pick sounds. Going up from 44.1 kHz to 48 kHz or more nothing can alias; the filter
// only removes the input's images, and the image of content at f plays at f + 3.9 kHz. So only
// what the filter passes above 28.1 kHz can land below 20 kHz, and the images of the top few kHz
// may fall at 20-24 kHz, where nobody hears them. With that much room 20 taps do what took 34:
// flat to 19 kHz (-0.09 dB, -0.46 at 20 kHz), errors that land below 20 kHz 75-79 dB down on
// sines (76-87 dB on the stems, against soxr), half the time (110 ms against 210-240 for a 66 s
// stem, Node and Chrome). Other rates (going down, or up by less) keep the old filter, which cuts
// below both Nyquists.
const CV_RATE = 160 / 147 - 1e-6;             // 44.1 -> 48 kHz, the smallest step up the short filter serves
const CV_HALF = 10, CV_CUT = 1.04;           // taps per side; cutoff as a fraction of the input Nyquist
const CV_ZC = 16, CV_SAFE_CUT = 0.97;        // the other rates' filter
const CV_PHASES = 6400, CV_BLOCK = 2048;     // see convertLoop

// chans: the loop in [0, n), Float32Array[] or Int16Array[] (scaled by `scale`); returns new channels
// of outLen + room samples (the loop, then spare room). Each output takes the nearest of
// CV_PHASES phases: a multiple of 160 and 320, so an exact 44.1 -> 48 or 96 kHz step reads exact
// rows, and otherwise the position is at most 1/12800 sample off (the error that leaves at 19 kHz
// is 75 dB down). The input is read a block at a time through a small float copy, wrapped at the
// loop's end and scaled from 16-bit there, so the inner loop has no wrap or bounds cases and sees
// one array type whatever the job sent (reading both types in one loop cost 15%).
function convertLoop(chans, n, outLen, room, scale, short) {
  const step = n / outLen, P = CV_PHASES;
  const fc = short ? CV_CUT : CV_SAFE_CUT * Math.min(1, 1 / step), half = short ? CV_HALF : Math.ceil(CV_ZC / fc), T = 2 * half;
  const { table } = kernel(fc, half, P);
  const nCh = chans.length, outs = chans.map(() => new Float32Array(outLen + room));
  const span = Math.ceil(CV_BLOCK * step) + T + 1, w0 = new Float64Array(span), w1 = new Float64Array(span);
  for (let c = 0; c < nCh; c += 2) { // channels in pairs; a lone last one is its own pair
    const s0 = chans[c], s1 = chans[Math.min(c + 1, nCh - 1)], o0 = outs[c], o1 = outs[Math.min(c + 1, nCh - 1)];
    for (let i0 = 0; i0 < outLen; i0 += CV_BLOCK) {
      const i1 = Math.min(outLen, i0 + CV_BLOCK), first = Math.floor(i0 * step) - half + 1;
      const m = Math.floor((i1 - 1) * step) + half + 1 - first;
      for (let j = 0, q = first < 0 ? first + n : first; j < m; j++, q++) {
        if (q === n) q = 0;
        w0[j] = s0[q] * scale; w1[j] = s1[q] * scale;
      }
      for (let i = i0; i < i1; i++) {
        // Row P (a whole sample on) is the next sample's row 0, so the nearest row is always in reach.
        const x = i * step, b = Math.floor(x);
        let r = Math.round((x - b) * P) * T, j = b - half + 1 - first, a0 = 0, a1 = 0, c0 = 0, c1 = 0;
        for (const end = r + T; r < end; r += 2, j += 2) {
          const u = table[r], v = table[r + 1];
          a0 += w0[j] * u; c0 += w0[j + 1] * v; a1 += w1[j] * u; c1 += w1[j + 1] * v;
        }
        o0[i] = a0 + c0; o1[i] = a1 + c1;
      }
    }
  }
  return outs;
}

// ---------- near-unity nudge ----------
// A first pick is usually a few samples off its whole-bar length (48 of the 57 stems are -16..+15
// samples off). Resampling the whole loop for that took 300-450 ms; instead (15-45 ms) each
// missing or extra sample is taken up by a smooth one-sample glide over NUDGE_W samples (at most
// 2.7 cents for 23 ms) at the quietest spot of its own stretch of the loop, and everything else
// is copied. The loop's ends are copied verbatim, so the wrap stays seamless, and timing stays
// within ~1 sample of a plain resample.
const NUDGE_MAX = 32, NUDGE_W = 1024, NUDGE_B = 256, NUDGE_PHASES = 256;
const canNudge = (n, targetLen) => (n - 4 * NUDGE_W) / Math.abs(targetLen - n) >= 2 * NUDGE_W;
// Its own small sinc table (phases are interpolated, so 256 are plenty): the resampler's takes
// ~12 ms to build, longer than the whole nudge. Cutoff at Nyquist, so whole-sample positions read
// back exactly and the glides join the copies seamlessly.
let nudgeTable = null;
function nudgeKernel() {
  if (nudgeTable) return nudgeTable;
  const half = RS_ZC, taps = 2 * half, t = new Float32Array((NUDGE_PHASES + 1) * taps), norm = besselI0(RS_BETA);
  for (let p = 0; p <= NUDGE_PHASES; p++) {
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - p / NUDGE_PHASES, r = x / half;
      const v = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (r <= -1 || r >= 1 ? 0 : besselI0(RS_BETA * Math.sqrt(1 - r * r)) / norm);
      t[p * taps + k] = v; sum += v;
    }
    for (let k = 0; k < taps; k++) t[p * taps + k] /= sum;
  }
  return (nudgeTable = t);
}

function nudgeLoop(chans, n, targetLen, scale) {
  const d = targetLen - n, k = Math.abs(d), dir = d > 0 ? -1 : 1; // input read ahead per glide
  const W = NUDGE_W, B = NUDGE_B, nCh = chans.length, half = RS_ZC, taps = 2 * half, table = nudgeKernel();
  // Loudness of each block (every 8th sample of the mono sum is plenty to rank them), as prefix sums.
  const nb = Math.floor(n / B), E = new Float64Array(nb + 1), c0 = chans[0], c1 = chans[nCh - 1];
  for (let b = 0; b < nb; b++) {
    let e = 0;
    for (let i = b * B, end = i + B; i < end; i += 8) { const m = c0[i] + c1[i]; e += m * m; }
    E[b + 1] = E[b] + e;
  }
  const margin = 2 * W, seg = (n - 2 * margin) / k, wb = W / B;
  const out = chans.map(() => new Float32Array(targetLen));
  const copy = (o, i, len) => {
    for (let c = 0; c < nCh; c++) {
      if (scale === 1) out[c].set(chans[c].subarray(i, i + len), o);
      else for (let j = 0, src = chans[c], dst = out[c]; j < len; j++) dst[o + j] = src[i + j] * scale;
    }
  };
  let o = 0, i = 0; // next output and input sample
  for (let s = 0; s < k; s++) {
    const lo = Math.ceil((margin + s * seg) / B), hi = Math.max(lo, Math.floor((margin + (s + 1) * seg - W) / B) - 1);
    let best = lo, bestE = Infinity;
    for (let b = lo; b <= hi; b++) { const e = E[b + wb] - E[b]; if (e < bestE) { bestE = e; best = b; } }
    const at = best * B;
    copy(o, i, at - i);
    o += at - i; i = at;
    for (let j = 0; j < W; j++) {
      const x = i + j + dir * (0.5 - 0.5 * Math.cos((Math.PI * j) / W));
      const base = Math.floor(x), f = (x - base) * NUDGE_PHASES, p = Math.min(NUDGE_PHASES - 1, Math.floor(f)), t = f - p;
      const r0 = p * taps, r1 = r0 + taps, b0 = base - half + 1;
      for (let c = 0; c < nCh; c++) {
        const src = chans[c];
        let acc = 0;
        for (let q = 0; q < taps; q++) acc += src[b0 + q] * (table[r0 + q] + t * (table[r1 + q] - table[r0 + q]));
        out[c][o + j] = acc * scale;
      }
    }
    o += W; i += W + dir;
  }
  copy(o, i, n - i);
  return out;
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

// chans: the loop in [0, inLen) (16-bit values when scale != 1); returns targetLen samples per
// channel. `onsets` overrides the attacks found on chans, and `exact` plays each pinned attack from
// exactly its stretched time instead of searching +-tol around it (the hq path stretches only the
// percussive part, so it pins the whole stem's attacks, on the grid). `pinned`, when given, gets
// the attacks that were pinned (input times).
function timeStretch(chans, inLen, targetLen, sampleRate, type, scale = 1, onsets = null, exact = false, pinned = null) {
  const nCh = chans.length;
  if (targetLen === inLen) return chans.map((c) => toFloat(c, inLen, scale));
  const stretch = targetLen / inLen;
  // Within ~1.7 cents of unity a plain loop resample beats splicing, and unlike
  // wrap/trim it keeps the seam continuous.
  if (Math.abs(stretch - 1) < 0.001) return resampleLoop(scale === 1 ? chans : chans.map((c) => toFloat(c, inLen, scale)), inLen, targetLen);

  const { seqLen, seek, Wd, tail } = lens(sampleRate);
  const ovl = Math.round(OVL_S * sampleRate);
  const hopN = seqLen - ovl;
  // Frames tile [0, span) exactly. The last frame's tail, [span, targetLen), is
  // crossfaded into src[inLen - ovl .. inLen), the material that leads into the
  // loop start, so out[targetLen - 1] -> out[0] is a natural continuation.
  const span = targetLen - ovl;
  const closeRef = inLen - ovl;

  // Circularly extended input: frames and references read past inLen. Float input with that
  // much spare room (a resampled copy, or the caller's) is extended in place instead of copied.
  const total = inLen + tail;
  const src = chans.map((c) => {
    const a = scale === 1 && c.length >= total ? (c.length === total ? c : c.subarray(0, total)) : toFloat(c, inLen, scale, tail);
    for (let i = inLen; i < total; i++) a[i] = a[i - inLen];
    return a;
  });
  chans = null;
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
  const cfg = ANCHOR[type] || ANCHOR.groove;
  const tol = Math.round(cfg.tol * sampleRate), pre = ovl + tol + 32, minGap = 2 * ovl;
  const anchors = [[0, 0]];
  for (const t of onsets || findOnsets(src, inLen, sampleRate, cfg)) {
    const aIn = t - pre, aOut = Math.round(t * stretch) - pre, [pIn, pOut] = anchors[anchors.length - 1];
    if (aIn - pIn >= minGap + tol && aOut - pOut >= minGap && closeRef - aIn >= minGap + tol && span - aOut >= minGap) {
      anchors.push([aIn, aOut]);
      if (pinned) pinned.push(t);
    }
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
      else if (i === 0) { start = exact ? inA : search(inA, nat, hopK, -1, inA - tol, inA + tol, Math.max(1, tol)); if (exact) rho = simAt(nat, inA); }
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

// ---------- FFT ----------
// Real-input FFT of N points through a complex FFT of N/2 (about half the work). forward():
// N samples -> bins 0..N/2 (re, im); inverse(): its exact inverse. Cached per size.
const ffts = new Map();
function rfft(N) {
  let f = ffts.get(N);
  if (f) return f;
  const h = N >> 1, bits = Math.round(Math.log2(h));
  const rev = new Uint32Array(h);
  for (let i = 0; i < h; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  // Twiddles per stage (stage with butterfly span `half` at [half, 2 * half)), then e^(-i pi k / h).
  const tc = new Float64Array(h), ts = new Float64Array(h), wc = new Float64Array(h), ws = new Float64Array(h);
  for (let half = 1; half < h; half <<= 1) for (let j = 0; j < half; j++) { tc[half + j] = Math.cos((Math.PI * j) / half); ts[half + j] = -Math.sin((Math.PI * j) / half); }
  for (let k = 0; k < h; k++) { wc[k] = Math.cos((Math.PI * k) / h); ws[k] = -Math.sin((Math.PI * k) / h); }
  const zr = new Float64Array(h), zi = new Float64Array(h);
  const cfft = (sign) => { // radix-2, the first two stages without multiplies
    for (let i = 0; i < h; i++) { const j = rev[i]; if (j > i) { let t = zr[i]; zr[i] = zr[j]; zr[j] = t; t = zi[i]; zi[i] = zi[j]; zi[j] = t; } }
    for (let i = 0; i < h; i += 2) { const ar = zr[i], ai = zi[i], br = zr[i + 1], bi = zi[i + 1]; zr[i] = ar + br; zi[i] = ai + bi; zr[i + 1] = ar - br; zi[i + 1] = ai - bi; }
    for (let i = 0; h >= 4 && i < h; i += 4) {
      let ar = zr[i], ai = zi[i], br = zr[i + 2], bi = zi[i + 2];
      zr[i] = ar + br; zi[i] = ai + bi; zr[i + 2] = ar - br; zi[i + 2] = ai - bi;
      ar = zr[i + 1]; ai = zi[i + 1]; br = sign * zi[i + 3]; bi = -sign * zr[i + 3];
      zr[i + 1] = ar + br; zi[i + 1] = ai + bi; zr[i + 3] = ar - br; zi[i + 3] = ai - bi;
    }
    for (let half = 4; half < h; half <<= 1) {
      const size = half << 1;
      for (let j = 0; j < half; j++) {
        const c = tc[half + j], s = sign * ts[half + j];
        for (let a = j; a < h; a += size) {
          const b = a + half, tr = zr[b] * c - zi[b] * s, ti = zr[b] * s + zi[b] * c;
          zr[b] = zr[a] - tr; zi[b] = zi[a] - ti; zr[a] += tr; zi[a] += ti;
        }
      }
    }
  };
  f = {
    forward(x, re, im) {
      for (let j = 0; j < h; j++) { zr[j] = x[2 * j]; zi[j] = x[2 * j + 1]; }
      cfft(1);
      re[0] = zr[0] + zi[0]; im[0] = 0; re[h] = zr[0] - zi[0]; im[h] = 0;
      for (let k = 1; k < h; k++) {
        const ar = zr[k], ai = zi[k], br = zr[h - k], bi = -zi[h - k];
        const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi), or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
        const c = wc[k], s = ws[k];
        re[k] = er + or * c - oi * s; im[k] = ei + or * s + oi * c;
      }
    },
    inverse(re, im, x) {
      for (let k = 0; k < h; k++) {
        const ar = re[k], ai = im[k], br = re[h - k], bi = -im[h - k];
        const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi), dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
        const c = wc[k], s = -ws[k], or = dr * c - di * s, oi = dr * s + di * c;
        zr[k] = er - oi; zi[k] = ei + or;
      }
      cfft(-1);
      for (let j = 0; j < h; j++) { x[2 * j] = zr[j] / h; x[2 * j + 1] = zi[j] / h; }
    },
  };
  ffts.set(N, f);
  return f;
}

const hanns = new Map();
function hann(N) {
  let w = hanns.get(N);
  if (!w) { w = new Float64Array(N); for (let j = 0; j < N; j++) w[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N); hanns.set(N, w); }
  return w;
}

// Overlap-add gain for Hann frames of N samples centred every H samples (0, H, .., (F-1)H) around a
// loop of len samples. The windows' squares sum to a constant except near the wrap, where the last
// hop is short, so only those samples get their own gain: inv[q] for sample (start + q) % len.
function olaGain(len, N, H, F, w) {
  let sq = 0;
  for (let j = 0; j < N; j++) sq += w[j] * w[j];
  const m = Math.min(len, 2 * N), start = m === len ? 0 : len - N, sum = new Float64Array(m);
  for (let f = 0; f < F; f++) {
    const c = f * H;
    if (m < len && Math.min(c, len - c) > 1.5 * N) continue; // nowhere near the wrap
    for (let j = 0; j < N; j++) {
      const q = ((((c - N / 2 + j - start) % len) + len) % len);
      if (q < m) sum[q] += w[j] * w[j];
    }
  }
  const inv = new Float32Array(m);
  for (let q = 0; q < m; q++) inv[q] = 1 / Math.max(sum[q], 1e-3);
  return { start, inv, m, rest: H / sq };
}

const princarg = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// ---------- formant correction ----------
// Resampling by `ratio` moves a voice's formants along with its pitch (chipmunk up, giant down).
// This puts the spectral envelope back: an STFT over the loop (circular), each frame scaled by
// E(f * ratio) / E(f), where E is the frame's envelope (formantGains) and f * ratio is where the
// original envelope now sits. Returns the corrected loop with `room` spare samples.
const FORMANT_N = 2048, FORMANT_HOP = 512, FORMANT_LIFTER_S = 0.0022, FORMANT_DB = 20;

function formantPass(x, n, sr, ratio, room) {
  const N = FORMANT_N, H = FORMANT_HOP, nb = N / 2 + 1, nCh = x.length, F = Math.max(1, Math.ceil(n / H));
  const fft = rfft(N), w = hann(N), y = x.map(() => new Float32Array(n + room));
  const spec = x.map(() => [new Float64Array(nb), new Float64Array(nb)]);
  const fbuf = new Float64Array(N), P = new Float64Array(nb), G = new Float64Array(nb), st = formantState(nb);
  const kTop = Math.floor(0.9 * (nb - 1) * Math.min(ratio, 1 / ratio)); // above it the resampled loop has no envelope to read
  for (let f = 0; f < F; f++) {
    const s0 = f * H - N / 2;
    P.fill(0);
    for (let c = 0; c < nCh; c++) {
      const [re, im] = spec[c];
      windowed(x[c], n, s0, w, fbuf);
      fft.forward(fbuf, re, im);
      for (let k = 0; k < nb; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    }
    formantGains(P, nb, sr, ratio, G, kTop, st);
    for (let c = 0; c < nCh; c++) {
      const [re, im] = spec[c];
      for (let k = 0; k < nb; k++) { re[k] *= G[k]; im[k] *= G[k]; }
      fft.inverse(re, im, fbuf);
      overlapAdd(y[c], n, s0, fbuf, w);
    }
  }
  const g = olaGain(n, N, H, F, w);
  for (const o of y) normalise(o, n, g);
  return y;
}

// Formant-correction gains G for one frame's power spectrum P (nb bins). The envelope E is the
// cepstrum of the log spectrum liftered below the voice's pitch period (the cepstrum's peak; at
// most FORMANT_LIFTER_S), so a high voice's harmonics don't leak into it. It is computed on every
// other bin (half-size FFTs; quefrencies up to 11.6 ms still fit). G(f) = E(f * ratio) / E(f) as
// amplitude, clamped to FORMANT_DB; from kTop up it holds its last value.
function formantGains(P, nb, sr, ratio, G, kTop, st) {
  const m = (nb - 1) >> 1, M = 2 * m, fft = rfft(M), { env, re, im, buf } = st;
  let mx = 0;
  for (let k = 0; k < nb; k++) if (P[k] > mx) mx = P[k];
  const fl = mx * 1e-10 + 1e-30;
  re[0] = Math.log(P[0] + fl);
  for (let j = 1; j < m; j++) re[j] = Math.log(0.25 * P[2 * j - 1] + 0.5 * P[2 * j] + 0.25 * P[2 * j + 1] + fl);
  re[m] = Math.log(P[2 * m] + fl);
  im.fill(0);
  fft.inverse(re, im, buf); // real cepstrum
  let Q = Math.round(FORMANT_LIFTER_S * sr), q0 = 0, best = 0.05;
  for (let q = Math.round(0.001 * sr); q < m - 1; q++) if (buf[q] > best) { best = buf[q]; q0 = q; }
  if (q0) Q = Math.max(Math.round(0.001 * sr), Math.min(Q, Math.round(0.75 * q0)));
  for (let q = 1; q < Q; q++) { const l = q < 0.75 * Q ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (q - 0.75 * Q)) / (0.25 * Q)); buf[q] *= l; buf[M - q] *= l; }
  for (let q = Q; q <= M - Q; q++) buf[q] = 0;
  fft.forward(buf, env, im); // env: smoothed log power, on every other bin
  const gMax = 10 ** (FORMANT_DB / 20), gMin = 1 / gMax;
  // Written out by hand: with a helper closure and Math.min/floor this loop took 3x as long as
  // all the rest of the frame's work.
  for (let k = 0; k <= kTop; k++) {
    const x = 0.5 * k * ratio, j = x < m - 1 ? x | 0 : m - 1, t = x - j < 1 ? x - j : 1, i = k >> 1;
    const g = Math.exp(0.5 * (env[j] + t * (env[j + 1] - env[j]) - (k & 1 ? 0.5 * (env[i] + env[i + 1]) : env[i])));
    G[k] = g > gMax ? gMax : g < gMin ? gMin : g;
  }
  for (let k = kTop + 1; k < nb; k++) G[k] = G[kTop];
}
function formantState(nb) {
  const m = (nb - 1) >> 1;
  return { env: new Float64Array(m + 1), re: new Float64Array(m + 1), im: new Float64Array(m + 1), buf: new Float64Array(2 * m) };
}

// ---------- harmonic/percussive split ----------
// Fitzgerald's median filtering over an STFT of the loop (circular): a bin that is steady across
// ~400 ms is harmonic, one that is broadband across ~180 Hz is percussive. The masks are soft and
// the harmonic part is what the percussive part leaves, so the two add back up to x exactly. They
// lean towards harmonic (SP_BIAS, SP_POW): a dense low chord looks broadband at this resolution,
// and whatever is wrongly called percussive goes through WSOLA and warbles again. Returns
// { h, p, low }: p has `room` spare samples, h reuses x's memory, low is the share of h's energy
// below PV_LOW_HZ.
const SP_N = 4096, SP_HOP = 1024, SP_MED = 17, SP_BIAS = 2, SP_POW = 2;

function splitPass(x, n, sr, room) {
  const N = SP_N, H = SP_HOP, nb = N / 2 + 1, nCh = x.length, L = SP_MED >> 1, K = 2 * L + 1;
  const fft = rfft(N), w = hann(N), F = Math.max(1, Math.ceil(n / H)), p = x.map(() => new Float32Array(n + room));
  // Ring of the last K frames: power (summed over channels) and spectra. Each frame's mask needs
  // L frames either side, so the pass starts L frames before the loop start and ends L after it.
  const pw = new Float32Array(K * nb), spec = [];
  for (let r = 0; r < K; r++) spec.push(x.map(() => [new Float64Array(nb), new Float64Array(nb)]));
  const sortedT = new Float32Array(nb * K), sortedF = new Float32Array(K); // per bin: the last K powers, sorted
  const fbuf = new Float64Array(N), re = new Float64Array(nb), im = new Float64Array(nb), newP = new Float32Array(nb);
  const mask = new Float64Array(nb), Pf = new Float64Array(nb), kLow = Math.round((PV_LOW_HZ * N) / sr);
  let eLow = 0, eAll = 0;
  for (let i = 0; i < F + 2 * L; i++) {
    const row = i % K, s0 = ((((i - L) % F) + F) % F) * H - N / 2;
    newP.fill(0);
    for (let c = 0; c < nCh; c++) {
      const [sr_, si] = spec[row][c];
      windowed(x[c], n, s0, w, fbuf);
      fft.forward(fbuf, sr_, si);
      for (let k = 0; k < nb; k++) newP[k] += sr_[k] * sr_[k] + si[k] * si[k];
    }
    const P = pw.subarray(row * nb, row * nb + nb);
    for (let k = 0, base = 0; k < nb; k++, base += K) {
      if (i < K) insertSorted(sortedT, base, i, newP[k]);
      else replaceSorted(sortedT, base, K, P[k], newP[k]);
      P[k] = newP[k];
    }
    if (i < 2 * L) continue;
    // Frame o (analysed L steps ago): median over K neighbouring bins (edges repeated), then the mask.
    const orow = (i - L) % K, os = (i - 2 * L) * H - N / 2, Po = pw.subarray(orow * nb, orow * nb + nb);
    const at = (k) => Po[k < 0 ? 0 : k >= nb ? nb - 1 : k];
    for (let j = 0; j < K; j++) insertSorted(sortedF, 0, j, at(j - L));
    Pf[0] = sortedF[L];
    for (let k = 1; k < nb; k++) { replaceSorted(sortedF, 0, K, at(k - 1 - L), at(k + L)); Pf[k] = sortedF[L]; }
    for (let k = 0, base = L; k < nb; k++, base += K) {
      const ph = Pf[k], hh = SP_BIAS * sortedT[base];
      mask[k] = ph + hh > 0 ? 1 / (1 + (hh / ph) ** SP_POW) : 0.5;
      const eh = Po[k] * (1 - mask[k]) * (1 - mask[k]);
      eAll += eh;
      if (k < kLow) eLow += eh;
    }
    for (let c = 0; c < nCh; c++) {
      const [sr_, si] = spec[orow][c];
      for (let k = 0; k < nb; k++) { re[k] = sr_[k] * mask[k]; im[k] = si[k] * mask[k]; }
      fft.inverse(re, im, fbuf);
      overlapAdd(p[c], n, os, fbuf, w);
    }
  }
  const g = olaGain(n, N, H, F, w);
  for (const o of p) normalise(o, n, g);
  for (let c = 0; c < nCh; c++) { const hc = x[c], pc = p[c]; for (let j = 0; j < n; j++) hc[j] -= pc[j]; }
  return { h: x, p, low: eAll > 0 ? eLow / eAll : 0 };
}

function windowed(xc, n, s0, w, out) {
  const N = w.length;
  if (s0 >= 0 && s0 + N <= n) for (let j = 0; j < N; j++) out[j] = xc[s0 + j] * w[j];
  else for (let j = 0; j < N; j++) out[j] = xc[((((s0 + j) % n) + n) % n)] * w[j];
}

function overlapAdd(o, n, s0, frame, w) {
  const N = frame.length;
  if (s0 >= 0 && s0 + N <= n) for (let j = 0; j < N; j++) o[s0 + j] += frame[j] * w[j];
  else for (let j = 0; j < N; j++) o[((((s0 + j) % n) + n) % n)] += frame[j] * w[j];
}

function normalise(o, n, g) {
  for (let j = 0; j < n; j++) o[j] *= g.rest;
  for (let q = 0; q < g.m; q++) { const j = (g.start + q) % n; o[j] *= g.inv[q] / g.rest; }
}

// Sorted windows (ascending) at arr[base .. base + count): insert v, or replace old with v.
function insertSorted(arr, base, count, v) {
  let i = base + count;
  while (i > base && arr[i - 1] > v) { arr[i] = arr[i - 1]; i--; }
  arr[i] = v;
}
function replaceSorted(arr, base, K, old, v) {
  const end = base + K;
  let i = base;
  while (i < end - 1 && arr[i] !== old) i++;
  if (v > old) while (i + 1 < end && arr[i + 1] < v) { arr[i] = arr[i + 1]; i++; }
  else while (i > base && arr[i - 1] > v) { arr[i] = arr[i - 1]; i--; }
  arr[i] = v;
}

// ---------- hq: phase vocoder for the harmonic part, anchored WSOLA for the rest ----------
// WSOLA's splices can't line up every partial of a held chord at once, so pads and chords
// warble at the splice rate; a phase vocoder doesn't, but it smears attacks. So the loop is
// split (splitPass): the percussive part goes through the same anchored WSOLA as the fast
// path, pinned to the whole stem's attacks and playing each from exactly its stretched time (the
// fast render puts it within 3 ms of there), and the harmonic part through the phase vocoder,
// whose time map is the same straight line, except right around those attacks (keepAttacks).
// FFT size: 4096 (93 ms) follows note changes and voices best on the real stems; 8192 is needed
// to resolve low chords (notes 20-30 Hz apart), so it is used when most of the harmonic energy
// is below PV_LOW_HZ. Not on a full mix: its kick and bass always put it there, and with its
// drums 8192 measured worse at every setting tried (Alive at 0.63-1.7x and -6 st: 0.9-2.4 dB
// further from the input, more energy just ahead of the hits, no cleaner partials).
const PV_LOW_HZ = 300, pvSize = (low, type) => (low > 0.5 && type !== 'all' ? 8192 : 4096);
const PV_CLOSE_S = 1.5; // the vocoder's phases are steered back into step with the loop start over this long

function hqStretch(x, n, targetLen, sr, type, ratio) {
  if (ratio !== 1) x = formantPass(x, n, sr, ratio, 0);
  const onsets = findOnsets(x, n, sr, ANCHOR[type] || ANCHOR.groove);
  let { h, p, low } = splitPass(x, n, sr, tailRoom(sr));
  x = null;
  const want = blockEnergy(h, p, n, Math.max(1, Math.round(targetLen / (LEVEL_S * sr))), targetLen / n);
  const pinned = [], out = timeStretch(p, n, targetLen, sr, type, 1, onsets, true, pinned);
  p = null;
  const N = pvSize(low, type), hOut = pvStretch(h, n, targetLen, sr, N);
  keepAttacks(hOut, h, n, targetLen, pinned, sr, N);
  h = null;
  for (let c = 0; c < out.length; c++) { const o = out[c], y = hOut[c]; for (let i = 0; i < targetLen; i++) o[i] += y[i]; hOut[c] = null; }
  levelMatch(out, want);
  return out;
}

// The vocoder spreads each attack's harmonic part over the frames around it, so at large ratios
// a note starts several ms early and soft (measured: the hq render's attacks were found 5 ms
// early, half of them more than 2 ms off, on leads and textures). So around each attack the
// harmonic part plays as it is, from KEEP_PRE_S before it to KEEP_POST_S after (both longer
// with the long FFT, which smears further), placed so the attack lands on its stretched time
// like the percussive part's. Both ends are crossfaded with the vocoder's output, at equal power
// where the two don't correlate (the usual case: the vocoder's phases are its own). Only attacks
// where the harmonic part itself changes get this: at least KEEP_NEW of its spectrum just after
// the attack must be new (a note starting). A drum hit over a held chord leaves it as it was,
// and a splice there would only cost the vocoder's smoothness (on the full mix, keeping every
// attack took half the hq gain away). An attack whose span would run into the previous one's
// keeps the vocoder's version.
const KEEP_PRE_S = 0.03, KEEP_POST_S = 0.045, KEEP_FADE_S = 0.01, KEEP_NEW = 0.5;
function keepAttacks(hOut, h, n, len, onsets, sr, N) {
  const sc = N / 4096, A = Math.round(KEEP_PRE_S * sr * sc), B = Math.round(KEEP_POST_S * sr * sc), X = Math.round(KEEP_FADE_S * sr);
  const s = len / n, nCh = h.length, at = [];
  if (len < 8 * (A + B)) return;
  const wrapO = (i) => ((i % len) + len) % len, wrapI = (i) => ((i % n) + n) % n;
  // Power spectrum of h (channels summed) in a 2048-sample window centred at c.
  const M = 2048, fft = rfft(M), w = hann(M), buf = new Float64Array(M), re = new Float64Array(M / 2 + 1), im = new Float64Array(M / 2 + 1);
  const power = (c0) => {
    const P = new Float64Array(M / 2 + 1);
    for (const x of h) {
      windowed(x, n, wrapI(c0 - M / 2), w, buf);
      fft.forward(buf, re, im);
      for (let k = 0; k < P.length; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    }
    return P;
  };
  const after = Math.round(0.025 * sr), before = Math.round(0.053 * sr); // windows end 30 ms before / start just after
  for (const t of onsets) {
    const o = Math.round(t * s);
    if (at.length && o - A < at[at.length - 1][1] + B + X) continue;
    const Pa = power(t + after), Pb = power(t - before);
    let fresh = 0, all = 0;
    for (let k = 2; k < Pa.length; k++) { fresh += Math.max(0, Pa[k] - Pb[k]); all += Pa[k]; }
    if (fresh >= KEEP_NEW * all && all > 0) at.push([t, o]);
  }
  if (at.length > 1 && at[0][1] - A + len < at[at.length - 1][1] + B + X) at.pop(); // the spans meet across the wrap
  const fade = new Float64Array(X);
  for (let j = 0; j < X; j++) fade[j] = 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / X);
  // Correlation of the vocoder's output and the kept part over a crossfade starting at output i.
  const corr = (i, d) => {
    let ab = 0, aa = 0, bb = 0;
    for (let j = i; j < i + X; j++) for (let c = 0; c < nCh; c++) { const a = hOut[c][wrapO(j)], b = h[c][wrapI(j + d)]; ab += a * b; aa += a * a; bb += b * b; }
    return Math.min(1, Math.max(0, ab / (Math.sqrt(aa * bb) + 1e-20)));
  };
  for (const [t, o] of at) {
    const start = o - A, end = o + B, d = t - o, r0 = corr(start, d), r1 = corr(end - X, d);
    for (let i = start; i < end; i++) {
      let a = 0, b = 1; // weights of the vocoder's output and of the kept part
      if (i < start + X || i >= end - X) {
        const f = i < start + X ? fade[i - start] : fade[end - 1 - i], r = i < start + X ? r0 : r1;
        const g = 1 / Math.sqrt((1 - f) * (1 - f) + f * f + 2 * r * f * (1 - f));
        a = (1 - f) * g; b = f * g;
      }
      const j = wrapO(i), q = wrapI(i + d);
      for (let c = 0; c < nCh; c++) hOut[c][j] = a * hOut[c][j] + b * h[c][q];
    }
  }
}

// Rendering the two parts their own ways loses the correlation between them where a bin was
// split (noise, reverb), and vocoder frames of noise add partly out of phase, so the sum comes
// out up to 3 dB quiet on noisy material at large ratios. So each ~LEVEL_S of the result is
// brought back to the level of the input it was read from (by -1..+3 dB, the gain interpolated
// between blocks around the loop). blockEnergy: energy of h + p in `nk` equal blocks, times `scale`.
const LEVEL_S = 0.5, LEVEL_MIN = 0.89, LEVEL_MAX = 1.41;
function blockEnergy(h, p, n, nk, scale) {
  const e = new Float64Array(nk);
  for (let k = 0; k < nk; k++) {
    for (let c = 0; c < h.length; c++) {
      const a = h[c], b = p[c];
      for (let i = Math.round((k * n) / nk), end = Math.round(((k + 1) * n) / nk); i < end; i++) { const v = a[i] + b[i]; e[k] += v * v; }
    }
    e[k] *= scale;
  }
  return e;
}
function levelMatch(out, want) {
  const len = out[0].length, nk = want.length, gain = new Float64Array(nk), B = len / nk;
  for (let k = 0; k < nk; k++) {
    let e = 0;
    for (const o of out) for (let i = Math.round(k * B), end = Math.round((k + 1) * B); i < end; i++) e += o[i] * o[i];
    gain[k] = e > 0 ? Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.sqrt(want[k] / e))) : 1;
  }
  for (const o of out) {
    for (let k = 0; k < nk; k++) { // ramps from block centre to block centre
      const a = Math.round((k + 0.5) * B), b = Math.round((k + 1.5) * B), g0 = gain[k], d = (gain[(k + 1) % nk] - g0) / (b - a);
      for (let i = a; i < b; i++) o[i < len ? i : i - len] *= g0 + d * (i - a);
    }
  }
}

// Phase vocoder with identity phase locking (Laroche & Dolson): frames of N samples every N/4 of
// output, read from the loop on the straight line t * targetLen / n. Each spectral peak's phase
// advances at its measured frequency; the bins around it keep their phase relation to it, which
// keeps partials and their sidebands coherent (no 'phasiness'). The peaks and their phases come
// from the mid (or side, when that is stronger) and both channels get the same rotation, so each
// keeps its phase offset from the other and the stereo image holds.
function pvStretch(h, n, targetLen, sr, N) {
  const nCh = h.length, half = N >> 1, nb = half + 1, Hs = N >> 2;
  const F = Math.max(2, Math.ceil(targetLen / Hs));
  const tS = (m) => (m >= F ? targetLen : m * Hs);                              // output centre
  const tA = (m) => (m >= F ? n : Math.round((m * Hs * n) / targetLen));         // input centre
  const fft = rfft(N), w = hann(N), g = olaGain(targetLen, N, Hs, F, w);
  const fbuf = new Float64Array(N), re = new Float64Array(nb), im = new Float64Array(nb);
  const spectra = () => h.map(() => [new Float64Array(nb), new Float64Array(nb)]);
  let cur = spectra(), prev = spectra();
  const hOut = h.map(() => new Float32Array(targetLen));
  const analyse = (m, spec) => {
    const s0 = (m >= F ? 0 : tA(m)) - half;
    for (let c = 0; c < nCh; c++) { windowed(h[c], n, s0, w, fbuf); fft.forward(fbuf, spec[c][0], spec[c][1]); }
  };
  const lock = phaseLocker(nb, N, nCh);
  // The loop must close: the frames before the wrap have to arrive in phase with frame 0, which
  // plays the input as it is. So the phases are also run backwards from frame 0 over the last J
  // frames, and the forward phases are steered onto that track over those frames (a glide of
  // at most half a cycle over PV_CLOSE_S, a fraction of a Hz).
  const J = Math.min(Math.round((PV_CLOSE_S * sr) / Hs), (F - 1) >> 1), back = [];
  if (J > 0) {
    analyse(F, prev);
    let dn = new Float64Array(nb);
    for (let m = F - 1; m >= F - J; m--) {
      analyse(m, cur);
      const db = new Float64Array(nb);
      lock(cur, prev, tA(m) - tA(m + 1), tS(m) - tS(m + 1), dn, db, null, 0, false);
      back[m - (F - J)] = db; dn = db;
      [cur, prev] = [prev, cur];
    }
  }
  let d = new Float64Array(nb), dPrev = new Float64Array(nb);
  const rc = new Float64Array(nb).fill(1), rs = new Float64Array(nb);
  for (let m = 0; m < F; m++) {
    analyse(m, cur);
    if (m > 0) {
      const steer = m >= F - J ? back[m - (F - J)] : null;
      lock(cur, prev, tA(m) - tA(m - 1), tS(m) - tS(m - 1), dPrev, d, steer, steer ? 1 / (F - m) : 0, true, rc, rs);
    }
    const s0 = tS(m) - half, q0 = (((s0 - g.start) % targetLen) + targetLen) % targetLen;
    const edge = s0 < 0 || s0 + N > targetLen || q0 < g.m || q0 + N > targetLen;
    for (let c = 0; c < nCh; c++) {
      const [ar, ai] = cur[c];
      for (let k = 0; k < nb; k++) { re[k] = ar[k] * rc[k] - ai[k] * rs[k]; im[k] = ar[k] * rs[k] + ai[k] * rc[k]; }
      fft.inverse(re, im, fbuf);
      const o = hOut[c];
      if (!edge) for (let j = 0; j < N; j++) o[s0 + j] += fbuf[j] * w[j] * g.rest;
      else for (let j = 0; j < N; j++) {
        const t = ((((s0 + j) % targetLen) + targetLen) % targetLen), q = (t - g.start + targetLen) % targetLen;
        o[t] += fbuf[j] * w[j] * (q < g.m ? g.inv[q] : g.rest);
      }
    }
    [cur, prev] = [prev, cur];
    [d, dPrev] = [dPrev, d];
  }
  return hOut;
}

// Identity phase locking for one frame. cur/prev: spectra per channel; Ha, Hs: input and output
// hops from prev to cur (negative when running backwards); dPrev: each bin's phase rotation in
// prev. Fills d (and rc, rs: its cos and sin) with this frame's rotation, steered by `wt` of the
// way onto `steer` when given.
function phaseLocker(nb, N, nCh) {
  const P = new Float64Array(nb), peaks = new Int32Array(nb), pd = new Float64Array(nb);
  return (cur, prev, Ha, Hs, dPrev, d, steer, wt, trig, rc, rs) => {
    const [Lr, Li] = cur[0], [Rr, Ri] = cur[nCh - 1], [lr, li] = prev[0], [rr, ri] = prev[nCh - 1];
    let mx = 0;
    for (let k = 0; k < nb; k++) { const v = Lr[k] * Lr[k] + Li[k] * Li[k] + Rr[k] * Rr[k] + Ri[k] * Ri[k]; P[k] = v; if (v > mx) mx = v; }
    const thr = mx * 1e-9;
    let np = 0;
    for (let k = 1; k < nb - 1; k++) {
      const v = P[k];
      if (v > thr && v > P[k - 1] && v >= P[k + 1] && (k < 2 || v > P[k - 2]) && (k > nb - 3 || v >= P[k + 2])) peaks[np++] = k;
    }
    if (!np) { d.set(dPrev); if (trig) for (let k = 0; k < nb; k++) { rc[k] = Math.cos(d[k]); rs[k] = Math.sin(d[k]); } return; }
    for (let i = 0; i < np; i++) {
      const k = peaks[i];
      // Phase reference: mid, or side when stronger (anti-phase content has no mid).
      let sg = 1;
      const mr = Lr[k] + Rr[k], mi = Li[k] + Ri[k], sr_ = Lr[k] - Rr[k], si = Li[k] - Ri[k];
      if (nCh > 1 && sr_ * sr_ + si * si > mr * mr + mi * mi) sg = -1;
      const pc = Math.atan2(Li[k] + sg * Ri[k], Lr[k] + sg * Rr[k]);
      const pp = Math.atan2(li[k] + sg * ri[k], lr[k] + sg * rr[k]);
      const wk = (2 * Math.PI * k) / N, dev = princarg(pc - pp - wk * Ha);
      let v = dPrev[k] + (wk + dev / Ha) * (Hs - Ha);
      if (steer) v += wt * princarg(steer[k] - v);
      pd[i] = princarg(v);
    }
    // Each bin follows the peak of its region; regions split at the lowest bin between peaks.
    let k = 0;
    for (let i = 0; i < np; i++) {
      let end = nb;
      if (i + 1 < np) { end = peaks[i]; for (let j = peaks[i] + 1; j < peaks[i + 1]; j++) if (P[j] < P[end]) end = j; end++; }
      const v = pd[i];
      if (trig) { const c = Math.cos(v), s = Math.sin(v); for (; k < end; k++) { d[k] = v; rc[k] = c; rs[k] = s; } }
      else for (; k < end; k++) d[k] = v;
    }
  };
}
