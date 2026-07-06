// @ts-check
/**
 * Bootstrap: mounts the HUD, starts the idle visualizer, unlocks the audio
 * engine on the first user gesture, and orchestrates the library ↔ wheel ↔
 * jam-rack flows. The core model is a 4-position rack (vocals/drums/bass/
 * lead) — every position plays together, conformed to one master BPM + key.
 */

import './app.css';
import { mountHud } from './ui/hud.js';
import { showToast } from './ui/toasts.js';
import { SLOTS_PER_PAGE } from './ui/wheel.js';
import { createHelp } from './ui/help.js';
import { createVisualizer } from './visualizer/visualizer.js';
import { createBeatDetector } from './visualizer/beat.js';
import { onTick, setSuspended } from './ticker.js';
import { createEngine } from './audio/engine.js';
import { createFx } from './audio/fx.js';
import { createMastering } from './audio/mastering.js';
import { Transport, createMetronome } from './audio/transport.js';
import { JamRack, ROLES } from './audio/jamRack.js';
import { DEMO_TRACKS, renderDemoStem, audioBufferToWavBlob } from './audio/demoLoops.js';
import { getAllTracks, getTrack, putTrack, deleteTrack, clearLibrary } from './library/store.js';
import { initIntake } from './library/intake.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('visualizer'));

const visualizer = createVisualizer(canvas);
visualizer.start();

// ---------- state ----------

/** @type {import('./audio/engine.js').Engine | null} */
let engine = null;
/** @type {Transport | null} */
let transport = null;
/** @type {JamRack | null} */
let rack = null;
/** @type {ReturnType<typeof createFx> | null} */
let fx = null;
/** @type {ReturnType<typeof createMastering> | null} */
let mastering = null;

/** Master musical key the whole rack conforms to. */
let masterKey = 'A minor';
/**
 * What each rack position is sourced from (for re-conforms on grid changes).
 * @type {Partial<Record<import('./audio/jamRack.js').Role, { record: import('./library/store.js').TrackRecord, raw: AudioBuffer }>>}
 */
const rackSources = {};
/** Conformed-buffer cache: `${trackId}:${role}:${bpm}:${keyPc}` → AudioBuffer */
const conformCache = new Map();

/** @type {import('./library/store.js').TrackRecord[]} */
let library = [];
let page = 0;
/** @type {import('./audio/jamRack.js').Role} */
let focusedRole = 'vocals';

// ---------- HUD ----------

const hud = mountHud(app, {
  onFxHold: (held) => fx?.setHeld(held),
  strip: {
    onPlayStop: () => {
      if (!transport) return;
      if (transport.isPlaying) transport.stop();
      else transport.start();
      syncTransportUi();
    },
    onBpm: (bpm) => {
      transport?.setBpm(bpm);
    },
    onKey: (key) => setMasterKey(key),
  },
  rack: (role) => ({
    onPick: (trackId) => {
      if (!trackId) {
        rack?.clearPosition(role);
        delete rackSources[role];
        return;
      }
      const record = library.find((r) => r.id === trackId);
      if (record) assignToRack(record, role);
    },
    onMute: (muted) => {
      rack?.mute(role, muted);
      refreshRackCards();
    },
    onSolo: (soloed) => {
      rack?.solo(role, soloed);
      refreshRackCards();
    },
    onVolume: (volume) => rack?.setVolume(role, volume),
    onFocusRequest: () => focusRole(role, { moveFocus: false }),
  }),
  wheel: {
    onSelect: (slot) => {
      const record = library.find((r) => r.id === slot.id);
      if (record) assignToRack(record, focusedRole);
    },
    onLoadTo: (slot, role) => {
      const record = library.find((r) => r.id === slot.id);
      if (record) assignToRack(record, role);
    },
    loadTargets: (slot) => {
      const record = library.find((r) => r.id === slot.id);
      return ROLES.map((role) => ({
        id: role,
        label: `Assign to ${role}`,
        disabled: !record?.stems[role],
      }));
    },
    onRemove: (slot) => removeTrack(slot.id),
    onPage: (delta) => {
      page += delta;
      refreshWheel();
    },
    onAddTracks: () => intake.openPicker(),
  },
});

/**
 * @param {import('./audio/jamRack.js').Role} role
 * @param {{ moveFocus?: boolean }} [opts]
 */
function focusRole(role, opts = {}) {
  focusedRole = role;
  for (const r of ROLES) hud.rackCards[r].setFocused(r === role);
  if (opts.moveFocus !== false) hud.rackCards[role].focus();
}
focusRole('vocals', { moveFocus: false });

function refreshRackCards() {
  if (!rack) return;
  for (const role of ROLES) hud.rackCards[role].update(rack.getPosition(role));
}

function refreshWheel() {
  const pageCount = Math.max(1, Math.ceil(library.length / SLOTS_PER_PAGE));
  page = Math.min(Math.max(page, 0), pageCount - 1);
  const view = library.slice(page * SLOTS_PER_PAGE, (page + 1) * SLOTS_PER_PAGE);
  hud.wheel.setSlots(view.map((r) => ({ id: r.id, title: r.title, color: r.color })));
  hud.wheel.setPage(page, pageCount);
}

function refreshPickers() {
  if (!rack) return;
  for (const role of ROLES) {
    hud.rackCards[role].setTracks(
      library.map((r) => ({ id: r.id, title: r.title, disabled: !r.stems[role] })),
      rack.getPosition(role).trackId
    );
  }
}

function syncTransportUi() {
  if (!transport) return;
  hud.strip.setPlaying(transport.isPlaying);
  hud.strip.setBpm(transport.bpm);
}

// ---------- per-frame UI sync (visuals only) ----------

onTick((dt) => {
  if (!rack || !transport) return;
  let anyAdjusting = false;
  for (const role of ROLES) {
    hud.rackCards[role].setLevel(rack.getLevel(role));
    if (rack.positions[role].adjusting) anyAdjusting = true;
  }
  hud.strip.setStatus(anyAdjusting ? 'adjusting' : transport.isPlaying ? 'playing' : 'stopped');
  updateAudioLevels(dt);
});

// ---------- analyser → visualizer ----------

const beatDetector = createBeatDetector();
/** @type {Uint8Array | null} */
let freqData = null;
let wasAudible = false;

/** @param {number} dt */
function updateAudioLevels(dt) {
  if (!engine || !transport) return;
  const audible = transport.isPlaying;
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
    const i1 = Math.min(/** @type {Uint8Array} */ (freqData).length - 1, Math.ceil(to / binHz));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += /** @type {Uint8Array} */ (freqData)[i];
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
    refreshPickers();
  },
  // Pre-fill BPM/key in the assign dialog (lazy-loaded, best-effort).
  analyze: async (file) => {
    const { analyzeFile } = await import('./audio/analyze.js');
    return analyzeFile(file);
  },
});

/** Render (or reuse cached) demo STEM SETS so the app is playable with no uploads. */
async function ensureDemoTracks() {
  for (const demo of DEMO_TRACKS) {
    const existing = await getTrack(demo.id).catch(() => undefined);
    if (existing?.stems) continue;
    /** @type {import('./library/store.js').TrackRecord['stems']} */
    const stems = {};
    for (const role of demo.roles) {
      const buffer = await renderDemoStem(demo.id, role);
      stems[role] = { blob: audioBufferToWavBlob(buffer) };
    }
    await putTrack({
      id: demo.id,
      title: demo.title,
      artist: demo.artist,
      sourceBpm: demo.sourceBpm,
      sourceKey: demo.sourceKey,
      bars: demo.bars,
      stems,
      color: demo.color,
      demo: true,
      addedAt: 0,
    });
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
    refreshPickers();
    showToast(`Removed “${record.title}” from the library.`, { type: 'success' });
  } catch (err) {
    console.error(err);
    showToast('Could not remove that track — try again.', { type: 'error' });
  }
}

// ---------- conform-to-grid pipeline ----------

/**
 * Conform one raw stem to the current master grid (BPM + key), cached.
 * @param {import('./library/store.js').TrackRecord} record
 * @param {import('./audio/jamRack.js').Role} role
 * @param {AudioBuffer} raw
 */
async function conform(record, role, raw) {
  if (!transport) throw new Error('Transport not ready.');
  // Lazy-load the stretch engine (vendored WASM) — keeps it off the critical path.
  const { renderToGrid, parseKey } = await import('./audio/timestretch.js');
  const cacheKey = `${record.id}:${role}:${transport.bpm}:${parseKey(masterKey).pc}`;
  const hit = conformCache.get(cacheKey);
  if (hit) return hit;
  const rendered = await renderToGrid(
    raw,
    record.sourceBpm,
    record.sourceKey,
    transport.bpm,
    masterKey,
    record.bars
  );
  // Keep the cache small — grid changes invalidate most entries anyway.
  if (conformCache.size > 24) conformCache.clear();
  conformCache.set(cacheKey, rendered);
  return rendered;
}

/**
 * Assign a track's stem to a rack position, conformed to the master grid.
 * @param {import('./library/store.js').TrackRecord} record
 * @param {import('./audio/jamRack.js').Role} role position AND stem role
 */
async function assignToRack(record, role) {
  if (!rack || !engine || !transport) return false;
  const stem = record.stems[role];
  if (!stem) {
    showToast(`“${record.title}” has no ${role} stem.`, { type: 'error' });
    return false;
  }
  try {
    rack.setAdjusting(role, true);
    const bytes = await stem.blob.arrayBuffer();
    const raw = await engine.ctx.decodeAudioData(bytes.slice(0));
    rackSources[role] = { record, raw };
    const conformed = await conform(record, role, raw);
    rack.assignPosition(role, { trackId: record.id, title: record.title, buffer: conformed });
    hud.wheel.setSelected(record.id);
    // First assignment starts the groove so beginners hear something instantly.
    if (!transport.isPlaying) {
      transport.start();
      syncTransportUi();
    }
    showToast(`“${record.title}” → ${role}.`);
    return true;
  } catch (err) {
    console.error(err);
    showToast(`Couldn't conform “${record.title}” (${role}) to the grid.`, { type: 'error' });
    return false;
  } finally {
    rack.setAdjusting(role, false);
  }
}

/**
 * Master grid changed (BPM or key): re-conform every assigned position and
 * swap buffers in on the next loop boundary — the brief "adjusting" moment.
 */
async function reconformRack() {
  if (!rack) return;
  await Promise.all(
    ROLES.map(async (role) => {
      const src = rackSources[role];
      if (!src || !rack) return;
      rack.setAdjusting(role, true);
      try {
        const conformed = await conform(src.record, role, src.raw);
        rack.queueBufferSwap(role, conformed);
      } catch (err) {
        console.error(err);
      } finally {
        rack?.setAdjusting(role, false);
      }
    })
  );
}

/** @param {string} key e.g. "D minor" */
function setMasterKey(key) {
  masterKey = key;
  hud.strip.setKey(key);
  reconformRack();
}

// ---------- help overlay ----------

createHelp(app, {
  onClearLibrary: async () => {
    try {
      await clearLibrary();
      library = library.filter((r) => r.demo);
      page = 0;
      refreshWheel();
      refreshPickers();
      showToast('Library cleared — demo loops kept.', { type: 'success' });
    } catch (err) {
      console.error(err);
      showToast('Could not clear the library — try again.', { type: 'error' });
    }
  },
  onToggleMastering: (enabled) => mastering?.setEnabled(enabled),
});

// ---------- audio unlock ----------

const overlay = document.createElement('div');
overlay.className = 'unlock-overlay';
overlay.innerHTML = `
  <button type="button" class="unlock-overlay__btn">
    <span class="unlock-overlay__title">Random <em>Access</em> Jam</span>
    <span class="unlock-overlay__hint">Tap anywhere to power up the rack</span>
  </button>`;
document.body.append(overlay);

/** @type {Promise<void> | null} */
let unlockPromise = null;

function unlock() {
  if (!unlockPromise) {
    unlockPromise = doUnlock().catch((err) => {
      unlockPromise = null;
      engine = null;
      rack = null;
      transport = null;
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

  transport = new Transport(engine.ctx);
  rack = new JamRack(engine.ctx, transport, engine.fxIn);
  fx = createFx(engine);
  mastering = createMastering(engine);

  rack.onPositionChanged = () => {
    refreshRackCards();
    refreshPickers();
  };
  transport.on('gridChanged', () => {
    syncTransportUi();
    reconformRack();
  });
  transport.on('stop', () => syncTransportUi());

  // Debug/console access (also hosts the Phase 1 metronome proof).
  /** @type {any} */ (window).__raj = {
    transport,
    rack,
    engine,
    ROLES,
    setMasterKey,
    metronome: createMetronome(engine.ctx, transport, engine.master),
    get mastering() {
      return mastering;
    },
  };

  overlay.classList.add('is-hidden');
  setTimeout(() => overlay.remove(), 400);

  await ensureDemoTracks();
  library = await getAllTracks();
  refreshWheel();
  refreshPickers();
  refreshRackCards();
  hud.strip.setKey(masterKey);
  syncTransportUi();

  // First-run magic: a cross-track mashup — Neon Causeway's drums + bass
  // under Midnight Reactor's lead — so the core idea is audible immediately.
  const neon = library.find((r) => r.id === 'demo-neon-causeway');
  const midnight = library.find((r) => r.id === 'demo-midnight-reactor');
  if (neon && midnight && ROLES.every((r) => !rack?.getPosition(r).trackId)) {
    await assignToRack(neon, 'drums');
    await assignToRack(neon, 'bass');
    await assignToRack(midnight, 'lead');
    showToast('Demo mashup loaded — two songs, one groove. Press ▶ to start/stop.', {
      type: 'success',
      duration: 6000,
    });
  }
}

overlay.addEventListener('pointerdown', () => unlock().catch(() => {}));
overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') unlock().catch(() => {});
});

// ---------- global keys + tab visibility ----------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return; // a control already handled it
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('input, textarea, select, [contenteditable]')) return;

  const roleByDigit = { 1: 'vocals', 2: 'drums', 3: 'bass', 4: 'lead' };
  if (e.key in roleByDigit) {
    focusRole(/** @type {any} */ (roleByDigit[/** @type {'1'} */ (e.key)]));
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'm':
    case 'M': {
      if (!rack) return;
      rack.mute(focusedRole, !rack.getPosition(focusedRole).muted);
      refreshRackCards();
      e.preventDefault();
      break;
    }
    case 's':
    case 'S': {
      if (!rack) return;
      rack.solo(focusedRole, !rack.getPosition(focusedRole).soloed);
      refreshRackCards();
      e.preventDefault();
      break;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!rack) return;
      const pos = rack.getPosition(focusedRole);
      const next = pos.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05);
      rack.setVolume(focusedRole, next);
      refreshRackCards();
      e.preventDefault();
      break;
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!transport) return;
      transport.setBpm(transport.bpm + (e.key === 'ArrowRight' ? 1 : -1));
      syncTransportUi();
      e.preventDefault();
      break;
    }
    case ' ': {
      if (e.repeat || target.closest('button, [role="option"], [role="button"]')) return;
      hud.fx.setHeld(true);
      e.preventDefault();
      break;
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ') hud.fx.setHeld(false);
});

document.addEventListener('visibilitychange', () => {
  // Suspend all animation when the tab is hidden and nothing is playing.
  setSuspended(document.hidden && !transport?.isPlaying);
});

// ---------- PWA service worker (no-op in dev) ----------

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {
      // Offline support is progressive enhancement — the app runs without it.
    });
}
