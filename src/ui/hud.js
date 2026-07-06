// @ts-check
/** HUD layout: master transport strip + FX, the 4-position rack, and the track wheel. */

import { createWheel } from './wheel.js';
import { createRackCard } from './rackCard.js';
import { createTransportStrip } from './tempo.js';
import { initToasts } from './toasts.js';
import { ROLES } from '../audio/jamRack.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onFxHold?: (held: boolean) => void,
 *   strip?: Parameters<typeof createTransportStrip>[1],
 *   rack?: (role: import('../audio/jamRack.js').Role) => Parameters<typeof createRackCard>[1] extends infer O ? Omit<O, 'role'> : never,
 *   wheel?: Parameters<typeof createWheel>[1],
 * }} [opts]
 */
export function mountHud(root, opts = {}) {
  const hud = document.createElement('div');
  hud.className = 'hud';
  root.append(hud);

  initToasts(root);

  // ----- top: brand + master transport strip + FX -----
  const top = document.createElement('div');
  top.className = 'hud-top';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'Random <em>Access</em> Jam';
  top.append(brand);

  const strip = createTransportStrip(top, opts.strip ?? {});

  const fxBtn = document.createElement('button');
  fxBtn.type = 'button';
  fxBtn.className = 'fx-btn';
  fxBtn.innerHTML = 'Audio FX<small>Hold — or hold Space</small>';
  fxBtn.setAttribute('aria-pressed', 'false');
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

  // ----- the rack: 4 position cards -----
  const rackGrid = document.createElement('div');
  rackGrid.className = 'hud-rack';
  rackGrid.setAttribute('role', 'region');
  rackGrid.setAttribute('aria-label', 'Jam rack — four positions playing together');
  hud.append(rackGrid);

  /** @type {Record<import('../audio/jamRack.js').Role, ReturnType<typeof createRackCard>>} */
  const rackCards = /** @type {any} */ ({});
  for (const role of ROLES) {
    rackCards[role] = createRackCard(rackGrid, {
      role,
      .../** @type {any} */ (opts.rack?.(role) ?? {}),
    });
  }

  // ----- wheel (track browser) -----
  const wheel = createWheel(hud, opts.wheel ?? {});
  wheel.el.style.gridArea = 'wheel';

  return {
    hud,
    wheel,
    strip,
    rackCards,
    fx: {
      setHeld: setFxHeld,
      button: fxBtn,
      get held() {
        return fxHeld;
      },
    },
  };
}
