// @ts-check
/** Bootstrap: mount the HUD with placeholder data and start the idle visualizer. */

import './app.css';
import { mountHud } from './ui/hud.js';
import { showToast } from './ui/toasts.js';
import { createVisualizer } from './visualizer/visualizer.js';
import { setSuspended } from './ticker.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('visualizer'));

const visualizer = createVisualizer(canvas);
visualizer.start();

const hud = mountHud(app, {
  onCrossfade: (x) => visualizer.setPalette(x),
  onTempo: () => {},
  onFxHold: () => {},
  wheel: {
    onSelect: (slot) => {
      hud.wheel.setSelected(slot.id);
      showToast(`Selected “${slot.title}” — deck loading arrives in the library milestone.`);
    },
    onAddTracks: () => showToast('Track uploads arrive in the library milestone.'),
    onPage: () => {},
  },
});

// ----- placeholder data so the full look is visible (milestone 1) -----

hud.wheel.setSlots([
  { id: 'demo-1', title: 'Neon Causeway', color: 'hsl(160, 90%, 60%)' },
  { id: 'demo-2', title: 'Midnight Reactor', color: 'hsl(250, 90%, 70%)' },
  null,
  null,
  null,
  null,
  null,
  null,
]);
hud.wheel.setPage(0, 1);
hud.wheel.setSelected('demo-1');

hud.deckA.setTrack({ title: 'Neon Causeway', artist: 'Demo loop · 120 BPM' });
hud.deckA.setPlaying(false);
hud.deckA.setMuted(false);
hud.deckA.setActive(true);
hud.deckA.setTime(0, 8);

hud.deckB.setTrack({ title: 'Midnight Reactor', artist: 'Demo loop · 120 BPM' });
hud.deckB.setPlaying(false);
hud.deckB.setMuted(false);
hud.deckB.setTime(0, 8);

// Global keyboard shortcuts: ←/→ nudge crossfader (unless typing in a control).
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

// Pause all animation when the tab is hidden (audio-aware version comes later).
document.addEventListener('visibilitychange', () => {
  setSuspended(document.hidden);
});
