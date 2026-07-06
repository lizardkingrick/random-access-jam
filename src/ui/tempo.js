// @ts-check
/**
 * Master transport strip: Play/Stop for the whole rack, master BPM
 * (readout + slider + steppers, 90–157), master key selector (root + mode),
 * and a playing/adjusting status indicator. This drives the Transport — the
 * old per-deck playbackRate tempo UI is gone.
 */

import { BPM_MIN, BPM_MAX } from '../audio/transport.js';

const KEY_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * @param {HTMLElement} container
 * @param {{
 *   onPlayStop?: () => void,
 *   onBpm?: (bpm: number) => void,
 *   onKey?: (key: string) => void,
 * }} [opts]
 */
export function createTransportStrip(container, opts = {}) {
  let bpm = 120;
  let playing = false;

  const el = document.createElement('div');
  el.className = 'strip panel';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Master transport');

  // ----- play / stop -----
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'strip__play';
  playBtn.addEventListener('click', () => opts.onPlayStop?.());

  // ----- BPM cluster -----
  const bpmWrap = document.createElement('div');
  bpmWrap.className = 'strip__bpm';

  const bpmLabel = document.createElement('span');
  bpmLabel.className = 'hud-label';
  bpmLabel.textContent = 'Master BPM';

  const bpmRow = document.createElement('div');
  bpmRow.className = 'strip__bpm-row';

  const minus = stepBtn('−', 'Slow down master tempo');
  const bpmValue = document.createElement('span');
  bpmValue.className = 'strip__bpm-value';
  bpmValue.setAttribute('aria-live', 'off');
  const plus = stepBtn('+', 'Speed up master tempo');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'strip__slider';
  slider.min = String(BPM_MIN);
  slider.max = String(BPM_MAX);
  slider.step = '1';
  slider.setAttribute('aria-label', 'Master BPM');

  bpmRow.append(minus, bpmValue, plus);
  bpmWrap.append(bpmLabel, bpmRow, slider);

  // ----- key cluster -----
  const keyWrap = document.createElement('div');
  keyWrap.className = 'strip__key';
  const keyLabel = document.createElement('span');
  keyLabel.className = 'hud-label';
  keyLabel.textContent = 'Master key';
  const keyRow = document.createElement('div');
  keyRow.className = 'strip__key-row';
  const rootSel = document.createElement('select');
  rootSel.setAttribute('aria-label', 'Master key root');
  for (const r of KEY_ROOTS) rootSel.append(new Option(r, r));
  const modeSel = document.createElement('select');
  modeSel.setAttribute('aria-label', 'Master key mode');
  modeSel.append(new Option('major'), new Option('minor'));
  keyRow.append(rootSel, modeSel);
  keyWrap.append(keyLabel, keyRow);

  // ----- status -----
  const status = document.createElement('div');
  status.className = 'strip__status';
  status.setAttribute('role', 'status');
  const statusDot = document.createElement('span');
  statusDot.className = 'strip__status-dot';
  const statusText = document.createElement('span');
  status.append(statusDot, statusText);

  el.append(playBtn, bpmWrap, keyWrap, status);
  container.append(el);

  // ----- behavior -----

  /** @param {string} txt @param {string} label */
  function stepBtn(txt, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'strip__step';
    b.textContent = txt;
    b.setAttribute('aria-label', label);
    return b;
  }

  function renderBpm() {
    bpmValue.textContent = String(bpm);
    slider.value = String(bpm);
    minus.disabled = bpm <= BPM_MIN;
    plus.disabled = bpm >= BPM_MAX;
  }

  function renderPlay() {
    playBtn.textContent = playing ? '■' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Stop the rack' : 'Play the rack');
    playBtn.classList.toggle('is-playing', playing);
  }

  /** @param {number} next @param {boolean} notify */
  function setBpmInternal(next, notify) {
    bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(next)));
    renderBpm();
    if (notify) opts.onBpm?.(bpm);
  }

  minus.addEventListener('click', () => setBpmInternal(bpm - 1, true));
  plus.addEventListener('click', () => setBpmInternal(bpm + 1, true));
  // Live readout while dragging; commit (and re-conform) on release.
  slider.addEventListener('input', () => {
    bpmValue.textContent = slider.value;
  });
  slider.addEventListener('change', () => setBpmInternal(Number(slider.value), true));

  const emitKey = () => opts.onKey?.(`${rootSel.value} ${modeSel.value}`);
  rootSel.addEventListener('change', emitKey);
  modeSel.addEventListener('change', emitKey);

  renderBpm();
  renderPlay();

  return {
    el,
    get bpm() {
      return bpm;
    },
    /** @param {number} next */
    setBpm(next) {
      setBpmInternal(next, false);
    },
    /** @param {string} key e.g. "A minor" */
    setKey(key) {
      const [root, mode] = key.split(' ');
      if (KEY_ROOTS.includes(root)) rootSel.value = root;
      if (mode === 'major' || mode === 'minor') modeSel.value = mode;
    },
    /** @param {boolean} next */
    setPlaying(next) {
      playing = next;
      renderPlay();
    },
    /** @param {'stopped' | 'playing' | 'adjusting'} state */
    setStatus(state) {
      statusText.textContent =
        state === 'adjusting' ? 'adjusting…' : state === 'playing' ? 'playing' : 'stopped';
      statusDot.dataset.state = state;
    },
  };
}
