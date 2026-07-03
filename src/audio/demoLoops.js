// @ts-check
/**
 * Procedurally generated demo loops (120 BPM, 4 bars, seamless) rendered with
 * OfflineAudioContext so the app is playable before any uploads. All synthesis
 * is original — simple kick/hat/snare/bass/chord voices.
 */

const SAMPLE_RATE = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const BARS = 4;
const DURATION = BARS * 4 * BEAT; // 8s

export const DEMO_TRACKS = [
  {
    id: 'demo-neon-causeway',
    title: 'Neon Causeway',
    artist: 'Built-in demo · 120 BPM',
    color: 'hsl(160, 90%, 60%)',
  },
  {
    id: 'demo-midnight-reactor',
    title: 'Midnight Reactor',
    artist: 'Built-in demo · 120 BPM',
    color: 'hsl(250, 90%, 70%)',
  },
];

/** @param {string} note e.g. 'A2', 'C#3' */
function freq(note) {
  const m = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!m) throw new Error(`Bad note: ${note}`);
  const idx = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(m[1]);
  const midi = (Number(m[2]) + 1) * 12 + idx;
  return 440 * 2 ** ((midi - 69) / 12);
}

/** @param {OfflineAudioContext} ctx */
function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 1337;
  for (let i = 0; i < data.length; i++) {
    // deterministic LCG noise so renders are identical across runs
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buf;
}

/**
 * @param {OfflineAudioContext} ctx @param {AudioNode} out
 * @param {number} t @param {{ punch?: number }} [o]
 */
function kick(ctx, out, t, o = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.setValueAtTime(155, t);
  osc.frequency.exponentialRampToValueAtTime(46, t + 0.11);
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(o.punch ?? 0.95, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.32);
}

/**
 * @param {OfflineAudioContext} ctx @param {AudioBuffer} noise @param {AudioNode} out
 * @param {number} t @param {{ open?: boolean, pan?: number }} [o]
 */
function hat(ctx, noise, out, t, o = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 8200;
  const g = ctx.createGain();
  const dur = o.open ? 0.22 : 0.05;
  g.gain.setValueAtTime(0.28, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  let tail = /** @type {AudioNode} */ (g);
  if (typeof ctx.createStereoPanner === 'function' && o.pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    g.connect(p);
    tail = p;
  }
  src.connect(hp).connect(g);
  tail.connect(out);
  src.start(t, 0.2, dur + 0.05);
}

/**
 * @param {OfflineAudioContext} ctx @param {AudioBuffer} noise @param {AudioNode} out @param {number} t
 */
function snare(ctx, noise, out, t) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  src.connect(bp).connect(g).connect(out);
  src.start(t, 0.5, 0.2);

  const tone = ctx.createOscillator();
  tone.frequency.value = 190;
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.25, t);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  tone.connect(tg).connect(out);
  tone.start(t);
  tone.stop(t + 0.1);
}

/**
 * @param {OfflineAudioContext} ctx @param {AudioNode} out
 * @param {number} t @param {string} note @param {number} dur @param {{ level?: number, cutoff?: number }} [o]
 */
function bass(ctx, out, t, note, dur, o = {}) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = freq(note);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(o.cutoff ?? 520, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + dur);
  lp.Q.value = 4;
  const g = ctx.createGain();
  const level = o.level ?? 0.34;
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.01);
  g.gain.setValueAtTime(level, t + dur - 0.03);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/**
 * Chord stab / arp note.
 * @param {OfflineAudioContext} ctx @param {AudioNode} out @param {number} t
 * @param {string[]} notes @param {number} dur
 * @param {{ type?: OscillatorType, level?: number, detune?: number, pan?: number }} [o]
 */
function stab(ctx, out, t, notes, dur, o = {}) {
  const g = ctx.createGain();
  const level = o.level ?? 0.09;
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3200;
  g.connect(lp);
  let tail = /** @type {AudioNode} */ (lp);
  if (typeof ctx.createStereoPanner === 'function' && o.pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    lp.connect(p);
    tail = p;
  }
  tail.connect(out);
  for (const note of notes) {
    for (const det of [-(o.detune ?? 6), o.detune ?? 6]) {
      const osc = ctx.createOscillator();
      osc.type = o.type ?? 'sawtooth';
      osc.frequency.value = freq(note);
      osc.detune.value = det;
      osc.connect(g);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }
}

/**
 * "Neon Causeway" — driving four-on-floor house groove in A minor.
 * @param {OfflineAudioContext} ctx @param {AudioNode} out @param {AudioBuffer} noise
 */
function scoreNeonCauseway(ctx, out, noise) {
  const bassLine = ['A1', 'A1', 'C2', 'A1', 'G1', 'G1', 'A1', 'B1'];
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * 4 * BEAT;
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      kick(ctx, out, t);
      hat(ctx, noise, out, t + BEAT / 2, { pan: b % 2 ? 0.35 : -0.35 });
      if (b === 3 && bar % 2 === 1) hat(ctx, noise, out, t + BEAT * 0.75, { open: true, pan: 0.2 });
    }
    // 8th-note bassline, two notes per beat
    for (let n = 0; n < 8; n++) {
      const note = bassLine[(bar * 8 + n) % bassLine.length];
      bass(ctx, out, t0 + n * (BEAT / 2), note, BEAT / 2 - 0.02, { cutoff: n % 2 ? 700 : 460 });
    }
    // Am7 stab on the 1 and the "and" of 2
    stab(ctx, out, t0, ['A3', 'C4', 'E4', 'G4'], 0.4);
    stab(ctx, out, t0 + 1.5 * BEAT, ['A3', 'C4', 'E4'], 0.25, { level: 0.06, pan: 0.3 });
  }
}

/**
 * "Midnight Reactor" — moodier syncopated electro groove in E minor.
 * @param {OfflineAudioContext} ctx @param {AudioNode} out @param {AudioBuffer} noise
 */
function scoreMidnightReactor(ctx, out, noise) {
  const kicks = [0, 0.75, 1.5, 2, 2.75, 3.5]; // in beats, syncopated
  const arp = ['E3', 'G3', 'B3', 'D4', 'E4', 'D4', 'B3', 'G3'];
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * 4 * BEAT;
    for (const kb of kicks) kick(ctx, out, t0 + kb * BEAT, { punch: 0.85 });
    snare(ctx, noise, out, t0 + 1 * BEAT);
    snare(ctx, noise, out, t0 + 3 * BEAT);
    for (let s = 0; s < 16; s++) {
      if (s % 2 === 1) hat(ctx, noise, out, t0 + s * (BEAT / 4), { pan: s % 4 === 1 ? -0.4 : 0.4 });
    }
    // 16th-note arp, skipping a few steps for syncopation
    for (let s = 0; s < 16; s++) {
      if (s % 8 === 6) continue;
      const note = arp[(s + bar * 2) % arp.length];
      stab(ctx, out, t0 + s * (BEAT / 4), [note], BEAT / 4, {
        type: 'square',
        level: 0.045,
        detune: 3,
        pan: (s % 4) / 3 - 0.5,
      });
    }
    // long dark bass root
    bass(ctx, out, t0, 'E1', 2 * BEAT, { level: 0.3, cutoff: 300 });
    bass(ctx, out, t0 + 2 * BEAT, bar % 2 ? 'G1' : 'E1', 2 * BEAT, { level: 0.3, cutoff: 300 });
  }
}

/**
 * Render one demo loop to an AudioBuffer.
 * @param {string} id one of DEMO_TRACKS ids
 * @returns {Promise<AudioBuffer>}
 */
export async function renderDemoLoop(id) {
  const OAC = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.round(DURATION * SAMPLE_RATE), SAMPLE_RATE);

  const bus = ctx.createGain();
  bus.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  bus.connect(comp).connect(ctx.destination);

  const noise = makeNoiseBuffer(ctx);
  if (id === 'demo-neon-causeway') scoreNeonCauseway(ctx, bus, noise);
  else if (id === 'demo-midnight-reactor') scoreMidnightReactor(ctx, bus, noise);
  else throw new Error(`Unknown demo loop: ${id}`);

  return ctx.startRendering();
}
