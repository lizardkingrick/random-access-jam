/* Audio engine — ported from Dream Chamber Studios Remixed (MuscularCrab).
   Every stem is a seamless loop, normally 32 bars / 128 beats. Stems are conformed
   to the master BPM (WSOLA time-stretch) and optionally the master key (resampling
   pitch shift) in a small pool of workers, then looped in sample-accurate sync.
   Swaps are quantized to the next bar. On desktops, a slower high-quality render of each tonal
   layer follows in the background and is swapped in on a later bar (see upgrade). */

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
  tempoTouched: false, // tempo set by hand (or by a share link) since the last stem change, which sets it again (see autoTempo)
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
// Every change also restarts the wait before the mix is kept for the next visit (see keepMix) and
// before the next hq upgrade starts (see upgrade).
const changed = () => { emit('change'); keepLater(); upgradeSoon(); };
const status = (msg, kind) => emit('status', { msg, kind });

// Why a stem didn't load, in words a player can act on (the details go to the console).
function loadError(song, err) {
  const m = String((err && err.message) || err);
  if (err && err.name === 'NotSupportedError') return "This browser can't play the stems: update it, or use Chrome or Firefox";
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

// `swap` ({ layerId, song }) asks what it would be once that pick is made (see pickAt).
export function masterRoot(swap) {
  if (state.masterKey !== 'auto') return NOTE[state.masterKey];
  const order = swap && !state.anchorOrder.includes(swap.layerId) ? [...state.anchorOrder, swap.layerId] : state.anchorOrder;
  for (const id of order) { // the first pick with a known key
    const t = tonic(MANIFEST[swap && id === swap.layerId ? swap.song : state.layers[id].song]?.key);
    if (t !== null) return t;
  }
  return null;
}
export function semisFor(songKey, swap) {
  if (!state.keyLock) return 0;
  const mr = masterRoot(swap), t = tonic(songKey);
  if (mr === null || t === null) return 0;
  return ((mr - t + 18) % 12) - 6; // nearest path, [-6, +5]: a tritone goes down
}

// What a layer's buffer has to be rendered as for the current tempo and key (or the given ones).
const renderKey = (song, type, bpm = state.bpm, semis = semisFor(MANIFEST[song].key)) => `${song}|${type}|${bpm}|${semis}|${ctx.sampleRate}`;
const isCurrent = (s) => !!s.buffer && s.bufferKey === renderKey(s.song, s.type);

// The local server (tools/serve.ps1) lists the stem folders, so the song list comes straight
// from disk with no build step. The hosted site has no listing and uses the prebuilt stems.json.
// Both are asked for at once: on the hosted site the listing is a 404, and waiting for that
// before asking for stems.json cost a round trip before any stem could start.
export async function loadManifest(url) {
  keptKeys(); // meanwhile, so a share link's first render knows whether it was kept (see keepMix)
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

// ---------- the device ----------
// deviceMemory is Chromium-only; elsewhere a touch-only device is assumed to be a phone (the stretch
// pool and the cache budget size themselves by it).
const touchOnly = navigator.maxTouchPoints > 0 && !(window.matchMedia && matchMedia('(hover: hover)').matches);
const deviceGB = navigator.deviceMemory || (touchOnly ? 2 : 8);
const cores = navigator.hardwareConcurrency || 2;
// Phones and tablets: touch-only, Android, iOS, and iPadOS, which calls itself a Mac with a touchscreen.
const UA = navigator.userAgent || '';
const handheld = touchOnly || /Android|iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1)
  || !!(navigator.userAgentData && navigator.userAgentData.mobile);
// WebKit: Safari, and every browser on iOS and iPadOS (they all say Apple is their vendor).
const webkit = /Apple/.test(navigator.vendor || '') || (/AppleWebKit/.test(UA) && !/Chrome\/|Chromium\/|Android/.test(UA));

// The stems' own sample rate. Desktop Chromium and Firefox run the context at it, so a loop plays
// exactly as rendered and the system converts the output stream. WebKit and phones run at the
// device's own rate (normally 48 kHz) instead: WebKit converting a 44.1 kHz context on the fly is
// the suspect for Safari's layers drifting apart, and on Android any other rate takes Chrome off its
// low-latency output and puts a resampler on the audio thread. There the originals are still decoded
// at 44.1 kHz (see decoderCtx) and the stretch worker converts each loop as part of its render, read
// round the loop like a pitch shift (the browser's decoder treats a file as a one-off and rings at
// both ends: a tick at every wrap).
const STEM_RATE = 44100;
const nativeRate = webkit || handheld;

export function ensureCtx() {
  if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  // iOS: as media playback, sound plays with the silent switch on (Safari 16.4+).
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* not settable */ }
  // Phones other than WebKit's render in bigger chunks with 'playback' (Chromium: 20 ms rather than
  // the smallest the device takes), so a busy moment (a stem switch: stretch workers, the 3D visuals)
  // doesn't run the audio thread dry; the swaps are scheduled ahead anyway (LEAD follows
  // baseLatency) and the visuals follow the output's own timestamps (see meters). WebKit keeps
  // 'interactive': it doesn't say how big its chunks are (no baseLatency), so they shouldn't grow
  // behind the scheduling lead's back.
  const latencyHint = handheld && !webkit ? 'playback' : 'interactive';
  let refused = '';
  try { ctx = new AC(nativeRate ? { latencyHint } : { sampleRate: STEM_RATE, latencyHint }); } catch (err) { refused = ` (${err && err.message})`; ctx = new AC(); }
  // Some browsers throw, older ones quietly ignore the rate: either way the worker converts the loops.
  if (!nativeRate && ctx.sampleRate !== STEM_RATE) console.warn(`44.1 kHz audio was refused${refused}; running at ${ctx.sampleRate} Hz, converting the loops to it`);
  setLead();
  watchClock();
  // A call, Siri or another app suspends (iOS: 'interrupts') the context; bring it back when we can.
  ctx.onstatechange = () => { if (ctx.state === 'running') watchClock(); wakeAudio(); };
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
// A stretch job briefly holds up to ~150 MB, so low-memory devices get two workers at most. Two
// cores always stay free, for the main thread (the UI and the 3D visuals) and the audio thread: a
// worker on either's core is what an audio dropout during a switch is made of. Phones and tablets
// get two at most whatever they report (a Galaxy S23 Ultra says 8 cores and 8 GB, but three of its
// cores are small efficiency cores, and phones slow down when every core runs flat out): two of a
// Random's three renders run at once and the third follows (but see POOL_URGENT).
const POOL_SIZE = Math.max(1, Math.min(deviceGB <= 4 || handheld ? 2 : 3, cores - 2));
// A phone that says it has plenty (8 cores and 8 GB, as the S23 Ultra does; only Chromium says how
// much memory) takes a third worker for jobs a layer waits for, never for background ones: a pick that
// moves the tempo re-renders all three layers, and on two workers its own render waited for a second
// round. Phones run no background jobs anyway (no hover pre-renders, no hq).
const POOL_URGENT = handheld && cores >= 8 && (navigator.deviceMemory || 0) >= 6 ? Math.max(POOL_SIZE, 3) : POOL_SIZE;
// An hq render (see upgrade) keeps a core busy for 1.5-4 s and holds ~130 MB, so only desktops with
// room to spare get one: never phones or tablets, where extra background work makes stem switches
// stutter, and not the low end of the budget above (4 GB or less, or 4 cores or fewer).
const HQ_OK = !handheld && deviceGB > 4 && cores > 4;
const pool = []; // { worker, job }
const jobQueue = [];
let jobSeq = 0;
const abortError = () => new DOMException('No longer wanted', 'AbortError');
const isAbort = (err) => !!err && err.name === 'AbortError';
// Workers take 16-bit input once one has said what quality it rendered at, which only a
// stretch-worker.js that reads 16-bit does. Until then they get floats, which every version
// takes. Workers started later load the same script or a newer one (js/ is never cached stale).
let int16Input = false;

function spawnWorker() {
  const slot = { worker: new Worker(new URL('./stretch-worker.js', import.meta.url)), job: null, pre: false };
  slot.worker.onmessage = (e) => {
    const job = slot.job;
    slot.job = null;
    if (e.data.quality) int16Input = true;
    if (job && job.id === e.data.id) {
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data); // { channels, quality, formant }
    }
    pumpJobs();
    preRenderSoon(); // a worker is free: the hovered song may be rendered now
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

// A job can't be interrupted, so its worker is ended instead.
function retire(slot) {
  slot.worker.terminate();
  pool.splice(pool.indexOf(slot), 1);
  dropJob(slot.job);
  slot.job = null;
}

// Started on the first tap or key press (main.js), so the first pick's stretch doesn't also wait
// for a worker to load and compile its script.
export function warmUp() {
  if (!pool.length) spawnWorker();
}

// Whether a layer is loading, re-rendering, or about to (a tempo nudge waits a moment, see setBpm).
const mixBusy = () => activeLayers().some((id) => {
  const s = state.layers[id];
  return s.loading || s.syncing || (!isCurrent(s) && !s.error);
});

// Jobs a layer is waiting for are `urgent`; the others are pre-renders of a hovered song (see
// preRender) and, last of all, hq upgrades (`low`, see upgrade). Urgent ones go first, newest
// first; a pre-render only starts while the mix is settled and no other pre-render is running,
// an upgrade only while no other background job runs either (a pre-render doesn't wait for an
// upgrade, it runs beside it), and one nobody would pick now stops at once.
function pumpJobs() {
  for (let k = jobQueue.length - 1; k >= 0; k--) if (!jobQueue[k].wanted()) dropJob(jobQueue.splice(k, 1)[0]);
  for (const slot of [...pool]) {
    if (slot.job && slot.pre && !slot.job.wanted()) { retire(slot); if (!pool.length) spawnWorker(); }
  }
  const rank = (j) => (j.urgent() ? 2 : j.low ? 0 : 1);
  while (jobQueue.length) {
    const job = jobQueue.reduceRight((a, j) => (rank(j) > rank(a) ? j : a)), r = rank(job), urgent = r === 2; // newest first within a rank
    if (!urgent && (mixBusy() || pool.some((s) => s.job && s.pre && !s.job.urgent() && (r === 0 || !s.job.low)))) return;
    // Counted by busy workers: an idle one may be the urgent-only third (see POOL_URGENT).
    const busy = pool.filter((s) => s.job);
    let slot = busy.length < (urgent ? POOL_URGENT : POOL_SIZE) ? pool.find((s) => !s.job) || spawnWorker() : null;
    // As many busy as this job may use: one stuck on a render nobody wants gives way (a new one
    // starts at once), and so, for a job a layer waits for, does one on an upgrade, or else on a
    // pre-render.
    const stale = !slot && (busy.find((s) => !s.job.wanted()) || (urgent && (busy.find((s) => s.job.low) || busy.find((s) => !s.job.urgent()))));
    if (stale) { retire(stale); slot = spawnWorker(); }
    if (!slot) return;
    jobQueue.splice(jobQueue.indexOf(job), 1);
    slot.job = job;
    slot.pre = !urgent;
    // The input is copied out in short steps (see stretchStem), so it goes a few tasks later, unless
    // the job was dropped meanwhile (its worker is gone then).
    job.message(int16Input).then((msg) => { if (slot.job === job) slot.worker.postMessage(msg, msg.channels.map((c) => c.buffer)); }, (err) => {
      if (slot.job !== job) return;
      slot.job = null;
      job.reject(err); // e.g. out of memory for the copy
      pumpJobs();
    });
  }
}

// `channels(int16)` is a function, so the input is copied out of the original only when a worker
// takes the job, not while it waits, and in the form that worker reads: 16-bit with room at the end
// (`inLen` samples of loop), or floats of exactly the loop, at `srcRate` (the originals' rate; the
// worker converts it to `sampleRate`, the context's). `type` (the stem type) lets the worker
// tune itself per layer; `quality` and `formant` ask for its slower paths (see upgrade). Resolves
// with the worker's reply: { channels, quality, formant }.
function stretchInWorker(channels, sampleRate, targetLen, pitchRatio, { wanted = () => true, urgent = wanted, dropped = () => {}, type, inLen, srcRate = sampleRate, low = false, quality, formant } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    const message = async (int16) => ({ id, channels: await channels(int16), inLen, sampleRate, srcRate, targetLen, pitchRatio, type, ...(quality && { quality, formant }) });
    jobQueue.push({ id, message, wanted, urgent, dropped, low, resolve, reject });
    pumpJobs();
  });
}

// ---------- buffers ----------
// Originals (10-15 MB each, as 16-bit: see toInt16) and renders (19-34 MB each, by tempo) are kept
// for quick re-picks and key or tempo changes, within a memory budget sized for the device: phones
// get killed by the OS long before desktops notice (deviceGB: see the device). Playing layers
// hold their own buffers, so evicting is always safe, and a buffer a layer is playing costs the
// cache nothing extra.
const MB = 1 << 20;
// Phones and tablets get 256 MB at most: an iPad with a trackpad or mouse hovers like a desktop, so
// without deviceMemory (Safari) it was taken for an 8 GB machine.
export const CACHE_BUDGET = (deviceGB <= 2 ? 128 : deviceGB <= 4 || handheld ? 256 : 512) * MB;
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
  // A render is an AudioBuffer (32-bit floats); an original says what its 16-bit copy takes.
  return (e) => (e.buf && !used.has(e.buf) ? e.buf.bytes ?? e.buf.length * e.buf.numberOfChannels * 4 : 0);
}
export function cacheBytes() {
  const size = entryBytes(), sum = (m) => [...m.values()].reduce((a, e) => a + size(e), 0);
  return { originals: sum(originals), renders: sum(renders), entries: originals.size + renders.size, budget: CACHE_BUDGET };
}

// Over budget, the least useful entries go first, oldest first within each group: renders at
// another tempo or that no layer can use now, then originals no layer has picked, then the rest.
// The hovered song's original and pre-renders (see hoverRenders) count as picked. An entry still
// loading is never evicted (a pick or render is waiting on it).
function trimCaches() {
  const size = entryBytes();
  let total = 0;
  for (const m of [originals, renders]) for (const e of m.values()) total += size(e);
  if (total <= CACHE_BUDGET) return;
  const keys = new Set(activeLayers().map((id) => renderKey(state.layers[id].song, state.layers[id].type)));
  const ids = new Set(activeLayers().map((id) => MANIFEST[state.layers[id].song].stems[state.layers[id].type]));
  if (hover) { for (const h of hoverRenders()) keys.add(h.key); ids.add(MANIFEST[hover.song].stems[hover.type]); }
  const tiers = [
    [renders, ([k]) => !keys.has(k)], // the layers' keys are all at the current tempo
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

// Originals are decoded at the stems' own rate, whatever the context runs at (see STEM_RATE), by a
// one-sample offline context; where there's none, by the context itself (then the worker has nothing
// to convert, and the loop ends ring as they always did there).
let decoder = null;
function decoderCtx() {
  if (ctx.sampleRate === STEM_RATE) return ctx;
  if (!decoder) {
    try { decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, STEM_RATE); } catch (err) {
      console.warn("can't decode at 44.1 kHz here, so the loop ends may tick:", err);
      decoder = ctx;
    }
  }
  return decoder;
}
// Decodes with the promise form, or the callbacks where that is all there is (Safari before 14.1).
const decode = (bytes) => new Promise((resolve, reject) => {
  const p = decoderCtx().decodeAudioData(bytes, resolve, reject);
  if (p) p.catch(() => {}); // the callback reports it
});

// Whether a lossy decode lines up with its master sample for sample, as stems.json says it must
// (measured from the WAV at build time): at least as long (codec padding after the end is trimmed,
// see loopShape) and its alignment mark found where it is (within MARK_TOL samples: decoders round
// differently, but none moved a mark at all in testing). A decoder that trims the start differently
// would shift the stem against the others for as long as it plays. Safari's Ogg decoder is new (18.4)
// and untested here; Chrome's and ffmpeg's match the WAVs exactly. Nothing to check against: true.
const MARK_W = 4096, MARK_TOL = 8, PAD_MAX = 0.05;
function exactDecode(info, type, buf) {
  const frames = info.frames && info.frames[type], mark = info.marks && info.marks[type];
  if (!frames || buf.sampleRate !== STEM_RATE) return true;
  if (buf.length < frames || buf.length > frames + PAD_MAX * STEM_RATE) return false;
  if (!mark) return true;
  const [at, level] = mark, l = level / 32768, x = [0, 1].map((c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
  for (let i = Math.max(0, at - MARK_W), end = Math.min(frames, at + MARK_TOL + 1); i < end; i++) {
    if (Math.abs(x[0][i]) >= l || Math.abs(x[1][i]) >= l) return Math.abs(i - at) <= MARK_TOL;
  }
  return false;
}

// Hands the main thread back between chunks of long work, by message rather than timer for the
// same reason as in loudness.js (a hidden tab holds timers back for a second or more).
const yields = [], relay = new MessageChannel();
relay.port1.onmessage = () => yields.shift()();
const breather = () => new Promise((resolve) => { yields.push(resolve); relay.port2.postMessage(0); });
// Long loops over samples (the 16-bit copies, a job's input and its render's buffer, a kept render,
// the WAV export) run fn(from, to, acc, ...args) over [0, n) in short steps and hand the main
// thread back whenever SLICE_MS have gone, so a slice lasts as long on a phone as on a desktop. In
// fixed chunks they took up to 9 ms each on a desktop, so 30-45 ms on a phone: frames dropped in
// the visuals all through a switch. A breather comes first, so a decode's own main-thread work
// (Chrome copies it into the AudioBuffer: 6-10 ms) and the first slice don't add up in one task.
const STEP = 1 << 15, SLICE_MS = 4;
async function inSteps(n, fn, acc, ...args) {
  let since = -Infinity;
  for (let from = 0; from < n; from += STEP) {
    if (performance.now() - since > SLICE_MS) { await breather(); since = performance.now(); }
    acc = fn(from, Math.min(n, from + STEP), acc, ...args);
  }
  return acc;
}
const peakOf = (from, to, peak, x) => {
  for (let i = from; i < to; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
  return peak;
};
// floor(v + 0.5) rounds to the same values as Math.round here, in under half its time in Chrome.
const toI16 = (from, to, _, x, y, kPos, kNeg) => {
  for (let i = from; i < to; i++) { const v = Math.floor(x[i] * (x[i] > 0 ? kPos : kNeg) + 0.5); y[i] = v > 32767 ? 32767 : v; }
};
const copyInto = (from, to, _, x, y) => { y.set(x.subarray(from, to), from); };
const scaleInto = (from, to, _, x, y, k) => { for (let i = from; i < to; i++) y[i] = x[i] * k; };

// How a decoder turned 16-bit samples into floats: most divide by 32768, Chromium divides positive
// ones by 32767. Read off a few thousand of the louder samples; 0 when the floats aren't 16-bit
// values at all (a lossy or resampled decode). A stem with nothing that loud loses nothing either way.
function stepOf(src) {
  const on = (v, k) => Math.abs(v * k - Math.round(v * k)) < 0.01;
  let neg = true, pos = true, posAlt = true;
  for (const x of src) {
    for (let i = 0, n = 0; i < x.length && n < 2000; i++) {
      const v = x[i];
      if (v < -0.25) { n++; neg &&= on(v, 32768); } else if (v > 0.25) { n++; pos &&= on(v, 32768); posAlt &&= on(v, 32767); }
    }
  }
  return !neg ? 0 : pos ? 32768 : posAlt ? 32767 : 0;
}

// Originals are kept as 16-bit, half the memory of the decoder's floats. The stems are 16-bit, so a
// WAV or FLAC comes back as exactly its own values. A lossy decode is rounded to 16 bits (noise
// near -98 dBFS) and, where it rings past full scale (Vorbis does, by up to 0.5 dB on 18 of the
// stems), scaled down to fit instead of clipped: `gain` is that scale, which render() puts back on
// the buffer's trim. Done in steps (see inSteps), so the page stays smooth.
async function toInt16(buf, lossy) {
  const src = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const step = lossy ? 0 : stepOf(src);
  let peak = 1;
  if (!step) for (const x of src) peak = await inSteps(x.length, peakOf, peak, x);
  const kNeg = 32768 / peak, kPos = step || kNeg;
  const channels = [];
  for (const x of src) {
    const y = new Int16Array(x.length);
    await inSteps(x.length, toI16, 0, x, y, kPos, kNeg);
    channels.push(y);
  }
  return { channels, length: buf.length, sampleRate: buf.sampleRate, lossy, gain: peak, bytes: buf.length * channels.length * 2 };
}

// Where a stem comes from. A local listing gives each stem's URL (`src`). The hosted build has an
// Ogg Vorbis copy (small) and a FLAC copy (lossless, about 4x the Ogg) of each, both page-relative
// (works at any mount point): browsers that can't decode Ogg (Safari, and every iOS browser,
// before 18.4) get the FLAC. Whether this one can is guessed before the first pick, so those
// don't download an Ogg first, and settled by the first decode. WebKit gets the FLAC from the
// start: an Ogg there would be its new decoder's (18.4), and a FLAC is sample-exact in every
// decoder (about 4x the download; Cloudflare serves it for free); its Ogg is tried only if the FLAC
// won't decode. An Ogg that decodes but doesn't line up with its master (see exactDecode) also
// counts as undecodable. Only a dev checkout has the WAV masters next to it (../Stems, see
// serve.mjs), so only there are they the last resort.
let oggOk = null, flacOk = true, oggsMissing = false;
function canOgg() {
  try { return new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== ''; } catch (_) { return true; } // no media element: let decoding tell
}
const nearWavs = () => !!LOCAL || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// With `early`, the promise resolves as soon as the stem is decoded: until its 16-bit copy is made
// (`channels`), the original holds the decoder's `floats` instead.
function getOriginal(info, type, onProgress, early = false) {
  const id = info.stems[type];
  let entry = lruGet(originals, id);
  if (!entry) {
    ensureCtx();
    entry = { listeners: new Set(), ctl: new AbortController() };
    const progress = (p) => entry.listeners.forEach((fn) => fn(p));
    let decoded;
    const first = new Promise((resolve) => { decoded = resolve; });
    // Lossy codecs pad a few ms that must be trimmed off the loop; WAVs and FLACs are the loop exactly.
    const load = async (path) => {
      entry.downloading = true;
      let bytes, buf;
      try { bytes = await fetchBytes(encodePath(path), progress, () => stemWanted(id), entry.ctl.signal); }
      finally { entry.downloading = false; }
      try { buf = await decode(bytes); } catch (err) {
        throw Object.assign(new Error(`can't decode ${path}: ${(err && err.message) || err}`), { name: 'EncodingError' });
      }
      const lossy = !/\.(wav|flac)$/i.test(path);
      if (lossy && !exactDecode(info, type, buf)) {
        throw Object.assign(new Error(`${path} decodes as ${buf.length} samples at ${buf.sampleRate} Hz, out of line with its master`), { name: 'EncodingError' });
      }
      // The first stretch can start from the decoder's floats at once (see render) instead of
      // waiting 30-150 ms for the 16-bit copy, which lets them go once it's made. A lossy decode that
      // checked out is the master's loop exactly (`frames`), padding after it aside.
      const frames = lossy && info.frames && buf.sampleRate === STEM_RATE ? info.frames[type] || 0 : 0;
      const orig = { length: buf.length, frames, sampleRate: buf.sampleRate, lossy, floats: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) };
      decoded(orig);
      // A loudness to measure (local stems) goes first: the first render waits for it, not the copy.
      const measuring = measureLoudness(info, type, buf, lossy);
      if (measuring) await measuring.catch(() => {});
      return Object.assign(orig, await toInt16(buf, lossy), { floats: null });
    };
    entry.promise = (async () => {
      if (info.src && info.src[type]) return load(info.src[type]);
      const ogg = info.oggs && info.oggs[type], flac = flacOk && info.flacs && info.flacs[type];
      oggOk ??= canOgg();
      const tries = [];
      if (ogg && !oggsMissing && (oggOk || !flac)) tries.push(ogg); // no FLAC to fall back on: the guess may be wrong
      if (flac) tries[webkit ? 'unshift' : 'push'](flac);
      if (nearWavs()) tries.push('../' + id);
      // A copy this browser can't decode, or that isn't there, moves on to the next; a download that
      // failed ends it (the next copy would fare no better, and is bigger).
      let undecodable = false, last = new Error(`fetch failed (404): no copy of ${id} here`);
      for (const path of tries) {
        try { return await load(path); } catch (err) {
          if (isAbort(err)) throw err;
          const bad = err.name === 'EncodingError';
          if (!bad && !/\(404\)/.test(err.message)) throw err;
          if (path === ogg) { if (bad) oggOk = false; else oggsMissing = true; } // for later picks too
          if (path === flac && bad) flacOk = false;
          undecodable ||= bad;
          last = err;
          console.warn('stem failed, trying the next copy:', path, err);
        }
      }
      // Nothing played and the rest was missing: the browser is what to fix.
      throw undecodable ? Object.assign(new Error(`no copy of ${id} decodes here (${last.message})`), { name: 'NotSupportedError' }) : last;
    })();
    entry.promise.then((buf) => { entry.settled = true; entry.buf = buf; entry.listeners.clear(); setTimeout(trimCaches); }, () => {
      entry.listeners.clear();
      if (originals.get(id) === entry) originals.delete(id); // not a newer load of the same stem
    });
    entry.early = Promise.race([first, entry.promise]);
    entry.early.catch(() => {}); // reported through entry.promise
    originals.set(id, entry);
  }
  // Already downloaded (e.g. hover-prefetched): say so now, so the card moves on to the stretch.
  if (onProgress) { if (entry.settled) onProgress(1); else entry.listeners.add(onProgress); }
  return early ? entry.early : entry.promise;
}

// Warm the cache (e.g. on hover) so a pick feels instant: the download, then a pre-render (see
// preRender). Only one at a time (a newer hover cancels the older download), and never while a
// pick is loading: that one comes first. No song: the pointer moved on, so its pre-render stops.
let hover = null; // { layerId, song, type } of the last prefetch, while the pointer is on it
export function prefetch(layerId, song) {
  const type = song ? stemTypeFor(layerId, song) : null;
  hover = type ? { layerId, song, type } : null;
  pumpJobs();
  if (!type || activeLayers().some((id) => state.layers[id].loading)) return;
  abortUnwanted(MANIFEST[song].stems[type]);
  getOriginal(MANIFEST[song], type).then(preRender, () => {});
}

// The tempo and key shift a pick of `song` on `layerId` would be rendered at (see selectStem):
// the average tempo with it in the mix, or the tempo it has if that is near enough (a first pick:
// its own, see autoTempo), and a pick on the auto-key anchor moves the key.
function pickAt(layerId, song) {
  return { bpm: autoBpm({ [layerId]: song }), semis: semisFor(MANIFEST[song].key, { layerId, song }) };
}
// The renders a pick of the hovered song would wait for: its own, then those of the other layers
// it moves to a new tempo or key (nearly every pick moves the average tempo). { song, type, at, key }
// each; none when the song is already on its layer (picking it again removes it). A layer that
// failed to render (see syncFailed) isn't tried again for a pick that may not come.
function hoverRenders() {
  if (!hover || state.layers[hover.layerId].song === hover.song) return [];
  const { bpm } = pickAt(hover.layerId, hover.song), others = activeLayers().filter((id) => id !== hover.layerId && !state.layers[id].error);
  const out = [];
  for (const [id, song, type] of [[hover.layerId, hover.song, hover.type], ...others.map((id) => [id, state.layers[id].song, state.layers[id].type])]) {
    const at = { bpm, semis: semisFor(MANIFEST[song].key, hover) }, key = renderKey(song, type, at.bpm, at.semis);
    if (id === hover.layerId || state.layers[id].bufferKey !== key) out.push({ song, type, at, key });
  }
  return out;
}

// Renders what a pick of the hovered song would wait for, once it's decoded: the song at the tempo
// and key the pick would bring, then the other layers at them, one at a time, so the pick only waits
// for the bar line. They run as low-priority jobs (see pumpJobs), and only when nothing is waiting
// for a worker and the mix is settled; it's tried again whenever a worker goes idle or the mix
// settles. A pick of the song takes the renders over, done or not. An hq upgrade waiting in the
// queue doesn't hold them back.
function preRender() {
  pumpJobs(); // one held back while the mix was busy may go now
  if (!hover || !ctx || jobQueue.some((j) => !j.low) || mixBusy()) return;
  const orig = originals.get(MANIFEST[hover.song].stems[hover.type]);
  if (!orig || !orig.settled) return;
  const next = hoverRenders().find((h) => !renders.has(h.key));
  if (next) render(next.song, next.type, null, next.at).promise.catch(() => {});
}
let preRenderTimer = 0;
// After the current task, once the layers have taken their renders and said they're done.
const preRenderSoon = () => { clearTimeout(preRenderTimer); preRenderTimer = setTimeout(preRender); };

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
// The hosted stems.json has them already (measured from the WAVs at build time: lufs[type]);
// local stems and the instrument guns are measured here, once per visit, as they are decoded.
const TYPE_LUFS = { groove: -12.6, all: -12.6, lead: -12.6, texture: -14.6, guns: -14.3 };
const loudness = new Map(); // stem id -> Promise of LUFS
const knownLufs = (info, type) => (info.lufs && Number.isFinite(info.lufs[type]) ? info.lufs[type] : null);
// From the decoder's floats (`buf`), the original's loop only, as it plays. Returns the
// measurement when it starts one.
function measureLoudness(info, type, buf, lossy) {
  const id = info.stems[type];
  if (knownLufs(info, type) !== null || loudness.has(id)) return null;
  const chans = [0, 1].map((c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
  const p = integratedLoudness(chans, buf.sampleRate, loopShape(buf.length, info.bpm, buf.sampleRate, lossy).inLen);
  p.catch(() => loudness.delete(id)); // measured again the next time it's decoded
  loudness.set(id, p);
  return p;
}
function stemTrim(info, type) {
  const known = knownLufs(info, type), measured = loudness.get(info.stems[type]);
  if (known === null && !measured) return Promise.reject(new Error(`no loudness for ${info.stems[type]}`));
  return (known !== null ? Promise.resolve(known) : measured).then((lufs) => {
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
// Room after the loop in the worker's 16-bit input, which the worker may extend the loop into
// instead of copying it (WSOLA reads up to ~160 ms past the end).
const SPARE_S = 0.25;

// Stretches a stem to `bpm` and shifts it by `semis` in a worker. `job` takes the queue's options
// (see stretchInWorker) and `onProgress` for the download. The buffer carries the trim it plays
// with and what the worker did (`quality`, `formant`). An hq request the worker would only answer
// with the fast render again resolves with null instead.
async function stretchStem(info, type, bpm, semis, { onProgress, ...job }) {
  const sr = ctx.sampleRate;
  const orig = await getOriginal(info, type, onProgress, true), srcRate = orig.sampleRate;
  const { beats, inLen } = orig.frames ? loopShape(orig.frames, info.bpm, srcRate) : loopShape(orig.length, info.bpm, srcRate, orig.lossy);
  const len = loopSamples(beats, bpm, sr), ratio = Math.pow(2, semis / 12);
  // The worker's own rule (see its run): a loop that its pitch shift and rate conversion alone bring
  // within 0.1% of its length isn't stretched by the hq path, so without formants to keep there is
  // nothing to gain, and the 12 MB input copy and the worker's time are saved. The usual case: a
  // first pick at its own tempo and key.
  if (job.quality === 'hq' && !job.formant && Math.abs(len / Math.round(inLen * (sr / srcRate) / ratio) - 1) < 0.001) return null;
  // The worker's own copy of the loop, in whatever form the original has when a worker takes
  // the job: the decoder's floats, or 16-bit with room at the end, or floats made from that
  // until a worker has shown it reads 16-bit (see int16Input). Copied in steps (see inSteps), like
  // the reply below: in one go the copies for two jobs held the main thread for up to 45 ms on a
  // desktop (a phone takes 3-4x that), long enough for the visuals to stall during a switch.
  const spare = Math.ceil(SPARE_S * srcRate);
  let gain = 1; // what the copy sent was scaled down by (see toInt16)
  const chans = async (int16) => {
    const from16 = !!orig.channels, src = from16 ? orig.channels : orig.floats; // the copy may be made meanwhile
    gain = from16 ? orig.gain : 1;
    const out = [];
    for (let c = 0; c < 2; c++) {
      const x = src[Math.min(c, src.length - 1)], y = from16 && int16 ? new Int16Array(inLen + spare) : new Float32Array(inLen);
      if (!from16 || int16) await inSteps(inLen, copyInto, 0, x, y);
      else await inSteps(inLen, scaleInto, 0, x, y, 1 / 32768);
      out.push(y);
    }
    return out;
  };
  // A loudness still being measured (from the decode, see getOriginal) finishes meanwhile.
  const [out, trim] = await Promise.all([
    stretchInWorker(chans, sr, len, ratio, { ...job, type, inLen, srcRate }),
    stemTrim(info, type).catch((err) => { console.warn('loudness not measured:', err); return 1; }),
  ]);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) await inSteps(len, copyInto, 0, out.channels[c], buf.getChannelData(c));
  buf.trim = trim * gain; // and back up by what toInt16 scaled a hot lossy decode down
  buf.quality = out.quality || 'fast'; // an older worker doesn't say: it only has the fast path
  buf.formant = !!out.formant;
  return buf;
}

// Renders a stem at the current tempo and key (or at `at`, { bpm, semis }: see preRender).
// Identical requests share one render. An entry holds the best render made for its key: the fast
// one, replaced by its hq upgrade once that lands (see upgrade). The key needs no quality of its
// own, as nothing asks for the fast render once there is a better one, and formant correction
// follows from the key (the song, its type and the shift).
function render(song, type, onProgress, at) {
  const info = MANIFEST[song];
  const { bpm, semis } = at || { bpm: state.bpm, semis: semisFor(info.key) };
  const key = renderKey(song, type, bpm, semis);
  let entry = lruGet(renders, key);
  if (!entry) {
    entry = { bpm };
    const forget = () => { if (renders.get(key) === entry) renders.delete(key); };
    // Waited for while a layer has this pick and the tempo and key still call for this render;
    // still wanted, as a pre-render, while the pointer rests on a song whose pick would use it.
    const urgent = () => activeLayers().some((id) => {
      const s = state.layers[id];
      return s.song === song && s.type === type && renderKey(song, type) === key;
    });
    const wanted = () => urgent() || hoverRenders().some((h) => h.key === key);
    entry.promise = (async () => {
      const kept = await keptRender(info, type, key);
      if (kept) { if (onProgress) onProgress(1); entry.buf = kept; return kept; }
      // Dropped from the queue: forgotten at once, so a new request for it starts afresh.
      entry.buf = await stretchStem(info, type, bpm, semis, { onProgress, wanted, urgent, dropped: forget });
      return entry.buf;
    })();
    entry.promise.then(() => setTimeout(trimCaches), forget); // once the layer waiting for it holds it
    renders.set(key, entry);
  } else {
    if (onProgress) onProgress(1);
    pumpJobs(); // a pre-render a pick now waits for becomes urgent
  }
  return { key, bpm, promise: entry.promise };
}

// ---------- the last mix, kept across reloads ----------
// A reload or a share link would otherwise download, decode and stretch every layer again (about
// a second for three layers on a desktop, several on a phone). So the layers' renders are kept in
// IndexedDB as 16-bit (10-17 MB each) once the mix has stood still for a few seconds, and only the
// last mix is kept. A stored render is found by its render key and stem file, so it is only used
// for exactly the pick, tempo, key and sample rate it was made for (the render key has the rate).
// Where IndexedDB is missing or refuses (private modes, a full disk) nothing is kept and everything
// works as before.
// A render's grade is part of its id ('hq' for an upgrade, see upgrade), so a mix that was upgraded
// after it was kept is stored again, and a reload takes the hq render of a key when there is one.
const KEEP = { db: 'dcr-renders', store: 'mix', idle: 5000, version: 6 }; // bump `version` when renders change (6: the worker's faster 48 kHz conversion)
const gradeOf = (buf) => (buf.upgraded ? 'hq' : 'fast');
const keptId = (key, info, type, grade) => `${key}|${info.stems[type]}|${grade}|${KEEP.version}`;
const idbDone = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
let keptDbP = null, keptKeysP = null;
function keptDb() {
  keptDbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(KEEP.db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KEEP.store);
    // Deleted or upgraded elsewhere (site data cleared, another tab): closed so that can go ahead,
    // and opened afresh next time. Kept closed, every later keepMix failed for the rest of the visit.
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); keptDbP = keptKeysP = null; }; resolve(db); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked by another tab'));
  }).catch(() => null);
  return keptDbP;
}
// The keys stored (a Set kept up to date by keepMix), or null where there's no database.
function keptKeys() {
  keptKeysP ??= keptDb().then((db) => db && idbDone(db.transaction(KEEP.store).objectStore(KEEP.store).getAllKeys()))
    .then((keys) => (keys ? new Set(keys) : null), () => null);
  return keptKeysP;
}

// The stored render for `key`, ready to play, or null.
async function keptRender(info, type, key) {
  // A database that doesn't answer counts as empty rather than holding the pick up.
  const keys = await Promise.race([keptKeys(), sleep(500).then(() => null)]);
  const id = keys && ['hq', 'fast'].map((g) => keptId(key, info, type, g)).find((k) => keys.has(k));
  if (!id) return null;
  try {
    const db = await keptDb();
    const rec = await idbDone(db.transaction(KEEP.store).objectStore(KEEP.store).get(id));
    if (!rec || rec.sampleRate !== ctx.sampleRate) return null;
    const buf = ctx.createBuffer(2, rec.length, rec.sampleRate);
    for (let c = 0; c < 2; c++) await inSteps(rec.channels[c].length, scaleInto, 0, rec.channels[c], buf.getChannelData(c), rec.scale);
    buf.trim = rec.trim;
    buf.quality = rec.quality || 'fast'; buf.formant = !!rec.formant;
    if (rec.upgraded) buf.upgraded = buf.final = true; // nothing better to come (see upgrade)
    // The original is only needed for the next tempo or key change: it loads once the mix is going.
    setTimeout(() => { if (stemWanted(info.stems[type])) getOriginal(info, type).catch(() => {}); }, 3000);
    return buf;
  } catch (err) {
    console.warn('a kept render could not be read, stretching instead:', err);
    return null;
  }
}

let keepTimer = 0, keeping = false, keepAgain = false;
function keepLater() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(keepMix, KEEP.idle);
}
// Deletes the stored renders the mix no longer plays, then stores its new ones one at a time (so
// only one 16-bit copy is held at once), each in its own transaction: a write that fails or stops
// half-way leaves records that are each still right for their key. Only with room to spare in
// the site's quota, counted once the old records are gone (they are what fills it on a nearly full
// device); where the browser can't say how much there is, nothing is stored. While an hq
// upgrade is on its way it waits for it (its landing restarts the wait), so a mix is written once
// in its final form rather than fast first and again a few seconds later. A pick, tempo or key
// change meanwhile stops it before the next record: the copies and the writes (12 MB each) would
// compete with that pick for a mix that is already gone, and the change starts the wait again.
async function keepMix() {
  if (keeping) { keepAgain = true; return; } // the mix changed while the last one was being stored
  const ids = activeLayers();
  if (!ctx || !ids.length || mixBusy() || upJob || !ids.every((id) => isCurrent(state.layers[id]))) return;
  if (!navigator.storage || !navigator.storage.estimate) return;
  const bufs = ids.map((id) => state.layers[id].buffer);
  const moved = () => mixBusy() || upJob || activeLayers().join() !== ids.join() || ids.some((id, k) => state.layers[id].buffer !== bufs[k]);
  keeping = true;
  try {
    const keys = await keptKeys(), db = await keptDb();
    if (!keys) return;
    // Another tab may have stored its mix since: start from what is there now.
    const there = await idbDone(db.transaction(KEEP.store).objectStore(KEEP.store).getAllKeys());
    keys.clear();
    there.forEach((k) => keys.add(k));
    const mix = new Map(ids.map((id) => { const s = state.layers[id]; return [keptId(s.bufferKey, MANIFEST[s.song], s.type, gradeOf(s.buffer)), s.buffer]; }));
    const fresh = [...mix].filter(([k]) => !keys.has(k)), stale = [...keys].filter((k) => !mix.has(k));
    const commit = (fn) => new Promise((resolve, reject) => {
      const tx = db.transaction(KEEP.store, 'readwrite');
      fn(tx.objectStore(KEEP.store));
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    if (stale.length) {
      await commit((store) => stale.forEach((k) => store.delete(k)));
      stale.forEach((k) => keys.delete(k));
    }
    if (!fresh.length) return;
    const need = fresh.reduce((n, [, b]) => n + b.length * 4, 0); // 16-bit stereo
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota - usage < 2 * need + 64 * MB) return;
    for (const [k, b] of fresh) {
      if (moved()) break;
      const q = await toInt16(b, true); // scaled to fit, like a hot lossy decode
      if (moved()) break;
      await commit((store) => store.put({ channels: q.channels, scale: q.gain / 32768, trim: trimOf(b), length: b.length, sampleRate: b.sampleRate,
        quality: b.quality, formant: !!b.formant, upgraded: !!b.upgraded }, k));
      keys.add(k);
    }
  } catch (err) {
    console.warn("couldn't keep the mix for the next visit:", err);
  } finally {
    keeping = false;
    if (keepAgain) { keepAgain = false; keepLater(); }
  }
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
// Where a browser doesn't say how big its chunks are (Safari has no baseLatency), the lead covers
// what phones and Bluetooth output use (up to ~50 ms), and watchClock raises it if the clock
// moves in bigger steps than that.
const BLIND_AHEAD = 0.05, LEAD_MAX = 0.25;
let ahead = 0; // how far the audio thread may already be past currentTime, as far as we know
function setLead(step = 0) {
  ahead = Math.max(ahead, ctx.baseLatency > 0 ? ctx.baseLatency : BLIND_AHEAD, step);
  LEAD = Math.min(LEAD_MAX, Math.max(XFADE + 0.04, XFADE + 0.02 + 2 * ahead));
}
// currentTime moves on once per chunk the audio thread renders, so its biggest step is at least
// how far ahead of it the audio already is. Where baseLatency doesn't say, it is read every few ms
// for the first second or so the context runs (and again after an interruption): steps taken while
// this page's timers ran on time count, longer gaps (the main thread was busy) don't. (Where it
// does say, it is trusted, as before: Chromium's clock also jumps two chunks at once now and then
// while a page loads, and that would add 20 ms to every Play.)
function watchClock() {
  if (ctx.baseLatency > 0) return;
  let last = ctx.currentTime, wall = performance.now(), reads = 0;
  const timer = setInterval(() => {
    const t = ctx.currentTime, now = performance.now();
    if (now - wall < 12 && t > last && t - last < LEAD_MAX) setLead(t - last);
    last = t; wall = now;
    if (++reads > 300 || ctx.state !== 'running') clearInterval(timer);
  }, 4);
}
// The earliest a source may still be started: one any closer to now may already be in the past for
// the audio thread, which then starts it late, and it stays late (see startSource).
const soonest = () => ctx.currentTime + (LEAD - XFADE) / 2;

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
// A start that would come too close to now (see soonest: the main thread was held up, or the
// clock lags the audio) would be heard late and stay late, a flam against the other layers until
// the layer restarts. It moves on to a later beat line instead, its loop position with it, so it
// lands in time, and the old source plays on until then.
function startSource(layerId, when, offset, buffer) {
  const s = state.layers[layerId];
  const late = soonest() + XFADE - when;
  if (late > 0) {
    const skip = Math.ceil(late / (barSec() / 4)) * barSec() / 4;
    when += skip; offset += skip;
  }
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
  // Joins a Tape stop brake already under way, at the point the braked sources have reached (see
  // brakeLag), so a swap landing then (an hq upgrade, say) crossfades into the same moment of the
  // music, not one ahead. (fxOn.len is only set once a brake has started: Tape stop held while
  // stopped has none.)
  let behind = 0;
  if (fxOn && fxOn.id === 'tapestop' && fxOn.len !== undefined) {
    slowToHalt(src.playbackRate, fxOn.t, fxOn.len, fxOn.floor, at);
    behind = brakeLag(Math.max(0, at - fxOn.t), fxOn.len, fxOn.floor);
  }
  const f = Math.round((offset - (when - at) - behind) * sr); // the loop position at `at`, in whole frames
  src.start(at, (((f % len) + len) % len) / sr);
  // Once it's gone, the cache counts its buffer again (a replaced pick's render, say), and the layer
  // lets go of it: kept in s.tails until the layer's next stop, it held a render (20-25 MB) per layer
  // that the cache had already counted as freed.
  src.onended = () => { src.disconnect(); trim.disconnect(); sg.disconnect(); s.tails = (s.tails || []).filter((x) => x.src !== src); trimCaches(); };
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

// The sources of a layer that are or will be sounding, outgoing ones included: { src, startAt }.
const sourcesOf = (s) => [...(s.tails || []).filter((x) => x.stopAt > ctx.currentTime), ...(s.source ? [{ src: s.source, startAt: s.startAt }] : [])];

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
// While an Audio FX is held, picks wait for it: every group made during the hold has an extra
// member, 'fx', settled when it's let go (see dropHeld), so the new songs drop in as it releases.
const openGroups = new Set();
let tempoHeld = false; // a tempo restart waits for a group to land (see resyncOnce)
let tempoAt = 0; // where the next tempo restart lands, when a stem change brought it: that change's bar line (see resyncOnce)
let heldGroup = null; // the group single picks join during a hold
function swapGroup(members) {
  const g = { members: new Set(members), waiting: new Set(members), starts: [], ready: new Set() };
  if (fxOn && state.playing) g.waiting.add('fx');
  g.timer = setTimeout(() => { for (const m of [...g.waiting]) settle(g, m); }, 30000);
  openGroups.add(g);
  return g;
}
function settle(g, member, start) {
  if (!g || !g.waiting.has(member)) return false;
  if (start) { g.starts.push(start); g.ready.add(member); }
  g.waiting.delete(member);
  if (g.waiting.size) return true;
  clearTimeout(g.timer);
  openGroups.delete(g);
  if (g === heldGroup) heldGroup = null;
  // A held group drops in as the FX is let go, if it's ready by then; otherwise on a bar line.
  const t = state.playing ? (g.dropAt > ctx.currentTime + XFADE ? g.dropAt : nextBarTime()) : 0;
  if (g.starts.length && state.playing) {
    for (const fn of g.starts) fn(t);
    changed();
  }
  if (tempoHeld) { tempoHeld = false; tempoAt = t; queueMicrotask(rebuildAll); } // the held tempo change goes ahead now, with the group
  return true;
}
// While playing, a tempo restart would start a group's ready picks at once and cut the old
// picks of the ones still loading: it waits until the whole group is in, and during an FX hold
// until the picks made in it drop in on the release (see dropHeld).
const groupPending = () => [...openGroups].some((g) => [...g.waiting].some((m) => m === 'fx' || (state.layers[m] && state.layers[m].loading)));
// The groups waiting for the held FX, and the layers in them that are ready to drop.
const heldGroups = () => [...openGroups].filter((g) => g.waiting.has('fx'));
export const queued = (layerId) => heldGroups().some((g) => g.waiting.has(layerId) || g.ready.has(layerId));
// Letting go of the FX: everything picked during the hold drops in at `at` (in time: each song
// starts at the loop position the clock is at). A pick still loading follows on a bar line, and the
// held group takes no more picks: one made in the next hold joined it, found no FX to wait for,
// and dropped in mid-hold.
function dropHeld(at) {
  for (const g of heldGroups()) { g.dropAt = at; settle(g, 'fx'); }
  heldGroup = null;
  changed();
}

// ---------- hq upgrades ----------
// A pick plays its fast render (onset-anchored WSOLA) as soon as that is ready. On a desktop with
// room to spare (HQ_OK), each layer of a type the worker's hq path improves (held chords, pads and
// voices, where WSOLA warbles) is then rendered again at 'hq' in the background, one layer at a time
// and behind every other job, and swapped in at the next bar. Both renders put every attack on the
// same grid, so that is a plain same-song crossfade on the bar line. A new pick, tempo or key drops
// the job. A sung lead shifted in key also gets its formants kept in place.
const HQ_TYPES = { lead: true, texture: true, all: true }; // grooves: the worker's hq is no better there
// Lead stems that are a sung voice, whose formants should stay put so they don't sound chipmunked
// when shifted up or like a slowed-down giant when shifted down. The audio audit's list: a judgement
// by ear, not a measurement (the robot voices of Technologic or Harder Better Faster Stronger aren't
// on it). Names as in stems.json. Changing it changes stored renders: bump KEEP.version.
const SUNG_LEADS = new Set(['Get Lucky', 'Instant Crush', 'Starboy', 'I Feel It Coming', 'One More Time', 'Lose Yourself To Dance', "Doin' It Right"]);
const UP_ORDER = ['lead', 'texture', 'groove']; // voices first: with formants they change the most
const UP_WAIT = 1000; // ms the mix stands still before an upgrade starts, so quick re-picks don't start and drop them
let upJob = null, upTimer = 0; // { wanted } of the upgrade on its way

function upgradeSoon() {
  if (!HQ_OK) return;
  clearTimeout(upTimer);
  upTimer = setTimeout(upgrade, UP_WAIT);
  if (upJob && !upJob.wanted()) pumpJobs(); // the pick, tempo or key moved on: its worker stops now
}

// Upgrades the first layer that plays a fast render of an hq type and hasn't had its turn (`final`:
// the hq render itself, or a fast one the worker couldn't better), once the mix is settled. A muted
// layer waits until it's heard again (setMuted reports a change, which brings this back).
function upgrade() {
  if (!HQ_OK || upJob || !ctx || mixBusy()) return;
  const id = UP_ORDER.find((lid) => { const s = state.layers[lid]; return s.song && !s.muted && HQ_TYPES[s.type] && isCurrent(s) && !s.buffer.final; });
  if (!id) return;
  const s = state.layers[id], { song, type, buffer: fast, bufferKey: key, bufferBpm: bpm } = s, info = MANIFEST[song];
  const made = renders.get(key);
  if (made && made.buf && made.buf.upgraded) { swapIn(id, made.buf); return; } // made while its pick waited for a group
  const semis = semisFor(info.key);
  const wanted = () => s.song === song && s.buffer === fast && renderKey(song, type) === key; // the layer still plays it
  const job = upJob = { wanted };
  stretchStem(info, type, bpm, semis, { wanted, urgent: () => false, low: true, quality: 'hq', formant: type === 'lead' && semis !== 0 && SUNG_LEADS.has(song) })
    .then((buf) => {
      if (!buf || (buf.quality !== 'hq' && !buf.formant)) { fast.final = true; return; } // nothing better to be had (e.g. at its own tempo and key)
      buf.upgraded = buf.final = true;
      buf.trim *= levelMatch(fast, buf);
      renders.delete(key); // the cache keeps the better one (see render), newest
      renders.set(key, { bpm, buf, promise: Promise.resolve(buf) });
      setTimeout(trimCaches);
      if (wanted()) swapIn(id, buf);
    }, (err) => {
      if (isAbort(err)) return; // dropped: tried again if the settings come back to it
      console.warn('hq render failed, the fast one plays on:', song, err);
      fast.final = true;
    })
    // On to the next layer, in a task of its own: its input copy and this render's buffer copy
    // together held the main thread for 35 ms (a dropped frame or two in the visuals). keepMix
    // skipped the mix while this ran, and an upgrade that swaps nothing in reports no change.
    .finally(() => { if (upJob === job) upJob = null; keepLater(); setTimeout(upgrade); });
}

// WSOLA's splices lose a little level on some material and the hq path doesn't (measured: hq came
// out 0.13-0.37 dB louder on the layers tested), so the upgrade plays at the fast render's level
// and the balance of the mix doesn't move when it lands. Within 1 dB, in case of an odd render.
// Every 61st sample reads a minute of music to within 0.04 dB in 1 ms; a step that divides the
// bar (16 or 64) locks onto the beat grid and was off by up to 0.18 dB.
function levelMatch(from, to) {
  const level = (b) => {
    let sum = 0, n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 61) { sum += d[i] * d[i]; n++; } }
    return Math.sqrt(sum / n) * trimOf(b);
  };
  const r = level(from) / level(to);
  return Number.isFinite(r) && r > 0 ? Math.min(1.122, Math.max(0.891, r)) : 1;
}

// Puts a better render of the same pick on a layer, heard from the next bar (or the next Play). A
// pick in a group that hasn't landed yet (still loading, or ready and waiting for the others, whose
// start checks it still has the buffer it was made with) gets it once the group is in: upgrade runs
// again then and finds it in the cache. It's started only on a layer heard playing the render it
// betters: a layer re-keyed for a pick that waits (for an FX hold's release, or a group still
// loading) plays its old render until then, and the re-key's own start (see resyncOnce) plays the
// new s.buffer when it lands. Started here, it brought the new key in while the anchor still
// played the old one.
function swapIn(id, buf) {
  const s = state.layers[id];
  if ([...openGroups].some((g) => g.members.has(id))) return;
  const was = s.buffer;
  s.buffer = buf;
  if (state.playing && s.source && s.source.buffer === was && s.bufferBpm === clockBpm) { const t = nextBarTime(); startSource(id, t, t - state.transportStart); }
  changed();
}

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
  tempoAt = 0;
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
  pumpJobs(); // a pre-render for the old key or tempo stops now
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
  // Meanwhile the layers that restart with it are rendered at the new tempo (each render is shared,
  // see render), so the restart waits for the group only, not for them after it.
  const holdTempo = () => {
    if (!state.playing || clockBpm === state.bpm || !groupPending()) return false;
    tempoHeld = true;
    for (const id of activeLayers()) { const s = state.layers[id]; if (s.buffer && !s.loading && !isCurrent(s)) render(s.song, s.type).promise.catch(() => {}); }
    for (const g of groups) settle(g, 'resync');
    return true;
  };
  if (holdTempo()) return;
  const stale = activeLayers().filter((id) => { const s = state.layers[id]; return s.buffer && !s.loading && !isCurrent(s); });
  // At a new tempo the new renders go on their layers only as the restart is committed, with the
  // clock (up to a bar after they're ready, see tempoWait). Put on the layers earlier, they left
  // none at the clock's tempo for that bar, so Export said "Nothing to export" while the mix
  // played, and an hq upgrade could start on a render not heard yet.
  const fresh = [];
  const willBe = (id) => isCurrent(state.layers[id]) || fresh.some((r) => r.id === id);
  const assign = () => {
    for (const r of fresh) {
      const s = state.layers[r.id];
      if (s.song !== r.song || s.renderTag !== r.tag || s.loading || r.job.key !== renderKey(s.song, s.type)) continue; // moved on during the wait
      s.buffer = r.result.value; s.bufferKey = r.job.key; s.bufferBpm = r.job.bpm; s.error = null;
    }
  };
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
    if (holdTempo()) { changed(); return; } // a pick at the new tempo started loading meanwhile: the restart waits for it
    // At a new tempo the clock moves on with the layers that made it (see below).
    const clockMoves = activeLayers().some(willBe);
    for (const r of failed) {
      const tempo = r.job.bpm !== state.layers[r.id].bufferBpm;
      syncFailed(r, !tempo ? "couldn't change key, so it plays on in the old key"
        : clockMoves && state.playing ? "couldn't follow the tempo change, so it's silent for now" : "couldn't follow the tempo change");
    }
  }

  // The clock follows the tempo once at least one layer is ready at it (a layer that failed
  // to re-render drops out rather than playing out of time).
  const tempoMoves = clockBpm !== state.bpm && activeLayers().some(willBe);
  if (!state.playing) {
    assign();
    clockBpm = state.bpm;
    tempoAt = 0;
  } else if (tempoMoves) {
    // Everything restarts together at the new tempo, from the same point in the loop: a tempo set
    // by hand as soon as it can, one a stem change brought on that change's bar line (see settle
    // and clearLayer), or the next one if the renders took longer. A bar line of the old clock is
    // one of the new clock too (see retime), so the new downbeat lands where the old one was due.
    let t = !tempoAt ? frame(ctx.currentTime + LEAD) : tempoAt >= soonest() + XFADE ? tempoAt : nextBarTime();
    if (tempoAt && await tempoWait(t, state.bpm)) { resyncAgain = true; resyncGroups.unshift(...groups); changed(); return; }
    if (t < soonest() + XFADE) t = nextBarTime(); // the wait ran late
    tempoAt = 0;
    assign();
    retime(t);
    for (const l of LAYERS) {
      const s = state.layers[l.id];
      if (s.song && s.buffer && s.bufferBpm === clockBpm && !s.loading) startSource(l.id, t, t - state.transportStart);
      else stopSource(l.id, t); // still loading a new pick at the old tempo: it joins when ready; a cleared one leaves now
    }
    if (fxOn && fxOn.repeats) restartRepeats(t); // a held Stutter repeats at the new tempo (an Auto length follows it)
  } else if (fresh.length) {
    assign();
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
  // A cleared layer waiting to leave with a tempo restart that isn't coming (the tempo went back,
  // or no layer could follow it) leaves on the next bar line instead.
  if (state.playing && !tempoMoves) for (const l of LAYERS) if (!state.layers[l.id].song && state.layers[l.id].source) stopSource(l.id, nextBarTime());
  for (const g of groups) settle(g, 'resync'); // nothing (more) to start for it
  // A layer that failed earlier is fine again once the settings come back to what it has.
  for (const id of activeLayers()) if (isCurrent(state.layers[id])) state.layers[id].error = null;
  changed();
  preRenderSoon();
}

// A restart a stem change brought is planned for that change's bar line (up to a bar away), but
// it's committed (the clock moved on, the old sources faded out) only just before it: a pick,
// Random or clear made meanwhile would otherwise land a bar or so later at a tempo of its own, so
// the mix would move twice. Waits until COMMIT s before the bar line's lead; true if the mix moved
// on meanwhile (another tempo, a pick loading for it, new settings, Stop), so the restart is
// planned again with that change in it.
const COMMIT = 0.1;
async function tempoWait(t, bpm) {
  for (;;) {
    if (resyncAgain || state.bpm !== bpm || !state.playing || groupPending()) return true;
    const left = t - LEAD - COMMIT - ctx.currentTime;
    if (left <= 0) return false;
    await sleep(Math.min(50, left * 1000));
  }
}

// ---------- layer selection ----------
export async function selectStem(layerId, song, opts = {}) {
  ensureCtx();
  const s = state.layers[layerId];
  if (s.song === song && !opts.force) {
    // During an FX hold, picking a queued song again takes it back: the layer keeps what it had.
    if (fxOn && state.playing && queued(layerId) && s.heldFrom !== song) {
      return s.heldFrom ? selectStem(layerId, s.heldFrom, { force: true }) : clearLayer(layerId);
    }
    return clearLayer(layerId);
  }
  const type = stemTypeFor(layerId, song);
  if (!type) { settle(opts.group, layerId); return; }

  // The tempo moves to the average with this pick in (see autoTempo): a share link's picks keep its
  // tempo (keepTempo), and Random sets it once for all of its picks (tempoSet).
  const auto = !opts.keepTempo && !opts.tempoSet && autoTempo({ [layerId]: song });
  const rootBefore = masterRoot();
  const gen = playGen;
  // During an FX hold a pick waits for the release (see dropHeld); the layer remembers what it
  // had, so the pick can be taken back.
  let group = opts.group || null;
  if (fxOn && state.playing) {
    if (s.heldFrom === undefined) s.heldFrom = s.song; // the first change in this hold
    if (!group) {
      if (!heldGroup) heldGroup = swapGroup([]);
      group = heldGroup;
      group.waiting.add(layerId);
      group.members.add(layerId); // an hq upgrade leaves it alone until it lands (see swapIn)
    }
  }
  // At a tempo the clock isn't at yet, the pick lands with the restart that brings every layer to it
  // (see resyncOnce): in a group, so that restart waits for it and its old song plays on till then.
  if (state.playing && state.bpm !== clockBpm) group ??= swapGroup([layerId]);
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
  // A new song on the auto-key anchor moves the master key: re-key the other layers (after
  // this task, so a random pick of every layer re-keys once, against the final songs).
  if (rootBefore !== null && masterRoot() !== rootBefore) {
    group ??= swapGroup([layerId]);
    group.waiting.add('resync');
    queueMicrotask(() => rebuildAll(group));
  }
  if (auto) queueMicrotask(() => rebuildAll()); // the other layers render at the new tempo meanwhile (see resyncOnce)

  // A pick replaced by a newer one waiting in the same group (two picks on a layer during an FX
  // hold join the one held group) leaves the layer's place in it to that pick. Settled by the old
  // one, the new pick found the group no longer waiting for it and dropped in mid-hold.
  s.group = group;
  const leave = () => { if (s.group !== group) settle(group, layerId); };
  const tag = ++s.renderTag;
  try {
    // Progress arrives per network chunk; re-render the UI in 2% steps, not hundreds of times.
    // It can go back (an Ogg this browser couldn't decode, then the FLAC).
    const progress = (p) => {
      if (s.renderTag === tag && (p >= 1 || Math.abs(p - s.progress) >= 0.02)) { s.progress = p; changed(); }
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
    if (s.renderTag !== tag || s.song !== song) { leave(); return; }
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
        // restart waits for the rest of the group, so they all land with the tempo change, on
        // the group's bar line (or as the held FX lets go).
        retimeLater = settle(group, layerId, (t) => { tempoAt = t; rebuildAll(); }) && group.waiting.size > 0;
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
    preRenderSoon();
  } catch (err) {
    if (s.renderTag !== tag) { leave(); return; }
    console.error(err);
    s.loading = false;
    stopSource(layerId);
    const rootBefore = masterRoot();
    s.song = s.type = s.buffer = s.bufferKey = null;
    state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
    if (!activeLayers().length) { state.playing = false; wantPlay = false; }
    status(loadError(song, err), 'error');
    // The average goes back to the stems that are left, unless the tempo was set by hand (or by a
    // share link) since.
    const back = !opts.keepTempo && !state.tempoTouched && autoTempo({}, state.playing ? clockBpm : state.bpm);
    // Settled only now that it's gone: the rest of its group, if keyed against it, no longer
    // counts as current and waits for the re-key below instead of starting in the wrong key.
    settle(group, layerId);
    changed();
    if (back || (masterRoot() !== rootBefore && masterRoot() !== null)) rebuildAll(); // the tempo went back, or the failed pick was the key anchor
    // The others may have been waiting on this one to start (Play pressed during loading).
    if (!state.playing && (wantPlay || (!opts.noAutoplay && gen === playGen)) && activeLayers().length
      && activeLayers().every((id) => !state.layers[id].loading)) play();
  }
}

export function clearLayer(layerId) {
  const s = state.layers[layerId];
  if (!s.song) return;
  const auto = autoTempo({ [layerId]: null }), others = activeLayers().length > 1; // the average of what's left
  // It leaves on the bar line, unless it's the last layer: then the music stops now, with the UI.
  // At a new tempo it leaves with the restart that brings the others to it (see resyncOnce): on
  // that bar line if they're ready by then. During an FX hold that restart waits for the release,
  // like a pick made in the hold (see groupPending).
  const withTempo = ctx && state.playing && others && state.bpm !== clockBpm;
  if (withTempo) {
    tempoAt = nextBarTime();
    if (fxOn) heldGroup ??= swapGroup([]);
  }
  // A held Stutter stops repeating it now, and its source goes too (muted at the insert until the
  // release), so it doesn't come back for a moment as the Stutter is let go.
  const repeating = fxOn && fxOn.repeats;
  if (repeating) {
    const t = ctx.currentTime + 0.005;
    stopRepeats(repeatsAt(t).filter((r) => r.lid === layerId), t);
    fxOn.repeats = fxOn.repeats.filter((r) => r.lid !== layerId);
  }
  if (ctx && (!withTempo || repeating)) stopSource(layerId, state.playing && others && !repeating ? nextBarTime() : undefined);
  s.renderTag++;
  s.group = null; // a pick still loading settles its group as it ends (see selectStem)
  const rootBefore = masterRoot();
  s.song = s.type = s.buffer = s.bufferKey = s.error = null;
  s.loading = s.syncing = false;
  state.anchorOrder = state.anchorOrder.filter((x) => x !== layerId);
  if (!activeLayers().length) { state.playing = false; playGen++; wantPlay = false; }
  abortUnwanted(); // its download, if it was still coming
  changed();
  if (auto || (masterRoot() !== rootBefore && masterRoot() !== null)) rebuildAll();
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
  // One tempo for the batch, set before any of it renders: the average with all of the new picks in.
  const auto = picks.length > 0 && autoTempo(Object.fromEntries(picks));
  // While playing, the old mix carries on until every new pick is ready, then all swap together.
  const group = swapGroup(picks.map(([id]) => id));
  for (const [id, song] of picks) selectStem(id, song, { force: true, group, tempoSet: true });
  if (auto) queueMicrotask(() => rebuildAll()); // a layer it didn't re-pick renders at the new tempo meanwhile
}

// ---------- auto tempo ----------
// A stem change by the player (a pick, Random, a clear) sets the tempo to the rounded average of
// the native BPMs of the stems in the mix after it (an instrument gun's is its song's), or keeps it
// if it is near that already (see TEMPO_BAND), so the mix plays at the tempo in the middle of its
// songs, and a first pick at its own. A tempo set by hand
// holds until the next stem change; a share link keeps its own (its picks are keepTempo).
// `picks` maps layer ids to their new songs (null: cleared); null when no stem would be left.
// (`in`, not Object.hasOwn: Safari has that only from 15.4, and picks is a plain object.)
function meanBpm(picks = {}) {
  const songs = LAYERS.map((l) => (l.id in picks ? picks[l.id] : state.layers[l.id].song)).filter(Boolean);
  if (!songs.length) return null;
  const bpm = Math.round(songs.reduce((sum, song) => sum + MANIFEST[song].bpm, 0) / songs.length);
  return Math.max(BPM_MIN, Math.min(BPM_MAX, bpm));
}
// A change that leaves other layers in the mix keeps the tempo while the new average is within
// TEMPO_BAND BPM of it: a move re-renders every layer (three jobs, so on a phone's two workers the
// pick's own render waited for a second round) for a difference of 1.5-2.5% nobody hears. After a
// change the tempo is still never further than that from the average, as one that would be moves it.
// About 30% of single re-picks in a three-layer mix keep the tempo this way, against 7% without.
// Only on phones and tablets: a desktop renders the three at once in a fraction of a bar, so it
// plays the exact average (the tempo shown is then always the one asked for).
// `near` is the tempo to keep: the one asked for, or the clock's for a pick that failed (it goes back).
const TEMPO_BAND = handheld ? 2 : 0;
function autoBpm(picks = {}, near = state.bpm) {
  const bpm = meanBpm(picks), others = activeLayers().some((id) => !(id in picks));
  return bpm !== null && others && Math.abs(bpm - near) <= TEMPO_BAND ? near : bpm;
}
// Sets the tempo for a stem change; true if it moved (re-rendering is the caller's: rebuildAll).
function autoTempo(picks, near) {
  const bpm = autoBpm(picks, near);
  state.tempoTouched = false;
  if (bpm === null || bpm === state.bpm) return false;
  state.bpm = bpm;
  pumpJobs(); // renders and pre-renders at the old tempo stop now
  return true;
}

// ---------- mix settings ----------
let bpmTimer;
export function setBpm(bpm, { immediate = false } = {}) {
  bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
  if (bpm === state.bpm) return;
  state.bpm = bpm;
  state.tempoTouched = true;
  tempoAt = 0; // by hand: as soon as it can (see resyncOnce)
  changed();
  pumpJobs(); // a pre-render at the old tempo stops now
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
  { id: 'stutter', label: 'Stutter', desc: 'Repeats the last sliver of the beat in a rapid loop' },
  { id: 'lowpass', label: 'Low-pass', desc: 'Muffled and underwater: only the bass and kick' },
  { id: 'highpass', label: 'High-pass', desc: 'Thin and sizzling: the bass sweeps away' },
  { id: 'phaser', label: 'Phaser', desc: 'A jet-engine swoosh through the melodies' },
  { id: 'wah', label: 'Wah', desc: 'A resonant band sweeping up and down on the beat' },
  { id: 'tapestop', label: 'Tape stop', desc: 'Slows to a halt like a vinyl brake' },
];
// Each effect's two settings: 'steps' are musical lengths and rates (so the effect stays on the
// beat), 'range' is a slider from min to max. The defaults are the effects as they always were,
// except Stutter's: it used to repeat eighth notes with a third of each one silent, which sounded
// spaced out, so it now follows the tempo (Auto) and sounds for 90% of each repeat.
const steps = (id, label, value, options) => ({ id, label, kind: 'steps', value, options: options.map(([l, v]) => ({ label: l, value: v })) });
const range = (id, label, value, min, max) => ({ id, label, kind: 'range', value, min, max, step: (max - min) / 100 });
export const FX_PARAMS = {
  // len: repeats per bar (8 = an eighth note), 0 for Auto (see stutterPerBar); gate: how much of each repeat sounds
  stutter: [steps('len', 'Length', 0, [['Auto', 0], ['1/4', 4], ['1/8', 8], ['1/16', 16], ['1/32', 32]]), range('gate', 'Gate', 0.9, 0.25, 0.95)],
  // depth: how far the sweep goes (1 = down to 260 Hz / up to 2.4 kHz); res: the filter's Q
  lowpass: [range('depth', 'Depth', 1, 0, 1), range('res', 'Resonance', 5, 0.7, 12)],
  highpass: [range('depth', 'Depth', 1, 0, 1), range('res', 'Resonance', 4, 0.7, 12)],
  // speed: sweeps per bar; mix: how much of the phased sound against the dry mix
  phaser: [steps('speed', 'Speed', 0.5, [['4 bars', 0.25], ['2 bars', 0.5], ['1 bar', 1], ['½ bar', 2]]), range('mix', 'Depth', 1, 0.2, 1)],
  // speed: sweeps per bar (4 = once a beat); depth: cents either side of the centre
  wah: [steps('speed', 'Speed', 4, [['1 bar', 1], ['½ bar', 2], ['Beat', 4], ['½ beat', 8]]), range('depth', 'Depth', 1500, 400, 2400)],
  // len: the brake's length in bars; amount: how far it slows (1 = to a halt)
  tapestop: [steps('len', 'Length', 0.5, [['1 beat', 0.25], ['2 beats', 0.5], ['1 bar', 1]]), range('amount', 'Amount', 1, 0.3, 1)],
};
const fxSet = Object.fromEntries(Object.entries(FX_PARAMS).map(([id, ps]) => [id, Object.fromEntries(ps.map((p) => [p.id, p.value]))]));
export const fxParam = (id, key) => fxSet[id][key];
let fxOn = null; // { id, ...state the release needs }
const playingLayers = () => activeLayers().filter((id) => state.layers[id].source && state.layers[id].buffer);

// Tape stop's brake: full speed at t, down to `floor` (a halt by default) `len` later. A source
// started during the hold gets the same curve, so it joins at the speed the others have reached.
// `from` is when the source starts, if after t: its curve is set from there, at the speed the
// curve has reached then. Set from t, Chromium starts such a source's ramp at its own start, at
// full speed (measured: a source started 0.4 s into a 1 s brake ran at 0.92x over its first
// 0.1 s, not 0.55x).
const HALT = 0.0001;
function slowToHalt(rate, t, len, floor = HALT, from = t) {
  const at = Math.max(t, from), k = Math.min(1, (at - t) / len);
  rate.cancelScheduledValues(t);
  rate.setValueAtTime(1 - k * (1 - floor), at);
  if (k < 1) rate.linearRampToValueAtTime(floor, t + len);
}
// How far behind the clock a braked source is, d s into the brake: the rate falls in a straight
// line to `floor` over len (so (1 - floor)·d²/2len), then stays there.
function brakeLag(d, len, floor = HALT) {
  const k = 1 - floor;
  return d <= len ? k * d * d / (2 * len) : k * (len / 2 + d - len);
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
// `speed` cycles per bar (once a beat by default), starting where that cycle is at t, so it
// stays locked to the beat when it restarts with new settings.
const startWah = (t) => {
  const { speed, depth } = fxSet.wah;
  startSweep('wah', [wah.detune], depth, speed, cyclePos(speed, t), t);
};
// Where Low-pass and High-pass sweep to, in cents from rest: Depth 1 is the full sweep, 0 a
// gentle one (about 3.7 kHz and 200 Hz).
const lpCents = () => cents(22000, 260) * (0.4 + 0.6 * fxSet.lowpass.depth);
const hpCents = () => cents(10, 2400) * (0.55 + 0.45 * fxSet.highpass.depth);
// Phaser's Depth sets the wet/dry balance; at 1 it's the measured, level-matched mix.
const phaserMix = () => {
  const m = fxSet.phaser.mix;
  return { wet: PHASER.wet * m, dry: 1 - (1 - PHASER.dry) * m };
};

// Stutter's beat repeat: from the next grid line (a 1/16, or a 1/32 for 1/32 repeats), loop the
// repeat-length slice that played just before it, gated so each repeat is chopped. The real
// sources keep running underneath, muted at the layer's FX insert (see fxStart). Returns the
// repeats. On whole samples like the rest of the transport (see frame): a repeat read from
// between samples would sound duller than the music it stands in for. With the same lead as a
// swap (see LEAD): a repeat that starts late is out of step with its own gate.
// Repeats started again during the hold (a new Length, a new tempo: see restartRepeats) start no
// earlier than `after` and loop a slice that ends where the press caught the music (fxOn.end, in
// bars), so the stutter keeps its sound and only changes speed.
// Auto Length: the power-of-two split of the beat whose repeats come nearest 8 a second, nearest
// as the ear hears rates (on a log scale): 2^round(log2(480 / BPM)) repeats a beat. That is 32nds
// below 84.85 BPM (10.7-11.2 a second at 80-84) and 16ths from there to 169.7 BPM (5.7-9.3 a
// second at 85-140).
const stutterPerBar = () => fxSet.stutter.len || 4 * 2 ** Math.round(Math.log2(480 / clockBpm));
// The gate's 4 ms attack starts on the slice's first sample, where the loop has just wrapped, and
// its 6 ms release ends at least 2 ms before the slice does: the jump at the wrap is never heard.
const GATE = { attack: 0.004, release: 0.006, closed: 0.002 };
// Slices k0 to k1 - 1 of a repeat's gate, at the current Gate setting.
function gateSlices(param, t0, slice, k0, k1) {
  const shut = Math.max(GATE.attack, Math.min(slice * fxSet.stutter.gate, slice - GATE.closed - GATE.release));
  for (let k = k0; k < k1; k++) {
    const a = t0 + k * slice;
    param.setValueAtTime(0, a);
    param.linearRampToValueAtTime(1, a + GATE.attack);
    param.setValueAtTime(1, a + shut);
    param.linearRampToValueAtTime(0, a + shut + GATE.release);
  }
}
function startRepeats(after = 0) {
  const perBar = stutterPerBar(), bar = barSec(), sr = ctx.sampleRate;
  const sliceF = Math.round(bar / perBar * sr), slice = sliceF / sr;
  const from0 = Math.max(after, ctx.currentTime + Math.max(0.03, LEAD - XFADE));
  // The grid in exact fractions of the bar, counted from the latest bar line: counted in the
  // repeat's whole-sample length instead, each line was up to half a sample off, and after a few
  // minutes at one tempo the cut-in was 15-45 ms off the beat (the music's own lines don't move).
  const n = Math.max(16, perBar), k = Math.ceil((from0 - state.transportStart) * n / bar), b = Math.floor(k / n);
  const t0 = frame(state.transportStart + b * bar + (k - b * n) * bar / n);
  fxOn.end ??= (t0 - state.transportStart) / bar;
  const slices = 12 * perBar; // up to 12 bars of repeats; released long before that
  const repeats = [];
  for (const lid of activeLayers()) {
    const s = state.layers[lid];
    const buffer = bufferAt(s, t0); // what is heard then: the outgoing stem if a swap is pending
    if (!buffer) continue;
    const len = buffer.length, f = Math.round(fxOn.end * bar * sr);
    const atF = ((f % len) + len) % len;
    const from = Math.min(Math.max(0, atF - sliceF), len - sliceF) / sr;
    const gate = ctx.createGain(), fade = ctx.createGain();
    gate.gain.setValueAtTime(0, ctx.currentTime);
    gateSlices(gate.gain, t0, slice, 0, slices);
    tracked(fade.gain, 1); // the gate's schedule stays as it is; letting go fades this one out
    const src = ctx.createBufferSource();
    src.buffer = buffer; src.loop = true; src.loopStart = from; src.loopEnd = from + slice;
    const trim = trimNode(ctx, buffer); // at the level the stem was playing
    src.connect(trim); trim.connect(gate); gate.connect(fade);
    fade.connect(s.gain); // past the FX insert, which mutes the real sources
    src.start(t0, from);
    repeats.push({ lid, src, gate, fade, trim, t0, slice, slices, perBar });
  }
  return { repeats, t0 };
}

// Fades repeats out over [t, t + len]. On a gain of their own, not the gate: freezing the gate's
// schedule (cancelAndHoldAtTime) between two of its events made Chromium jump from full level to
// a quarter in one sample (measured on 5 of 12 releases before), and Firefox has no such call.
function stopRepeats(repeats, t, len = 0.01) {
  for (const r of repeats) {
    if (r.until <= t + len) continue; // fading out by then already
    const { src, gate, fade, trim } = r;
    rampTracked(fade.gain, t, t + len, 0);
    r.until = t + len;
    try { src.stop(t + len + 0.02); } catch (_) { /* already stopped */ }
    src.onended = () => { src.disconnect(); trim.disconnect(); gate.disconnect(); fade.disconnect(); };
  }
}
// The repeats still sounding at t: the held Stutter's, and old ones still handing over to them.
const repeatsAt = (t) => [...fxOn.repeats, ...(fxOn.leaving || []).filter((r) => r.until > t)];

// New repeats from the next grid line on or after `after` (a new Length, or the new tempo once the
// layers restart at it); the old ones play on until then and hand over like a press does: out over
// the 4 ms before the new ones start, which come in over their own 4 ms attack. Old ones from a
// restart just before (two quick Length clicks) go by then too, so no two lengths play at once.
function restartRepeats(after) {
  const next = startRepeats(after);
  stopRepeats(repeatsAt(next.t0), next.t0 - GATE.attack, GATE.attack);
  fxOn.leaving = [...(fxOn.leaving || []), ...fxOn.repeats].filter((r) => r.until > ctx.currentTime);
  fxOn.repeats = next.repeats;
}

// A new Gate from each repeat's next slice that can still be rescheduled: the slices keep their
// place, so a Gate drag doesn't restart them. The gate is shut at a slice's start (its release
// ended earlier), so dropping the events from there on leaves no ramp cut in half.
function regate(repeats) {
  const from = soonest() + 0.002;
  for (const r of repeats) {
    const k = Math.max(0, Math.ceil((from - r.t0) / r.slice));
    if (k >= r.slices) continue;
    r.gate.gain.cancelScheduledValues(r.t0 + k * r.slice);
    gateSlices(r.gate.gain, r.t0, r.slice, k, r.slices);
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
  fxOn = { id, t };
  if (id === 'lowpass') { // sweeps down while held (to 260 Hz at full Depth), so a longer hold goes deeper
    rampTracked(lp.detune, t, t + 1.6, lpCents());
    rampTracked(lp.Q, t, t + 0.4, fxSet.lowpass.res);
  } else if (id === 'highpass') { // up to 2.4 kHz at full Depth
    rampTracked(hp.detune, t, t + 1.6, hpCents());
    rampTracked(hp.Q, t, t + 0.4, fxSet.highpass.res);
  } else if (id === 'phaser') {
    // The stages rest at the bottom of the sweep; the LFO starts at its trough, so it lifts them
    // from exactly there (cos, offset by half the range): every press is the same rising swoosh.
    const half = PHASER.range / 2, { wet, dry } = phaserMix();
    for (const f of phaser) { f.detune.cancelScheduledValues(t); f.detune.setValueAtTime(half, t); }
    startSweep('phaser', phaser.map((f) => f.detune), -half, fxSet.phaser.speed, 0, t);
    rampTracked(phWet.gain, t, t + 0.08, wet);
    rampTracked(fxDry.gain, t, t + 0.08, dry);
  } else if (id === 'wah') {
    startWah(t);
    rampTracked(wahWet.gain, t, t + 0.05, WAH.wet);
    rampTracked(fxDry.gain, t, t + 0.05, WAH.dry);
  } else if (id === 'stutter' && state.playing) {
    // The repeats stand in for the real sources, which are muted at the layer's FX insert (so a
    // swap landing during the hold stays muted too); letting go lands back exactly in time.
    const { repeats, t0 } = startRepeats();
    fxOn.repeats = repeats;
    // Every layer, so one leaving or joining during the hold stays quiet too.
    for (const l of LAYERS) rampTracked(state.layers[l.id].fxIn.gain, t0 - GATE.attack, t0, 0);
  } else if (id === 'tapestop' && state.playing) {
    // Slow every source down (outgoing and pending ones too); letting go restarts them in sync
    // with the clock. At full Amount it's a halt, and the layers fade out at the end of it.
    const { len, amount } = fxSet.tapestop;
    fxOn.len = barSec() * len; // in beats or bars, so it lands like a played break at any tempo
    fxOn.floor = Math.max(0.0001, 1 - amount);
    fxOn.layers = playingLayers();
    for (const l of LAYERS) {
      const s = state.layers[l.id];
      // A swap waiting for its bar line was set to start where the clock will be, ahead of the
      // braked source it takes over from: scheduled again, it starts where that one will be (see
      // startSource). One too close to start again safely (see soonest) is left: it starts at most
      // 0.25 ms ahead on a desktop.
      if (s.source && s.startAt > soonest()) {
        const { buffer } = s.source, when = s.startAt + XFADE;
        s.source.stop(); // before its start: it never sounds
        s.source = null;
        startSource(l.id, when, when - state.transportStart, buffer);
      }
      for (const x of sourcesOf(s)) slowToHalt(x.src.playbackRate, t, fxOn.len, fxOn.floor, x.startAt);
      if (amount >= 0.95) rampTracked(s.fxIn.gain, t + 0.7 * fxOn.len, t + fxOn.len, 0);
    }
  }
}

// Changes one of an effect's settings (see FX_PARAMS). Held, the effect follows at once: the
// filters glide to their new depth or resonance, Phaser and Wah change speed or depth on the beat,
// Stutter starts repeating the new length from the next grid line (see restartRepeats) and takes a
// new Gate from its next repeat. Tape stop's brake is already under way, so its settings take
// effect at the next press.
export function setFxParam(id, key, value) {
  const p = FX_PARAMS[id] && FX_PARAMS[id].find((q) => q.id === key);
  if (!p || !(p.kind === 'steps' ? p.options.some((o) => o.value === value) : value >= p.min && value <= p.max)) return;
  fxSet[id][key] = value;
  if (!ctx || !fxOn || fxOn.id !== id) return;
  const t = ctx.currentTime + 0.005;
  if (id === 'lowpass' || id === 'highpass') {
    const f = id === 'lowpass' ? lp : hp;
    // the depth keeps to the press's sweep if that's still going, so a hold still goes deeper
    if (key === 'depth') rampTracked(f.detune, t, Math.max(t + 0.15, fxOn.t + 1.6), id === 'lowpass' ? lpCents() : hpCents());
    else rampTracked(f.Q, t, t + 0.08, value);
  } else if (id === 'phaser') {
    if (key === 'speed' && sweeps.phaser) {
      sweeps.phaser.perBar = value;
      sweeps.phaser.osc.frequency.setValueAtTime(value / barSec(), t);
    } else if (key === 'mix') {
      const { wet, dry } = phaserMix();
      rampTracked(phWet.gain, t, t + 0.08, wet);
      rampTracked(fxDry.gain, t, t + 0.08, dry);
    }
  } else if (id === 'wah') {
    startWah(t);
  } else if (id === 'stutter' && fxOn.repeats) {
    if (key === 'gate') regate(fxOn.repeats);
    else if (fxOn.repeats.some((r) => r.perBar !== stutterPerBar())) restartRepeats(); // Auto may already be that length
  }
}

// Letting go. With { cancel: true } (Stop pressed while held) nothing is restarted.
export function fxStop({ cancel = false } = {}) {
  if (!ctx || !fxOn) return;
  const { id } = fxOn, t = ctx.currentTime + 0.005;
  // Songs picked during the hold drop in as it lets go (see dropHeld): the layers of a group
  // that's ready, waiting only for the release.
  // At a new tempo they land with the restart instead (see resyncOnce), which may come a bar later
  // if the other layers aren't rendered yet: until then the old songs play on, so none drops out.
  const dropping = new Set(clockBpm !== state.bpm ? [] : heldGroups().filter((g) => g.waiting.size === 1).flatMap((g) => [...g.ready]));
  let dropAt = frame(ctx.currentTime + LEAD);
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
    stopRepeats(repeatsAt(t), t);
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
      // The new picks come in with the restarts instead of their layers' old songs.
      const when = Math.max(at + 0.04, ctx.currentTime + LEAD); // as soon as a restart can't come in late
      for (const [lid, buffer] of back) if (!dropping.has(lid)) startSource(lid, when, when - state.transportStart, buffer);
      dropAt = frame(when);
    }
  }
  fxOn = null;
  for (const l of LAYERS) state.layers[l.id].heldFrom = undefined;
  dropHeld(dropAt);
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

async function encodeWav(channels, sampleRate) {
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
  // In steps (see inSteps): in one go it held the page for 100-140 ms on a desktop.
  await inSteps(len, toWav, 44, channels, v);
  return new Blob([buf], { type: 'audio/wav' });
}
// Frames [from, to) at byte o, interleaved; returns where the next frame goes.
function toWav(from, to, o, channels, v) {
  for (let i = from; i < to; i++) {
    for (let c = 0; c < channels.length; c++) {
      const x = Math.floor(channels[c][i] * 0x7fff + Math.random() - Math.random() + 0.5);
      v.setInt16(o, Math.max(-0x8000, Math.min(0x7fff, x)), true);
      o += 2;
    }
  }
  return o;
}
