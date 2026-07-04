// @ts-check
/**
 * Bootstrap: mounts the HUD, starts the idle visualizer, unlocks the audio
 * engine on the first user gesture, and orchestrates the library ↔ wheel ↔
 * deck flows.
 */

import './app.css';
import { mountHud } from './ui/hud.js';
import { showToast } from './ui/toasts.js';
import { SLOTS_PER_PAGE } from './ui/wheel.js';
import { createVisualizer } from './visualizer/visualizer.js';
import { createBeatDetector } from './visualizer/beat.js';
import { onTick, setSuspended } from './ticker.js';
import { createEngine } from './audio/engine.js';
import { Deck } from './audio/deck.js';
import { createCrossfader } from './audio/crossfader.js';
import { createFx } from './audio/fx.js';
import { Transport, createMetronome } from './audio/transport.js';
import { DEMO_TRACKS, renderDemoLoop, audioBufferToWavBlob } from './audio/demoLoops.js';
import { getAllTracks, getTrack, putTrack, deleteTrack, clearLibrary } from './library/store.js';
import { initIntake } from './library/intake.js';
import { createHelp } from './ui/help.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('visualizer'));

const visualizer = createVisualizer(canvas);
visualizer.start();

/** @type {import('./audio/engine.js').Engine | null} */
let engine = null;
/** @type {{ a: Deck, b: Deck } | null} */
let decks = null;
/** @type {ReturnType<typeof createCrossfader> | null} */
let crossfader = null;
/** @type {ReturnType<typeof createFx> | null} */
let fx = null;
/** @type {Transport | null} */
let transport = null;
/** @type {ReturnType<typeof createMetronome> | null} */
let metronome = null;

/** @type {import('./library/store.js').TrackRecord[]} */
let library = [];
let page = 0;

/** @param {'a' | 'b'} id */
const deck = (id) => (decks ? decks[id] : null);
/** @param {'a' | 'b'} id */
const card = (id) => (id === 'a' ? hud.deckA : hud.deckB);

// ---------- HUD ----------

const hud = mountHud(app, {
  onCrossfade: (x) => {
    visualizer.setPalette(x);
    updateActiveDecks(x);
    crossfader?.set(x);
  },
  onTempo: (rate) => {
    // One global tempo control drives both decks (beginner-friendly).
    deck('a')?.setRate(rate);
    deck('b')?.setRate(rate);
  },
  onFxHold: (held) => {
    fx?.setHeld(held);
  },
  deckA: deckCardHandlers('a'),
  deckB: deckCardHandlers('b'),
  wheel: {
    onSelect: (slot) => {
      // Queue onto the deck the listener is NOT hearing so beginners never
      // cut off their own music.
      const target = crossfader ? crossfader.inactiveDeck : 'b';
      loadTrackToDeck(slot.id, target);
    },
    onLoadTo: (slot, deckId) => loadTrackToDeck(slot.id, deckId),
    onRemove: (slot) => removeTrack(slot.id),
    onPage: (delta) => {
      page += delta;
      refreshWheel();
    },
    onAddTracks: () => intake.openPicker(),
  },
});

/** @param {'a' | 'b'} id */
function deckCardHandlers(id) {
  return {
    onPlayPause: () => {
      const d = deck(id);
      if (!d || !d.buffer) return;
      if (d.playing) d.pause();
      else d.play();
      card(id).setPlaying(d.playing);
    },
    onMute: () => {
      const d = deck(id);
      if (!d) return;
      d.setMuted(!d.muted);
      card(id).setMuted(d.muted);
    },
    onEject: () => {
      const d = deck(id);
      if (!d || !d.track) return;
      d.eject();
      card(id).setTrack(null);
      card(id).setPlaying(false);
    },
    onSeek: (/** @type {number} */ fraction) => {
      const d = deck(id);
      if (!d || !d.buffer) return;
      d.seekFraction(fraction);
    },
    onSeekBy: (/** @type {number} */ delta) => {
      const d = deck(id);
      if (!d || !d.buffer || !d.duration) return;
      d.seekFraction(Math.min(Math.max(d.position / d.duration + delta, 0), 0.999));
    },
  };
}

/** @param {number} x crossfader position */
function updateActiveDecks(x) {
  hud.deckA.setActive(x <= 0.5);
  hud.deckB.setActive(x >= 0.5);
}
updateActiveDecks(0.5);

// ---------- per-frame UI sync ----------

onTick((dt) => {
  if (!decks) return;
  for (const id of /** @type {const} */ (['a', 'b'])) {
    const d = decks[id];
    const c = card(id);
    if (!d.buffer) continue;
    c.setTime(d.position, d.duration);
    c.waveform.setProgress(d.duration ? d.position / d.duration : 0);
    c.waveform.render();
  }
  updateAudioLevels(dt);
});

// ---------- analyser → visualizer ----------

const beatDetector = createBeatDetector();
/** @type {Uint8Array | null} */
let freqData = null;
let wasAudible = false;

/** @param {number} dt */
function updateAudioLevels(dt) {
  if (!engine || !decks) return;
  const audible = decks.a.playing || decks.b.playing;
  if (!audible) {
    if (wasAudible) {
      visualizer.setLevels({ low: 0, mid: 0, high: 0 });
      beatDetector.reset();
      wasAudible = false;
    }
    return;
  }
  wasAudible = true;

  const analyser = engine.analyser;
  if (!freqData) freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);

  const binHz = engine.ctx.sampleRate / analyser.fftSize;
  const band = (/** @type {number} */ from, /** @type {number} */ to) => {
    const i0 = Math.max(1, Math.floor(from / binHz));
    const i1 = Math.min(freqData.length - 1, Math.ceil(to / binHz));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += freqData[i];
    return sum / ((i1 - i0 + 1) * 255);
  };

  const low = band(30, 250);
  visualizer.setLevels({ low, mid: band(250, 2000), high: band(2000, 9000) });
  if (beatDetector.update(low, dt)) visualizer.onBeat();
}

// ---------- library ----------

const intake = initIntake({
  getAudioContext: async () => {
    await unlock();
    if (!engine) throw new Error('Audio engine is unavailable.');
    return engine.ctx;
  },
  onTrackAdded: (record) => {
    library.push(record);
    page = Math.floor((library.length - 1) / SLOTS_PER_PAGE);
    refreshWheel();
  },
});

function refreshWheel() {
  const pageCount = Math.max(1, Math.ceil(library.length / SLOTS_PER_PAGE));
  page = Math.min(Math.max(page, 0), pageCount - 1);
  const view = library.slice(page * SLOTS_PER_PAGE, (page + 1) * SLOTS_PER_PAGE);
  hud.wheel.setSlots(view.map((r) => ({ id: r.id, title: r.title, color: r.color })));
  hud.wheel.setPage(page, pageCount);
}

/** Render (or reuse cached) demo loops so the app is playable with no uploads. */
async function ensureDemoTracks() {
  for (const demo of DEMO_TRACKS) {
    const existing = await getTrack(demo.id).catch(() => undefined);
    if (existing) continue;
    const buffer = await renderDemoLoop(demo.id);
    await putTrack({
      id: demo.id,
      title: demo.title,
      artist: demo.artist,
      type: 'audio/wav',
      size: 0,
      duration: buffer.duration,
      color: demo.color,
      demo: true,
      loop: true,
      addedAt: 0,
      blob: audioBufferToWavBlob(buffer),
    });
  }
}

/**
 * Decode a library track and load it onto a deck. If that deck was playing,
 * the new track keeps playing; otherwise it loads paused.
 * @param {string} trackId
 * @param {'a' | 'b'} deckId
 * @param {{ autoplay?: boolean }} [opts]
 */
async function loadTrackToDeck(trackId, deckId, opts = {}) {
  const d = deck(deckId);
  if (!d || !engine) return;
  const record = library.find((r) => r.id === trackId) ?? (await getTrack(trackId));
  if (!record) {
    showToast('That track is no longer in the library.', { type: 'error' });
    return;
  }
  try {
    const bytes = await record.blob.arrayBuffer();
    const buffer = await engine.ctx.decodeAudioData(bytes.slice(0));
    const autoplay = opts.autoplay ?? d.playing;
    d.load(buffer, { id: record.id, title: record.title, artist: record.artist }, {
      loop: record.loop,
      autoplay,
    });
    d.setRate(hud.tempo.rate);
    const c = card(deckId);
    c.setTrack({ title: record.title, artist: record.artist });
    c.waveform.setBuffer(buffer);
    c.setPlaying(d.playing);
    c.setMuted(d.muted);
    c.setTime(d.position, d.duration);
    hud.wheel.setSelected(record.id);
    showToast(`“${record.title}” → Deck ${deckId.toUpperCase()}${autoplay ? '' : ' — press play when ready'}.`);
  } catch (err) {
    console.error(err);
    showToast(`Couldn't load “${record.title}” — try re-adding the file.`, { type: 'error' });
  }
}

/** Remove a track from the library (demo loops can't be removed). @param {string} trackId */
async function removeTrack(trackId) {
  const record = library.find((r) => r.id === trackId);
  if (!record) return;
  if (record.demo) {
    showToast('The demo loops are built in — they stay on the wheel.');
    return;
  }
  try {
    await deleteTrack(trackId);
    library = library.filter((r) => r.id !== trackId);
    refreshWheel();
    showToast(`Removed “${record.title}” from the library.`, { type: 'success' });
  } catch (err) {
    console.error(err);
    showToast('Could not remove that track — try again.', { type: 'error' });
  }
}

// ---------- help overlay ----------

createHelp(app, {
  onClearLibrary: async () => {
    try {
      await clearLibrary();
      library = library.filter((r) => r.demo);
      page = 0;
      refreshWheel();
      showToast('Library cleared — demo loops kept.', { type: 'success' });
    } catch (err) {
      console.error(err);
      showToast('Could not clear the library — try again.', { type: 'error' });
    }
  },
});

/**
 * TEMPORARY (Phase 1): a metronome toggle in the top-left cluster so the
 * transport grid is audible. Removed when the jam rack lands.
 */
function mountMetronomeButton() {
  const top = hud.hud.querySelector('.hud-top');
  if (!top || !transport || !metronome) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fx-btn metro-btn';
  btn.setAttribute('aria-pressed', 'false');
  const render = () => {
    btn.innerHTML = `Metronome<small>${metronome?.enabled ? `on — ${transport?.bpm} BPM` : 'temp · Phase 1'}</small>`;
  };
  render();
  btn.addEventListener('click', () => {
    if (!metronome || !transport) return;
    const on = metronome.toggle();
    if (!on && transport.isPlaying) transport.stop();
    btn.classList.toggle('is-held', on);
    btn.setAttribute('aria-pressed', String(on));
    render();
  });
  transport.on('gridChanged', render);
  top.append(btn);
}

// ---------- audio unlock ----------

const overlay = document.createElement('div');
overlay.className = 'unlock-overlay';
overlay.innerHTML = `
  <button type="button" class="unlock-overlay__btn">
    <span class="unlock-overlay__title">Random <em>Access</em> Jam</span>
    <span class="unlock-overlay__hint">Tap anywhere to power up the decks</span>
  </button>`;
document.body.append(overlay);

/** @type {Promise<void> | null} */
let unlockPromise = null;

function unlock() {
  if (!unlockPromise) {
    unlockPromise = doUnlock().catch((err) => {
      unlockPromise = null;
      engine = null;
      decks = null;
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Audio could not start.', { type: 'error' });
      throw err;
    });
  }
  return unlockPromise;
}

async function doUnlock() {
  engine = createEngine();
  await engine.resume();

  decks = {
    a: new Deck(engine.ctx, engine.xfA, 'a'),
    b: new Deck(engine.ctx, engine.xfB, 'b'),
  };
  for (const id of /** @type {const} */ (['a', 'b'])) {
    decks[id].onEnded = () => card(id).setPlaying(false);
  }
  fx = createFx(engine);
  crossfader = createCrossfader(engine);
  crossfader.set(hud.crossfader.value);

  // Phase 1: master transport clock + temporary metronome proof.
  transport = new Transport(engine.ctx);
  metronome = createMetronome(engine.ctx, transport, engine.master);
  mountMetronomeButton();
  // Console access for grid experiments: __raj.transport.setBpm(140) etc.
  /** @type {any} */ (window).__raj = { transport, metronome, engine };

  overlay.classList.add('is-hidden');
  setTimeout(() => overlay.remove(), 400);

  await ensureDemoTracks();
  library = await getAllTracks();
  refreshWheel();

  // Auto-load the first two tracks (the demos on first run) onto the decks.
  if (library[0]) await loadTrackToDeck(library[0].id, 'a', { autoplay: false });
  if (library[1]) await loadTrackToDeck(library[1].id, 'b', { autoplay: false });
  showToast('Decks loaded — press play, then ride the crossfader.', { type: 'success' });
}

overlay.addEventListener('pointerdown', () => unlock().catch(() => {}));
overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') unlock().catch(() => {});
});

// ---------- global keys + tab visibility ----------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return; // a control (waveform, wheel, …) already handled it
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') {
    hud.crossfader.nudge(-0.05);
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    hud.crossfader.nudge(0.05);
    e.preventDefault();
  } else if (e.key === ' ' && !e.repeat && !target.closest('button, [role="option"], [role="button"]')) {
    // Space anywhere (except on a focused control that handles it) = FX hold.
    hud.fx.setHeld(true);
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ') hud.fx.setHeld(false);
});

document.addEventListener('visibilitychange', () => {
  const anyPlaying = Boolean(decks && (decks.a.playing || decks.b.playing));
  // Suspend all animation when the tab is hidden and nothing is playing.
  setSuspended(document.hidden && !anyPlaying);
});

// ---------- PWA service worker (no-op in dev) ----------

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {
      // Offline support is progressive enhancement — the app runs without it.
    });
}
