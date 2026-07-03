// @ts-check
/** Tempo pill: rate readout with −/+ nudge buttons; double-click/press resets. */

export const TEMPO_MIN = 0.85;
export const TEMPO_MAX = 1.15;
const STEP = 0.01;

/**
 * @param {HTMLElement} container
 * @param {{ onChange?: (rate: number) => void }} [opts]
 */
export function createTempo(container, opts = {}) {
  let rate = 1;

  const el = document.createElement('div');
  el.className = 'tempo panel';

  const minus = document.createElement('button');
  minus.className = 'tempo__btn';
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', 'Slow down tempo');

  const readout = document.createElement('button');
  readout.className = 'tempo__readout';
  readout.type = 'button';
  readout.title = 'Double-click to reset tempo';
  const value = document.createElement('span');
  value.className = 'tempo__value';
  const unit = document.createElement('span');
  unit.className = 'tempo__unit';
  unit.textContent = 'tempo';
  readout.append(value, unit);

  const plus = document.createElement('button');
  plus.className = 'tempo__btn';
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', 'Speed up tempo');

  el.append(minus, readout, plus);
  container.append(el);

  function render() {
    value.textContent = `${rate.toFixed(2)}×`;
    readout.setAttribute(
      'aria-label',
      `Tempo ${rate.toFixed(2)} times normal speed. Double-tap to reset.`
    );
    minus.disabled = rate <= TEMPO_MIN + 1e-9;
    plus.disabled = rate >= TEMPO_MAX - 1e-9;
  }

  /** @param {number} next */
  function set(next, notify = true) {
    rate = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(next * 100) / 100));
    render();
    if (notify) opts.onChange?.(rate);
  }

  minus.addEventListener('click', () => set(rate - STEP));
  plus.addEventListener('click', () => set(rate + STEP));
  readout.addEventListener('dblclick', () => set(1));
  readout.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      set(1);
    }
  });

  render();

  return {
    el,
    get rate() {
      return rate;
    },
    /** @param {number} next */
    setRate(next) {
      set(next, false);
    },
  };
}
