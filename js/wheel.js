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

function wrap(text, maxChars) {
  const lines = [];
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + word).length <= maxChars) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  return lines;
}

export function createWheel(svg, { onPick, onFocusChange }) {
  let items = [];       // [{ song, label, g }]
  let focus = -1;
  svg.setAttribute('viewBox', '0 0 600 600');
  const rim = el('circle', { cx: C, cy: C, r: R_OUT + 4, class: 'wheel-rim' });
  const layer = el('g', { class: 'segs' });
  svg.append(rim, layer);

  function setFocus(i, { fromPointer = false } = {}) {
    if (i === focus) return;
    if (items[focus]) items[focus].g.classList.remove('focus');
    focus = i;
    if (items[focus]) {
      items[focus].g.classList.add('focus');
      if (!fromPointer && document.activeElement?.closest?.('.seg')) items[focus].g.focus({ preventScroll: true });
    }
    onFocusChange(items[focus]?.song ?? null);
  }

  function setPage(songs, labelOf) {
    layer.replaceChildren();
    focus = -1;
    const n = songs.length;
    items = songs.map((song, i) => {
      const mid = -90 + (i * 360) / n, half = 180 / n;
      const g = el('g', { class: 'seg', tabindex: '0', role: 'button', 'data-song': song });
      g.style.setProperty('--d', `${i * 35}ms`);
      g.append(el('path', { d: segmentPath(i, n), class: 'seg-shape' }));

      // How much horizontal room the label has depends on where the segment sits.
      const rm = (R_OUT + R_IN) / 2;
      const chord = 2 * rm * Math.sin(Math.min(half, 80) * Math.PI / 180);
      const rad = mid * Math.PI / 180;
      const room = Math.abs(Math.cos(rad)) * (R_OUT - R_IN) + Math.abs(Math.sin(rad)) * chord;
      const label = labelOf(song);
      let fs = FONT, lines = wrap(label, Math.max(7, Math.floor(room * 0.86 / (fs * 0.47))));
      if (lines.length > 3) { fs = 19; lines = wrap(label, Math.floor(room * 0.86 / (fs * 0.47))); }
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

      g.addEventListener('pointerenter', () => setFocus(i, { fromPointer: true }));
      g.addEventListener('pointerleave', () => { if (focus === i) setFocus(-1, { fromPointer: true }); });
      g.addEventListener('focus', () => setFocus(i));
      g.addEventListener('click', () => onPick(song));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onPick(song); } // Space is the FX key
      });
      return { song, label, g };
    });
    onFocusChange(null);
  }

  // view: { disabled(song), active(song), loading(song), usedBy(song) -> [layerIds], layerLabel }
  function update(view) {
    for (const it of items) {
      const dis = view.disabled(it.song);
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
    move(delta) {
      if (!items.length) return;
      setFocus(focus < 0 ? (delta > 0 ? 0 : items.length - 1) : (focus + delta + items.length) % items.length);
    },
    // Gamepad stick: pick the segment the stick points at (0° = up, clockwise).
    focusAngle(deg) {
      if (!items.length) return;
      const n = items.length;
      setFocus(Math.round(((deg % 360) + 360) % 360 / (360 / n)) % n);
    },
    clearFocus() { setFocus(-1); },
    pickFocused() { if (items[focus]) onPick(items[focus].song); },
  };
}
