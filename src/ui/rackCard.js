// @ts-check
/**
 * Rack position card: one of the four jam positions (vocals/drums/bass/lead).
 * Contains a source-track picker, mute/solo toggles, a volume slider, a live
 * level meter (fed from the shared visual ticker), an "adjusting…" badge, and
 * a clear empty state. Presentation only — all audio behavior lives in
 * jamRack.js.
 */

const GLYPHS = {
  vocals: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a6 6 0 0 0 12 0h2a8 8 0 0 1-7 7.94V22h-2v-2.06A8 8 0 0 1 4 12h2Z',
  drums: 'M12 4c4.97 0 9 1.34 9 3v10c0 1.66-4.03 3-9 3s-9-1.34-9-3V7c0-1.66 4.03-3 9-3Zm7 5.2C17.36 10.28 14.82 10.8 12 10.8S6.64 10.28 5 9.2V17c.3.9 3.28 2 7 2s6.7-1.1 7-2V9.2Z',
  bass: 'M5 4h2v10.35A3.5 3.5 0 1 1 5 17V4Zm9 0h2v6.35A3.5 3.5 0 1 1 14 13V4h0Z',
  lead: 'M3 17.5 9 4l3.5 8L15 7l6 10.5h-4L15 13l-2 4.5h-3L8 10l-2.5 7.5H3Z',
};

/**
 * @typedef {{ id: string, title: string, disabled: boolean }} PickerOption
 *
 * @param {HTMLElement} container
 * @param {{
 *   role: import('../audio/jamRack.js').Role,
 *   onPick?: (trackId: string | null) => void,
 *   onMute?: (muted: boolean) => void,
 *   onSolo?: (soloed: boolean) => void,
 *   onVolume?: (volume: number) => void,
 *   onFocusRequest?: () => void,
 * }} opts
 */
export function createRackCard(container, opts) {
  const { role } = opts;

  const el = document.createElement('section');
  el.className = `rack-card panel rack-card--${role}`;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', `${role} position`);
  el.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'rack-card__head';
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('viewBox', '0 0 24 24');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.classList.add('rack-card__glyph');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', GLYPHS[role]);
  path.setAttribute('fill', 'currentColor');
  glyph.append(path);
  const name = document.createElement('span');
  name.className = 'rack-card__role';
  name.textContent = role;
  const badge = document.createElement('span');
  badge.className = 'rack-card__badge';
  badge.textContent = 'adjusting…';
  badge.hidden = true;
  head.append(glyph, name, badge);

  const picker = document.createElement('select');
  picker.className = 'rack-card__picker';
  picker.setAttribute('aria-label', `Source track for ${role}`);

  const meterWrap = document.createElement('div');
  meterWrap.className = 'rack-card__meter';
  meterWrap.setAttribute('aria-hidden', 'true');
  const meterFill = document.createElement('div');
  meterFill.className = 'rack-card__meter-fill';
  meterWrap.append(meterFill);

  const controls = document.createElement('div');
  controls.className = 'rack-card__controls';

  const muteBtn = toggleBtn('M', `Mute ${role}`);
  const soloBtn = toggleBtn('S', `Solo ${role}`);

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'rack-card__volume';
  volume.min = '0';
  volume.max = '120';
  volume.step = '1';
  volume.value = '100';
  volume.setAttribute('aria-label', `${role} volume`);
  volume.setAttribute('aria-valuetext', '100%');

  controls.append(muteBtn, soloBtn, volume);

  const empty = document.createElement('div');
  empty.className = 'rack-card__empty';
  empty.textContent = 'Empty — pick a track';

  el.append(head, picker, meterWrap, controls, empty);
  container.append(el);

  /** @param {string} label @param {string} aria */
  function toggleBtn(label, aria) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rack-card__toggle';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.setAttribute('aria-pressed', 'false');
    return b;
  }

  picker.addEventListener('change', () => opts.onPick?.(picker.value || null));
  muteBtn.addEventListener('click', () => {
    const next = muteBtn.getAttribute('aria-pressed') !== 'true';
    opts.onMute?.(next);
  });
  soloBtn.addEventListener('click', () => {
    const next = soloBtn.getAttribute('aria-pressed') !== 'true';
    opts.onSolo?.(next);
  });
  volume.addEventListener('input', () => {
    volume.setAttribute('aria-valuetext', `${volume.value}%`);
    opts.onVolume?.(Number(volume.value) / 100);
  });
  el.addEventListener('pointerdown', () => opts.onFocusRequest?.());
  el.addEventListener('focusin', () => opts.onFocusRequest?.());

  let lastLevel = -1;

  return {
    el,
    role,
    /**
     * Rebuild the source picker. Options with no stem for this role come
     * disabled/greyed.
     * @param {PickerOption[]} tracks @param {string | null} selectedId
     */
    setTracks(tracks, selectedId) {
      picker.replaceChildren(new Option('— empty —', ''));
      for (const t of tracks) {
        const option = new Option(t.title, t.id);
        option.disabled = t.disabled;
        if (t.disabled) option.textContent = `${t.title} (no ${role})`;
        picker.append(option);
      }
      picker.value = selectedId ?? '';
    },
    /** @param {ReturnType<import('../audio/jamRack.js').JamRack['getPosition']>} snap */
    update(snap) {
      el.classList.toggle('is-empty', !snap.trackId);
      el.classList.toggle('is-audible', snap.audible);
      empty.hidden = Boolean(snap.trackId);
      badge.hidden = !snap.adjusting;
      muteBtn.setAttribute('aria-pressed', String(snap.muted));
      muteBtn.classList.toggle('is-on', snap.muted);
      soloBtn.setAttribute('aria-pressed', String(snap.soloed));
      soloBtn.classList.toggle('is-on', snap.soloed);
      if (picker.value !== (snap.trackId ?? '')) picker.value = snap.trackId ?? '';
      if (Math.round(snap.volume * 100) !== Number(volume.value)) {
        volume.value = String(Math.round(snap.volume * 100));
      }
    },
    /** Level meter, driven from the shared ticker. @param {number} v 0..1 */
    setLevel(v) {
      const q = Math.round(v * 40) / 40; // quantize to skip pointless style writes
      if (q === lastLevel) return;
      lastLevel = q;
      meterFill.style.transform = `scaleX(${q})`;
    },
    /** @param {boolean} focused */
    setFocused(focused) {
      el.classList.toggle('is-focused', focused);
    },
    focus() {
      el.focus();
    },
  };
}
