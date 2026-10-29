import * as E from './engine.js';
import { state, LAYERS, NOTE, NOTE_NAMES, prettyKey } from './engine.js';
import { ALBUMS, albumById, songsForAlbum, displayName, albumArtUnique, LAYER_ICONS } from './catalog.js';
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
  fx: { held: false, x: 0, y: 0, amount: 0, ox: 0, oy: 0 },
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
  const label = layerDef(ui.layer).label;
  if (!E.stemTypeFor(ui.layer, song)) {
    const other = LAYERS.find((l) => E.stemTypeFor(l.id, song));
    toast(`${displayName(song)} has no ${label} stem${other ? ` — try it as ${other.label}` : ''}`);
    return;
  }
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
  hub.dataset.layer = ui.layer;
  hub.classList.toggle('peek', !!ui.peek);
  $('#hubCats').querySelectorAll('.hub-cat').forEach((b) => b.setAttribute('aria-selected', b.dataset.layer === ui.layer));
  const title = $('#hubTitle'), sub = $('#hubSub');
  if (ui.peek) {
    const info = E.MANIFEST[ui.peek];
    title.textContent = displayName(ui.peek);
    const meta = `${prettyKey(info.key)} · ${info.bpm} BPM`;
    if (!E.stemTypeFor(ui.layer, ui.peek)) sub.innerHTML = `${meta}<br>No ${def.label} stem`;
    else if (s.song === ui.peek) sub.innerHTML = `${meta}<br><b>Playing</b> · pick again to remove`;
    else sub.innerHTML = `${meta}<br>Add as <b>${def.label}</b>`;
  } else {
    $('#hubIcon').innerHTML = LAYER_ICONS[ui.layer];
    title.textContent = def.label;
    sub.textContent = s.song ? displayName(s.song) : `Pick a ${def.label.toLowerCase()}`;
  }
}

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
  $('#albumName').innerHTML = `<b>${album.name}</b> · ${album.year || ''} · ${songs.length} tracks`;
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
    li.classList.toggle('loading', s.loading);
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
    song.textContent = displayName(s.song) + (s.type === 'all' ? ' (full mix)' : '');
    sub.textContent = s.loading
      ? (s.progress < 1 ? `Loading… ${Math.round((s.progress || 0) * 100)}%` : 'Syncing to tempo…')
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
      e.preventDefault();
      step(d);
      const repeat = (delay) => { timer = setTimeout(() => { step(d); repeat(70); }, delay); };
      repeat(420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $(btn).addEventListener(ev, stopRepeat));
    $(btn).addEventListener('keydown', (e) => { if (e.key === 'Enter') step(d); });
  }
  $('.tempo').addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); }, { passive: false });

  const sel = $('#masterKey');
  sel.innerHTML = '<option value="auto">Auto</option>' + NOTE_NAMES.map((n) => `<option value="${n}">${prettyKey(n)}</option>`).join('');
  sel.onchange = () => { E.ensureCtx(); E.setMasterKey(sel.value); scheduleHash(); };
  $('#keyLockBtn').onclick = () => { E.ensureCtx(); E.setKeyLock(!state.keyLock); scheduleHash(); };

  const mv = $('#masterVol');
  mv.addEventListener('input', () => { E.setMasterVolume(Number(mv.value)); paintRange(mv); });
  paintRange(mv);

  $('#playBtn').onclick = () => E.togglePlay();
  $('#randomBtn').onclick = () => E.randomize();
  $('#recBtn').onclick = () => E.toggleRecord(download);
  $('#exportBtn').onclick = () => {
    const blob = E.exportLoopWav();
    if (blob) { download(blob, 'dream-chamber-loop.wav'); toast('Exported one 32-bar loop'); }
  };
  $('#shareBtn').onclick = shareMix;
  $('#helpBtn').onclick = () => $('#help').showModal();
}

function renderControls() {
  $('#bpmOut').textContent = state.bpm;
  const anyLoading = E.activeLayers().some((id) => state.layers[id].loading);
  $('.tempo').classList.toggle('pending', anyLoading);
  $('#tempoSub').textContent = anyLoading ? 'Syncing…' : 'BPM';
  $('#masterKey').value = state.masterKey;
  $('#masterKey').disabled = !state.keyLock;
  $('#keyLockBtn').setAttribute('aria-pressed', state.keyLock);
  const mr = E.masterRoot();
  $('#keySub').textContent = !state.keyLock ? 'Off · native keys'
    : state.masterKey !== 'auto' ? 'Locked'
    : mr === null ? 'Auto' : `Auto · ${prettyKey(NOTE_NAMES[mr])}`;
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

// ---------- Audio FX (hold) ----------
function fxEngage(x, y) {
  E.ensureCtx();
  ui.fx.held = true;
  ui.fx.ox = x; ui.fx.oy = y;
  const pad = $('#fxPad');
  pad.style.setProperty('--ox', `${x}px`);
  $('.fx-axis-x', pad).style.top = `${y}px`;
  $('.fx-axis-y', pad).style.left = `${x}px`;
  pad.classList.add('on');
  $('#fxBtn').classList.add('held');
  fxMove(x, y);
}
function fxMove(px, py) {
  if (!ui.fx.held) return;
  const span = Math.min(innerWidth, innerHeight) * 0.4;
  let x = Math.max(-1, Math.min(1, (px - ui.fx.ox) / span));
  const y = Math.max(0, Math.min(1, (ui.fx.oy - py) / span));
  if (Math.abs(x) < 0.05) x = 0;
  setFxValues(x, y);
  const dot = $('#fxDot');
  dot.style.setProperty('--x', `${ui.fx.ox + x * span}px`);
  dot.style.setProperty('--y', `${ui.fx.oy - y * span}px`);
}
function setFxValues(x, y) {
  ui.fx.x = x; ui.fx.y = y;
  ui.fx.amount = Math.min(1, Math.abs(x) + y * 0.6);
  E.setFx(x, y);
}
function fxRelease() {
  if (!ui.fx.held) return;
  ui.fx.held = false;
  ui.fx.amount = 0;
  $('#fxPad').classList.remove('on');
  $('#fxBtn').classList.remove('held');
  E.releaseFx();
}
function bindFx() {
  const btn = $('#fxBtn');
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    fxEngage(e.clientX, e.clientY);
  });
  btn.addEventListener('pointermove', (e) => fxMove(e.clientX, e.clientY));
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, fxRelease));
  btn.addEventListener('click', (e) => e.preventDefault());
  addEventListener('pointermove', (e) => {
    ui.mouse.x = e.clientX; ui.mouse.y = e.clientY;
    if (e.pointerType === 'mouse') document.body.classList.remove('pad');
    if (spaceHeld) fxMove(e.clientX, e.clientY);
  });
  addEventListener('blur', fxRelease);
}

// ---------- keyboard ----------
let spaceHeld = false;
function bindKeys() {
  addEventListener('keydown', (e) => {
    document.body.classList.remove('pad');
    if ($('#help').open || e.ctrlKey || e.metaKey || e.altKey) return;
    const inField = e.target.matches('input, select, textarea');
    if (e.key === ' ') {
      if (e.target.matches('select, textarea')) return;
      e.preventDefault();
      if (!e.repeat && !spaceHeld) { spaceHeld = true; fxEngage(ui.mouse.x, ui.mouse.y); }
      return;
    }
    if (inField && e.key.startsWith('Arrow')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const actions = {
      1: () => setLayer('groove'), 2: () => setLayer('lead'), 3: () => setLayer('texture'),
      c: () => cycleLayer(1),
      q: () => setAlbum(ui.album - 1), e: () => setAlbum(ui.album + 1),
      ArrowLeft: () => wheel.move(-1), ArrowUp: () => wheel.move(-1),
      ArrowRight: () => wheel.move(1), ArrowDown: () => wheel.move(1),
      Enter: () => { if (!e.target.closest('button, a, .seg') && wheel.focused) wheel.pickFocused(); else return false; },
      p: () => E.togglePlay(), r: () => E.randomize(),
      m: () => state.layers[ui.layer].song && E.setMuted(ui.layer, !state.layers[ui.layer].muted),
      Backspace: () => E.clearLayer(ui.layer), Delete: () => E.clearLayer(ui.layer),
      '+': () => E.setBpm(state.bpm + 1), '=': () => E.setBpm(state.bpm + 1),
      '-': () => E.setBpm(state.bpm - 1), '_': () => E.setBpm(state.bpm - 1),
      '?': () => $('#help').showModal(), h: () => $('#help').showModal(),
    };
    if (actions[k] && actions[k]() !== false) e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceHeld = false; fxRelease(); }
  });
}

// ---------- gamepad ----------
const prevButtons = [];
let padStickActive = false;
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find(Boolean);
  if (!gp) return;
  const pressed = gp.buttons.map((b) => b.pressed);
  const down = (i) => pressed[i] && !prevButtons[i];
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
  if (down(9)) E.togglePlay();
  if (down(8)) E.randomize();
  if (pressed[2]) {
    if (!ui.fx.held) { E.ensureCtx(); ui.fx.held = true; $('#fxBtn').classList.add('held'); }
    setFxValues(Math.abs(rx) < 0.08 ? 0 : rx, Math.max(0, -ry));
  } else if (prevButtons[2]) fxRelease();
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
  const codeToSong = Object.fromEntries(Object.entries(E.MANIFEST).map(([song, info]) => [info.code, song]));
  restoring = true;
  try {
    const bpm = Number(p.get('bpm'));
    if (bpm >= E.BPM_MIN && bpm <= E.BPM_MAX) { state.bpm = Math.round(bpm); state.tempoTouched = true; }
    if (p.get('lock') === '0') state.keyLock = false;
    const key = p.get('key');
    if (key && NOTE[key] !== undefined) state.masterKey = key;
    // Selection order matters: the first slot is the auto-key anchor.
    const order = [...new Set((p.get('a') || 'glt').split('').map((ch) => SLOT_LETTERS[ch]).filter(Boolean).concat(Object.values(SLOT_LETTERS)))];
    const loads = [];
    for (const id of order) {
      const letter = id[0], s = state.layers[id];
      const vol = Number(p.get('v' + letter));
      if (p.has('v' + letter) && vol >= 0 && vol <= 100) s.volume = vol / 100;
      if (p.get('m' + letter) === '1') s.muted = true;
      const song = codeToSong[p.get(letter)];
      if (song) loads.push(E.selectStem(id, song, { noAutoplay: true, keepTempo: true }));
    }
    if (!loads.length) return false;
    const first = state.layers[order.find((id) => state.layers[id].song)];
    const i = ui.albums.indexOf(E.MANIFEST[first.song].album);
    if (i >= 0) setAlbum(i);
    toast('Shared mix loaded — press Play');
    await Promise.all(loads);
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
    await E.loadManifest('stems.json');
  } catch (err) {
    console.error(err);
    toast('Could not load stems.json — run tools/build-stems.mjs first', 'error');
    return;
  }
  buildHub();
  buildAlbums();
  buildLayers();
  buildControls();
  bindFx();
  bindKeys();
  addEventListener('gamepadconnected', () => { document.body.classList.add('pad'); toast('Controller connected'); });

  createStage($('#stage'), () => {
    const m = E.meters();
    tickClock(m);
    pollGamepad();
    const active = {};
    for (const l of LAYERS) { const s = state.layers[l.id]; active[l.id] = !!(s.song && s.source && !s.muted && state.playing); }
    return { meters: m, active, playing: state.playing, bpm: state.bpm, fx: ui.fx.amount, fxX: ui.fx.x, zone: ui.zone };
  });
  const measureZone = () => { ui.zone = Math.max(0.3, $('#wheelWrap').getBoundingClientRect().left / innerWidth); };
  addEventListener('resize', measureZone);
  measureZone();

  const ram = ui.albums.indexOf('ram');
  setAlbum(ram >= 0 ? ram : 0);
  const restored = await restoreFromHash().catch((err) => { console.error('share restore failed', err); return false; });
  if (!restored) {
    let seen = false;
    try { seen = localStorage.getItem('dcr-seen-help') === '1'; localStorage.setItem('dcr-seen-help', '1'); } catch (_) { /* private mode */ }
    if (!seen) $('#help').showModal();
  }
}
boot();
