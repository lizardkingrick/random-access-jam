import * as E from './engine.js';
import { state, LAYERS, NOTE, NOTE_NAMES, prettyKey } from './engine.js';
import { ALBUMS, albumById, songsForAlbum, displayName, albumArtUnique, loadCovers, LAYER_ICONS } from './catalog.js';
import { createWheel } from './wheel.js';
import { createStage } from './stage.js';
import { VERSION, VERSION_LABEL } from './version.js';

const $ = (s, root = document) => root.querySelector(s);
const layerDef = (id) => LAYERS.find((l) => l.id === id);
const ui = {
  layer: 'groove',
  albums: [],          // album ids that have songs
  album: 0,
  peek: null,          // song under the pointer / stick
  fx: { held: false, x: 0, amount: 0, type: 'lowpass' },
  mouse: { x: innerWidth / 2, y: innerHeight / 2 },
};

// ---------- toast ----------
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 4500 : 2600);
}
E.on('status', ({ msg, kind }) => toast(msg, kind));

// ---------- wheel ----------
const wheel = createWheel($('#wheel'), {
  onPick: pickSong,
  onFocusChange(song) {
    ui.peek = song;
    renderHub();
    if (song && matchMedia('(hover: hover)').matches) {
      setTimeout(() => { if (ui.peek === song && E.stemTypeFor(ui.layer, song)) E.prefetch(ui.layer, song); }, 350);
    }
  },
});

function pickSong(song) {
  if (!E.stemTypeFor(ui.layer, song)) return; // an empty slot for this layer: nothing to pick
  E.selectStem(ui.layer, song);
}

// ---------- hub ----------
function buildHub() {
  $('#hubCats').innerHTML = LAYERS.map((l) =>
    `<button class="hub-cat" role="tab" data-layer="${l.id}" aria-label="${l.label} layer" title="${l.label}">${LAYER_ICONS[l.id]}</button>`).join('');
  $('#hubCats').addEventListener('click', (e) => {
    const b = e.target.closest('.hub-cat');
    if (b) setLayer(b.dataset.layer);
  });
  // 32 bar ticks around the hub = position in the 32-bar loop
  const ticks = [];
  for (let i = 0; i < 32; i++) {
    const a0 = (-90 + i * 11.25 + 1.4) * Math.PI / 180, a1 = (-90 + (i + 1) * 11.25 - 1.4) * Math.PI / 180;
    const r = 143;
    ticks.push(`<path class="tick" d="M${150 + r * Math.cos(a0)} ${150 + r * Math.sin(a0)} A${r} ${r} 0 0 1 ${150 + r * Math.cos(a1)} ${150 + r * Math.sin(a1)}"/>`);
  }
  $('#hubRing').innerHTML = ticks.join('');
}

function shiftLabel(song) {
  const semis = E.semisFor(E.MANIFEST[song].key);
  return semis ? ` ${semis > 0 ? '+' : ''}${semis} st` : '';
}

function renderHub() {
  const hub = $('#hub'), def = layerDef(ui.layer), s = state.layers[ui.layer];
  // An empty slot (no stem for this layer) shows nothing, so the hub keeps the layer view.
  const peek = ui.peek && E.stemTypeFor(ui.layer, ui.peek) ? ui.peek : null;
  hub.dataset.layer = ui.layer;
  hub.classList.toggle('peek', !!peek);
  $('#hubCats').querySelectorAll('.hub-cat').forEach((b) => b.setAttribute('aria-selected', b.dataset.layer === ui.layer));
  const title = $('#hubTitle'), sub = $('#hubSub');
  if (peek) {
    const info = E.MANIFEST[peek];
    const meta = `${prettyKey(info.key)} · ${info.bpm} BPM`;
    let html;
    if (s.song === peek) {
      const now = s.loading ? 'Loading…' : state.playing ? 'Playing' : 'Selected';
      html = `${meta}<br><b>${now}</b> · pick again to remove`;
    } else {
      const part = info.parts && info.parts[E.stemTypeFor(ui.layer, peek)];
      html = `${meta}<br>Add ${part ? `the ${part} ` : ''}as <b>${def.label}</b>`;
    }
    setHub(title, displayName(peek), sub, html);
  } else {
    const name = def.label.toLowerCase();
    setHub(title, def.label, sub, s.song ? escapeHtml(displayName(s.song)) : `Pick ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`);
  }
}
// The hub is a live region: only touch it when the text changes, or screen readers re-read
// it on every render (progress ticks, hovers).
function setHub(title, titleText, sub, subHtml) {
  if (title.textContent !== titleText) title.textContent = titleText;
  if (sub.dataset.html !== subHtml) { sub.dataset.html = subHtml; sub.innerHTML = subHtml; }
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- albums ----------
function buildAlbums() {
  const present = new Set(Object.values(E.MANIFEST).map((i) => i.album));
  ui.albums = ALBUMS.map((a) => a.id).filter((id) => present.has(id));
  for (const id of present) if (!ui.albums.includes(id)) ui.albums.push(id);
  $('#albumStrip').innerHTML = ui.albums.map((id, i) =>
    `<button class="album" role="tab" data-i="${i}" title="${albumById(id).name}" aria-label="${albumById(id).name}">${albumArtUnique(id)}</button>`).join('');
  $('#albumStrip').addEventListener('click', (e) => {
    const b = e.target.closest('.album');
    if (b) setAlbum(Number(b.dataset.i));
  });
  $('#albumPrev').onclick = () => setAlbum(ui.album - 1);
  $('#albumNext').onclick = () => setAlbum(ui.album + 1);
}

function setAlbum(i) {
  ui.album = (i + ui.albums.length) % ui.albums.length;
  const id = ui.albums[ui.album], album = albumById(id);
  const songs = songsForAlbum(E.MANIFEST, id);
  wheel.setPage(songs, displayName);
  $('#albumName').innerHTML = [`<b>${album.name}</b>`, album.year, `${songs.length} track${songs.length === 1 ? "" : "s"}`].filter(Boolean).join(' · ');
  $('#albumStrip').querySelectorAll('.album').forEach((b, k) => {
    b.setAttribute('aria-selected', k === ui.album);
    if (k === ui.album) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  render();
}

function setLayer(id, { jumpToAlbum = false } = {}) {
  ui.layer = id;
  const song = state.layers[id].song;
  if (jumpToAlbum && song) {
    const i = ui.albums.indexOf(E.MANIFEST[song].album);
    if (i >= 0 && i !== ui.album) { setAlbum(i); return; }
  }
  render();
}
const cycleLayer = (d = 1) => setLayer(LAYERS[(LAYERS.findIndex((l) => l.id === ui.layer) + d + LAYERS.length) % LAYERS.length].id);

// ---------- layer cards ----------
const ICON_SOUND = `<svg class="i-sound" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_MUTED = `<svg class="i-muted" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_CLEAR = `<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

function buildLayers() {
  const list = $('#layers');
  list.innerHTML = LAYERS.map((l) => `
    <li class="layer empty" data-layer="${l.id}">
      <button class="layer-pick" aria-label="Choose the ${l.label} layer"></button>
      <span class="layer-icon">${LAYER_ICONS[l.id]}</span>
      <span class="layer-text"><span class="layer-song"></span><span class="layer-sub"></span></span>
      <span class="layer-actions">
        <span class="layer-badge"></span>
        <button class="ibtn ibtn-mute" aria-label="Mute ${l.label}" title="Mute (M)">${ICON_SOUND}${ICON_MUTED}</button>
        <button class="ibtn ibtn-clear" aria-label="Remove ${l.label}" title="Remove (Backspace)">${ICON_CLEAR}</button>
      </span>
      <input type="range" class="layer-vol" min="0" max="1" step="0.01" value="${state.layers[l.id].volume}" aria-label="${l.label} volume">
      <span class="layer-load"></span>
    </li>`).join('');
  for (const li of list.children) {
    const id = li.dataset.layer;
    $('.layer-pick', li).onclick = () => setLayer(id, { jumpToAlbum: true });
    $('.ibtn-mute', li).onclick = () => { E.ensureCtx(); E.setMuted(id, !state.layers[id].muted); scheduleHash(); };
    $('.ibtn-clear', li).onclick = () => E.clearLayer(id);
    const vol = $('.layer-vol', li);
    vol.addEventListener('input', () => { E.ensureCtx(); E.setVolume(id, Number(vol.value)); paintRange(vol); scheduleHash(); });
    paintRange(vol);
  }
}

function renderLayers() {
  for (const li of $('#layers').children) {
    const id = li.dataset.layer, s = state.layers[id], def = layerDef(id);
    li.classList.toggle('empty', !s.song);
    li.classList.toggle('loading', s.loading || s.syncing);
    li.classList.toggle('muted', s.muted);
    li.classList.toggle('current', id === ui.layer);
    li.classList.toggle('playing', !!s.source && state.playing && !s.muted);
    li.style.setProperty('--p', s.progress || 0);
    $('.layer-pick', li).setAttribute('aria-pressed', id === ui.layer);
    $('.ibtn-mute', li).setAttribute('aria-pressed', s.muted);
    const song = $('.layer-song', li), sub = $('.layer-sub', li);
    if (!s.song) {
      song.textContent = def.label;
      sub.textContent = id === ui.layer ? `Pick a song on the wheel →` : 'Empty';
      $('.layer-badge', li).dataset.album = '';
      continue;
    }
    const info = E.MANIFEST[s.song];
    const part = s.type === 'all' ? 'full mix' : info.parts && info.parts[s.type];
    song.textContent = displayName(s.song) + (part ? ` (${part})` : '');
    sub.textContent = s.loading && s.progress < 1 ? `Loading… ${Math.round((s.progress || 0) * 100)}%`
      : s.loading || s.syncing ? 'Syncing to tempo…'
      : `${albumById(info.album).name} · ${prettyKey(info.key)}${shiftLabel(s.song)}`;
    const badge = $('.layer-badge', li);
    if (badge.dataset.album !== info.album) { badge.dataset.album = info.album; badge.innerHTML = albumArtUnique(info.album); }
    const vol = $('.layer-vol', li);
    if (Number(vol.value) !== s.volume) { vol.value = s.volume; paintRange(vol); }
  }
}

// ---------- tempo / key ----------
function buildControls() {
  const step = (d) => { E.ensureCtx(); E.setBpm(state.bpm + d); scheduleHash(); };
  for (const [btn, d] of [['#tempoDown', -1], ['#tempoUp', 1]]) {
    let timer;
    const stopRepeat = () => clearTimeout(timer);
    $(btn).addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // a right-click's menu would swallow the pointerup: runaway repeat
      e.preventDefault();
      $(btn).setPointerCapture(e.pointerId);
      step(d);
      const repeat = (delay) => { timer = setTimeout(() => { step(d); repeat(70); }, delay); };
      repeat(420);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture', 'contextmenu'].forEach((ev) => $(btn).addEventListener(ev, stopRepeat));
    addEventListener('blur', stopRepeat);
    $(btn).addEventListener('keydown', (e) => { if (e.key === 'Enter') step(d); });
  }
  // One step per notch: trackpads send many small (and sideways) deltas per gesture.
  let wheelAcc = 0;
  $('.tempo').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(wheelAcc) < 50) return;
    step(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
  }, { passive: false });

  const sel = $('#masterKey');
  // Key lock matches minor keys (a major key counts as its relative minor), so offer those.
  sel.innerHTML = '<option value="auto">Auto</option>' + NOTE_NAMES.map((n) => `<option value="${n}">${prettyKey(n)}m</option>`).join('');
  sel.onchange = () => { E.ensureCtx(); E.setMasterKey(sel.value); scheduleHash(); };
  $('#keyLockBtn').onclick = () => { E.ensureCtx(); E.setKeyLock(!state.keyLock); scheduleHash(); };

  const mv = $('#masterVol');
  mv.addEventListener('input', () => { E.setMasterVolume(Number(mv.value)); paintRange(mv); });
  paintRange(mv);

  $('#playBtn').onclick = () => E.togglePlay();
  $('#randomBtn').onclick = () => E.randomize();
  $('#recBtn').onclick = () => E.toggleRecord(download);
  $('#exportBtn').onclick = async () => {
    const btn = $('#exportBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const blob = await E.exportLoopWav();
      if (blob) { download(blob, 'dream-chamber-loop.wav'); toast('Exported one 32-bar loop'); }
    } catch (err) {
      console.error(err);
      toast('Export failed — see console', 'error');
    } finally { btn.disabled = false; }
  };
  $('#shareBtn').onclick = shareMix;
  $('#helpBtn').onclick = () => $('#help').showModal();
}

function renderControls() {
  $('#bpmOut').textContent = state.bpm;
  const anyLoading = E.activeLayers().some((id) => state.layers[id].loading || state.layers[id].syncing);
  $('.tempo').classList.toggle('pending', anyLoading);
  $('#tempoSub').textContent = anyLoading ? 'Syncing…' : 'BPM';
  $('#masterKey').value = state.masterKey;
  $('#masterKey').disabled = !state.keyLock;
  $('#keyLockBtn').setAttribute('aria-pressed', state.keyLock);
  const mr = E.masterRoot();
  $('#keySub').textContent = !state.keyLock ? 'Off · native keys'
    : state.masterKey !== 'auto' ? 'Locked'
    : mr === null ? 'Auto' : `Auto · ${prettyKey(NOTE_NAMES[mr])} minor`; // shown uppercase: "m" would read as major
  document.body.classList.toggle('is-playing', state.playing);
  $('#playBtn .tlabel').textContent = state.playing ? 'Stop' : 'Play';
  $('#recBtn').classList.toggle('active', state.recording);
  $('#recBtn .tlabel').textContent = state.recording ? 'Stop' : 'Rec';
}

function paintRange(r) { r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`); }

// ---------- render ----------
function render() {
  renderControls();
  renderLayers();
  renderHub();
  const cur = state.layers[ui.layer];
  wheel.update({
    layerLabel: layerDef(ui.layer).label,
    disabled: (song) => !E.stemTypeFor(ui.layer, song),
    active: (song) => cur.song === song,
    loading: (song) => cur.song === song && cur.loading,
    usedBy: (song) => LAYERS.map((l) => l.id).filter((id) => state.layers[id].song === song),
  });
  document.body.style.setProperty('--bpm', state.bpm);
  scheduleHash();
}
E.on('change', render);

// ---------- clock (runs inside the stage's frame) ----------
let lastBar = -1, lastBeat = -1;
const dots = [...document.querySelectorAll('.beat-dots i')];
function tickClock(m) {
  const bar = m.beatIndex >= 0 ? Math.floor(m.bar) : -1;
  const beat = m.beatIndex >= 0 ? m.beatIndex % 4 : -1;
  if (beat !== lastBeat) { lastBeat = beat; dots.forEach((d, i) => d.classList.toggle('on', i === beat)); }
  if (bar !== lastBar) {
    lastBar = bar;
    $('#barReadout').textContent = bar < 0 ? 'BAR --' : `BAR ${String(bar + 1).padStart(2, '0')} / 32`;
    $('#hubRing').querySelectorAll('.tick').forEach((t, i) => {
      t.classList.toggle('done', i < bar);
      t.classList.toggle('now', i === bar);
    });
  }
}

// ---------- Audio FX: pick one in the strip, hold F (or the button) to play it ----------
const FX_ICONS = {
  stutter: '<path d="M4 7v10M8 7v10M13 7v10M17 7v10" stroke-width="2.6"/>',
  lowpass: '<path d="M3 9h9c4 0 5 9 9 9"/>',
  highpass: '<path d="M3 18c4 0 5-9 9-9h9"/>',
  phaser: '<path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3-4 5-2"/><path d="M2 12c2.5 4 5 4 7.5 0s5-4 7.5 0 3 3 5 1" opacity=".55"/>',
  wah: '<path d="M2 18c5 0 6-11 10-11s5 11 10 11"/>',
  tapestop: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4a8 8 0 0 1 7.4 5" stroke-width="2.6"/>',
};
function loadFxChoice() {
  try { const v = localStorage.getItem('dcr-fx'); if (E.FX.some((f) => f.id === v)) return v; } catch (_) { /* private mode */ }
  return 'lowpass';
}
ui.fx.type = loadFxChoice();
function setFxType(id) {
  if (ui.fx.held) fxRelease(); // switching mid-hold: let the old one go cleanly
  ui.fx.type = id;
  try { localStorage.setItem('dcr-fx', id); } catch (_) { /* private mode */ }
  renderFxPicker();
}
const cycleFx = (d) => {
  const i = E.FX.findIndex((f) => f.id === ui.fx.type);
  setFxType(E.FX[(i + d + E.FX.length) % E.FX.length].id);
};
function buildFxPicker() {
  $('#fxPicker').innerHTML = E.FX.map((f) => `
    <button class="fx-chip" role="radio" data-fx="${f.id}" title="${f.label}: ${f.desc}">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FX_ICONS[f.id]}</svg>
      <span>${f.label}</span>
    </button>`).join('');
  $('#fxPicker').addEventListener('click', (e) => {
    const b = e.target.closest('.fx-chip');
    if (b) setFxType(b.dataset.fx);
  });
  renderFxPicker();
}
function renderFxPicker() {
  const fx = E.FX.find((f) => f.id === ui.fx.type);
  $('#fxPicker').querySelectorAll('.fx-chip').forEach((b) => b.setAttribute('aria-checked', b.dataset.fx === fx.id));
  $('#fxName').textContent = fx.label;
  $('#fxHint').textContent = fx.desc;
}
function fxEngage() {
  if (ui.fx.held) return;
  E.ensureCtx();
  ui.fx.held = true;
  ui.fx.amount = 1;
  ui.fx.x = ui.fx.type === 'lowpass' || ui.fx.type === 'tapestop' ? -1 : 1; // stage tint: violet or cyan
  $('#fxBtn').classList.add('held');
  $('#fxPicker').classList.add('held');
  E.fxStart(ui.fx.type);
}
function fxRelease() {
  if (!ui.fx.held) return;
  ui.fx.held = false;
  ui.fx.amount = 0;
  $('#fxBtn').classList.remove('held');
  $('#fxPicker').classList.remove('held');
  E.fxStop();
}
function bindFx() {
  buildFxPicker();
  const btn = $('#fxBtn');
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    fxEngage();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, fxRelease));
  btn.addEventListener('click', (e) => e.preventDefault());
  addEventListener('pointermove', (e) => {
    if (jam.on) return; // pointer lock: movement is read from mousemove deltas instead
    ui.mouse.x = e.clientX; ui.mouse.y = e.clientY;
    if (e.pointerType === 'mouse') {
      document.body.classList.remove('pad');
      steerFromPointer(e.clientX, e.clientY);
    }
  });
  // Keys released in another window never reach us: forget F too, or the next press is ignored.
  addEventListener('blur', () => { fHeld = false; fxRelease(); });
}

// ---------- wheel steering ----------
// The highlight follows the direction of the mouse from the wheel's centre, not exact hovering,
// and stays on the last song pointed at; a click picks it.
// Pointer position relative to the wheel, in its 600-unit viewBox (hub radius 150, rim 292).
function wheelPolar(x, y) {
  const r = $('#wheelWrap').getBoundingClientRect();
  const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
  return { d: Math.hypot(dx, dy) / (r.width / 600), deg: Math.atan2(dx, -dy) * 180 / Math.PI };
}
function steerFromPointer(x, y, { dragging = false } = {}) {
  const { d, deg } = wheelPolar(x, y);
  // Hovering steers from the ring outward; while the button is held, anywhere off-centre does.
  if (dragging ? d > 40 : d > 150 && d < 335) wheel.focusAngle(deg, { fromPointer: true });
}

// Hold and drag through the songs, let go to pick. A plain click is a
// zero-length drag, so it still picks the song under the pointer. Letting go inside the hub
// cancels.
function bindWheelDrag() {
  const wrap = $('#wheelWrap');
  let drag = null;
  const end = () => { drag = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerdown', (e) => {
    if (jam.on || e.button !== 0 || e.target.closest('button')) return;
    E.ensureCtx();
    drag = e.pointerId;
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
    steerFromPointer(e.clientX, e.clientY, { dragging: true });
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection while dragging
  });
  wrap.addEventListener('pointermove', (e) => { if (e.pointerId === drag) steerFromPointer(e.clientX, e.clientY, { dragging: true }); });
  wrap.addEventListener('pointerup', (e) => {
    if (e.pointerId !== drag) return;
    end();
    if (wheelPolar(e.clientX, e.clientY).d > 150) wheel.pickFocused();
  });
  wrap.addEventListener('pointercancel', end); // e.g. the page started scrolling on a phone
}

// Jam mode: the cursor is captured (pointer lock) and mouse movement drives a virtual stick, so a
// small flick toward a song highlights it and a click anywhere picks it. Tab (or Esc) exits.
const jam = { on: false, vx: 0, vy: 0, fx: null, lastScroll: 0 };
const JAM_RADIUS = 90, JAM_DEADZONE = 28;
function enterJam() {
  if (jam.on || !document.documentElement.requestPointerLock || !matchMedia('(pointer: fine)').matches) return;
  E.ensureCtx();
  const p = document.documentElement.requestPointerLock();
  if (p && p.catch) p.catch(() => toast('Mouse capture was blocked. Point toward a song and click instead'));
}
// Some embedded browsers forbid pointer lock outright; don't offer a button that can't work.
const jamAllowed = () => !document.featurePolicy || document.featurePolicy.allowsFeature('pointer-lock');
const exitJam = () => { if (document.pointerLockElement) document.exitPointerLock(); };
function bindJam() {
  if (!jamAllowed()) { $('#jamBtn').hidden = true; return; }
  $('#jamBtn').addEventListener('click', () => (jam.on ? exitJam() : enterJam()));
  // Clicking empty space around the wheel and panels also enters, like stepping up to the deck.
  $('#app').addEventListener('click', (e) => { if (e.target.matches('.app, .left, .right')) enterJam(); });
  document.addEventListener('pointerlockchange', () => {
    jam.on = !!document.pointerLockElement;
    jam.vx = jam.vy = 0;
    document.body.classList.toggle('jamming', jam.on);
    if (!jam.on) { fHeld = false; fxRelease(); }
  });
  addEventListener('mousemove', (e) => {
    if (!jam.on) return;
    jam.vx += e.movementX;
    jam.vy += e.movementY;
    const m = Math.hypot(jam.vx, jam.vy);
    if (m > JAM_RADIUS) { jam.vx *= JAM_RADIUS / m; jam.vy *= JAM_RADIUS / m; }
    if (m > JAM_DEADZONE) wheel.focusAngle(Math.atan2(jam.vx, -jam.vy) * 180 / Math.PI, { fromPointer: true });
  });
  // Hold, flick through the songs, let go to pick.
  addEventListener('mousedown', (e) => { if (jam.on) e.preventDefault(); });
  addEventListener('mouseup', (e) => {
    if (!jam.on || e.button !== 0) return;
    if (wheel.pickable) wheel.pickFocused();
    else if (!wheel.focused) toast('Move the mouse toward a song, then let go');
  });
  // In the jam a click only ever picks the highlighted song: never let it also reach whatever
  // sits under the (hidden) cursor.
  addEventListener('click', (e) => { if (jam.on) { e.stopPropagation(); e.preventDefault(); } }, true);
  // Scroll steps the highlight one song at a time.
  addEventListener('wheel', (e) => {
    if (!jam.on) return;
    e.preventDefault();
    if (performance.now() - jam.lastScroll < 120 || !e.deltaY) return;
    jam.lastScroll = performance.now();
    wheel.move(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}

// ---------- keyboard: Space layer, F FX, Z/C tempo, A/D albums, Q/E pick FX, Tab exit ----------
let fHeld = false;
function bindKeys() {
  addEventListener('keydown', (e) => {
    document.body.classList.remove('pad');
    if ($('#help').open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') { // Exit Jam; outside the jam Tab keeps moving focus as usual
      if (jam.on) { e.preventDefault(); exitJam(); }
      return;
    }
    if (e.target.matches('select, textarea, input:not([type="range"])')) return;
    const inField = e.target.matches('input');
    if (inField && e.key.startsWith('Arrow')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'f') {
      e.preventDefault();
      if (!e.repeat && !fHeld) { fHeld = true; fxEngage(); }
      return;
    }
    // Holding a toggle key would re-fire it (add/remove/add, a burst of random mixes); tempo and
    // arrow keys repeat on purpose.
    if (e.repeat && !/^(Arrow|[zc\-+=_])/.test(k)) { e.preventDefault(); return; }
    const actions = {
      ' ': () => cycleLayer(1),
      1: () => setLayer('groove'), 2: () => setLayer('lead'), 3: () => setLayer('texture'),
      z: () => E.setBpm(state.bpm - 1), c: () => E.setBpm(state.bpm + 1),
      a: () => setAlbum(ui.album - 1), d: () => setAlbum(ui.album + 1),
      q: () => cycleFx(-1), e: () => cycleFx(1),
      ArrowLeft: () => wheel.move(-1), ArrowUp: () => wheel.move(-1),
      ArrowRight: () => wheel.move(1), ArrowDown: () => wheel.move(1),
      Enter: () => { if (!e.target.closest('button, a, .seg') && wheel.focused) wheel.pickFocused(); else return false; },
      p: () => E.togglePlay(), r: () => E.randomize(),
      m: () => state.layers[ui.layer].song && E.setMuted(ui.layer, !state.layers[ui.layer].muted),
      Backspace: () => E.clearLayer(ui.layer), Delete: () => E.clearLayer(ui.layer),
      '+': () => E.setBpm(state.bpm + 1), '=': () => E.setBpm(state.bpm + 1),
      '-': () => E.setBpm(state.bpm - 1), '_': () => E.setBpm(state.bpm - 1),
      '?': () => { exitJam(); $('#help').showModal(); }, h: () => { exitJam(); $('#help').showModal(); },
    };
    if (actions[k] && actions[k]() !== false) e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (e.key === ' ') e.preventDefault(); // or a focused button would also be clicked
    if (e.key.toLowerCase() === 'f') { fHeld = false; fxRelease(); }
  });
}

// ---------- gamepad ----------
const prevButtons = [];
let padStickActive = false;
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find(Boolean);
  if (!gp) { // disconnected (battery, Bluetooth): don't leave FX held
    if (prevButtons[2]) fxRelease();
    prevButtons.length = 0;
    return;
  }
  const pressed = gp.buttons.map((b) => b.pressed);
  const down = (i) => pressed[i] && !prevButtons[i];
  if ($('#help').open) { // A, B or Start closes the help; nothing reaches the wheel behind it
    if (down(0) || down(1) || down(9)) $('#help').close();
    if (ui.fx.held && !pressed[2]) fxRelease(); // X let go while the help was up
    pressed.forEach((p, i) => (prevButtons[i] = p));
    return;
  }
  const [lx = 0, ly = 0, rx = 0, ry = 0] = gp.axes;
  if (pressed.some(Boolean) || Math.hypot(lx, ly) > 0.5 || Math.hypot(rx, ry) > 0.5) document.body.classList.add('pad');

  if (Math.hypot(lx, ly) > 0.55) { wheel.focusAngle(Math.atan2(lx, -ly) * 180 / Math.PI); padStickActive = true; }
  else if (padStickActive && Math.hypot(lx, ly) < 0.2) padStickActive = false;

  if (down(0)) wheel.pickFocused();
  if (down(1)) E.clearLayer(ui.layer);
  if (down(3)) cycleLayer(1);
  if (down(4)) setAlbum(ui.album - 1);
  if (down(5)) setAlbum(ui.album + 1);
  if (down(12)) E.setBpm(state.bpm + 1);
  if (down(13)) E.setBpm(state.bpm - 1);
  if (down(14)) wheel.move(-1);
  if (down(15)) wheel.move(1);
  if (down(9)) {
    E.togglePlay();
    if (E.ctx && E.ctx.state !== 'running') toast('Click or press any key to turn the sound on');
  }
  if (down(8)) E.randomize();
  if (down(6)) cycleFx(-1); // LT / RT choose the effect, X plays it
  if (down(7)) cycleFx(1);
  if (pressed[2]) fxEngage();
  else if (prevButtons[2]) fxRelease();
  pressed.forEach((p, i) => (prevButtons[i] = p));
}

// ---------- share links (compatible with the original app's format) ----------
const SLOT_LETTERS = { g: 'groove', l: 'lead', t: 'texture' };
let restoring = false, hashTimer;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(updateHash, 300); }
function updateHash() {
  if (restoring) return;
  const p = new URLSearchParams();
  for (const [letter, id] of Object.entries(SLOT_LETTERS)) {
    const s = state.layers[id];
    if (s.song) p.set(letter, E.MANIFEST[s.song].code);
    if (Math.round(s.volume * 100) !== 85) p.set('v' + letter, Math.round(s.volume * 100));
    if (s.muted) p.set('m' + letter, 1);
  }
  if (E.activeLayers().length) p.set('bpm', state.bpm);
  if (!state.keyLock) p.set('lock', 0);
  if (state.masterKey !== 'auto') p.set('key', state.masterKey);
  const order = state.anchorOrder.map((id) => id[0]).join('');
  if (order) p.set('a', order);
  const str = p.toString();
  if (location.hash.slice(1) !== str) history.replaceState(null, '', str ? '#' + str : location.pathname + location.search);
}

async function restoreFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return false;
  const p = new URLSearchParams(raw);
  const codeToSong = new Map(Object.entries(E.MANIFEST).map(([song, info]) => [info.code, song])); // a Map: '#g=constructor' finds nothing
  restoring = true;
  try {
    const bpm = Number(p.get('bpm'));
    if (bpm >= E.BPM_MIN && bpm <= E.BPM_MAX) { state.bpm = Math.round(bpm); state.tempoTouched = true; }
    if (p.get('lock') === '0') state.keyLock = false;
    const key = p.get('key');
    if (key && Object.hasOwn(NOTE, key)) state.masterKey = NOTE_NAMES[NOTE[key]]; // Db, A# etc. -> the picker's spelling
    // Selection order matters: the first slot is the auto-key anchor.
    const order = [...new Set((p.get('a') || 'glt').split('').map((ch) => SLOT_LETTERS[ch]).filter(Boolean).concat(Object.values(SLOT_LETTERS)))];
    const loads = [];
    for (const id of order) {
      const letter = id[0], s = state.layers[id];
      const vol = Number(p.get('v' + letter));
      if (p.has('v' + letter) && vol >= 0 && vol <= 100) s.volume = vol / 100;
      if (p.get('m' + letter) === '1') s.muted = true;
      const song = codeToSong.get(p.get(letter));
      if (song) loads.push(E.selectStem(id, song, { noAutoplay: true, keepTempo: true }));
    }
    if (!loads.length) return false;
    const first = state.layers[order.find((id) => state.layers[id].song)];
    const i = ui.albums.indexOf(E.MANIFEST[first.song].album);
    if (i >= 0) setAlbum(i);
    toast('Loading shared mix…');
    await Promise.all(loads);
    if (!state.playing && !E.playPending()) toast('Shared mix ready — press Play');
    return true;
  } finally {
    restoring = false;
    render();
  }
}

async function shareMix() {
  updateHash();
  if (!E.activeLayers().length) { toast('Pick some stems first, then share'); return; }
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Mix link copied to clipboard');
  } catch (_) {
    toast('Copy the address bar URL to share this mix');
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------- boot ----------
async function boot() {
  $('#version').textContent = VERSION_LABEL;
  $('.ver-fine').textContent = `Version ${VERSION}`;
  try {
    await Promise.all([E.loadManifest('stems.json'), loadCovers()]);
  } catch (err) {
    console.error(err);
    toast('Could not load stems.json — run tools/build-stems.mjs first', 'error');
    return;
  }
  if (!Object.keys(E.MANIFEST).length) {
    toast(E.LOCAL ? 'No stems found: check the Stems folder shown in the server window' : 'No stems listed in stems.json', 'error');
    return;
  }
  buildHub();
  buildAlbums();
  buildLayers();
  buildControls();
  bindFx();
  bindKeys();
  bindJam();
  bindWheelDrag();
  addEventListener('gamepadconnected', () => { document.body.classList.add('pad'); toast('Controller connected'); });
  addEventListener('gamepaddisconnected', () => fxRelease());
  // Browsers only start audio after a click or key press (a controller doesn't count), and a
  // share link builds the mix before any. Wake the audio on the first one, whatever it is.
  const wake = () => { if (E.ctx && E.ctx.state !== 'running') E.ctx.resume().catch(() => {}); };
  ['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, wake, { capture: true }));

  const helpEl = $('#help');
  createStage($('#stage'), () => {
    const m = E.meters();
    tickClock(m);
    pollGamepad();
    const active = {};
    for (const l of LAYERS) { const s = state.layers[l.id]; active[l.id] = !!(s.song && s.source && !s.muted && state.playing); }
    const lead = LAYERS.map((l) => state.layers[l.id].song).find(Boolean); // the first filled layer sets the album
    return { meters: m, active, playing: state.playing, bpm: state.bpm, fx: ui.fx.amount, fxX: ui.fx.x, zone: ui.zone, open: ui.open, paused: helpEl.open, album: lead ? E.MANIFEST[lead].album : null };
  });
  // The stage centres its pyramid over the open area between the side panels; when the panels
  // are stacked (phones, portrait) that's the whole width.
  const measureZone = () => {
    const wheel = $('#wheelWrap').getBoundingClientRect(), left = $('.left').getBoundingClientRect();
    ui.zone = Math.max(0.3, wheel.left / innerWidth);
    ui.open = left.right < wheel.left ? [left.right / innerWidth, wheel.left / innerWidth] : [0, 1];
  };
  addEventListener('resize', measureZone);
  measureZone();

  const ram = ui.albums.indexOf('ram');
  setAlbum(ram >= 0 ? ram : 0);
  // The app rewrites the hash with replaceState (no event), so this only fires when someone
  // pastes another share link into the address bar, even while this one loads: load that mix.
  addEventListener('hashchange', () => location.reload());
  const restored = await restoreFromHash().catch((err) => { console.error('share restore failed', err); return false; });
  if (!restored) {
    let seen = false;
    try { seen = localStorage.getItem('dcr-seen-help') === '1'; localStorage.setItem('dcr-seen-help', '1'); } catch (_) { /* private mode */ }
    if (!seen) $('#help').showModal();
  }
}
boot();
