/* Audio engine — ported from Dream Chamber Studios Remixed (MuscularCrab).
   Every stem is a seamless loop, normally 32 bars / 128 beats. Stems are conformed
   to the master BPM (WSOLA time-stretch) and optionally the master key (resampling
   pitch shift) in a small pool of workers, then looped in sample-accurate sync.
   Swaps are quantized to the next bar. */

import { manifestFromListing } from './manifest.js';

export const BEATS = 128; // one transport cycle: the 32-bar loop the bar clock counts
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
  const m = /^([A-G][b#]?)(m?)$/.exec(String(k ?? '').trim());
  return m ? { root: NOTE[m[1]], minor: !!m[2] } : null; // unknown key: treated as unpitched
}
export const prettyKey = (k) => k.replace('b', '♭').replace('#', '♯');

// Key lock matches pitch sets, not just roots: a major key has the same notes as its
// relative minor (A major = F#m), so majors are matched through that minor. Digital
// Love (A) over Get Lucky (F#m) then needs no shift instead of clashing a third apart.
export function tonic(k) {
  const p = parseKey(k);
  return p ? (p.minor ? p.root : (p.root + 9) % 12) : null;
}

export let MANIFEST = {};
export let LOCAL = null; // the local server's folder listing, if there is one
export let ctx = null;
let master, bus, hp, lp, fxDry, wah, wahWet, wahLfo, flDelay, flWet, analyser, mediaDest, glueIn;
let recorder = null, recChunks = [];

export const state = {
  bpm: 116,
  tempoTouched: false, // until the user moves tempo, the first stem sets it
  keyLock: true,
  masterKey: 'auto',
  playing: false,
  transportStart: 0, // context time of beat 1 of the running 32-bar cycle
  anchorOrder: [],
  recording: false,
  layers: {},
};
for (const l of LAYERS) {
  state.layers[l.id] = {
    song: null, type: null, volume: 0.85, muted: false,
    buffer: null, bufferKey: null, bufferBpm: 0,
    source: null, srcGain: null, gain: null, analyser: null,
    loading: false, syncing: false, progress: 0, renderTag: 0,
  };
}

// The tempo the running sources were rendered at. state.bpm moves as soon as the user
// nudges tempo; the clock keeps the old tempo until the re-rendered stems take over.
let clockBpm = state.bpm;

// ---------- events ----------
const listeners = { change: [], status: [] };
export const on = (ev, fn) => listeners[ev].push(fn);
// A throwing UI listener must not leave the engine half-updated (e.g. a layer stuck loading).
const emit = (ev, arg) => listeners[ev].forEach((fn) => { try { fn(arg); } catch (err) { console.error(err); } });
const changed = () => emit('change');
const status = (msg, kind) => emit('status', { msg, kind });

// ---------- helpers ----------
// One bar in seconds, rounded to whole samples exactly like the rendered loops (loopSamples),
// so the clock and every looping buffer share one grid.
const barSec = (bpm = clockBpm) => (ctx ? Math.round(4 * 60 / bpm * ctx.sampleRate) / ctx.sampleRate : 4 * 60 / bpm);
export const loopLenSec = () => BEATS / 4 * barSec();
export const activeLayers = () => LAYERS.map((l) => l.id).filter((id) => state.layers[id].song);
export const stemTypeFor = (layerId, song) =>
  LAYERS.find((l) => l.id === layerId).types.find((t) => MANIFEST[song].stems[t]);

export function masterRoot() {
  if (state.masterKey !== 'auto') return NOTE[state.masterKey];
  for (const id of state.anchorOrder) { // the first pick with a known key
    const t = tonic(MANIFEST[state.layers[id].song]?.key);
    if (t !== null) return t;
  }
  return null;
}
export function semisFor(songKey) {
  if (!state.keyLock) return 0;
  const mr = masterRoot(), t = tonic(songKey);
  if (mr === null || t === null) return 0;
  return ((mr - t + 18) % 12) - 6; // nearest path, [-6, +5]: a tritone goes down
}

// What a layer's buffer has to be rendered as for the current tempo and key.
const renderKey = (song, type) => `${song}|${type}|${state.bpm}|${semisFor(MANIFEST[song].key)}|${ctx.sampleRate}`;
const isCurrent = (s) => !!s.buffer && s.bufferKey === renderKey(s.song, s.type);

// The local server (tools/serve.ps1) lists the stem folders, so the song list comes straight
// from disk with no build step. The hosted site has no listing and uses the prebuilt stems.json.
export async function loadManifest(url) {
  try {
    const res = await fetch('__local/files', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) LOCAL = await res.json();
  } catch (_) { /* not the local server */ }
  if (LOCAL && LOCAL.stems && LOCAL.stems.length) MANIFEST = manifestFromListing(LOCAL);
  else MANIFEST = await (await fetch(url)).json();
  return MANIFEST;
}

// ---------- audio graph ----------
// layers -> bus -> highpass -> lowpass -> dry ------------------------> glue -> master -> analyser -> out
//                               lowpass -> wah (LFO band-pass) -> wet -> glue
//                               lowpass -> flanger (LFO delay + fb) -> wet -> glue
// The filters and wet paths sit idle until an Audio FX is held (see fxStart).
// The glue is gentle bus compression into a peak limiter, so three summed stems don't clip.
// Both compressors add automatic make-up gain (measured: +2.96 dB and +1.14 dB); the trims
// take it back out, so material below the thresholds plays at its original level.
function buildGlue(c) {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 2.5;
  comp.attack.value = 0.01; comp.release.value = 0.2;
  const trim1 = c.createGain(); trim1.gain.value = 0.711;
  const limit = c.createDynamicsCompressor();
  limit.threshold.value = -2; limit.knee.value = 0; limit.ratio.value = 20;
  limit.attack.value = 0.002; limit.release.value = 0.1;
  const trim2 = c.createGain(); trim2.gain.value = 0.877;
  comp.connect(trim1); trim1.connect(limit); limit.connect(trim2);
  return { input: comp, output: trim2 };
}

export function ensureCtx() {
  if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return ctx; }
  // Run at the stems' own rate: decoding 44.1 kHz loops into a 48 kHz context rings at both
  // loop ends (a tick at every wrap). The browser resamples the output stream instead.
  const AC = window.AudioContext || window.webkitAudioContext;
  try { ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' }); } catch (_) { ctx = new AC(); }
  master = ctx.createGain();
  master.gain.value = 0.9;
  bus = ctx.createGain();
  hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
  lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 22000;
  fxDry = ctx.createGain();
  wah = ctx.createBiquadFilter(); wah.type = 'bandpass'; wah.frequency.value = 900; wah.Q.value = 7;
  wahWet = ctx.createGain(); wahWet.gain.value = 0;
  wahLfo = ctx.createOscillator(); wahLfo.frequency.value = clockBpm / 60; // one sweep per beat
  const wahDepth = ctx.createGain(); wahDepth.gain.value = 650;
  flDelay = ctx.createDelay(0.05); flDelay.delayTime.value = 0.004;
  const flFb = ctx.createGain(); flFb.gain.value = 0.6;
  flWet = ctx.createGain(); flWet.gain.value = 0;
  const flLfo = ctx.createOscillator(); flLfo.frequency.value = 0.25;
  const flDepth = ctx.createGain(); flDepth.gain.value = 0.003; // 1-7 ms sweep
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  mediaDest = ctx.createMediaStreamDestination();
  const glue = buildGlue(ctx);
  glueIn = glue.input;

  bus.connect(hp); hp.connect(lp); lp.connect(fxDry); fxDry.connect(glueIn);
  lp.connect(wah); wah.connect(wahWet); wahWet.connect(glueIn);
  wahLfo.connect(wahDepth); wahDepth.connect(wah.frequency); wahLfo.start();
  lp.connect(flDelay); flDelay.connect(flFb); flFb.connect(flDelay); flDelay.connect(flWet); flWet.connect(glueIn);
  flLfo.connect(flDepth); flDepth.connect(flDelay.delayTime); flLfo.start();
  glue.output.connect(master);
  glue.output.connect(mediaDest); // recordings are taken before the volume slider
  master.connect(analyser); analyser.connect(ctx.destination);

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

// ---------- stretch workers ----------
// A few workers so a tempo or key change re-renders the layers in parallel. Workers start
// on first use; each takes one job at a time from a FIFO queue.
// A stretch job briefly holds up to ~150 MB, so low-memory devices get two workers at most.
const POOL_SIZE = Math.max(1, Math.min((navigator.deviceMemory || 8) <= 4 ? 2 : 3, (navigator.hardwareConcurrency || 2) - 1));
const pool = []; // { worker, job }
const jobQueue = [];
let jobSeq = 0;

function spawnWorker() {
  const slot = { worker: new Worker(new URL('./stretch-worker.js', import.meta.url)), job: null };
  slot.worker.onmessage = (e) => {
    const job = slot.job;
    slot.job = null;
    if (job && job.id === e.data.id) {
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.channels);
    }
    pumpJobs();
  };
  slot.worker.onerror = (e) => { // the script itself failed: drop this worker
    e.preventDefault();
    const job = slot.job;
    slot.job = null;
    slot.worker.terminate();
    pool.splice(pool.indexOf(slot), 1);
    if (job) job.reject(new Error(e.message || 'stretch worker failed'));
    pumpJobs();
  };
  pool.push(slot);
  return slot;
}

function pumpJobs() {
  while (jobQueue.length) {
    const slot = pool.find((s) => !s.job) || (pool.length < POOL_SIZE ? spawnWorker() : null);
    if (!slot) return;
    const job = jobQueue.shift();
    slot.job = job;
    slot.worker.postMessage(job.msg, job.msg.channels.map((c) => c.buffer));
  }
}

function stretchInWorker(channels, sampleRate, targetLen, pitchRatio) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    jobQueue.push({ id, msg: { id, channels, sampleRate, targetLen, pitchRatio }, resolve, reject });
    pumpJobs();
  });
}

// ---------- buffers ----------
// Decoded originals are big (about 23 MB per minute of stereo at 48 kHz) and hover-prefetch
// would otherwise keep every stem ever pointed at, so both caches keep only the most
// recently used few. Playing layers hold their own buffers, so evicting is always safe.
const ORIGINALS_MAX = 6, RENDERS_MAX = 8;
const originals = new Map(); // stem id -> { promise, listeners }
const renders = new Map();   // render key -> Promise<AudioBuffer>
function lruGet(map, key) {
  const v = map.get(key);
  if (v !== undefined) { map.delete(key); map.set(key, v); }
  return v;
}
function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

const encodePath = (p) => encodeURI(p).replace(/#/g, '%23');

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) { // length lied (gzip): fall back to collecting the rest
      const rest = [out.subarray(0, got), value];
      for (;;) { const r = await reader.read(); if (r.done) break; rest.push(r.value); }
      return new Blob(rest).arrayBuffer();
    }
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out.buffer.slice(0, got);
}

// A local listing gives each stem's URL (`src`). Otherwise: the compressed Ogg copy
// (page-relative, works at any mount point), then the WAV master in ../Stems (legacy local dev).
let oggsMissing = false;
function getOriginal(info, type, onProgress) {
  const id = info.stems[type];
  let entry = lruGet(originals, id);
  if (!entry) {
    ensureCtx();
    entry = { listeners: new Set() };
    const progress = (p) => entry.listeners.forEach((fn) => fn(p));
    // Lossy codecs pad a few ms that must be trimmed off the loop; WAVs are the loop exactly.
    const load = async (path) => {
      const buf = await ctx.decodeAudioData(await fetchBytes(encodePath(path), progress));
      buf.lossy = !/\.wav$/i.test(path);
      return buf;
    };
    entry.promise = (async () => {
      if (info.src && info.src[type]) return load(info.src[type]);
      const ogg = info.oggs && info.oggs[type];
      if (ogg && !oggsMissing) {
        try { return await load(ogg); }
        catch (err) {
          if (/\(404\)/.test(err.message)) oggsMissing = true; // no compressed set here: go straight to WAVs
          console.warn('ogg failed, falling back to wav:', ogg, err);
        }
      }
      return load('../' + id);
    })();
    entry.promise.then(() => entry.listeners.clear(), () => { entry.listeners.clear(); originals.delete(id); });
    lruSet(originals, id, entry, ORIGINALS_MAX);
  }
  if (onProgress) entry.listeners.add(onProgress);
  return entry.promise;
}

// Warm the cache (e.g. on hover) so a pick feels instant.
export function prefetch(layerId, song) {
  const type = stemTypeFor(layerId, song);
  if (type) getOriginal(MANIFEST[song], type).catch(() => {});
}

// How many beats a file loops over (the nearest whole number of bars at the BPM in its name:
// 128 for stems, 64 for the Da Funk melody gun) and how many of its samples form the loop.
// A WAV is the loop exactly, even when it's a few samples off the nominal length (the gun
// loops; the HBFS guns are really ~123.5 BPM). A lossy decode is trimmed back to the ideal
// length when it only overshoots by codec padding.
export function loopShape(length, bpm, sampleRate, lossy = false) {
  const beats = Math.max(4, Math.round(length / sampleRate * bpm / 60 / 4) * 4);
  const ideal = Math.round(beats * 60 / bpm * sampleRate);
  const padded = lossy && length > ideal && length - ideal <= sampleRate * 0.05;
  return { beats, inLen: padded ? ideal : length };
}

// Rendered loops are whole numbers of one rounded bar, so a 16-bar loop playing twice stays
// sample-locked to a 32-bar one instead of drifting by a rounding sample every cycle.
const loopSamples = (beats, bpm, sr) => Math.round(4 * 60 / bpm * sr) * (beats / 4);

// Renders a stem at the current tempo and key. Identical requests share one render.
function render(song, type, onProgress) {
  const info = MANIFEST[song];
  const semis = semisFor(info.key), bpm = state.bpm, sr = ctx.sampleRate;
  const key = renderKey(song, type);
  let promise = lruGet(renders, key);
  if (!promise) {
    promise = (async () => {
      const orig = await getOriginal(info, type, onProgress);
      const { beats, inLen } = loopShape(orig.length, info.bpm, sr, orig.lossy);
      const chans = [0, 1].map((c) => orig.getChannelData(Math.min(c, orig.numberOfChannels - 1)).slice(0, inLen));
      const len = loopSamples(beats, bpm, sr);
      const out = await stretchInWorker(chans, sr, len, Math.pow(2, semis / 12));
      const buf = ctx.createBuffer(2, len, sr);
      buf.copyToChannel(out[0], 0);
      buf.copyToChannel(out[1], 1);
      return buf;
    })();
    promise.catch(() => renders.delete(key));
    lruSet(renders, key, promise, RENDERS_MAX);
  } else if (onProgress) {
    onProgress(1);
  }
  return { key, bpm, promise };
}

// ---------- transport ----------
// The next bar line, with a little lead so a swap is never scheduled in the past.
function nextBarTime() {
  const bar = barSec();
  const elapsed = ctx.currentTime + 0.02 - state.transportStart;
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
  src.onended = () => { src.disconnect(); sg.disconnect(); };
  s.source = src;
  s.srcGain = sg;
  s.startAt = when;
}

function stopSource(layerId, when) {
  const s = state.layers[layerId];
  const t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
  // An outgoing source from an earlier bar-quantized swap may still be due to play past t
  // (Stop pressed, or a tempo restart, before that bar line): cut it at t as well.
  s.tails = (s.tails || []).filter((x) => x.stopAt > ctx.currentTime);
  for (const x of s.tails) {
    if (x.stopAt <= t + 0.05) continue;
    try {
      x.sg.gain.cancelScheduledValues(t);
      x.sg.gain.setTargetAtTime(0, t, 0.01);
      x.src.stop(t + 0.06);
      x.stopAt = t + 0.06;
    } catch (_) { /* already stopped */ }
  }
  if (!s.source) return;
  try {
    if (t <= s.startAt) {
      s.source.stop(); // scheduled but not started yet: stopping before its start, it never sounds
    } else {
      s.srcGain.gain.setValueAtTime(1, t);
      s.srcGain.gain.linearRampToValueAtTime(0, t + 0.03);
      s.source.stop(t + 0.05);
      s.tails.push({ src: s.source, sg: s.srcGain, stopAt: t + 0.05 });
    }
  } catch (_) { /* already stopped */ }
  s.source = null;
  s.srcGain = null;
}

// Moves the clock to the current tempo at time t, keeping the position in the 32-bar cycle.
function retime(t) {
  const bars = (t - state.transportStart) / barSec(), cycle = BEATS / 4;
  const pos = ((bars % cycle) + cycle) % cycle;
  clockBpm = state.bpm;
  state.transportStart = t - pos * barSec();
  wahLfo.frequency.setTargetAtTime(clockBpm / 60, ctx.currentTime, 0.05);
}

// Renders the given layers at the current tempo/key, in parallel; remembers which pick each
// render was for, so a layer re-picked meanwhile can ignore it.
async function renderLayers(ids) {
  const jobs = ids.map((id) => {
    const s = state.layers[id];
    return { id, song: s.song, tag: s.renderTag, job: render(s.song, s.type) };
  });
  const done = await Promise.allSettled(jobs.map((j) => j.job.promise));
  return jobs.map((j, k) => ({ ...j, result: done[k] }));
}

let playGen = 0; // bumped by stop(), so work started before a stop doesn't start playback
let wantPlay = false; // Play was pressed while stems were still loading
export const playPending = () => wantPlay;
export async function play() {
  ensureCtx();
  if (state.playing) return;
  if (!activeLayers().length) { status('Pick a stem from the wheel to start the jam'); return; }
  if (activeLayers().some((id) => state.layers[id].loading)) {
    wantPlay = true; // the last pick to finish loading starts everything together
    status('Starting when the stems are ready…');
    return;
  }
  wantPlay = false;
  const gen = playGen;
  // Bring stale layers up to date; if tempo or key moves again while they render, go again.
  for (let pass = 0; pass < 4; pass++) {
    const stale = activeLayers().filter((id) => !state.layers[id].loading && !isCurrent(state.layers[id]));
    if (!stale.length) break;
    for (const id of stale) state.layers[id].syncing = true;
    changed();
    const results = await renderLayers(stale);
    for (const r of results) {
      const s = state.layers[r.id];
      s.syncing = false;
      if (r.result.status === 'fulfilled' && s.song === r.song && s.renderTag === r.tag) {
        s.buffer = r.result.value; s.bufferKey = r.job.key; s.bufferBpm = r.job.bpm;
      }
    }
    if (gen !== playGen || state.playing) { changed(); return; } // stopped or restarted meanwhile
  }
  const ready = activeLayers().filter((id) => isCurrent(state.layers[id]) && !state.layers[id].loading);
  if (!ready.length) { changed(); return; }
  const t = ctx.currentTime + 0.12;
  clockBpm = state.bpm;
  state.transportStart = t;
  wahLfo.frequency.setValueAtTime(clockBpm / 60, ctx.currentTime);
  for (const id of ready) startSource(id, t, 0);
  state.playing = true;
  changed();
}

export function stop() {
  playGen++;
  wantPlay = false;
  if (!ctx) return;
  for (const id of LAYERS.map((l) => l.id)) stopSource(id);
  state.playing = false;
  changed();
}

export const togglePlay = () => (state.playing ? stop() : play());

// Re-renders every layer that no longer matches the tempo/key, then swaps them in: a tempo
// change restarts everything together, in phase; a key change swaps on the next bar. Layers
// still loading a new pick are left to selectStem. Calls while running coalesce into one
// more pass.
let resyncRun = null, resyncAgain = false;
export function rebuildAll() {
  if (!ctx) return Promise.resolve();
  if (resyncRun) { resyncAgain = true; return resyncRun; }
  resyncRun = (async () => {
    try {
      do { resyncAgain = false; await resyncOnce(); } while (resyncAgain);
    } finally { resyncRun = null; }
  })();
  return resyncRun;
}

async function resyncOnce() {
  const stale = activeLayers().filter((id) => { const s = state.layers[id]; return s.buffer && !s.loading && !isCurrent(s); });
  const fresh = [];
  if (stale.length) {
    for (const id of stale) state.layers[id].syncing = true;
    changed();
    const results = await renderLayers(stale);
    let failed = false;
    for (const r of results) {
      const s = state.layers[r.id];
      s.syncing = false;
      if (s.song !== r.song || s.renderTag !== r.tag || s.loading) continue; // re-picked meanwhile
      if (r.result.status !== 'fulfilled') { failed = true; console.error(r.result.reason); continue; }
      if (r.job.key !== renderKey(s.song, s.type)) { resyncAgain = true; continue; } // settings moved on
      fresh.push(r);
    }
    if (failed) status('Could not re-sync stems — see console', 'error');
    if (resyncAgain) { changed(); return; } // nudged again while rendering: wait for the next pass
    for (const r of fresh) {
      const s = state.layers[r.id];
      s.buffer = r.result.value; s.bufferKey = r.job.key; s.bufferBpm = r.job.bpm;
    }
  }

  // The clock follows the tempo once at least one layer is ready at it (a layer that failed
  // to re-render drops out rather than playing out of time).
  const tempoMoves = clockBpm !== state.bpm && activeLayers().some((id) => isCurrent(state.layers[id]));
  if (!state.playing) {
    clockBpm = state.bpm;
  } else if (tempoMoves) {
    // Everything restarts together at the new tempo, from the same point in the loop.
    const t = ctx.currentTime + 0.08;
    retime(t);
    for (const id of activeLayers()) {
      const s = state.layers[id];
      if (s.buffer && s.bufferBpm === clockBpm && !s.loading) startSource(id, t, t - state.transportStart);
      else stopSource(id, t); // still loading a new pick at the old tempo: it joins when ready
    }
  } else if (fresh.length) {
    const t = nextBarTime();
    for (const r of fresh) startSource(r.id, t, t - state.transportStart);
  }
  changed();
}

// ---------- layer selection ----------
export async function selectStem(layerId, song, opts = {}) {
  ensureCtx();
  const s = state.layers[layerId];
  if (s.song === song && !opts.force) return clearLayer(layerId);
  const type = stemTypeFor(layerId, song);
  if (!type) return;

  const firstStem = activeLayers().length === 0;
  if (firstStem && !state.tempoTouched && !opts.keepTempo && !state.playing) state.bpm = Math.round(MANIFEST[song].bpm);
  const rootBefore = masterRoot();
  const gen = playGen;
  s.song = song;
  s.type = type;
  s.loading = true;
  s.progress = 0;
  if (!state.anchorOrder.includes(layerId)) state.anchorOrder.push(layerId);
  changed();
  // A new song on the auto-key anchor moves the master key: re-key the other layers (after
  // this task, so a random pick of every layer re-keys once, against the final songs).
  if (rootBefore !== null && masterRoot() !== rootBefore) queueMicrotask(rebuildAll);

  const tag = ++s.renderTag;
  try {
    // Progress arrives per network chunk; re-render the UI in 2% steps, not hundreds of times.
    const job = render(song, type, (p) => {
      if (s.renderTag === tag && (p >= 1 || p - s.progress >= 0.02)) { s.progress = p; changed(); }
    });
    const buf = await job.promise;
    if (s.renderTag !== tag || s.song !== song) return;
    s.buffer = buf; s.bufferKey = job.key; s.bufferBpm = job.bpm;
    s.loading = false;
    s.progress = 1;
    if (state.playing) {
      if (job.bpm === clockBpm) {
        const t = nextBarTime();
        startSource(layerId, t, t - state.transportStart);
      } else {
        stopSource(layerId); // the old pick was at another tempo; the resync starts this one
      }
    } else if ((wantPlay || !opts.noAutoplay) && gen === playGen && activeLayers().every((id) => !state.layers[id].loading)) {
      play(); // a pick starts the jam (unless Stop was pressed while it loaded)
    }
    // Tempo/key moved while it loaded, or it's ready at a tempo the clock hasn't reached yet:
    // the resync re-renders or retimes and starts it with the others.
    if (!isCurrent(s) || (state.playing && job.bpm !== clockBpm)) rebuildAll();
    changed();
  } catch (err) {
    if (s.renderTag !== tag) return;
    console.error(err);
    s.loading = false;
    stopSource(layerId);
    const rootBefore = masterRoot();
    s.song = s.type = s.buffer = s.bufferKey = null;
    state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
    if (!activeLayers().length) { state.playing = false; wantPlay = false; }
    status(`Couldn't load ${song} — is the stem file there?`, 'error');
    changed();
    if (masterRoot() !== rootBefore && masterRoot() !== null) rebuildAll(); // the failed pick was the key anchor
    // The others may have been waiting on this one to start (Play pressed during loading).
    if (!state.playing && (wantPlay || !opts.noAutoplay) && gen === playGen && activeLayers().length
      && activeLayers().every((id) => !state.layers[id].loading)) play();
  }
}

export function clearLayer(layerId) {
  const s = state.layers[layerId];
  if (!s.song) return;
  if (ctx) stopSource(layerId, state.playing ? nextBarTime() : undefined);
  s.renderTag++;
  const rootBefore = masterRoot();
  s.song = s.type = s.buffer = s.bufferKey = null;
  s.loading = s.syncing = false;
  state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
  if (!activeLayers().length) { state.playing = false; playGen++; wantPlay = false; }
  changed();
  if (masterRoot() !== rootBefore && masterRoot() !== null) rebuildAll();
}

export function randomize() {
  ensureCtx();
  // The auto-key anchor goes first, so the others are keyed against its new song.
  const order = [...new Set([...state.anchorOrder, ...LAYERS.map((l) => l.id)])];
  const taken = new Set(); // one song per layer when there's a choice: the point is to mix tracks
  for (const id of order) {
    const options = Object.keys(MANIFEST).filter((song) => stemTypeFor(id, song) && song !== state.layers[id].song);
    const fresh = options.filter((song) => !taken.has(song));
    const pool = fresh.length ? fresh : options;
    if (!pool.length) continue;
    const song = pool[Math.floor(Math.random() * pool.length)];
    taken.add(song);
    selectStem(id, song, { force: true });
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
// Pick one with the FX strip, hold F (or the button) to play it; letting go snaps back.
export const FX = [
  { id: 'stutter', label: 'Stutter', desc: 'Repeats the last eighth note in a choppy loop' },
  { id: 'lowpass', label: 'Low-pass', desc: 'Muffled and underwater: only the bass and kick' },
  { id: 'highpass', label: 'High-pass', desc: 'Thin and sizzling: the bass sweeps away' },
  { id: 'phaser', label: 'Phaser', desc: 'A jet-engine swoosh through the melodies' },
  { id: 'wah', label: 'Wah', desc: 'A resonant band sweeping up and down on the beat' },
  { id: 'tapestop', label: 'Tape stop', desc: 'Slows to a halt like a vinyl brake' },
];
let fxOn = null; // { id, ...state the release needs }

// Freeze a parameter where it is right now so a new ramp starts from there.
function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
}
const playingLayers = () => activeLayers().filter((id) => state.layers[id].source && state.layers[id].buffer);

export function fxStart(id) {
  if (!ctx || fxOn) return;
  const t = ctx.currentTime + 0.005;
  fxOn = { id };
  if (id === 'lowpass') { // sweeps down while held, so a longer hold goes deeper
    hold(lp.frequency, t); lp.frequency.exponentialRampToValueAtTime(260, t + 1.6);
    hold(lp.Q, t); lp.Q.linearRampToValueAtTime(5, t + 0.4);
  } else if (id === 'highpass') {
    hold(hp.frequency, t); hp.frequency.exponentialRampToValueAtTime(2400, t + 1.6);
    hold(hp.Q, t); hp.Q.linearRampToValueAtTime(4, t + 0.4);
  } else if (id === 'phaser') {
    hold(flWet.gain, t); flWet.gain.linearRampToValueAtTime(0.7, t + 0.08);
    hold(fxDry.gain, t); fxDry.gain.linearRampToValueAtTime(0.7, t + 0.08); // keep the overall level
  } else if (id === 'wah') {
    hold(wahWet.gain, t); wahWet.gain.linearRampToValueAtTime(2.2, t + 0.05); // band-pass is quiet: make up level
    hold(fxDry.gain, t); fxDry.gain.linearRampToValueAtTime(0.12, t + 0.05);
  } else if (id === 'stutter' && state.playing) {
    // Beat repeat: from the next 1/16 line, loop the eighth note that just played, gated so
    // each repeat is chopped. The real sources keep running underneath, muted, so letting go
    // lands back exactly in time.
    const bar = barSec(), slice = bar / 8, grid = bar / 16;
    const t0 = state.transportStart + Math.ceil((ctx.currentTime + 0.03 - state.transportStart) / grid) * grid;
    fxOn.repeats = [];
    for (const lid of playingLayers()) {
      const s = state.layers[lid], dur = s.buffer.duration;
      const at = (((t0 - state.transportStart) % dur) + dur) % dur;
      const from = Math.min(Math.max(0, at - slice), dur - slice);
      const gate = ctx.createGain();
      gate.gain.setValueAtTime(0, ctx.currentTime);
      for (let k = 0; k < 96; k++) { // up to 12 bars of repeats; released long before that
        const a = t0 + k * slice;
        gate.gain.setValueAtTime(0, a);
        gate.gain.linearRampToValueAtTime(1, a + 0.004);
        gate.gain.setValueAtTime(1, a + slice * 0.62);
        gate.gain.linearRampToValueAtTime(0, a + slice * 0.62 + 0.006);
      }
      const src = ctx.createBufferSource();
      src.buffer = s.buffer; src.loop = true; src.loopStart = from; src.loopEnd = from + slice;
      src.connect(gate);
      gate.connect(s.gain);
      src.start(t0, from);
      fxOn.repeats.push({ src, gate });
      s.srcGain.gain.setValueAtTime(1, t0 - 0.004);
      s.srcGain.gain.linearRampToValueAtTime(0, t0);
    }
  } else if (id === 'tapestop' && state.playing) {
    // Slow every source to a halt; letting go restarts them in sync with the clock.
    fxOn.layers = playingLayers();
    for (const lid of fxOn.layers) {
      const s = state.layers[lid];
      hold(s.source.playbackRate, t);
      s.source.playbackRate.linearRampToValueAtTime(0.0001, t + 1.3);
      s.srcGain.gain.setValueAtTime(1, t + 0.9);
      s.srcGain.gain.linearRampToValueAtTime(0, t + 1.3);
    }
  }
}

export function fxStop() {
  if (!ctx || !fxOn) return;
  const { id } = fxOn, t = ctx.currentTime + 0.005;
  if (id === 'lowpass') {
    hold(lp.frequency, t); lp.frequency.exponentialRampToValueAtTime(22000, t + 0.12);
    hold(lp.Q, t); lp.Q.linearRampToValueAtTime(0.7, t + 0.12);
  } else if (id === 'highpass') {
    hold(hp.frequency, t); hp.frequency.exponentialRampToValueAtTime(10, t + 0.12);
    hold(hp.Q, t); hp.Q.linearRampToValueAtTime(0.7, t + 0.12);
  } else if (id === 'phaser') {
    hold(flWet.gain, t); flWet.gain.linearRampToValueAtTime(0, t + 0.15);
    hold(fxDry.gain, t); fxDry.gain.linearRampToValueAtTime(1, t + 0.15);
  } else if (id === 'wah') {
    hold(wahWet.gain, t); wahWet.gain.linearRampToValueAtTime(0, t + 0.06);
    hold(fxDry.gain, t); fxDry.gain.linearRampToValueAtTime(1, t + 0.06);
  } else if (id === 'stutter' && fxOn.repeats) {
    for (const { src, gate } of fxOn.repeats) {
      hold(gate.gain, t); gate.gain.linearRampToValueAtTime(0, t + 0.01);
      try { src.stop(t + 0.03); } catch (_) { /* already stopped */ }
      src.onended = () => { src.disconnect(); gate.disconnect(); };
    }
    for (const lid of LAYERS.map((l) => l.id)) {
      const s = state.layers[lid];
      if (!s.srcGain) continue;
      hold(s.srcGain.gain, t); s.srcGain.gain.linearRampToValueAtTime(1, t + 0.01);
    }
  } else if (id === 'tapestop' && fxOn.layers) {
    const at = t + 0.02;
    for (const lid of fxOn.layers) {
      const s = state.layers[lid];
      if (s.buffer && s.source && state.playing) startSource(lid, at, at - state.transportStart);
    }
  }
  fxOn = null;
}

// ---------- meters (for the visuals) ----------
const meterBuf = new Float32Array(256);
let spectrum = null;
const meterOut = { groove: 0, lead: 0, texture: 0, bass: 0, mid: 0, high: 0, beat: 0, bar: 0, beatIndex: -1, spectrum: null };
export function meters() {
  meterOut.groove = meterOut.lead = meterOut.texture = meterOut.bass = meterOut.mid = meterOut.high = meterOut.beat = meterOut.bar = 0;
  meterOut.beatIndex = -1;
  if (!ctx) return meterOut;
  for (const l of LAYERS) {
    const s = state.layers[l.id];
    if (!s.source) continue;
    s.analyser.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    meterOut[l.id] = Math.min(1, Math.sqrt(sum / meterBuf.length) * 3.2);
  }
  spectrum ??= new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(spectrum);
  const band = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += spectrum[i]; return s / (b - a) / 255; };
  meterOut.bass = band(1, 6); meterOut.mid = band(6, 40); meterOut.high = band(40, 160);
  meterOut.spectrum = spectrum;
  if (state.playing) {
    // The visuals follow what is audible now, not what the audio thread is rendering: on
    // Bluetooth or HDMI output that difference is 100-300 ms and the beat flashes run early.
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    const heard = ts && ts.contextTime
      ? ts.contextTime + (performance.now() - ts.performanceTime) / 1000
      : ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    const elapsed = heard - state.transportStart;
    if (elapsed >= 0) {
      const beats = elapsed / barSec() * 4;
      meterOut.beatIndex = Math.floor(beats) % BEATS;
      meterOut.beat = beats % 1;
      meterOut.bar = (beats / 4) % 32;
    }
  }
  return meterOut;
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

// One full 32-bar cycle through the same glue as the live mix. It renders two cycles and keeps
// the second, so the compressors are already settled and the file loops without a bump.
export async function exportLoopWav() {
  const ids = activeLayers().filter((id) => {
    const s = state.layers[id];
    return s.buffer && !s.muted && s.bufferBpm === clockBpm;
  });
  if (!ids.length) { status('Nothing to export — pick some stems first'); return null; }
  const sr = ctx.sampleRate;
  const len = loopSamples(BEATS, clockBpm, sr);
  const look = 2 * Math.floor(0.006 * sr); // two compressors' look-ahead (measured: 528 samples at 44.1k): bar 1 at sample 0
  const off = new OfflineAudioContext(2, len * 2 + look, sr);
  const glue = buildGlue(off);
  const out = off.createGain();
  out.gain.value = 0.9; // the default master level
  glue.output.connect(out);
  out.connect(off.destination);
  for (const id of ids) {
    const s = state.layers[id];
    const src = off.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    const g = off.createGain();
    g.gain.value = s.volume;
    src.connect(g);
    g.connect(glue.input);
    src.start(0);
  }
  const rendered = await off.startRendering();
  return encodeWav([0, 1].map((c) => rendered.getChannelData(c).subarray(len + look)), sr);
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
