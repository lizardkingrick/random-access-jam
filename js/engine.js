/* Audio engine — ported from Dream Chamber Studios Remixed (MuscularCrab).
   Every stem is a seamless 32-bar / 128-beat loop. Stems are conformed to the
   master BPM (WSOLA time-stretch) and optionally the master key (resampling
   pitch shift) in a worker, then looped in sample-accurate sync. Swaps are
   quantized to the next bar, like the Fortnite remix station. */

export const BEATS = 128;
export const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const BPM_MIN = 80, BPM_MAX = 140;

// Slot ids match the original app so its share links keep working.
export const LAYERS = [
  { id: 'groove', label: 'Groove', types: ['groove', 'all'] },
  { id: 'lead', label: 'Lead', types: ['lead'] },
  { id: 'texture', label: 'Extra', types: ['texture'] },
];

export function parseKey(k) {
  const m = /^([A-G][b#]?)(m?)$/.exec(k);
  return { root: NOTE[m[1]], minor: !!m[2] };
}
export const prettyKey = (k) => k.replace('b', '♭').replace('#', '♯');

export let MANIFEST = {};
export let ctx = null;
let master, bus, hp, lp, delay, delayFb, delaySend, analyser, mediaDest;
let recorder = null, recChunks = [];

export const state = {
  bpm: 116,
  tempoTouched: false, // until the user moves tempo, the first stem sets it
  keyLock: true,
  masterKey: 'auto',
  playing: false,
  transportStart: 0,
  anchorOrder: [],
  recording: false,
  layers: {},
};
for (const l of LAYERS) {
  state.layers[l.id] = {
    song: null, type: null, volume: 0.85, muted: false,
    buffer: null, source: null, srcGain: null, gain: null, analyser: null,
    loading: false, progress: 0, renderTag: 0,
  };
}

// ---------- events ----------
const listeners = { change: [], status: [] };
export const on = (ev, fn) => listeners[ev].push(fn);
const emit = (ev, arg) => listeners[ev].forEach((fn) => fn(arg));
const changed = () => emit('change');
const status = (msg, kind) => emit('status', { msg, kind });

// ---------- helpers ----------
const targetLen = () => Math.round(BEATS * 60 / state.bpm * ctx.sampleRate);
export const loopLenSec = () => BEATS * 60 / state.bpm;
const barLenSec = () => 4 * 60 / state.bpm;
export const activeLayers = () => LAYERS.map((l) => l.id).filter((id) => state.layers[id].song);
export const stemTypeFor = (layerId, song) =>
  LAYERS.find((l) => l.id === layerId).types.find((t) => MANIFEST[song].stems[t]);

export function masterRoot() {
  if (state.masterKey !== 'auto') return NOTE[state.masterKey];
  const anchor = state.anchorOrder[0];
  if (!anchor) return null;
  return parseKey(MANIFEST[state.layers[anchor].song].key).root;
}
export function semisFor(songKey) {
  if (!state.keyLock) return 0;
  const mr = masterRoot();
  if (mr === null) return 0;
  return ((mr - parseKey(songKey).root + 18) % 12) - 6; // nearest path, [-6, +5]
}

export async function loadManifest(url) {
  MANIFEST = await (await fetch(url)).json();
  return MANIFEST;
}

// ---------- audio graph ----------
// layers -> bus -> highpass -> lowpass -> master -> analyser -> out
//                               lowpass -> delaySend -> delay(+feedback) -> master
export function ensureCtx() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.9;
  bus = ctx.createGain();
  hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
  lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 22000;
  delay = ctx.createDelay(2); delay.delayTime.value = 0.75 * 60 / state.bpm;
  delayFb = ctx.createGain(); delayFb.gain.value = 0.3;
  delaySend = ctx.createGain(); delaySend.gain.value = 0;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  mediaDest = ctx.createMediaStreamDestination();

  bus.connect(hp); hp.connect(lp); lp.connect(master);
  lp.connect(delaySend); delaySend.connect(delay);
  delay.connect(delayFb); delayFb.connect(delay); delay.connect(master);
  master.connect(analyser); analyser.connect(ctx.destination);
  master.connect(mediaDest);

  for (const l of LAYERS) {
    const s = state.layers[l.id];
    s.gain = ctx.createGain();
    s.gain.gain.value = s.muted ? 0 : s.volume;
    s.analyser = ctx.createAnalyser();
    s.analyser.fftSize = 256;
    s.gain.connect(s.analyser);
    s.gain.connect(bus);
  }
  return ctx;
}

// ---------- stretch worker ----------
const worker = new Worker(new URL('./stretch-worker.js', import.meta.url));
let workerId = 0;
const workerJobs = new Map();
worker.onmessage = (e) => {
  const job = workerJobs.get(e.data.id);
  if (!job) return;
  workerJobs.delete(e.data.id);
  if (e.data.error) job.reject(new Error(e.data.error));
  else job.resolve(e.data.channels);
};
function stretchInWorker(channels, sampleRate, len, pitchRatio) {
  return new Promise((resolve, reject) => {
    const id = ++workerId;
    workerJobs.set(id, { resolve, reject });
    worker.postMessage({ id, channels, sampleRate, targetLen: len, pitchRatio },
      channels.map((c) => c.buffer));
  });
}

// ---------- buffers ----------
const originalCache = new Map(); // wav path -> Promise<AudioBuffer>
const renderCache = new Map();   // render key -> AudioBuffer (capped)
const encodePath = (p) => encodeURI(p).replace(/#/g, '%23');

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) return new Blob([out.subarray(0, got), value]).arrayBuffer(); // length lied (gzip)
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out.buffer.slice(0, got);
}

// Compressed Ogg copy first (page-relative, works at any mount point); the
// WAV master in ../Stems is only a local-dev fallback.
function getOriginal(info, type, onProgress) {
  const wavPath = info.stems[type];
  if (originalCache.has(wavPath)) return originalCache.get(wavPath);
  ensureCtx();
  const p = (async () => {
    const ogg = info.oggs && info.oggs[type];
    if (ogg) {
      try { return await ctx.decodeAudioData(await fetchBytes(encodePath(ogg), onProgress)); }
      catch (err) { console.warn('ogg failed, falling back to wav:', ogg, err); }
    }
    return ctx.decodeAudioData(await fetchBytes('../' + encodePath(wavPath), onProgress));
  })();
  originalCache.set(wavPath, p);
  p.catch(() => originalCache.delete(wavPath));
  return p;
}

// Warm the cache (e.g. on hover) so a pick feels instant.
export function prefetch(layerId, song) {
  const type = stemTypeFor(layerId, song);
  if (type) getOriginal(MANIFEST[song], type).catch(() => {});
}

async function renderStem(layerId, onProgress) {
  const s = state.layers[layerId];
  const info = MANIFEST[s.song];
  const semis = semisFor(info.key);
  const key = `${s.song}|${s.type}|${state.bpm}|${semis}|${ctx.sampleRate}`;
  if (renderCache.has(key)) return renderCache.get(key);

  const orig = await getOriginal(info, s.type, onProgress);
  // Lossy decodes can pad a few ms; trim to the exact 128-beat loop.
  const ideal = Math.round(BEATS * 60 / info.bpm * ctx.sampleRate);
  const inLen = Math.min(orig.length, ideal);
  const chans = [0, 1].map((c) => orig.getChannelData(Math.min(c, orig.numberOfChannels - 1)).slice(0, inLen));
  const len = targetLen();
  const out = await stretchInWorker(chans, ctx.sampleRate, len, Math.pow(2, semis / 12));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  buf.copyToChannel(out[0], 0);
  buf.copyToChannel(out[1], 1);
  if (renderCache.size > 12) renderCache.delete(renderCache.keys().next().value);
  renderCache.set(key, buf);
  return buf;
}

// ---------- transport ----------
function nextBarTime() {
  const bar = barLenSec();
  const elapsed = ctx.currentTime - state.transportStart;
  return state.transportStart + (Math.floor(elapsed / bar) + 1) * bar;
}

function startSource(layerId, when, offset) {
  const s = state.layers[layerId];
  stopSource(layerId, when);
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.loop = true;
  src.loopEnd = s.buffer.duration;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0, when);
  sg.gain.linearRampToValueAtTime(1, when + 0.02);
  src.connect(sg);
  sg.connect(s.gain);
  src.start(when, ((offset % s.buffer.duration) + s.buffer.duration) % s.buffer.duration);
  s.source = src;
  s.srcGain = sg;
}

function stopSource(layerId, when) {
  const s = state.layers[layerId];
  if (!s.source) return;
  const t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
  try {
    s.srcGain.gain.setValueAtTime(1, t);
    s.srcGain.gain.linearRampToValueAtTime(0, t + 0.03);
    s.source.stop(t + 0.05);
  } catch (_) { /* already stopped */ }
  s.source = null;
  s.srcGain = null;
}

export async function play() {
  ensureCtx();
  const ids = activeLayers().filter((id) => !state.layers[id].loading || state.layers[id].buffer);
  if (!ids.length) { status('Pick a stem from the wheel to start the jam'); return; }
  for (const id of ids) if (!state.layers[id].buffer) state.layers[id].buffer = await renderStem(id);
  const t = ctx.currentTime + 0.12;
  state.transportStart = t;
  for (const id of ids) startSource(id, t, 0);
  state.playing = true;
  changed();
}

export function stop() {
  if (!ctx) return;
  for (const id of activeLayers()) stopSource(id);
  state.playing = false;
  changed();
}

export const togglePlay = () => (state.playing ? stop() : play());

// Re-render every active stem (BPM or key changed) and continue from the same
// point in the loop so the groove doesn't jump back to bar 1.
let rebuildToken = 0;
export async function rebuildAll() {
  if (!ctx) return;
  const token = ++rebuildToken;
  const ids = activeLayers().filter((id) => state.layers[id].buffer || state.layers[id].loading);
  if (!ids.length) return;
  for (const id of ids) state.layers[id].loading = true;
  changed();
  try {
    const bufs = {};
    for (const id of ids) bufs[id] = await renderStem(id);
    if (token !== rebuildToken) return;
    let phase = 0;
    if (state.playing && ids.some((id) => state.layers[id].buffer)) {
      const old = ids.map((id) => state.layers[id].buffer).find(Boolean);
      phase = ((ctx.currentTime - state.transportStart) % old.duration) / old.duration;
    }
    for (const id of ids) { state.layers[id].buffer = bufs[id]; state.layers[id].loading = false; }
    delay.delayTime.setTargetAtTime(0.75 * 60 / state.bpm, ctx.currentTime, 0.05);
    if (state.playing) {
      const t = ctx.currentTime + 0.08;
      const offset = phase * loopLenSec();
      state.transportStart = t - offset;
      for (const id of ids) startSource(id, t, offset);
    }
    changed();
  } catch (err) {
    console.error(err);
    for (const id of ids) state.layers[id].loading = false;
    status('Could not re-sync stems — see console', 'error');
    changed();
  }
}

// ---------- layer selection ----------
export async function selectStem(layerId, song, opts = {}) {
  ensureCtx();
  const s = state.layers[layerId];
  if (s.song === song && !opts.force) return clearLayer(layerId);
  const type = stemTypeFor(layerId, song);
  if (!type) return;

  const firstStem = activeLayers().length === 0;
  if (firstStem && !state.tempoTouched && !opts.keepTempo) state.bpm = MANIFEST[song].bpm;
  s.song = song;
  s.type = type;
  s.loading = true;
  s.progress = 0;
  if (!state.anchorOrder.includes(layerId)) state.anchorOrder.push(layerId);
  changed();

  const tag = ++s.renderTag;
  try {
    const buf = await renderStem(layerId, (p) => { s.progress = p; changed(); });
    if (s.renderTag !== tag || s.song !== song) return;
    s.buffer = buf;
    s.loading = false;
    if (state.playing) {
      const t = nextBarTime();
      startSource(layerId, t, t - state.transportStart);
    } else if (!opts.noAutoplay && activeLayers().every((id) => !state.layers[id].loading)) {
      play(); // first pick starts the jam, like Fortnite
    }
    changed();
  } catch (err) {
    if (s.renderTag !== tag) return;
    console.error(err);
    s.loading = false;
    s.song = s.type = s.buffer = null;
    state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
    status(`Couldn't load ${song} — is the stem file there?`, 'error');
    changed();
  }
}

export function clearLayer(layerId) {
  const s = state.layers[layerId];
  if (!s.song) return;
  if (ctx) stopSource(layerId, state.playing ? nextBarTime() : undefined);
  s.renderTag++;
  s.song = s.type = s.buffer = null;
  s.loading = false;
  const wasAnchor = state.anchorOrder[0] === layerId;
  state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
  if (!activeLayers().length) state.playing = false;
  changed();
  if (wasAnchor && state.keyLock && state.masterKey === 'auto') rebuildAll();
}

export function randomize() {
  ensureCtx();
  for (const l of LAYERS) {
    const options = Object.keys(MANIFEST).filter((song) => stemTypeFor(l.id, song) && song !== state.layers[l.id].song);
    selectStem(l.id, options[Math.floor(Math.random() * options.length)], { force: true });
  }
}

// ---------- mix settings ----------
let bpmTimer;
export function setBpm(bpm, { immediate = false } = {}) {
  bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
  if (bpm === state.bpm) return;
  state.bpm = bpm;
  state.tempoTouched = true;
  changed();
  clearTimeout(bpmTimer);
  // Rendering is heavy; wait until the user stops nudging.
  bpmTimer = setTimeout(rebuildAll, immediate ? 0 : 450);
}
export function setKeyLock(on) { state.keyLock = on; changed(); rebuildAll(); }
export function setMasterKey(k) { state.masterKey = k; changed(); rebuildAll(); }
export function setMasterVolume(v) { ensureCtx(); master.gain.setTargetAtTime(v, ctx.currentTime, 0.02); }
export function setVolume(layerId, v) {
  const s = state.layers[layerId];
  s.volume = v;
  if (s.gain && !s.muted) s.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}
export function setMuted(layerId, muted) {
  const s = state.layers[layerId];
  s.muted = muted;
  if (s.gain) s.gain.gain.setTargetAtTime(muted ? 0 : s.volume, ctx.currentTime, 0.015);
  changed();
}

// ---------- Audio FX (hold) ----------
// x: -1 (low-pass sweep) .. 0 (dry) .. +1 (high-pass sweep); y: 0..1 echo amount.
export function setFx(x, y) {
  if (!ctx) return;
  const t = ctx.currentTime, k = 0.03;
  const lpf = x < 0 ? 22000 * Math.pow(200 / 22000, -x) : 22000;
  const hpf = x > 0 ? 10 * Math.pow(2500 / 10, x) : 10;
  lp.frequency.setTargetAtTime(lpf, t, k);
  hp.frequency.setTargetAtTime(hpf, t, k);
  lp.Q.setTargetAtTime(0.7 + Math.max(0, -x) * 7, t, k);
  hp.Q.setTargetAtTime(0.7 + Math.max(0, x) * 7, t, k);
  delaySend.gain.setTargetAtTime(y * 0.7, t, k);
  delayFb.gain.setTargetAtTime(0.25 + y * 0.45, t, k);
}
export function releaseFx() {
  if (!ctx) return;
  const t = ctx.currentTime;
  lp.frequency.setTargetAtTime(22000, t, 0.12);
  hp.frequency.setTargetAtTime(10, t, 0.12);
  lp.Q.setTargetAtTime(0.7, t, 0.1);
  hp.Q.setTargetAtTime(0.7, t, 0.1);
  delaySend.gain.setTargetAtTime(0, t, 0.05); // echo tail rings out
  delayFb.gain.setTargetAtTime(0.3, t, 0.3);
}

// ---------- meters (for the visuals) ----------
const meterBuf = new Float32Array(256);
let spectrum = null;
export function meters() {
  const out = { groove: 0, lead: 0, texture: 0, bass: 0, mid: 0, high: 0, beat: 0, bar: 0, beatIndex: -1 };
  if (!ctx) return out;
  for (const l of LAYERS) {
    const s = state.layers[l.id];
    if (!s.source) continue;
    s.analyser.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    out[l.id] = Math.min(1, Math.sqrt(sum / meterBuf.length) * 3.2);
  }
  spectrum ??= new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(spectrum);
  const band = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += spectrum[i]; return s / (b - a) / 255; };
  out.bass = band(1, 6); out.mid = band(6, 40); out.high = band(40, 160);
  out.spectrum = spectrum;
  if (state.playing) {
    const elapsed = ctx.currentTime - state.transportStart;
    if (elapsed >= 0) {
      const beats = elapsed / (60 / state.bpm);
      out.beatIndex = Math.floor(beats) % BEATS;
      out.beat = beats % 1;
      out.bar = (beats / 4) % 32;
    }
  }
  return out;
}

// ---------- record & export ----------
export function toggleRecord(download) {
  ensureCtx();
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  if (!window.MediaRecorder) { status('Recording is not supported in this browser', 'error'); return; }
  recChunks = [];
  recorder = new MediaRecorder(mediaDest.stream);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType });
    download(blob, `dream-chamber-remix.${recorder.mimeType.includes('ogg') ? 'ogg' : 'webm'}`);
    state.recording = false;
    status('Recording saved');
    changed();
  };
  recorder.start();
  state.recording = true;
  status('Recording — press REC again to stop');
  changed();
}

export function exportLoopWav() {
  const ids = activeLayers().filter((id) => state.layers[id].buffer && !state.layers[id].muted);
  if (!ids.length) { status('Nothing to export — pick some stems first'); return null; }
  const len = state.layers[ids[0]].buffer.length;
  const mix = [new Float32Array(len), new Float32Array(len)];
  for (const id of ids) {
    const s = state.layers[id];
    const v = s.volume * 0.9;
    for (let c = 0; c < 2; c++) {
      const data = s.buffer.getChannelData(c), m = mix[c];
      for (let i = 0; i < len; i++) m[i] += data[i] * v;
    }
  }
  return encodeWav(mix, ctx.sampleRate);
}

function encodeWav(channels, sampleRate) {
  const len = channels[0].length, nCh = channels.length;
  const buf = new ArrayBuffer(44 + len * nCh * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * nCh * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true); v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
