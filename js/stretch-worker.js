// WSOLA time-stretcher + resampling pitch-shifter.
// Receives raw channel data, returns channels conformed to exactly targetLen
// samples so every stem loops at an identical, sample-accurate length.

self.onmessage = (e) => {
  const { id, channels, sampleRate, targetLen, pitchRatio } = e.data;
  try {
    let chans = channels;
    if (Math.abs(pitchRatio - 1) > 1e-6) {
      chans = chans.map((c) => resampleLoop(c, Math.round(c.length / pitchRatio)));
    }
    const out = timeStretch(chans, sampleRate, targetLen);
    self.postMessage({ id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

// Catmull-Rom resampler; input is a seamless loop, so neighbours wrap.
function resampleLoop(input, outLen) {
  const n = input.length;
  const out = new Float32Array(outLen);
  const ratio = n / outLen;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i1 = Math.floor(x) % n;
    const t = x - Math.floor(x);
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const a = input[i0], b = input[i1], c = input[i2], d = input[i3];
    out[i] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  }
  return out;
}

function timeStretch(channels, sampleRate, targetLen) {
  const inLen = channels[0].length;
  const nCh = channels.length;

  // Near-unity ratio: just wrap/trim to the exact target length.
  if (Math.abs(targetLen / inLen - 1) < 0.0005) {
    return channels.map((c) => {
      const out = new Float32Array(targetLen);
      for (let i = 0; i < targetLen; i++) out[i] = c[i % inLen];
      return out;
    });
  }

  const seq = Math.round(0.050 * sampleRate);     // analysis frame
  const overlap = Math.round(0.010 * sampleRate); // crossfade region
  const seek = Math.round(0.015 * sampleRate);    // search radius
  const hopOut = seq - overlap;
  const stretch = targetLen / inLen;
  const hopIn = hopOut / stretch;

  // Extend the input circularly so frames near the end read wrapped material —
  // the rendered loop then meets its own start cleanly.
  const ext = seq + 2 * seek + Math.ceil(hopIn) + 8;
  const src = [];
  for (let c = 0; c < nCh; c++) {
    const a = new Float32Array(inLen + ext);
    a.set(channels[c]);
    for (let i = 0; i < ext; i++) a[inLen + i] = channels[c][i % inLen];
    src.push(a);
  }

  // Decimated mono copy for cheap correlation search.
  const dec = 4;
  const monoLen = Math.floor((inLen + ext) / dec);
  const mono = new Float32Array(monoLen);
  for (let i = 0; i < monoLen; i++) {
    let s = 0;
    for (let c = 0; c < nCh; c++) s += src[c][i * dec];
    mono[i] = s;
  }
  const seekD = Math.floor(seek / dec);
  const corrWin = Math.floor(seq / dec / 2);

  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(targetLen));

  // First frame verbatim.
  for (let c = 0; c < nCh; c++) {
    const n = Math.min(seq, targetLen);
    out[c].set(src[c].subarray(0, n), 0);
  }

  let prevIn = 0;
  let outPos = hopOut;
  const maxIn = inLen + ext - seq - 2;

  while (outPos < targetLen) {
    const natural = prevIn + hopOut;          // seamless continuation point
    const nominal = outPos / stretch;         // point that achieves the stretch
    let lo = Math.max(0, Math.round(nominal - seek));
    let hi = Math.min(maxIn, Math.round(nominal + seek));
    if (lo > hi) lo = hi;

    // Find candidate best matching the natural continuation.
    const refD = Math.min(Math.floor(natural / dec), monoLen - corrWin - 1);
    let best = lo, bestScore = -Infinity;
    const loD = Math.floor(lo / dec);
    const hiD = Math.floor(hi / dec);
    for (let pD = loD; pD <= hiD; pD++) {
      let corr = 0, energy = 1e-9;
      for (let j = 0; j < corrWin; j++) {
        const v = mono[pD + j];
        corr += v * mono[refD + j];
        energy += v * v;
      }
      const score = corr / Math.sqrt(energy);
      if (score > bestScore) { bestScore = score; best = pD * dec; }
    }

    // Crossfade the overlap, then copy the frame body.
    const frameEnd = Math.min(seq, targetLen - outPos);
    for (let c = 0; c < nCh; c++) {
      const o = out[c], s = src[c];
      const ovl = Math.min(overlap, frameEnd);
      for (let j = 0; j < ovl; j++) {
        const w = j / overlap;
        o[outPos + j] = o[outPos + j] * (1 - w) + s[best + j] * w;
      }
      for (let j = ovl; j < frameEnd; j++) o[outPos + j] = s[best + j];
    }

    prevIn = best;
    outPos += hopOut;
  }
  return out;
}
