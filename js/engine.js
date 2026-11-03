/* Audio engine — ported from Dream Chamber Studios Remixed (MuscularCrab).
   Every stem is a seamless loop, normally 32 bars / 128 beats. Stems are conformed
   to the master BPM (WSOLA time-stretch) and optionally the master key (resampling
   pitch shift) in a small pool of workers, then looped in sample-accurate sync.
   Swaps are quantized to the next bar. */

import { manifestFromListing } from './manifest.js';
import { integratedLoudness } from './loudness.js';

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
let master, bus, hp, lp, fxDry, wah, wahWet, phaser, phWet, analyser, mediaDest, glueIn;
let recorder = null;

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
    source: null, srcGain: null, fxIn: null, gain: null, analyser: null,
    loading: false, syncing: false, progress: 0, renderTag: 0,
    error: null, // why the layer couldn't follow the last tempo or key change, if it couldn't
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

// Why a stem didn't load, in words a player can act on (the details go to the console).
function loadError(song, err) {
  const m = String((err && err.message) || err);
  if (/\(404\)/.test(m)) return `${song} is missing from the server`;
  if (/\((429|503)\)/.test(m)) return `The server is busy, so ${song} didn't load: try again in a moment`;
  if ((err && err.name === 'EncodingError') || /decod/i.test(m)) return `This browser can't play the file for ${song}`;
  if ((err && err.name === 'RangeError') || /memory|allocat/i.test(m)) return `Not enough memory for ${song}: close other tabs and try again`;
  if ((err && err.name === 'TypeError') || /network|fetch/i.test(m)) return `Couldn't download ${song}: check the connection and try again`;
  return `Couldn't load ${song}: try again`;
}

// ---------- helpers ----------
// One bar in seconds, rounded to whole samples exactly like the rendered loops (loopSamples),
// so the clock and every looping buffer share one grid.
const barSec = (bpm = clockBpm) => (ctx ? Math.round(4 * 60 / bpm * ctx.sampleRate) / ctx.sampleRate : 4 * 60 / bpm);
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
// Both are asked for at once: on the hosted site the listing is a 404, and waiting for that
// before asking for stems.json cost a round trip before any stem could start.
export async function loadManifest(url) {
  const hosted = fetch(url).then((res) => res.json());
  hosted.catch(() => {}); // unused, and maybe missing, when the local listing answers
  try {
    const res = await fetchPatiently('__local/files', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) LOCAL = await res.json();
  } catch (_) { /* not the local server */ }
  if (LOCAL && LOCAL.stems && LOCAL.stems.length) MANIFEST = manifestFromListing(LOCAL);
  else MANIFEST = await hosted;
  return MANIFEST;
}

// ---------- audio graph ----------
// layers -> bus -> highpass -> lowpass -> dry ------------------------> glue -> master -> analyser -> out
//                               lowpass -> wah (swept band-pass) -> wet -> glue
//                               lowpass -> phaser (4 swept all-passes) -> wet -> glue
// The filters and wet paths sit idle until an Audio FX is held (see fxStart), which also starts
// the sweep's LFO.
// The glue is a lookahead true-peak limiter (js/limiter-worklet.js): the stems are evened out
// at the source (see stemTrim), so it only has to catch the peaks where three stems add up,
// and never goes over its -1 dBTP ceiling. `drive` sets how far typical mixes reach into it,
// chosen so a three-layer mix plays about as loud as it did through the old compressors.
const LIMIT = { lookahead: 0.005, release: 0.12, ceiling: -1, drive: -2.5 };
const limiterModule = new URL('./limiter-worklet.js', import.meta.url);
const loadLimiter = (c) => (c.audioWorklet && window.AudioWorkletNode
  ? c.audioWorklet.addModule(limiterModule) : Promise.reject(new Error('AudioWorklet is not supported')));
function buildLimiter(c) {
  const lookahead = Math.round(LIMIT.lookahead * c.sampleRate);
  const input = c.createGain();
  input.gain.value = Math.pow(10, LIMIT.drive / 20);
  const output = new AudioWorkletNode(c, 'true-peak-limiter', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { lookahead, release: LIMIT.release, ceiling: LIMIT.ceiling },
  });
  input.connect(output);
  return { input, output, latency: lookahead }; // its delay is exactly the lookahead
}

// Where AudioWorklet is missing (or its module won't load), and until it has loaded: gentle
// bus compression into a DynamicsCompressor peak limiter, so three summed stems don't clip.
// Both compressors add automatic make-up gain (measured: +2.96 dB and +1.14 dB); the trims
// take it back out. Each compressor delays the audio by its 6 ms look-ahead.
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
  return { input: comp, output: trim2, latency: 2 * Math.floor(0.006 * c.sampleRate) }; // measured: 528 samples at 44.1k
}

// The limiter if this context can run it, otherwise the compressor glue.
async function buildMaster(c) {
  try { await loadLimiter(c); return buildLimiter(c); } catch (err) {
    noLimiter(err);
    return buildGlue(c);
  }
}

// The live graph starts on the compressor glue and moves to the limiter once its module has
// loaded (normally long before the first stem is ready; play() waits a moment for it).
let limiterReady = null;
// AudioWorklet only exists on HTTPS or localhost, so a phone opening the dev server by its LAN
// address always hears the fallback: say so, or a check made that way tests the wrong chain.
const noLimiter = (err) => console.warn(`The true-peak limiter is unavailable, using the compressor glue${
  window.isSecureContext === false ? ' (it needs HTTPS or localhost)' : ''}:`, err);
function upgradeGlue(c, fallback, fbLevel, glueOut) {
  limiterReady = loadLimiter(c).then(() => {
    const lim = buildLimiter(c), level = c.createGain();
    // While playing, the limiter path is delayed to line up with the fallback (528 against 221
    // samples), so the blend doesn't comb-filter and the music doesn't skip 7 ms ahead. The delay
    // stays: it is the latency the jam already had.
    let out = lim.output, filled = lim.latency / c.sampleRate;
    const lag = (fallback.latency - lim.latency) / c.sampleRate;
    if (state.playing && lag > 0) {
      out = c.createDelay(Math.max(1, lag * 2));
      out.delayTime.value = lag;
      lim.output.connect(out);
      filled += lag;
    }
    // Crossfaded while music plays, so the switch is a short blend rather than a click. The new
    // path stays silent until its fade (a new gain starts at 1, and plays at that until its first
    // event, so both chains would sound at full level together), and the fade starts only once
    // the audio has come through its delay (or it steps in from silence part-way up the ramp).
    const now = c.currentTime, t = now + 0.005 + filled, fade = state.playing ? 0.05 : 0.001;
    level.gain.value = 0;
    level.gain.setValueAtTime(0, t); level.gain.linearRampToValueAtTime(1, t + fade);
    fbLevel.gain.setValueAtTime(1, now); fbLevel.gain.setValueAtTime(1, t); fbLevel.gain.linearRampToValueAtTime(0, t + fade);
    glueIn.connect(lim.input); out.connect(level); level.connect(glueOut);
    setTimeout(() => { glueIn.disconnect(fallback.input); fbLevel.disconnect(); }, (fade + 0.2) * 1000);
  }, noLimiter);
}

export function ensureCtx() {
  if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return ctx; }
  // Run at the stems' own rate: decoding 44.1 kHz loops into a 48 kHz context rings at both
  // loop ends (a tick at every wrap). The browser resamples the output stream instead.
  const AC = window.AudioContext || window.webkitAudioContext;
  // iOS: as media playback, sound plays with the silent switch on (Safari 16.4+).
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* not settable */ }
  let refused = '';
  try { ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' }); } catch (err) { refused = ` (${err && err.message})`; ctx = new AC(); }
  // Some browsers throw, older ones quietly ignore the rate: either way, say so in the console.
  if (ctx.sampleRate !== 44100) console.warn(`44.1 kHz audio was refused${refused}; running at ${ctx.sampleRate} Hz, so loops may tick where they wrap`);
  LEAD = Math.min(0.2, Math.max(XFADE + 0.04, XFADE + 0.02 + 2 * (ctx.baseLatency || 0)));
  // A call, Siri or another app suspends (iOS: 'interrupts') the context; bring it back when we can.
  ctx.onstatechange = wakeAudio;
  document.addEventListener('visibilitychange', wakeAudio);
  master = ctx.createGain();
  master.gain.value = 0.9;
  bus = ctx.createGain();
  hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
  lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 22000;
  // Low-pass and High-pass sweep in cents (detune), which is exponential in Hz but ramps in
  // straight lines, so it can be tracked like the gains (see rampTracked).
  for (const p of [hp.detune, hp.Q, lp.detune, lp.Q]) tracked(p, p.value);
  fxDry = ctx.createGain(); tracked(fxDry.gain, 1);
  wah = ctx.createBiquadFilter(); wah.type = 'bandpass'; wah.frequency.value = WAH.center; wah.Q.value = WAH.q;
  wahWet = ctx.createGain(); wahWet.gain.value = 0; tracked(wahWet.gain, 0);
  phaser = Array.from({ length: PHASER.stages }, () => {
    const f = ctx.createBiquadFilter();
    f.type = 'allpass'; f.frequency.value = PHASER.low; f.Q.value = PHASER.q;
    return f;
  });
  phWet = ctx.createGain(); phWet.gain.value = 0; tracked(phWet.gain, 0);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  mediaDest = ctx.createMediaStreamDestination();
  glueIn = ctx.createGain();
  const glueOut = ctx.createGain(), glue = buildGlue(ctx), fbLevel = ctx.createGain();
  glueIn.connect(glue.input); glue.output.connect(fbLevel); fbLevel.connect(glueOut);
  upgradeGlue(ctx, glue, fbLevel, glueOut);

  bus.connect(hp); hp.connect(lp); lp.connect(fxDry); fxDry.connect(glueIn);
  lp.connect(wah); wah.connect(wahWet); wahWet.connect(glueIn);
  phaser.reduce((a, b) => { a.connect(b); return b; }, lp).connect(phWet); phWet.connect(glueIn);
  glueOut.connect(master);
  glueOut.connect(mediaDest); // recordings are taken before the volume slider, at the export's level
  master.connect(analyser); analyser.connect(ctx.destination);

  // Chromium stops running a node once all its inputs have ended, and automation timed in that
  // gap is lost (measured: an insert reopened just after its sources stopped, as on Stop during
  // Stutter, stayed shut and the next Play was silent). A constant zero keeps the inserts running.
  const keepAlive = ctx.createConstantSource ? ctx.createConstantSource() : null;
  if (keepAlive) { keepAlive.offset.value = 0; keepAlive.start(); }
  for (const l of LAYERS) {
    const s = state.layers[l.id];
    // Every source of the layer (playing, fading out, or waiting for its bar line) goes through
    // fxIn, so Stutter and Tape stop can silence all of them at once.
    s.fxIn = ctx.createGain();
    tracked(s.fxIn.gain, 1);
    if (keepAlive) keepAlive.connect(s.fxIn);
    s.gain = ctx.createGain();
    s.fxIn.connect(s.gain);
    s.gain.gain.value = s.muted ? 0 : s.volume;
    s.analyser = ctx.createAnalyser();
    s.analyser.fftSize = 256;
    s.gain.connect(s.analyser);
    s.gain.connect(bus);
  }
  return ctx;
}

// While the jam should be playing, a stopped clock is resumed as soon as the page is visible.
// Browsers may only allow that after a tap, so if it hasn't come back shortly, ask for one
// (once per interruption); main.js resumes on the next tap or key press.
let wakeAsked = false;
function wakeAudio() {
  if (!ctx || ctx.state === 'running') { wakeAsked = false; return; }
  if (!state.playing || ctx.state === 'closed' || document.hidden) return;
  ctx.resume().catch(() => {});
  setTimeout(() => {
    if (wakeAsked || !state.playing || ctx.state === 'running' || document.hidden) return;
    wakeAsked = true;
    status('The sound was paused by the device: tap anywhere to bring it back');
  }, 400);
}

// ---------- stretch workers ----------
// A few workers so a tempo or key change re-renders the layers in parallel. Workers start
// on first use; each takes one job at a time, newest first, so the latest pick doesn't wait
// behind older ones. Jobs nobody wants any more (re-picked, or the tempo or key moved on)
// are dropped with an AbortError, which callers take as "nothing to do" rather than a failure.
// A stretch job briefly holds up to ~150 MB, so low-memory devices get two workers at most.
// deviceMemory is Chromium-only; elsewhere a touch-only device is assumed to be a phone (the
// cache budget below uses the same estimate).
const touchOnly = navigator.maxTouchPoints > 0 && !(window.matchMedia && matchMedia('(hover: hover)').matches);
const deviceGB = navigator.deviceMemory || (touchOnly ? 2 : 8);
const POOL_SIZE = Math.max(1, Math.min(deviceGB <= 4 ? 2 : 3, (navigator.hardwareConcurrency || 2) - 1));
const pool = []; // { worker, job }
const jobQueue = [];
let jobSeq = 0;
const abortError = () => new DOMException('No longer wanted', 'AbortError');
const isAbort = (err) => !!err && err.name === 'AbortError';

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

function dropJob(job) { job.dropped(); job.reject(abortError()); }

function pumpJobs() {
  for (let k = jobQueue.length - 1; k >= 0; k--) if (!jobQueue[k].wanted()) dropJob(jobQueue.splice(k, 1)[0]);
  while (jobQueue.length) {
    let slot = pool.find((s) => !s.job) || (pool.length < POOL_SIZE ? spawnWorker() : null);
    // Every worker busy: one stuck on a render nobody wants gives way (a new one starts at once).
    const stale = !slot && pool.find((s) => !s.job.wanted());
    if (stale) {
      stale.worker.terminate();
      pool.splice(pool.indexOf(stale), 1);
      dropJob(stale.job);
      slot = spawnWorker();
    }
    if (!slot) return;
    const job = jobQueue.pop();
    let msg;
    try { msg = job.message(); } catch (err) { job.reject(err); continue; } // e.g. out of memory for the copy
    slot.job = job;
    slot.worker.postMessage(msg, msg.channels.map((c) => c.buffer));
  }
}

// `channels` is a function, so the input is copied out of the original only when a worker takes
// the job, not while it waits. `type` (the stem type) lets the worker tune itself per layer.
function stretchInWorker(channels, sampleRate, targetLen, pitchRatio, { wanted = () => true, dropped = () => {}, type } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    const message = () => ({ id, channels: channels(), sampleRate, targetLen, pitchRatio, type });
    jobQueue.push({ id, message, wanted, dropped, resolve, reject });
    pumpJobs();
  });
}

// ---------- buffers ----------
// Decoded originals (20-30 MB each) and renders (19-34 MB each, by tempo) are kept for quick
// re-picks and key or tempo changes, within a memory budget sized for the device: phones get
// killed by the OS long before desktops notice (deviceGB: see the stretch pool). Playing layers
// hold their own buffers, so evicting is always safe, and a buffer a layer is playing costs the
// cache nothing extra.
const MB = 1 << 20;
export const CACHE_BUDGET = (deviceGB <= 2 ? 128 : deviceGB <= 4 ? 256 : 512) * MB;
const originals = new Map(); // stem id -> { promise, listeners, ctl, settled, downloading, buf }
const renders = new Map();   // render key -> { promise, bpm, buf }
function lruGet(map, key) {
  const v = map.get(key);
  if (v !== undefined) { map.delete(key); map.set(key, v); }
  return v;
}

// The bytes a cache entry keeps alive that no layer is holding anyway.
function entryBytes() {
  const used = new Set();
  for (const l of LAYERS) {
    const s = state.layers[l.id];
    used.add(s.buffer);
    if (s.source) used.add(s.source.buffer);
    for (const x of s.tails || []) if (x.stopAt > ctx.currentTime) used.add(x.src.buffer);
  }
  return (e) => (e.buf && !used.has(e.buf) ? e.buf.length * e.buf.numberOfChannels * 4 : 0);
}
export function cacheBytes() {
  const size = entryBytes(), sum = (m) => [...m.values()].reduce((a, e) => a + size(e), 0);
  return { originals: sum(originals), renders: sum(renders), entries: originals.size + renders.size, budget: CACHE_BUDGET };
}

// Over budget, the least useful entries go first, oldest first within each group: renders at
// another tempo or that no layer can use now, then originals no layer has picked, then the rest.
// An entry still loading is never evicted (a pick or render is waiting on it).
function trimCaches() {
  const size = entryBytes();
  let total = 0;
  for (const m of [originals, renders]) for (const e of m.values()) total += size(e);
  if (total <= CACHE_BUDGET) return;
  const keys = new Set(activeLayers().map((id) => renderKey(state.layers[id].song, state.layers[id].type)));
  const ids = new Set(activeLayers().map((id) => MANIFEST[state.layers[id].song].stems[state.layers[id].type]));
  const tiers = [
    [renders, ([k, e]) => e.bpm !== state.bpm || !keys.has(k)],
    [originals, ([id]) => !ids.has(id)],
    [renders, () => true],
    [originals, () => true],
  ];
  for (const [map, pick] of tiers) {
    for (const [k, e] of [...map].filter(pick)) {
      if (total <= CACHE_BUDGET) return;
      if (!e.buf || !size(e) || map.get(k) !== e) continue;
      map.delete(k);
      total -= size(e);
    }
  }
}

// Downloads nobody is waiting for (hover prefetches, picks since replaced) are cancelled so they
// don't hold the server's few download slots while a real pick queues behind them.
function abortUnwanted(keep) {
  for (const [id, e] of originals) {
    if (e.downloading && id !== keep && !stemWanted(id)) { e.ctl.abort(); originals.delete(id); }
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(abortError()); return; }
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

const encodePath = (p) => encodeURI(p).replace(/#/g, '%23');

// The server answers 429/503 when this visitor (or everyone) has too many downloads going;
// wait as long as it asks and try again instead of failing the stem. Earlier downloads on a slow
// link can hold the slots for a while, so give up only after two minutes, not a set count.
// Retries stop as soon as nothing wants the file any more (a prefetch, or a pick since replaced),
// so they don't take slots from the picks that will play; the two minutes start from the first
// refusal while it was wanted.
// A dropped connection (fetch throws) is tried twice more, after 1 and 2 s, while still wanted.
// An abort (opts.signal) ends it at once, waits included.
async function fetchPatiently(url, opts, wanted = () => true) {
  let since = 0, drops = 0;
  const signal = opts && opts.signal;
  for (;;) {
    let res;
    try { res = await fetch(url, opts); } catch (err) {
      if (isAbort(err) || ++drops > 2 || !wanted()) throw err;
      await sleep(drops * 1000, signal);
      continue;
    }
    if ((res.status !== 429 && res.status !== 503) || !wanted()) return res;
    if (!since) since = Date.now();
    if (Date.now() - since > 120000) return res;
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 30);
    await sleep(wait * (750 + Math.random() * 500), signal);
    if (!wanted()) return res; // re-picked or cleared while waiting
  }
}

// Whether a layer's current pick is this stem (hover-prefetches and replaced picks aren't).
const stemWanted = (id) => activeLayers().some((lid) => {
  const s = state.layers[lid];
  return MANIFEST[s.song].stems[s.type] === id;
});

async function fetchBytes(url, onProgress, wanted, signal) {
  const res = await fetchPatiently(url, { signal }, wanted);
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
  if (got < total) throw new Error(`download cut short (network): ${url}`);
  return out.buffer; // exactly `total` bytes: the buffer itself, no copy
}

// A local listing gives each stem's URL (`src`). Otherwise: the compressed Ogg copy
// (page-relative, works at any mount point), then the WAV master in ../Stems (legacy local dev).
let oggsMissing = false;
function getOriginal(info, type, onProgress) {
  const id = info.stems[type];
  let entry = lruGet(originals, id);
  if (!entry) {
    ensureCtx();
    entry = { listeners: new Set(), ctl: new AbortController() };
    const progress = (p) => entry.listeners.forEach((fn) => fn(p));
    // Lossy codecs pad a few ms that must be trimmed off the loop; WAVs are the loop exactly.
    const load = async (path) => {
      entry.downloading = true;
      let bytes;
      try { bytes = await fetchBytes(encodePath(path), progress, () => stemWanted(id), entry.ctl.signal); }
      finally { entry.downloading = false; }
      const buf = await ctx.decodeAudioData(bytes);
      buf.lossy = !/\.wav$/i.test(path);
      return buf;
    };
    entry.promise = (async () => {
      if (info.src && info.src[type]) return load(info.src[type]);
      const ogg = info.oggs && info.oggs[type];
      let oggErr = null;
      if (ogg && !oggsMissing) {
        try { return await load(ogg); }
        catch (err) {
          if (isAbort(err)) throw err;
          if (/\(404\)/.test(err.message)) oggsMissing = true; // no compressed set here: go straight to WAVs
          else oggErr = err;
          console.warn('ogg failed, falling back to wav:', ogg, err);
        }
      }
      // On the hosted site there are no WAVs, so a missing WAV says nothing: report why the Ogg failed.
      try { return await load('../' + id); }
      catch (err) { throw oggErr && /\(404\)/.test(err.message) ? oggErr : err; }
    })();
    entry.promise.then((buf) => { entry.settled = true; entry.buf = buf; entry.listeners.clear(); setTimeout(trimCaches); }, () => {
      entry.listeners.clear();
      if (originals.get(id) === entry) originals.delete(id); // not a newer load of the same stem
    });
    originals.set(id, entry);
  }
  // Already downloaded (e.g. hover-prefetched): say so now, so the card moves on to the stretch.
  if (onProgress) { if (entry.settled) onProgress(1); else entry.listeners.add(onProgress); }
  return entry.promise;
}

// Warm the cache (e.g. on hover) so a pick feels instant. Only one at a time (a newer hover
// cancels the older download), and never while a pick is loading: that one comes first.
export function prefetch(layerId, song) {
  const type = stemTypeFor(layerId, song);
  if (!type || activeLayers().some((id) => state.layers[id].loading)) return;
  abortUnwanted(MANIFEST[song].stems[type]);
  getOriginal(MANIFEST[song], type).catch(() => {});
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

// ---------- loudness ----------
// The stems differ by 7 LU (-10.1 to -17.1 LUFS), so a swap on one layer could jump or drop
// several dB. Each original is measured once (BS.1770, see loudness.js) and played with a trim
// towards the average of its kind: that keeps today's balance between Groove, Lead and Extra and
// only moves the outliers. The measurements are a few bytes, so they outlive the audio caches.
const TYPE_LUFS = { groove: -12.6, all: -12.6, lead: -12.6, texture: -14.6, guns: -14.3 };
const loudness = new Map(); // stem id -> Promise of LUFS
function stemTrim(info, type, orig, inLen) {
  const id = info.stems[type];
  if (!loudness.has(id)) {
    const chans = [0, 1].map((c) => orig.getChannelData(Math.min(c, orig.numberOfChannels - 1)));
    const p = integratedLoudness(chans, orig.sampleRate, inLen);
    p.catch(() => loudness.delete(id));
    loudness.set(id, p);
  }
  return loudness.get(id).then((lufs) => {
    const want = TYPE_LUFS[info.album === 'guns' ? 'guns' : type]; // an instrument-gun part
    const db = Number.isFinite(lufs) ? Math.max(-6, Math.min(6, want - lufs)) : 0;
    return Math.pow(10, db / 20);
  });
}
// The trim a rendered buffer plays with (render() puts it on the buffer).
const trimOf = (buffer) => buffer.trim ?? 1;
// A source's trim stage: set on its own node, so the level changes exactly with the swap.
function trimNode(c, buffer) {
  const g = c.createGain();
  g.gain.value = trimOf(buffer);
  return g;
}

// Rendered loops are whole numbers of one rounded bar, so a 16-bar loop playing twice stays
// sample-locked to a 32-bar one instead of drifting by a rounding sample every cycle.
const loopSamples = (beats, bpm, sr) => Math.round(4 * 60 / bpm * sr) * (beats / 4);

// Renders a stem at the current tempo and key. Identical requests share one render.
function render(song, type, onProgress) {
  const info = MANIFEST[song];
  const semis = semisFor(info.key), bpm = state.bpm, sr = ctx.sampleRate;
  const key = renderKey(song, type);
  let entry = lruGet(renders, key);
  if (!entry) {
    entry = { bpm };
    const forget = () => { if (renders.get(key) === entry) renders.delete(key); };
    // Still wanted while a layer has this pick and the tempo and key still call for this render.
    const wanted = () => activeLayers().some((id) => {
      const s = state.layers[id];
      return s.song === song && s.type === type && renderKey(song, type) === key;
    });
    entry.promise = (async () => {
      const orig = await getOriginal(info, type, onProgress);
      const { beats, inLen } = loopShape(orig.length, info.bpm, sr, orig.lossy);
      const chans = () => [0, 1].map((c) => orig.getChannelData(Math.min(c, orig.numberOfChannels - 1)).slice(0, inLen));
      const len = loopSamples(beats, bpm, sr);
      // Dropped from the queue: forgotten at once, so a new request for it starts afresh.
      // The loudness is measured meanwhile, on this thread (about 0.1 s for a stem).
      const [out, trim] = await Promise.all([
        stretchInWorker(chans, sr, len, Math.pow(2, semis / 12), { wanted, dropped: forget, type }),
        stemTrim(info, type, orig, inLen).catch((err) => { console.warn('loudness not measured:', err); return 1; }),
      ]);
      const buf = ctx.createBuffer(2, len, sr);
      buf.copyToChannel(out[0], 0);
      buf.copyToChannel(out[1], 1);
      buf.trim = trim;
      entry.buf = buf;
      return buf;
    })();
    entry.promise.then(() => setTimeout(trimCaches), forget); // once the layer waiting for it holds it
    renders.set(key, entry);
  } else if (onProgress) {
    onProgress(1);
  }
  return { key, bpm, promise: entry.promise };
}

// ---------- transport ----------
// Changes finish on the beat instead of starting there: an incoming stem starts XFADE early,
// from the matching point in its loop (the loops are seamless, so that is its real lead-in),
// and fades in while the outgoing one fades out. The new downbeat lands at full level and the
// old one is already gone.
const XFADE = 0.01;

// How far ahead of now anything is scheduled (bar swaps, Play, the tempo restart): the
// crossfade plus a margin, more on devices that render audio in big chunks (baseLatency),
// because a source that starts late never catches up and stays flammed. Set in ensureCtx.
let LEAD = XFADE + 0.04;

// Times and loop positions stay on whole samples: a source read from between two samples is
// interpolated, which dulls the top end.
const frame = (t) => Math.round(t * ctx.sampleRate) / ctx.sampleRate;

// The next bar line, with enough lead that its crossfade is never scheduled in the past.
function nextBarTime() {
  const bar = barSec();
  const elapsed = ctx.currentTime + LEAD - state.transportStart;
  return state.transportStart + (Math.floor(elapsed / bar) + 1) * bar;
}

// Params this file automates (each source's fade gain, each layer's FX insert, the FX filters and
// wet/dry levels) keep their schedule
// as straight lines between known points, so the level at a future time is computed, not read:
// AudioParam.value is only the level now, cancelAndHoldAtTime doesn't anchor a ramp that starts
// after the last event, and Firefox lacks it.
function tracked(param, v) { param.pts = [[0, v]]; return param; }
function levelAt(param, t) {
  const p = param.pts;
  if (t <= p[0][0]) return p[0][1];
  let k = p.length - 1;
  while (p[k][0] > t) k--;
  const [t0, v0] = p[k], next = p[k + 1];
  return next ? v0 + (next[1] - v0) * (t - t0) / (next[0] - t0) : v0;
}
// From whatever level the param has at `from`, a straight line to v at `to`.
function rampTracked(param, from, to, v) {
  const v0 = levelAt(param, from);
  param.cancelScheduledValues(from);
  param.linearRampToValueAtTime(v0, from); // the same line the schedule was on up to `from`
  param.linearRampToValueAtTime(v, to);
  const pts = [...param.pts.filter(([t]) => t < from), [from, v0], [to, v]];
  while (pts.length > 2 && pts[1][0] <= ctx.currentTime) pts.shift(); // keep one point in the past
  param.pts = pts;
}

// `offset` is the loop position that should sound at `when`. `buffer` defaults to the layer's.
function startSource(layerId, when, offset, buffer) {
  const s = state.layers[layerId];
  stopSource(layerId, when);
  buffer ??= s.buffer;
  const dur = buffer.duration, len = buffer.length, sr = ctx.sampleRate;
  const at = frame(Math.max(when - XFADE, ctx.currentTime));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.loopEnd = dur;
  const sg = ctx.createGain();
  const full = Math.max(when, at + 0.003);
  sg.gain.setValueAtTime(0, at);
  sg.gain.linearRampToValueAtTime(1, full);
  sg.gain.pts = [[at, 0], [full, 1]];
  const trim = trimNode(ctx, buffer);
  src.connect(trim); trim.connect(sg);
  sg.connect(s.fxIn);
  // Joins a Tape stop brake already under way.
  if (fxOn && fxOn.id === 'tapestop' && fxOn.t !== undefined) slowToHalt(src.playbackRate, fxOn.t, fxOn.len);
  const f = Math.round((offset - (when - at)) * sr); // the loop position at `at`, in whole frames
  src.start(at, (((f % len) + len) % len) / sr);
  // Once it's gone, the cache counts its buffer again (a replaced pick's render, say).
  src.onended = () => { src.disconnect(); trim.disconnect(); sg.disconnect(); trimCaches(); };
  s.source = src;
  s.srcGain = sg;
  s.startAt = at;
}

// Fade from wherever the gain is at `begin` (it may still be fading in), not from 1.
const fadeOut = (sg, begin, end) => rampTracked(sg.gain, begin, end, 0);

// Fades a layer out by `when` (its bar line), or as soon as possible.
function stopSource(layerId, when) {
  const s = state.layers[layerId];
  const end = Math.max(when ?? 0, ctx.currentTime + XFADE), begin = end - XFADE;
  // An outgoing source from an earlier swap may still be due to play past `end` (Stop pressed,
  // or a tempo restart, before that bar line): fade it out by then as well.
  s.tails = (s.tails || []).filter((x) => x.stopAt > ctx.currentTime);
  for (const x of s.tails) {
    if (x.stopAt <= end) continue;
    try {
      fadeOut(x.sg, begin, end);
      x.src.stop(end + 0.02);
      x.stopAt = end + 0.02;
    } catch (_) { /* already stopped */ }
  }
  if (!s.source) return;
  try {
    if (begin <= s.startAt) {
      s.source.stop(); // not started by the time the fade would begin: stopped before its start, it never sounds
    } else {
      fadeOut(s.srcGain, begin, end);
      s.source.stop(end + 0.02);
      s.tails.push({ src: s.source, sg: s.srcGain, startAt: s.startAt, stopAt: end + 0.02 });
    }
  } catch (_) { /* already stopped */ }
  s.source = null;
  s.srcGain = null;
}

// The sources of a layer that are or will be sounding, outgoing ones included.
const sourcesOf = (s) => [...(s.tails || []).filter((x) => x.stopAt > ctx.currentTime).map((x) => x.src), ...(s.source ? [s.source] : [])];

// The buffer a layer is heard playing at time t: until a pending swap's bar line, the outgoing one.
function bufferAt(s, t) {
  const heard = [...(s.tails || []), ...(s.source ? [{ src: s.source, startAt: s.startAt, stopAt: Infinity }] : [])]
    .filter((x) => x.startAt <= t && x.stopAt > t);
  return heard.length ? heard[heard.length - 1].src.buffer : null;
}

// ---------- swap groups ----------
// Picks made together (Random, or a new key anchor that re-keys the other layers) drop in on one
// bar line once all of them are ready, so the mix never plays two keys at once. Members are
// layer ids, plus 'resync' for the re-key pass; each settles once, with a start function if it
// has something to start.
// A member that never reports back (an unexpected error) must not hold the others forever:
// after 30 s the ready ones go ahead.
const openGroups = new Set();
let tempoHeld = false; // a tempo restart waits for a group to land (see resyncOnce)
function swapGroup(members) {
  const g = { waiting: new Set(members), starts: [] };
  g.timer = setTimeout(() => { for (const m of [...g.waiting]) settle(g, m); }, 30000);
  openGroups.add(g);
  return g;
}
function settle(g, member, start) {
  if (!g || !g.waiting.has(member)) return false;
  if (start) g.starts.push(start);
  g.waiting.delete(member);
  if (g.waiting.size) return true;
  clearTimeout(g.timer);
  openGroups.delete(g);
  if (g.starts.length && state.playing) {
    const t = nextBarTime();
    for (const fn of g.starts) fn(t);
    changed();
  }
  if (tempoHeld) { tempoHeld = false; queueMicrotask(rebuildAll); } // the held tempo change goes ahead now
  return true;
}
// While playing, a tempo restart would start a group's ready picks at once and cut the old
// picks of the ones still loading: it waits until the whole group is in.
const groupLoading = () => [...openGroups].some((g) => [...g.waiting].some((m) => m !== 'resync' && state.layers[m].loading));

// Moves the clock to the current tempo at time t, keeping the position in the 32-bar cycle.
function retime(t) {
  const bars = (t - state.transportStart) / barSec(), cycle = BEATS / 4;
  const pos = ((bars % cycle) + cycle) % cycle;
  clockBpm = state.bpm;
  state.transportStart = frame(t - pos * barSec()); // on the sample grid, so every later bar line is too
  retuneSweeps(t);
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

// A render that failed outright (a worker crash, a memory spike) is tried once more before the
// layer is given up on; a dropped one (AbortError) just means the settings moved on.
async function renderLayersRetrying(ids) {
  const results = await renderLayers(ids);
  const again = results.filter((r) => {
    const s = state.layers[r.id];
    return r.result.status === 'rejected' && !isAbort(r.result.reason) && s.song === r.song && s.renderTag === r.tag && !s.loading;
  });
  if (!again.length) return results;
  for (const r of again) console.warn('re-render failed, trying once more:', r.song, r.result.reason);
  const retried = await renderLayers(again.map((r) => r.id));
  return results.map((r) => retried.find((x) => x.id === r.id) || r);
}

// A layer that couldn't be re-rendered stays in the mix (silent at a new tempo, in its old key
// after a key change) and says why; the next tempo or key change, or Stop then Play, tries again.
function syncFailed(r, what) {
  const s = state.layers[r.id], err = r.result.reason;
  console.error(err);
  s.error = loadError(r.song, err);
  const memory = /memory/i.test(s.error);
  status(`${r.song} ${what}: ${memory ? 'close other tabs, then press Stop and Play' : 'press Stop, then Play, to try again'}`, 'error');
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
  const failed = new Map(); // layer id -> its failed render, while it stays failed
  for (let pass = 0; pass < 4; pass++) {
    const stale = activeLayers().filter((id) => !state.layers[id].loading && !isCurrent(state.layers[id]) && !failed.has(id));
    if (!stale.length) break;
    for (const id of stale) state.layers[id].syncing = true;
    changed();
    const results = await renderLayersRetrying(stale);
    for (const r of results) {
      const s = state.layers[r.id];
      s.syncing = false;
      if (s.song !== r.song || s.renderTag !== r.tag) continue; // re-picked meanwhile
      if (r.result.status === 'fulfilled') {
        s.buffer = r.result.value; s.bufferKey = r.job.key; s.bufferBpm = r.job.bpm; s.error = null;
      } else if (!isAbort(r.result.reason)) failed.set(r.id, r);
    }
    if (gen !== playGen || state.playing) { changed(); return; } // stopped or restarted meanwhile
  }
  // The limiter's module is normally loaded by now; if not, give it a moment rather than start on
  // the fallback glue and switch over a second later (it switches by itself if it's slower).
  await Promise.race([limiterReady, sleep(300)]);
  if (gen !== playGen || state.playing) { changed(); return; }
  for (const r of failed.values()) if (!isCurrent(state.layers[r.id])) syncFailed(r, "couldn't be prepared at this tempo and key, so the jam starts without it");
  const ready = activeLayers().filter((id) => isCurrent(state.layers[id]) && !state.layers[id].loading);
  if (!ready.length) { changed(); return; }
  const t = frame(ctx.currentTime + LEAD);
  clockBpm = state.bpm;
  state.transportStart = t;
  if (fxOn && fxOn.id === 'wah') startWah(t); // a held Wah locks onto the new downbeat
  retuneSweeps(t);
  for (const l of LAYERS) {
    if (ready.includes(l.id)) startSource(l.id, t, 0);
    else stopSource(l.id, t); // a cleared layer may still be fading out from before
  }
  state.playing = true;
  changed();
}

export function stop() {
  playGen++;
  wantPlay = false;
  if (!ctx) return;
  for (const id of LAYERS.map((l) => l.id)) stopSource(id);
  state.playing = false;
  fxStop({ cancel: true }); // a held Stutter or Tape stop ends with the music
  changed();
}

export const togglePlay = () => (state.playing ? stop() : play());

// Re-renders every layer that no longer matches the tempo/key, then swaps them in: a tempo
// change restarts everything together, in phase; a key change swaps on the next bar. Layers
// still loading a new pick are left to selectStem. Calls while running coalesce into one
// more pass.
let resyncRun = null, resyncAgain = false;
const resyncGroups = []; // swap groups waiting on the next pass (see settle)
export function rebuildAll(group) {
  if (group) resyncGroups.push(group);
  if (!ctx) { resyncGroups.splice(0).forEach((g) => settle(g, 'resync')); return Promise.resolve(); }
  if (resyncRun) { resyncAgain = true; return resyncRun; }
  resyncRun = (async () => {
    try {
      do { resyncAgain = false; await resyncOnce(); } while (resyncAgain);
    } finally { resyncRun = null; }
  })();
  return resyncRun;
}

async function resyncOnce() {
  // Groups that arrive during this pass wait for the next one, which sees their changes.
  const groups = resyncGroups.splice(0);
  // A tempo change while a group is still loading: the old mix plays on at the old tempo, and
  // everything moves together once the group is in (settle runs this again). A re-key pass
  // waiting in a group has nothing to start on its own then: the restart re-keys as well.
  if (state.playing && clockBpm !== state.bpm && groupLoading()) {
    tempoHeld = true;
    for (const g of groups) settle(g, 'resync');
    return;
  }
  const stale = activeLayers().filter((id) => { const s = state.layers[id]; return s.buffer && !s.loading && !isCurrent(s); });
  const fresh = [];
  if (stale.length) {
    for (const id of stale) state.layers[id].syncing = true;
    changed();
    const results = await renderLayersRetrying(stale);
    const failed = [];
    for (const r of results) {
      const s = state.layers[r.id];
      s.syncing = false;
      if (s.song !== r.song || s.renderTag !== r.tag || s.loading) continue; // re-picked meanwhile
      if (r.result.status !== 'fulfilled') {
        if (isAbort(r.result.reason)) resyncAgain = true; // dropped: the tempo or key moved on
        else failed.push(r);
        continue;
      }
      if (r.job.key !== renderKey(s.song, s.type)) { resyncAgain = true; continue; } // settings moved on
      fresh.push(r);
    }
    if (resyncAgain) { resyncGroups.unshift(...groups); changed(); return; } // nudged again while rendering: wait for the next pass
    for (const r of fresh) {
      const s = state.layers[r.id];
      s.buffer = r.result.value; s.bufferKey = r.job.key; s.bufferBpm = r.job.bpm; s.error = null;
    }
    // At a new tempo the clock moves on with the layers that made it (see below).
    const clockMoves = activeLayers().some((id) => isCurrent(state.layers[id]));
    for (const r of failed) {
      const tempo = r.job.bpm !== state.layers[r.id].bufferBpm;
      syncFailed(r, !tempo ? "couldn't change key, so it plays on in the old key"
        : clockMoves && state.playing ? "couldn't follow the tempo change, so it's silent for now" : "couldn't follow the tempo change");
    }
  }

  // The clock follows the tempo once at least one layer is ready at it (a layer that failed
  // to re-render drops out rather than playing out of time).
  const tempoMoves = clockBpm !== state.bpm && activeLayers().some((id) => isCurrent(state.layers[id]));
  if (!state.playing) {
    clockBpm = state.bpm;
  } else if (tempoMoves) {
    // Everything restarts together at the new tempo, from the same point in the loop.
    const t = frame(ctx.currentTime + LEAD);
    retime(t);
    for (const id of activeLayers()) {
      const s = state.layers[id];
      if (s.buffer && s.bufferBpm === clockBpm && !s.loading) startSource(id, t, t - state.transportStart);
      else stopSource(id, t); // still loading a new pick at the old tempo: it joins when ready
    }
  } else if (fresh.length) {
    const go = (t) => {
      for (const r of fresh) {
        const s = state.layers[r.id];
        if (s.bufferKey === r.job.key && !s.loading && isCurrent(s)) startSource(r.id, t, t - state.transportStart);
      }
    };
    // Re-keyed for a new anchor pick: drop in on the same bar as that pick (the latest one, if
    // the anchor changed twice).
    const target = [...groups].reverse().find((g) => g.waiting.has('resync'));
    if (target) settle(target, 'resync', go); else go(nextBarTime());
  }
  for (const g of groups) settle(g, 'resync'); // nothing (more) to start for it
  // A layer that failed earlier is fine again once the settings come back to what it has.
  for (const id of activeLayers()) if (isCurrent(state.layers[id])) state.layers[id].error = null;
  changed();
}

// ---------- layer selection ----------
export async function selectStem(layerId, song, opts = {}) {
  ensureCtx();
  const s = state.layers[layerId];
  if (s.song === song && !opts.force) return clearLayer(layerId);
  const type = stemTypeFor(layerId, song);
  if (!type) { settle(opts.group, layerId); return; }

  const firstStem = activeLayers().length === 0;
  if (firstStem && !state.tempoTouched && !opts.keepTempo && !state.playing) state.bpm = Math.round(MANIFEST[song].bpm);
  const rootBefore = masterRoot();
  const gen = playGen;
  s.song = song;
  s.type = type;
  s.loading = true;
  s.progress = 0;
  s.error = null;
  if (!state.anchorOrder.includes(layerId)) state.anchorOrder.push(layerId);
  changed();
  // The replaced pick's download, and any hover prefetch, stop competing with this one (after
  // this task, so a Random batch doesn't cancel a download one of its other picks needs).
  queueMicrotask(abortUnwanted);
  // Picks made together (Random) drop in together; so does a new song on the auto-key anchor
  // and the other layers it re-keys.
  let group = opts.group || null;
  // A new song on the auto-key anchor moves the master key: re-key the other layers (after
  // this task, so a random pick of every layer re-keys once, against the final songs).
  if (rootBefore !== null && masterRoot() !== rootBefore) {
    group ??= swapGroup([layerId]);
    group.waiting.add('resync');
    queueMicrotask(() => rebuildAll(group));
  }

  const tag = ++s.renderTag;
  try {
    // Progress arrives per network chunk; re-render the UI in 2% steps, not hundreds of times.
    const progress = (p) => {
      if (s.renderTag === tag && (p >= 1 || p - s.progress >= 0.02)) { s.progress = p; changed(); }
    };
    let job, buf;
    for (;;) {
      job = render(song, type, progress);
      try { buf = await job.promise; break; } catch (err) {
        // Dropped from the stretch queue because the tempo or key moved while it waited: render
        // again for the new settings, however often that happens (nothing failed). A pick
        // replaced meanwhile just ends, below.
        if (!isAbort(err) || s.renderTag !== tag || s.song !== song) throw err;
      }
    }
    if (s.renderTag !== tag || s.song !== song) { settle(group, layerId); return; }
    s.buffer = buf; s.bufferKey = job.key; s.bufferBpm = job.bpm;
    s.loading = false;
    s.progress = 1;
    let retimeLater = false;
    if (state.playing) {
      if (job.bpm === clockBpm) {
        // Rendered for an older key (it moved while this loaded): the resync below starts the re-render.
        const go = (t) => {
          if (state.playing && s.renderTag === tag && s.buffer === buf && isCurrent(s)) startSource(layerId, t, t - state.transportStart);
        };
        if (!settle(group, layerId, go)) go(nextBarTime());
      } else {
        // Rendered for a tempo the clock hasn't reached yet: the old pick plays on until the
        // resync restarts everything at the new tempo, this one included. In a group that
        // restart waits for the rest of the group, so they all land with the tempo change.
        retimeLater = settle(group, layerId, () => rebuildAll()) && group.waiting.size > 0;
      }
    } else {
      settle(group, layerId);
      if ((wantPlay || (!opts.noAutoplay && gen === playGen)) && activeLayers().every((id) => !state.layers[id].loading)) {
        play(); // a pick starts the jam (unless Stop was pressed while it loaded)
      }
    }
    // Tempo/key moved while it loaded, or it's ready at a tempo the clock hasn't reached yet:
    // the resync re-renders or retimes and starts it with the others.
    if (!isCurrent(s) || (state.playing && job.bpm !== clockBpm && !retimeLater)) rebuildAll();
    changed();
  } catch (err) {
    if (s.renderTag !== tag) { settle(group, layerId); return; }
    console.error(err);
    s.loading = false;
    stopSource(layerId);
    const rootBefore = masterRoot();
    s.song = s.type = s.buffer = s.bufferKey = null;
    state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
    if (!activeLayers().length) { state.playing = false; wantPlay = false; }
    status(loadError(song, err), 'error');
    // Settled only now that it's gone: the rest of its group, if keyed against it, no longer
    // counts as current and waits for the re-key below instead of starting in the wrong key.
    settle(group, layerId);
    changed();
    if (masterRoot() !== rootBefore && masterRoot() !== null) rebuildAll(); // the failed pick was the key anchor
    // The others may have been waiting on this one to start (Play pressed during loading).
    if (!state.playing && (wantPlay || (!opts.noAutoplay && gen === playGen)) && activeLayers().length
      && activeLayers().every((id) => !state.layers[id].loading)) play();
  }
}

export function clearLayer(layerId) {
  const s = state.layers[layerId];
  if (!s.song) return;
  // It leaves on the bar line, unless it's the last layer: then the music stops now, with the UI.
  if (ctx) stopSource(layerId, state.playing && activeLayers().length > 1 ? nextBarTime() : undefined);
  if (fxOn && fxOn.repeats) { // a held Stutter stops repeating this layer
    stopRepeats(fxOn.repeats.filter((r) => r.lid === layerId), ctx.currentTime);
    fxOn.repeats = fxOn.repeats.filter((r) => r.lid !== layerId);
  }
  s.renderTag++;
  const rootBefore = masterRoot();
  s.song = s.type = s.buffer = s.bufferKey = s.error = null;
  s.loading = s.syncing = false;
  state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
  if (!activeLayers().length) { state.playing = false; playGen++; wantPlay = false; }
  abortUnwanted(); // its download, if it was still coming
  changed();
  if (masterRoot() !== rootBefore && masterRoot() !== null) rebuildAll();
}

export function randomize() {
  ensureCtx();
  // The auto-key anchor goes first, so the others are keyed against its new song.
  const order = [...new Set([...state.anchorOrder, ...LAYERS.map((l) => l.id)])];
  const taken = new Set(); // one song per layer when there's a choice: the point is to mix tracks
  const picks = [];
  for (const id of order) {
    const options = Object.keys(MANIFEST).filter((song) => stemTypeFor(id, song) && song !== state.layers[id].song);
    const fresh = options.filter((song) => !taken.has(song));
    const pool = fresh.length ? fresh : options;
    if (!pool.length) continue;
    const song = pool[Math.floor(Math.random() * pool.length)];
    taken.add(song);
    picks.push([id, song]);
  }
  // While playing, the old mix carries on until every new pick is ready, then all swap together.
  const group = swapGroup(picks.map(([id]) => id));
  for (const [id, song] of picks) selectStem(id, song, { force: true, group });
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

// Freeze a parameter where it is right now so a new ramp starts from there. Only for one with
// events still to come (the Stutter gate): past its last event, cancelAndHoldAtTime anchors
// nothing and the next ramp starts back at that event, so the level jumps (measured: a gain at 0
// leapt to 0.89 at once). The filter sweeps and wet/dry levels use tracked ramps instead.
function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
}
const playingLayers = () => activeLayers().filter((id) => state.layers[id].source && state.layers[id].buffer);

// Tape stop's brake: full speed at t, a halt `len` later (two beats). A source started during
// the hold gets the same curve, so it joins at the speed the others have reached.
function slowToHalt(rate, t, len) {
  rate.cancelScheduledValues(t);
  rate.setValueAtTime(1, t);
  rate.linearRampToValueAtTime(0.0001, t + len);
}

// Wah: a resonant band-pass swept once per beat, brightest on the beat. It sweeps in cents
// (WAH.depth either side of WAH.center), so it moves evenly in pitch instead of lingering up
// high (about 340 Hz to 1.9 kHz). A narrow band is far quieter than the full mix, so the band is
// boosted and some of the dry mix keeps the low end. Measured on engaging it: within 1 LU on
// three-layer mixes, about 2.5 LU down on a bass-heavy groove alone (more band gain only drives
// the limiter there).
const WAH = { center: 800, depth: 1500, q: 5, wet: 3.6, dry: 0.6 };
// Phaser: four all-pass stages mixed with the dry signal, which cancel each other in four
// notches; the sweep moves them up and down through the mids. There is no feedback loop, so no
// delay inside a cycle (Web Audio holds those to at least 128 samples). One sweep every two
// bars, from the bottom at the press. The notches take out some energy: the mix is made up
// (measured: within 0.3 LU of the dry level).
const PHASER = { stages: 4, q: 0.8, low: 300, range: 3600, perBar: 0.5, wet: 0.66, dry: 0.66 };

const cents = (from, to) => 1200 * Math.log2(to / from);

// The sweeps' LFOs, by effect: started fresh at each press (and running out after a release).
const sweeps = {};
// Where a cycle of `perBar` cycles per bar is at time t, counted from the transport's bar 1.
const cyclePos = (perBar, t) => ((perBar * (t - state.transportStart) / barSec()) % 1 + 1) % 1;
// A sine LFO into `params`, ±depth, from time t; `phase` is where in its cycle it starts, in
// cycles from its peak. A one-harmonic PeriodicWave sets that phase: an oscillator always starts
// at its own zero, so it can't be started part-way through a cycle any other way.
function startSweep(id, params, depth, perBar, phase, t) {
  stopSweep(id, t);
  const osc = ctx.createOscillator(), amt = ctx.createGain(), a = 2 * Math.PI * phase;
  // cos(wt + a) = cos(a) cos(wt) - sin(a) sin(wt)
  osc.setPeriodicWave(ctx.createPeriodicWave(Float32Array.of(0, Math.cos(a)), Float32Array.of(0, -Math.sin(a))));
  osc.frequency.value = perBar / barSec();
  amt.gain.value = depth;
  osc.connect(amt);
  for (const p of params) amt.connect(p);
  osc.start(t);
  const sweep = { osc, perBar };
  osc.onended = () => { osc.disconnect(); amt.disconnect(); if (sweeps[id] === sweep) delete sweeps[id]; };
  sweeps[id] = sweep;
}
// A later stop replaces an earlier one, so a quick re-press cuts a sweep still running out.
function stopSweep(id, t) {
  try { if (sweeps[id]) sweeps[id].osc.stop(t); } catch (_) { /* already stopped */ }
}
// On a tempo change the clock restarts at t with the beat position carried over (retime), so a
// sweep that changes speed exactly then stays locked to the beat.
function retuneSweeps(t) {
  for (const s of Object.values(sweeps)) s.osc.frequency.setValueAtTime(s.perBar / barSec(), t);
}
// One cycle per beat, starting where the beat is at t.
const startWah = (t) => startSweep('wah', [wah.detune], WAH.depth, 4, cyclePos(4, t), t);

function stopRepeats(repeats, t) {
  for (const { src, gate, trim } of repeats) {
    hold(gate.gain, t); gate.gain.linearRampToValueAtTime(0, t + 0.01);
    try { src.stop(t + 0.03); } catch (_) { /* already stopped */ }
    src.onended = () => { src.disconnect(); trim.disconnect(); gate.disconnect(); };
  }
}

// Brings every layer's FX insert back to full level over [t, t + 0.01].
function openInserts(t) {
  for (const l of LAYERS) {
    const g = state.layers[l.id].fxIn;
    if (g) rampTracked(g.gain, t, t + 0.01, 1);
  }
}

export function fxStart(id) {
  if (!ctx || fxOn) return;
  const t = ctx.currentTime + 0.005;
  fxOn = { id };
  if (id === 'lowpass') { // sweeps down while held (to 260 Hz), so a longer hold goes deeper
    rampTracked(lp.detune, t, t + 1.6, cents(22000, 260));
    rampTracked(lp.Q, t, t + 0.4, 5);
  } else if (id === 'highpass') { // up to 2.4 kHz
    rampTracked(hp.detune, t, t + 1.6, cents(10, 2400));
    rampTracked(hp.Q, t, t + 0.4, 4);
  } else if (id === 'phaser') {
    // The stages rest at the bottom of the sweep; the LFO starts at its trough, so it lifts them
    // from exactly there (cos, offset by half the range): every press is the same rising swoosh.
    const half = PHASER.range / 2;
    for (const f of phaser) { f.detune.cancelScheduledValues(t); f.detune.setValueAtTime(half, t); }
    startSweep('phaser', phaser.map((f) => f.detune), -half, PHASER.perBar, 0, t);
    rampTracked(phWet.gain, t, t + 0.08, PHASER.wet);
    rampTracked(fxDry.gain, t, t + 0.08, PHASER.dry);
  } else if (id === 'wah') {
    startWah(t);
    rampTracked(wahWet.gain, t, t + 0.05, WAH.wet);
    rampTracked(fxDry.gain, t, t + 0.05, WAH.dry);
  } else if (id === 'stutter' && state.playing) {
    // Beat repeat: from the next 1/16 line, loop the eighth note that just played, gated so
    // each repeat is chopped. The real sources keep running underneath, muted at the layer's
    // FX insert (so a swap landing during the hold stays muted too), and letting go lands back
    // exactly in time.
    // On whole samples like the rest of the transport (see frame): a repeat read from between
    // samples would sound duller than the music it stands in for.
    const bar = barSec(), sr = ctx.sampleRate, grid = bar / 16;
    const sliceF = Math.round(bar / 8 * sr), slice = sliceF / sr;
    const t0 = frame(state.transportStart + Math.ceil((ctx.currentTime + 0.03 - state.transportStart) / grid) * grid);
    fxOn.repeats = [];
    for (const lid of activeLayers()) {
      const s = state.layers[lid];
      const buffer = bufferAt(s, t0); // what is heard then: the outgoing stem if a swap is pending
      if (!buffer) continue;
      const len = buffer.length, f = Math.round((t0 - state.transportStart) * sr);
      const atF = ((f % len) + len) % len;
      const from = Math.min(Math.max(0, atF - sliceF), len - sliceF) / sr;
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
      src.buffer = buffer; src.loop = true; src.loopStart = from; src.loopEnd = from + slice;
      const trim = trimNode(ctx, buffer); // at the level the stem was playing
      src.connect(trim); trim.connect(gate);
      gate.connect(s.gain); // past the FX insert, which mutes the real sources
      src.start(t0, from);
      fxOn.repeats.push({ lid, src, gate, trim });
    }
    // Every layer, so one leaving or joining during the hold stays quiet too.
    for (const l of LAYERS) rampTracked(state.layers[l.id].fxIn.gain, t0 - 0.004, t0, 0);
  } else if (id === 'tapestop' && state.playing) {
    // Slow every source to a halt (outgoing and pending ones too); letting go restarts them in
    // sync with the clock.
    fxOn.t = t;
    fxOn.len = barSec() / 2; // two beats, so it lands like a played break at any tempo
    fxOn.layers = playingLayers();
    for (const l of LAYERS) {
      const s = state.layers[l.id];
      for (const src of sourcesOf(s)) slowToHalt(src.playbackRate, t, fxOn.len);
      rampTracked(s.fxIn.gain, t + 0.7 * fxOn.len, t + fxOn.len, 0);
    }
  }
}

// Letting go. With { cancel: true } (Stop pressed while held) nothing is restarted.
export function fxStop({ cancel = false } = {}) {
  if (!ctx || !fxOn) return;
  const { id } = fxOn, t = ctx.currentTime + 0.005;
  if (id === 'lowpass') {
    rampTracked(lp.detune, t, t + 0.12, 0);
    rampTracked(lp.Q, t, t + 0.12, 0.7);
  } else if (id === 'highpass') {
    rampTracked(hp.detune, t, t + 0.12, 0);
    rampTracked(hp.Q, t, t + 0.12, 0.7);
  } else if (id === 'phaser') {
    rampTracked(phWet.gain, t, t + 0.15, 0);
    rampTracked(fxDry.gain, t, t + 0.15, 1);
    // Once the wet path is silent, the sweep stops and the stages go back to rest.
    stopSweep('phaser', t + 0.16);
    for (const f of phaser) f.detune.setValueAtTime(0, t + 0.16);
  } else if (id === 'wah') {
    rampTracked(wahWet.gain, t, t + 0.06, 0);
    rampTracked(fxDry.gain, t, t + 0.06, 1);
    stopSweep('wah', t + 0.07);
  } else if (id === 'stutter' && fxOn.repeats) {
    stopRepeats(fxOn.repeats, t);
    // On Stop the sources are fading out right now: open the inserts only once they're silent.
    openInserts(cancel ? t + 0.04 : t);
  } else if (id === 'tapestop' && fxOn.layers) {
    // The slowed sources fade out first; the inserts open once they're silent and the restarted
    // sources come in after that, so a stalled source's frozen sample never meets a rising gain.
    const at = t + 0.02;
    // Each layer comes back with the stem it was last scheduled to play. A pick that is ready but
    // waiting for the rest of its group (or still loading) follows on its own bar line.
    const back = new Map(activeLayers().filter((lid) => state.layers[lid].source).map((lid) => [lid, state.layers[lid].source.buffer]));
    for (const l of LAYERS) stopSource(l.id, at); // includes sources that joined during the hold
    fxOn = null; // the restarts below play at normal speed
    openInserts(at + 0.01);
    if (!cancel && state.playing) {
      const when = at + 0.04;
      for (const [lid, buffer] of back) startSource(lid, when, when - state.transportStart, buffer);
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
  // Ask for a format by name (Safari records MP4/AAC, the others WebM or Ogg Opus) and name the
  // file after what was actually recorded, so players open it.
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
    .find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(mediaDest.stream, type ? { mimeType: type, audioBitsPerSecond: 256000 } : undefined);
  const chunks = [];
  recorder = rec;
  const name = mixName(); // named after the mix the take starts with
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const mime = rec.mimeType || type || '';
    const ext = /ogg/.test(mime) ? 'ogg' : /mp4|aac/.test(mime) ? 'm4a' : 'webm';
    download(new Blob(chunks, { type: mime }), `${name}.${ext}`);
    if (recorder !== rec) return; // a new take started while this one was finishing
    recorder = null;
    state.recording = false;
    status('Recording saved');
    changed();
  };
  rec.start(1000); // in one-second pieces, so a long take isn't held as one block
  state.recording = true;
  status('Recording — press REC again to stop');
  changed();
}

// A file name that says what is in the mix, e.g. "Get Lucky + Voyager - 116 BPM F#m.wav", with
// the characters Windows and macOS refuse in names taken out.
function mixName() {
  const songs = [...new Set(activeLayers().map((id) => state.layers[id].song))];
  const mr = masterRoot();
  const key = state.keyLock && mr !== null ? ` ${NOTE_NAMES[mr]}m` : '';
  const name = songs.length ? `${songs.join(' + ')} - ${clockBpm} BPM${key}` : 'Dream Chamber remix';
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 150).replace(/[\s.]+$/, '');
  return safe || 'Dream Chamber remix';
}
export const mixFileName = (ext) => `${mixName()}.${ext}`;

// One full 32-bar cycle through the same glue as the live mix. It renders two cycles and keeps
// the second, so the limiter is already settled and the file loops without a bump. The level is
// the glue's output, the same as a recording's (both are taken before the master volume).
export async function exportLoopWav() {
  const ids = activeLayers().filter((id) => {
    const s = state.layers[id];
    return s.buffer && !s.muted && s.bufferBpm === clockBpm;
  });
  if (!ids.length) { status('Nothing to export — pick some stems first'); return null; }
  const sr = ctx.sampleRate;
  const len = loopSamples(BEATS, clockBpm, sr);
  // Long enough for either glue's delay, which is skipped below so bar 1 lands at sample 0.
  const off = new OfflineAudioContext(2, len * 2 + Math.ceil(0.02 * sr), sr);
  const glue = await buildMaster(off);
  glue.output.connect(off.destination);
  for (const id of ids) {
    const s = state.layers[id];
    const src = off.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    const g = off.createGain();
    g.gain.value = s.volume * trimOf(s.buffer);
    src.connect(g);
    g.connect(glue.input);
    src.start(0);
  }
  const rendered = await off.startRendering();
  const from = len + glue.latency;
  return encodeWav([0, 1].map((c) => rendered.getChannelData(c).subarray(from, from + len)), sr);
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
  // Rounded to the nearest step with TPDF dither (two random values of up to half a step either
  // way), so quiet tails fade into a little steady hiss instead of distortion that follows the music.
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.round(channels[c][i] * 0x7fff + Math.random() - Math.random());
      v.setInt16(o, Math.max(-0x8000, Math.min(0x7fff, x)), true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
