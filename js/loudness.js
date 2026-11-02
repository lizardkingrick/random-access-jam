/* Integrated loudness (ITU-R BS.1770-4), used to even out the stems' levels.
   K-weighting (a +4 dB high shelf, then a 38 Hz high-pass), mean square in 400 ms blocks
   that overlap by 75%, an absolute gate at -70 LUFS and a relative one 10 LU below the
   ungated level. The filter coefficients are derived for any sample rate (the same formulas
   as libebur128), and reproduce the standard's 48 kHz table. */

function kWeighting(sr) {
  let K = Math.tan(Math.PI * 1681.974450955533 / sr), Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
    2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan(Math.PI * 38.13547087602444 / sr); Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highpass = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, highpass];
}

// Hands the main thread back now and then, so measuring a stem never stalls the page. Through a
// message rather than a timer: browsers hold timers in a hidden, silent tab to about one a second
// (or one a minute), which would keep a stem picked just before switching tabs waiting ~25 s.
const yields = [];
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
if (channel) channel.port1.onmessage = () => yields.shift()();
const breather = () => new Promise((resolve) => {
  if (!channel) { setTimeout(resolve); return; }
  yields.push(resolve);
  channel.port2.postMessage(0);
});

// `channels` are Float32Arrays (a mono stem is passed twice, as it plays on both sides).
// Returns LUFS, or -Infinity for silence.
export async function integratedLoudness(channels, sr, length = channels[0].length) {
  const [s, h] = kWeighting(sr);
  const step = Math.round(sr * 0.1); // 100 ms: a quarter block
  const quarters = new Float64Array(Math.floor(length / step)); // K-weighted energy per 100 ms, channels summed
  const CHUNK = 1 << 18;
  for (const x of channels) {
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0; // direct form I state
    const end = quarters.length * step;
    for (let from = 0; from < end; from += CHUNK) {
      const to = Math.min(end, from + CHUNK);
      for (let i = from; i < to; i++) {
        const v = x[i];
        const y = s[0] * v + s[1] * s1 + s[2] * s2 - s[3] * s3 - s[4] * s4;
        s2 = s1; s1 = v; s4 = s3; s3 = y;
        const z = y - 2 * h1 + h2 - h[3] * h3 - h[4] * h4;
        h2 = h1; h1 = y; h4 = h3; h3 = z;
        quarters[(i / step) | 0] += z * z;
      }
      await breather();
    }
  }
  const blocks = [];
  for (let k = 0; k + 4 <= quarters.length; k++) {
    blocks.push((quarters[k] + quarters[k + 1] + quarters[k + 2] + quarters[k + 3]) / (4 * step));
  }
  const lufs = (z) => -0.691 + 10 * Math.log10(z);
  const mean = (zs) => zs.reduce((a, z) => a + z, 0) / zs.length;
  const loud = blocks.filter((z) => z > 0 && lufs(z) > -70);
  if (!loud.length) return -Infinity;
  const gate = lufs(mean(loud)) - 10;
  return lufs(mean(loud.filter((z) => lufs(z) > gate)));
}
