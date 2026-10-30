// Radial song wheel (SVG). One segment per song on the current album page;
// segments get rounded corners by stroking an inset path in its own colour.

const NS = 'http://www.w3.org/2000/svg';
const C = 300, R_OUT = 292, R_IN = 160, HALF_GAP = 4, CORNER = 12, FONT = 23;

const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};

function segmentPath(i, n) {
  const mid = -90 + (i * 360) / n, half = 180 / n;
  const inset = HALF_GAP + CORNER / 2;
  const ro = R_OUT - CORNER / 2, ri = R_IN + CORNER / 2;
  const go = (inset / ro) * (180 / Math.PI), gi = (inset / ri) * (180 / Math.PI);
  const [a, b] = [pt(ro, mid - half + go), pt(ro, mid + half - go)];
  const [c, d] = [pt(ri, mid + half - gi), pt(ri, mid - half + gi)];
  const large = 2 * half - 2 * go > 180 ? 1 : 0;
  return `M${a} A${ro} ${ro} 0 ${large} 1 ${b} L${c} A${ri} ${ri} 0 ${large} 0 ${d} Z`;
}

// Picks the largest font size, then the fewest lines, whose text box fits inside the segment:
// every corner clear of the rim, the hub and the gaps either side. Widths are estimated
// (the label font may still be loading), a little generously, so real text fits too.
function fitLabel(label, mid, half, rm) {
  const [cx, cy] = pt(rm, mid);
  const fits = (fs, lines) => {
    const bw = Math.max(...lines.map((l) => l.length)) * fs * 0.5, bh = lines.length * fs * 1.12;
    for (const [x, y] of [[cx - bw / 2, cy - bh / 2], [cx + bw / 2, cy - bh / 2], [cx - bw / 2, cy + bh / 2], [cx + bw / 2, cy + bh / 2]]) {
      const r = Math.hypot(x - C, y - C);
      if (r > R_OUT - 14 || r < R_IN + 12) return false;
      const ang = ((Math.atan2(y - C, x - C) * 180 / Math.PI - mid + 540) % 360) - 180;
      if (Math.abs(ang) > half - ((HALF_GAP + CORNER + 4) / r) * (180 / Math.PI)) return false;
    }
    return true;
  };
  // Keep titles the same size as their neighbours when possible: extra lines before a smaller font.
  for (const fs of [FONT, 21, 19, 17]) {
    for (let max = label.length; max >= 5; max--) {
      const lines = wrap(label, max);
      if (lines.length <= 3 && fits(fs, lines)) return { fs, lines };
    }
  }
  return { fs: 17, lines: wrap(label, 9) };
}

function wrap(text, maxChars) {
  const lines = [];
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + word).length <= maxChars) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  return lines;
}

// Selector arc between the hub and the segments, pointing at the highlighted song (a
// white arc). Drawn once at the top and rotated, so it glides from song to song.
const R_SEL = 155;
function selectorPath(n) {
  const span = Math.min(70, (360 / n) * 0.62) / 2;
  const [a, b] = [pt(R_SEL, -90 - span), pt(R_SEL, -90 + span)];
  return `M${a} A${R_SEL} ${R_SEL} 0 0 1 ${b}`;
}

export function createWheel(svg, { onPick, onFocusChange }) {
  let items = [];       // [{ song, label, g }]
  let focus = -1;
  let selAngle = 0;     // unwrapped, so the arc takes the short way round
  svg.setAttribute('viewBox', '0 0 600 600');
  const layer = el('g', { class: 'segs' });
  const selG = el('g', { class: 'wheel-sel-g' });
  const sel = el('path', { class: 'wheel-sel' });
  selG.append(sel);
  svg.append(layer, selG);

  function placeSelector() {
    sel.classList.toggle('on', focus >= 0);
    if (focus < 0) return;
    const target = (focus * 360) / items.length;
    selAngle += ((((target - selAngle) % 360) + 540) % 360) - 180;
    selG.style.transform = `rotate(${selAngle}deg)`;
  }

  // focusDom: keyboard moves take real focus, so Enter picks the highlighted song instead of
  // clicking whatever button was focused before (and screen readers follow along).
  function setFocus(i, { fromPointer = false, focusDom = false } = {}) {
    if (i === focus) return;
    if (items[focus]) items[focus].g.classList.remove('focus');
    focus = i;
    if (items[focus]) {
      items[focus].g.classList.add('focus');
      if (!fromPointer && (focusDom || document.activeElement?.closest?.('.seg'))) items[focus].g.focus({ preventScroll: true });
    }
    placeSelector();
    onFocusChange(items[focus]?.song ?? null);
  }

  function setPage(songs, labelOf) {
    const hadFocus = !!document.activeElement?.closest?.('.seg'); // keep keyboard focus on the wheel
    layer.replaceChildren();
    focus = -1;
    const n = songs.length;
    sel.setAttribute('d', selectorPath(n));
    placeSelector();
    items = songs.map((song, i) => {
      const mid = -90 + (i * 360) / n, half = 180 / n;
      const g = el('g', { class: 'seg', tabindex: '0', role: 'button', 'data-song': song });
      g.style.setProperty('--d', `${i * 35}ms`);
      g.append(el('path', { d: segmentPath(i, n), class: 'seg-shape' }));

      const rm = (R_OUT + R_IN) / 2;
      const label = labelOf(song);
      const { fs, lines } = fitLabel(label, mid, half, rm);
      const [x, y] = pt(rm, mid);
      const text = el('text', { x, y, class: 'seg-label', 'font-size': fs });
      const lh = fs * 1.12;
      lines.forEach((ln, k) => {
        const t = el('tspan', { x, y: y + (k - (lines.length - 1) / 2) * lh + fs * 0.35 });
        t.textContent = ln;
        text.append(t);
      });
      g.append(text);

      // Which layers already use this song (small coloured pips at the rim).
      const pips = el('g', { class: 'pips' });
      ['groove', 'lead', 'texture'].forEach((id, k) => {
        const [px, py] = pt(R_OUT - 18, mid + (k - 1) * (7.5 / (R_OUT - 18)) * 180 / Math.PI);
        pips.append(el('circle', { cx: px, cy: py, r: 4.5, class: `pip pip-${id}` }));
      });
      g.append(pips);
      layer.append(g);

      // Sticky: the highlight stays on the last song pointed at.
      g.addEventListener('pointerenter', () => setFocus(i, { fromPointer: true }));
      g.addEventListener('focus', () => setFocus(i));
      // Mouse and touch pick on release (hold, drag, let go: see main.js). Clicks with detail 0
      // come from assistive tech and keyboards, which have no press/release to follow.
      g.addEventListener('click', (e) => { if (e.detail === 0) onPick(song); });
      g.addEventListener('keydown', (e) => {
        // Space switches layers (handled globally). Enter adds the highlighted song, which the
        // mouse may have moved away from the focused one.
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) onPick(items[focus] ? items[focus].song : song); }
      });
      return { song, label, g };
    });
    onFocusChange(null);
    if (hadFocus && items.length) setFocus(0, { focusDom: true });
  }

  // view: { disabled(song), active(song), loading(song), usedBy(song) -> [layerIds], layerLabel }
  function update(view) {
    for (const it of items) {
      const dis = view.disabled(it.song);
      it.dis = dis;
      it.g.classList.toggle('disabled', dis);
      it.g.classList.toggle('active', view.active(it.song));
      it.g.classList.toggle('loading', view.loading(it.song));
      it.g.setAttribute('aria-disabled', dis);
      it.g.setAttribute('aria-pressed', view.active(it.song));
      it.g.setAttribute('aria-label', dis ? `${it.label} — no ${view.layerLabel} stem`
        : view.active(it.song) ? `${it.label} — playing as ${view.layerLabel}, activate to remove`
        : `${it.label} — add as ${view.layerLabel}`);
      const used = view.usedBy(it.song);
      it.g.querySelectorAll('.pip').forEach((p) => p.classList.toggle('on', used.some((id) => p.classList.contains(`pip-${id}`))));
    }
  }

  return {
    setPage,
    update,
    get focused() { return items[focus]?.song ?? null; },
    // Step to the next song that has a stem for this layer (empty slots are skipped).
    move(delta) {
      const n = items.length;
      let i = focus < 0 ? (delta > 0 ? -1 : 0) : focus;
      for (let k = 0; k < n; k++) {
        i = (i + delta + n) % n;
        if (!items[i].dis) { setFocus(i, { focusDom: true }); return; }
      }
    },
    // Stick or mouse direction: highlight the segment it points at (0° = up, clockwise).
    focusAngle(deg, opts) {
      if (!items.length) return;
      const n = items.length;
      setFocus(Math.round(((deg % 360) + 360) % 360 / (360 / n)) % n, opts);
    },
    clearFocus() { setFocus(-1); },
    // An empty slot (no stem for this layer) can be pointed at but does nothing.
    get pickable() { return !!items[focus] && !items[focus].dis; },
    pickFocused() { if (items[focus] && !items[focus].dis) onPick(items[focus].song); },
  };
}
