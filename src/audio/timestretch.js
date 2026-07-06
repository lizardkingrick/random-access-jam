// @ts-check
/**
 * Pitch-preserving time-stretch + key-shift, conforming any stem to the master
 * grid. Uses the vendored Signalsmith Stretch WASM (MIT) inside an
 * OfflineAudioContext — all stretching is an offline pre-render; nothing runs
 * realtime. If AudioWorklet isn't available on OfflineAudioContext (old
 * Safari), falls back to plain resampling (tempo right, pitch shifts — noted
 * via console.warn).
 */

import SignalsmithStretch from '../vendor/signalsmith-stretch/SignalsmithStretch.mjs';

const BEATS_PER_BAR = 4;

/** Ratio band outside which we assume half/double-time (Fuser-style guard). */
const RATIO_HIGH = 1.4;
const RATIO_LOW = 0.7;

const KEY_PCS = /** @type {Record<string, number>} */ ({
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
});

/**
 * Parse "A minor" / "C# major" into { pc: 0-11, mode }.
 * @param {string} key
 */
export function parseKey(key) {
  const m = /^\s*([A-G](?:#|b)?)\s*(major|minor|maj|min|m)?\s*$/i.exec(key ?? '');
  if (!m) return { pc: 0, mode: 'major' };
  const root = m[1][0].toUpperCase() + (m[1][1] ?? '').replace('B', 'b');
  const modeRaw = (m[2] ?? 'major').toLowerCase();
  return {
    pc: KEY_PCS[root] ?? 0,
    mode: modeRaw.startsWith('min') || modeRaw === 'm' ? 'minor' : 'major',
  };
}

/**
 * Semitone shift from source key root to master key root, wrapped to the
 * nearest direction in [-6, +6].
 * @param {string} sourceKey @param {string} masterKey
 */
export function semitoneShift(sourceKey, masterKey) {
  let diff = (parseKey(masterKey).pc - parseKey(sourceKey).pc) % 12;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

/**
 * Half/double-time guard: bring the source BPM into a sane ratio band of the
 * master so we never stretch extremely (a 220 BPM stem is treated as 110).
 * @param {number} sourceBpm @param {number} masterBpm
 */
export function effectiveSourceBpm(sourceBpm, masterBpm) {
  let eff = sourceBpm;
  let guard = 0;
  while (masterBpm / eff > RATIO_HIGH && guard++ < 4) eff *= 2;
  while (masterBpm / eff < RATIO_LOW && guard++ < 8) eff /= 2;
  return eff;
}

let workletSupported = /** @type {boolean | null} */ (null);

/**
 * Conform a stem buffer to the master grid: stretched to masterBpm,
 * pitch-shifted to masterKey, exactly `bars` bars long at masterBpm.
 *
 * @param {AudioBuffer} buffer decoded source stem
 * @param {number} sourceBpm
 * @param {string} sourceKey e.g. "A minor"
 * @param {number} masterBpm
 * @param {string} masterKey
 * @param {number} bars loop length of THIS stem in bars
 * @returns {Promise<AudioBuffer>}
 */
export async function renderToGrid(buffer, sourceBpm, sourceKey, masterBpm, masterKey, bars) {
  const effBpm = effectiveSourceBpm(sourceBpm, masterBpm);
  const rate = masterBpm / effBpm; // playback speed multiplier
  const semitones = semitoneShift(sourceKey, masterKey);

  const sampleRate = buffer.sampleRate;
  const targetSeconds = (bars * BEATS_PER_BAR * 60) / masterBpm;
  const targetFrames = Math.round(targetSeconds * sampleRate);
  const channels = Math.min(buffer.numberOfChannels, 2);

  // Fast path: nothing to change, just trim/pad to the exact grid length.
  if (Math.abs(rate - 1) < 1e-4 && semitones === 0) {
    return trimOrPad(buffer, targetFrames, channels);
  }

  const OAC = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
  const ctx = new OAC(channels, targetFrames, sampleRate);

  if (workletSupported !== false && ctx.audioWorklet) {
    try {
      const stretch = await SignalsmithStretch(ctx, {
        numberOfInputs: 0,
        outputChannelCount: [channels],
      });
      const channelData = [];
      for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));
      await stretch.addBuffers(channelData);
      stretch.connect(ctx.destination);
      // Loop the input so the output fills the full grid length even when the
      // stretched source is a hair shorter than the target.
      stretch.schedule({
        output: 0,
        active: true,
        input: 0,
        rate,
        semitones,
        loopStart: 0,
        loopEnd: buffer.duration,
      });
      const rendered = await ctx.startRendering();
      workletSupported = true;
      return rendered;
    } catch (err) {
      workletSupported = false;
      console.warn('signalsmith-stretch offline render failed; falling back to resample.', err);
    }
  }

  return resampleFallback(buffer, rate, semitones, targetFrames, channels, sampleRate);
}

/**
 * Degraded fallback (no worklet): resample for tempo — pitch follows speed,
 * plus the requested key shift folded into the rate.
 * @param {AudioBuffer} buffer @param {number} rate @param {number} semitones
 * @param {number} targetFrames @param {number} channels @param {number} sampleRate
 */
async function resampleFallback(buffer, rate, semitones, targetFrames, channels, sampleRate) {
  const OAC = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
  const ctx = new OAC(channels, targetFrames, sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.playbackRate.value = rate * 2 ** (semitones / 12);
  source.connect(ctx.destination);
  source.start(0);
  return ctx.startRendering();
}

/**
 * Copy a buffer trimmed or zero-padded to an exact frame count.
 * @param {AudioBuffer} buffer @param {number} frames @param {number} channels
 */
function trimOrPad(buffer, frames, channels) {
  if (buffer.length === frames && buffer.numberOfChannels === channels) return buffer;
  const out = new AudioBuffer({
    numberOfChannels: channels,
    length: frames,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < channels; c++) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    out.getChannelData(c).set(src.subarray(0, Math.min(src.length, frames)));
  }
  return out;
}
