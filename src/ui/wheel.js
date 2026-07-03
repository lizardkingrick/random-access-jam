// @ts-check
/**
 * Radial 8-slot track wheel (SVG) with hub pagination and an add-tracks button.
 * Slots behave as a listbox: roving tabindex, arrow-key navigation.
 */

export const SLOTS_PER_PAGE = 8;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZE = 420;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_OUTER = 202;
const R_INNER = 92;
const R_HUB = 80;
const GAP_DEG = 2.4;
const MAX_TITLE = 14;

/** @param {number} deg */
const rad = (deg) => ((deg - 90) * Math.PI) / 180;

/** @param {number} r @param {number} deg */
const pt = (r, deg) => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))];

/**
 * Annular-sector path between two radii and two angles (degrees, clockwise from top).
 * @param {number} a0 @param {number} a1 @param {number} r0 @param {number} r1
 */
function wedgePath(a0, a1, r0, r1) {
  const [x0, y0] = pt(r1, a0);
  const [x1, y1] = pt(r1, a1);
  const [x2, y2] = pt(r0, a1);
  const [x3, y3] = pt(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A ${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `A ${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/** @param {string} tag @param {Record<string, string>} [attrs] */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** @param {string} title */
function truncate(title) {
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/**
 * @typedef {{ id: string, title: string, color?: string }} WheelSlotData
 *
 * @param {HTMLElement} container
 * @param {{
 *   onSelect?: (slot: WheelSlotData, index: number) => void,
 *   onLoadTo?: (slot: WheelSlotData, deckId: 'a' | 'b') => void,
 *   onPage?: (delta: number) => void,
 *   onAddTracks?: () => void,
 * }} [opts]
 */
export function createWheel(container, opts = {}) {
  /** @type {(WheelSlotData | null)[]} */
  let slots = new Array(SLOTS_PER_PAGE).fill(null);
  /** @type {string | null} */
  let selectedId = null;
  let focusIndex = 0;
  let page = 0;
  let pageCount = 1;

  const wrap = document.createElement('div');
  wrap.className = 'hud-wheel';
  container.append(wrap);

  const svg = svgEl('svg', {
    class: 'wheel-svg',
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    role: 'listbox',
    'aria-label': 'Track wheel — pick a track to queue it on the next deck',
  });
  wrap.append(svg);

  /** @type {{ g: SVGGElement, wedge: SVGPathElement, label: SVGTextElement, chip: SVGCircleElement }[]} */
  const slotEls = [];

  const step = 360 / SLOTS_PER_PAGE;
  for (let i = 0; i < SLOTS_PER_PAGE; i++) {
    const a0 = i * step + GAP_DEG / 2;
    const a1 = (i + 1) * step - GAP_DEG / 2;
    const midA = (a0 + a1) / 2;

    const g = /** @type {SVGGElement} */ (
      svgEl('g', { class: 'wheel-slot wheel-slot--empty', role: 'option', 'aria-selected': 'false', tabindex: i === 0 ? '0' : '-1' })
    );
    const wedge = /** @type {SVGPathElement} */ (
      svgEl('path', { class: 'wheel-slot__wedge', d: wedgePath(a0, a1, R_INNER, R_OUTER) })
    );
    const [lx, ly] = pt((R_INNER + R_OUTER) / 2 + 6, midA);
    const label = /** @type {SVGTextElement} */ (
      svgEl('text', { class: 'wheel-slot__label', x: String(lx), y: String(ly + 4) })
    );
    const [cx, cy] = pt(R_INNER + 22, midA);
    const chip = /** @type {SVGCircleElement} */ (
      svgEl('circle', { class: 'wheel-slot__chip', cx: String(cx), cy: String(cy), r: '5', fill: 'none' })
    );
    g.append(wedge, label, chip);
    svg.append(g);
    slotEls.push({ g, wedge, label, chip });

    g.addEventListener('click', () => activate(i));
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      requestLoadMenu(i, e.clientX, e.clientY);
    });
    // Long-press for touch.
    let pressTimer = 0;
    g.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pressTimer = window.setTimeout(() => requestLoadMenu(i, e.clientX, e.clientY), 550);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
      g.addEventListener(ev, () => clearTimeout(pressTimer));
    }
    g.addEventListener('keydown', (e) => onSlotKeydown(e, i));
    g.addEventListener('focus', () => (focusIndex = i));
  }

  // ---------- hub ----------
  const hub = svgEl('g', { class: 'wheel-hub' });
  hub.append(svgEl('circle', { class: 'wheel-hub__disc', cx: String(CX), cy: String(CY), r: String(R_HUB) }));
  const pageText = svgEl('text', { class: 'wheel-hub__page', x: String(CX), y: String(CY + 2) });
  const countText = svgEl('text', { class: 'wheel-hub__count', x: String(CX), y: String(CY + 22) });
  hub.append(pageText, countText);
  svg.append(hub);

  /** @param {'prev' | 'next'} dir */
  function makeArrow(dir) {
    const x = dir === 'prev' ? CX - 48 : CX + 48;
    const g = svgEl('g', {
      class: 'wheel-hub__arrow',
      role: 'button',
      tabindex: '0',
      'aria-label': dir === 'prev' ? 'Previous page of tracks' : 'Next page of tracks',
    });
    g.append(svgEl('circle', { cx: String(x), cy: String(CY - 2), r: '18' }));
    const arrow = dir === 'prev'
      ? `M ${x + 5} ${CY - 10} L ${x - 7} ${CY - 2} L ${x + 5} ${CY + 6} Z`
      : `M ${x - 5} ${CY - 10} L ${x + 7} ${CY - 2} L ${x - 5} ${CY + 6} Z`;
    g.append(svgEl('path', { d: arrow }));
    const fire = () => {
      if (g.getAttribute('aria-disabled') === 'true') return;
      opts.onPage?.(dir === 'prev' ? -1 : 1);
    };
    g.addEventListener('click', fire);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire();
      }
    });
    svg.append(g);
    return g;
  }
  const prevArrow = makeArrow('prev');
  const nextArrow = makeArrow('next');

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'wheel-add';
  addBtn.textContent = '+ Add tracks';
  addBtn.addEventListener('click', () => opts.onAddTracks?.());
  wrap.append(addBtn);

  // ---------- behavior ----------

  /** @param {number} i */
  function activate(i) {
    const slot = slots[i];
    if (!slot) return;
    opts.onSelect?.(slot, i);
  }

  /** @param {number} i @param {number} x @param {number} y */
  function requestLoadMenu(i, x, y) {
    const slot = slots[i];
    if (!slot || !opts.onLoadTo) return;
    openLoadMenu(slot, x, y, opts.onLoadTo);
  }

  /** @param {KeyboardEvent} e @param {number} i */
  function onSlotKeydown(e, i) {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % SLOTS_PER_PAGE;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i + SLOTS_PER_PAGE - 1) % SLOTS_PER_PAGE;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(i);
      return;
    } else return;
    e.preventDefault();
    slotEls[i].g.setAttribute('tabindex', '-1');
    slotEls[next].g.setAttribute('tabindex', '0');
    slotEls[next].g.focus();
  }

  function render() {
    for (let i = 0; i < SLOTS_PER_PAGE; i++) {
      const { g, label, chip } = slotEls[i];
      const slot = slots[i];
      if (slot) {
        g.classList.remove('wheel-slot--empty');
        label.textContent = truncate(slot.title);
        chip.setAttribute('fill', slot.color ?? 'rgba(53, 201, 255, 0.8)');
        g.setAttribute('aria-selected', String(slot.id === selectedId));
        g.setAttribute('aria-label', `${slot.title}. Press Enter to queue on the next deck.`);
        g.removeAttribute('aria-disabled');
      } else {
        g.classList.add('wheel-slot--empty');
        label.textContent = '—';
        chip.setAttribute('fill', 'none');
        g.setAttribute('aria-selected', 'false');
        g.setAttribute('aria-disabled', 'true');
        g.setAttribute('aria-label', 'Empty slot');
      }
    }
    pageText.textContent = pageCount > 1 ? `Page ${page + 1}/${pageCount}` : 'Tracks';
    const filled = slots.filter(Boolean).length;
    countText.textContent = filled ? `${filled} in view` : 'Add music';
    prevArrow.setAttribute('aria-disabled', String(page <= 0));
    nextArrow.setAttribute('aria-disabled', String(page >= pageCount - 1));
  }

  render();

  return {
    el: wrap,
    /** @param {(WheelSlotData | null)[]} next up to 8 entries; padded with nulls */
    setSlots(next) {
      slots = [...next.slice(0, SLOTS_PER_PAGE)];
      while (slots.length < SLOTS_PER_PAGE) slots.push(null);
      render();
    },
    /** @param {number} p zero-based @param {number} count */
    setPage(p, count) {
      page = p;
      pageCount = Math.max(1, count);
      render();
    },
    /** @param {string | null} id */
    setSelected(id) {
      selectedId = id;
      render();
    },
  };
}

/**
 * Minimal context menu offering explicit "load to deck" choices.
 * @param {WheelSlotData} slot
 * @param {number} x @param {number} y
 * @param {(slot: WheelSlotData, deckId: 'a' | 'b') => void} onLoadTo
 */
function openLoadMenu(slot, x, y, onLoadTo) {
  document.querySelector('.wheel-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'wheel-menu panel';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Load ${slot.title}`);

  for (const deckId of /** @type {const} */ (['a', 'b'])) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wheel-menu__item';
    item.setAttribute('role', 'menuitem');
    item.textContent = `Load to Deck ${deckId.toUpperCase()}`;
    item.addEventListener('click', () => {
      close();
      onLoadTo(slot, deckId);
    });
    menu.append(item);
  }

  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (!menu.contains(/** @type {Node} */ (e.target))) close();
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  /** @type {HTMLButtonElement | null} */ (menu.querySelector('button'))?.focus();
}
