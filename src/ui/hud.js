// @ts-check
/** HUD layout: mounts every control and returns their controllers for wiring. */

import { createWheel } from './wheel.js';
import { createDeckCard } from './deckCard.js';
import { createTempo } from './tempo.js';
import { initToasts } from './toasts.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onCrossfade?: (x: number) => void,
 *   onTempo?: (rate: number) => void,
 *   onFxHold?: (held: boolean) => void,
 *   wheel?: Parameters<typeof createWheel>[1],
 *   deckA?: Partial<Parameters<typeof createDeckCard>[1]>,
 *   deckB?: Partial<Parameters<typeof createDeckCard>[1]>,
 * }} [opts]
 */
export function mountHud(root, opts = {}) {
  const hud = document.createElement('div');
  hud.className = 'hud';
  root.append(hud);

  initToasts(root);

  // ----- top-left column: brand, tempo, FX -----
  const top = document.createElement('div');
  top.className = 'hud-top';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'Random <em>Access</em> Jam';

  const tempo = createTempo(top, {
    onChange: (rate) => opts.onTempo?.(rate),
  });

  const fxBtn = document.createElement('button');
  fxBtn.type = 'button';
  fxBtn.className = 'fx-btn';
  fxBtn.innerHTML = 'Audio FX<small>Hold — or hold Space</small>';
  fxBtn.setAttribute('aria-pressed', 'false');

  top.prepend(brand);
  top.append(fxBtn);
  hud.append(top);

  let fxHeld = false;
  /** @param {boolean} held */
  const setFxHeld = (held) => {
    if (held === fxHeld) return;
    fxHeld = held;
    fxBtn.classList.toggle('is-held', held);
    fxBtn.setAttribute('aria-pressed', String(held));
    opts.onFxHold?.(held);
  };
  fxBtn.addEventListener('pointerdown', (e) => {
    fxBtn.setPointerCapture(e.pointerId);
    setFxHeld(true);
  });
  fxBtn.addEventListener('pointerup', () => setFxHeld(false));
  fxBtn.addEventListener('pointercancel', () => setFxHeld(false));
  fxBtn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setFxHeld(true);
    }
  });
  fxBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') setFxHeld(false);
  });

  // ----- decks -----
  const decks = document.createElement('div');
  decks.className = 'hud-decks';
  hud.append(decks);

  const deckA = createDeckCard(decks, {
    deckId: 'a',
    color: getComputedStyle(document.documentElement).getPropertyValue('--deck-a').trim() || '#2de2a6',
    ...opts.deckA,
  });
  const deckB = createDeckCard(decks, {
    deckId: 'b',
    color: getComputedStyle(document.documentElement).getPropertyValue('--deck-b').trim() || '#7a6bff',
    ...opts.deckB,
  });

  // ----- crossfader -----
  const fader = document.createElement('div');
  fader.className = 'hud-fader panel';

  const labelA = document.createElement('span');
  labelA.className = 'hud-fader__label hud-fader__label--a';
  labelA.textContent = 'A';
  labelA.setAttribute('aria-hidden', 'true');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'crossfader';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.value = '500';
  slider.setAttribute('aria-label', 'Crossfader between Deck A and Deck B');
  slider.setAttribute('aria-valuetext', 'Centered');

  const labelB = document.createElement('span');
  labelB.className = 'hud-fader__label hud-fader__label--b';
  labelB.textContent = 'B';
  labelB.setAttribute('aria-hidden', 'true');

  fader.append(labelA, slider, labelB);
  hud.append(fader);

  const emitFade = () => {
    const x = Number(slider.value) / 1000;
    slider.setAttribute(
      'aria-valuetext',
      x < 0.02 ? 'Fully Deck A' : x > 0.98 ? 'Fully Deck B' : x === 0.5 ? 'Centered' : `${Math.round((1 - x) * 100)}% A, ${Math.round(x * 100)}% B`
    );
    opts.onCrossfade?.(x);
  };
  slider.addEventListener('input', emitFade);

  // ----- wheel -----
  const wheel = createWheel(hud, opts.wheel ?? {});
  wheel.el.style.gridArea = 'wheel';

  return {
    hud,
    wheel,
    deckA,
    deckB,
    tempo,
    fx: { setHeld: setFxHeld, button: fxBtn, get held() { return fxHeld; } },
    crossfader: {
      input: slider,
      get value() {
        return Number(slider.value) / 1000;
      },
      /** @param {number} x 0..1 */
      setValue(x, notify = true) {
        slider.value = String(Math.round(Math.min(Math.max(x, 0), 1) * 1000));
        if (notify) emitFade();
      },
      /** @param {number} delta */
      nudge(delta) {
        this.setValue(Number(slider.value) / 1000 + delta);
      },
    },
  };
}
