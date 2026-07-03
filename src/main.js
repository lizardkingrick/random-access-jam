// @ts-check
/**
 * Bootstrap: mounts the HUD, starts the idle visualizer, and unlocks the
 * audio engine on the first user gesture (browsers block autoplay).
 */

import './app.css';
import { mountHud } from './ui/hud.js';
import { showToast } from './ui/toasts.js';
import { createVisualizer } from './visualizer/visualizer.js';
import { onTick, setSuspended } from './ticker.js';
import { createEngine } from './audio/engine.js';
import { Deck } from './audio/deck.js';
import { DEMO_TRACKS, renderDemoLoop } from './audio/demoLoops.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('visualizer'));

const visualizer = createVisualizer(canvas);
visualizer.start();

/** @type {import('./audio/engine.js').Engine | null} */
let engine = null;
/** @type {{ a: Deck, b: Deck } | null} */
let decks = null;

/** @param {'a' | 'b'} id */
const deck = (id) => (decks ? decks[id] : null);
/** @param {'a' | 'b'} id */
const card = (id) => (id === 'a' ? hud.deckA : hud.deckB);

// ---------- HUD ----------

const hud = mountHud(app, {
  onCrossfade: (x) => {
    visualizer.setPalette(x);
    updateActiveDecks(x);
    // Audio-side equal-power fade is wired in the crossfader milestone.
  },
  onTempo: (rate) => {
    // One global tempo control drives both decks (beginner-friendly).
    deck('a')?.setRate(rate);
    deck('b')?.setRate(rate);
  },
  onFxHold: () => {
    // FX chain arrives in the crossfader + FX milestone.
  },
  deckA: deckCardHandlers('a'),
  deckB: deckCardHandlers('b'),
  wheel: {
    onSelect: (slot) => {
      hud.wheel.setSelected(slot.id);
      showToast(`Selected “${slot.title}” — wheel-to-deck loading arrives with the library.`);
    },
    onAddTracks: () => showToast('Track uploads arrive with the library milestone.'),
    onPage: () => {},
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
  };
}

/** @param {number} x crossfader position */
function updateActiveDecks(x) {
  hud.deckA.setActive(x <= 0.5);
  hud.deckB.setActive(x >= 0.5);
}
updateActiveDecks(0.5);

// ---------- per-frame UI sync ----------

onTick(() => {
  if (!decks) return;
  for (const id of /** @type {const} */ (['a', 'b'])) {
    const d = decks[id];
    const c = card(id);
    if (!d.buffer) continue;
    c.setTime(d.position, d.duration);
    c.waveform.setProgress(d.duration ? d.position / d.duration : 0);
    c.waveform.render();
  }
});

// ---------- audio unlock + demo loops ----------

const overlay = document.createElement('div');
overlay.className = 'unlock-overlay';
overlay.innerHTML = `
  <button type="button" class="unlock-overlay__btn">
    <span class="unlock-overlay__title">Random <em>Access</em> Jam</span>
    <span class="unlock-overlay__hint">Tap anywhere to power up the decks</span>
  </button>`;
document.body.append(overlay);

let unlocking = false;
async function unlock() {
  if (unlocking || engine) return;
  unlocking = true;
  try {
    engine = createEngine();
    await engine.resume();

    decks = {
      a: new Deck(engine.ctx, engine.xfA, 'a'),
      b: new Deck(engine.ctx, engine.xfB, 'b'),
    };
    for (const id of /** @type {const} */ (['a', 'b'])) {
      decks[id].onEnded = () => card(id).setPlaying(false);
    }

    overlay.classList.add('is-hidden');
    setTimeout(() => overlay.remove(), 400);

    await loadDemoLoops();
  } catch (err) {
    console.error(err);
    showToast(err instanceof Error ? err.message : 'Audio could not start.', { type: 'error' });
    unlocking = false;
    engine = null;
  }
}
overlay.addEventListener('pointerdown', unlock);
overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') unlock();
});

async function loadDemoLoops() {
  if (!decks) return;
  const [bufA, bufB] = await Promise.all(DEMO_TRACKS.map((t) => renderDemoLoop(t.id)));
  const [metaA, metaB] = DEMO_TRACKS;

  decks.a.load(bufA, metaA, { loop: true });
  decks.b.load(bufB, metaB, { loop: true });

  for (const id of /** @type {const} */ (['a', 'b'])) {
    const d = decks[id];
    const c = card(id);
    const meta = id === 'a' ? metaA : metaB;
    c.setTrack({ title: meta.title, artist: meta.artist });
    c.waveform.setBuffer(d.buffer);
    c.setPlaying(false);
    c.setMuted(false);
    c.setTime(0, d.duration);
  }

  hud.wheel.setSlots([
    ...DEMO_TRACKS.map((t) => ({ id: t.id, title: t.title, color: t.color })),
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  hud.wheel.setPage(0, 1);
  hud.wheel.setSelected(metaA.id);

  showToast('Demo loops ready — press play on a deck.', { type: 'success' });
}

// ---------- global keys + tab visibility ----------

document.addEventListener('keydown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') {
    hud.crossfader.nudge(-0.05);
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    hud.crossfader.nudge(0.05);
    e.preventDefault();
  }
});

document.addEventListener('visibilitychange', () => {
  const anyPlaying = Boolean(decks && (decks.a.playing || decks.b.playing));
  // Keep the loop alive while audio plays (waveform progress must stay fresh
  // for when the tab returns); suspend fully when hidden and silent.
  setSuspended(document.hidden && !anyPlaying);
});
