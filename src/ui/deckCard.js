// @ts-check
/** Deck slot card: accent bar, metadata, waveform, transport controls. */

import { createWaveform, placeholderPeaks } from './waveform.js';

const ICONS = {
  play: 'M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.04 1.04 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14Z',
  pause: 'M7 5h3.5v14H7V5Zm6.5 0H17v14h-3.5V5Z',
  mute: 'M4 9v6h4l5 4V5L8 9H4Zm12.6 3 2.5-2.5-1.4-1.4-2.5 2.5-2.5-2.5-1.4 1.4L13.8 12l-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4-2.5-2.5Z',
  sound: 'M4 9v6h4l5 4V5L8 9H4Zm11.5 3a3.5 3.5 0 0 0-2-3.15v6.3a3.5 3.5 0 0 0 2-3.15Zm-2-7v2.1a5 5 0 0 1 0 9.8V19a7 7 0 0 0 0-14Z',
  eject: 'M5 17h14v2.5H5V17Zm7-12 7 9H5l7-9Z',
};

/** @param {keyof typeof ICONS} name */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** @param {number} seconds */
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   deckId: 'a' | 'b',
 *   color: string,
 *   onPlayPause?: () => void,
 *   onMute?: () => void,
 *   onEject?: () => void,
 *   onSeek?: (fraction: number) => void,
 * }} opts
 */
export function createDeckCard(container, opts) {
  const name = `Deck ${opts.deckId.toUpperCase()}`;

  const el = document.createElement('section');
  el.className = `deck-card panel deck-card--${opts.deckId}`;
  el.setAttribute('aria-label', name);

  const accent = document.createElement('div');
  accent.className = 'deck-card__accent';

  const body = document.createElement('div');
  body.className = 'deck-card__body';

  const head = document.createElement('div');
  head.className = 'deck-card__head';
  const tag = document.createElement('span');
  tag.className = 'deck-card__tag';
  tag.textContent = name;
  const title = document.createElement('span');
  title.className = 'deck-card__title';
  head.append(tag, title);

  const meta = document.createElement('div');
  meta.className = 'deck-card__meta';

  const waveWrap = document.createElement('div');
  waveWrap.className = 'deck-card__wave';
  const waveform = createWaveform(waveWrap, {
    color: opts.color,
    onSeek: (f) => opts.onSeek?.(f),
  });
  waveform.canvas.setAttribute('role', 'slider');
  waveform.canvas.setAttribute('aria-label', `${name} playback position`);
  waveform.canvas.setAttribute('aria-valuemin', '0');
  waveform.canvas.setAttribute('aria-valuemax', '100');
  waveform.canvas.tabIndex = 0;

  const controls = document.createElement('div');
  controls.className = 'deck-card__controls';

  /** @param {string} label */
  const makeBtn = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.setAttribute('aria-label', label);
    return b;
  };

  const playBtn = makeBtn(`Play ${name}`);
  playBtn.append(icon('play'));
  const muteBtn = makeBtn(`Mute ${name}`);
  muteBtn.setAttribute('aria-pressed', 'false');
  muteBtn.append(icon('sound'));
  const ejectBtn = makeBtn(`Eject track from ${name}`);
  ejectBtn.append(icon('eject'));

  const time = document.createElement('span');
  time.className = 'deck-card__time';
  time.textContent = '0:00 / 0:00';

  controls.append(playBtn, muteBtn, ejectBtn, time);
  body.append(head, meta, waveWrap, controls);
  el.append(accent, body);
  container.append(el);

  playBtn.addEventListener('click', () => opts.onPlayPause?.());
  muteBtn.addEventListener('click', () => opts.onMute?.());
  ejectBtn.addEventListener('click', () => opts.onEject?.());

  let hasTrack = false;

  function setEmpty() {
    hasTrack = false;
    title.textContent = 'No track loaded';
    meta.textContent = 'Pick a track from the wheel';
    waveform.setPeaks(placeholderPeaks());
    waveform.setProgress(0);
    waveform.render();
    time.textContent = '0:00 / 0:00';
    playBtn.disabled = true;
    ejectBtn.disabled = true;
  }

  setEmpty();

  return {
    el,
    waveform,
    deckId: opts.deckId,
    get hasTrack() {
      return hasTrack;
    },
    /** @param {{ title: string, artist?: string } | null} track */
    setTrack(track) {
      if (!track) {
        setEmpty();
        return;
      }
      hasTrack = true;
      title.textContent = track.title;
      meta.textContent = track.artist || 'Local file';
      playBtn.disabled = false;
      ejectBtn.disabled = false;
    },
    /** @param {boolean} playing */
    setPlaying(playing) {
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${name}`);
    },
    /** @param {boolean} muted */
    setMuted(muted) {
      muteBtn.replaceChildren(icon(muted ? 'mute' : 'sound'));
      muteBtn.setAttribute('aria-pressed', String(muted));
      muteBtn.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} ${name}`);
    },
    /** @param {boolean} active whether this deck is the audible one */
    setActive(active) {
      el.classList.toggle('is-active', active);
    },
    /** @param {number} current seconds @param {number} duration seconds */
    setTime(current, duration) {
      time.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
      if (duration > 0) {
        waveform.canvas.setAttribute('aria-valuenow', String(Math.round((current / duration) * 100)));
        waveform.canvas.setAttribute(
          'aria-valuetext',
          `${fmtTime(current)} of ${fmtTime(duration)}`
        );
      }
    },
  };
}
