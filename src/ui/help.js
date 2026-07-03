// @ts-check
/** "?" help overlay: keyboard shortcuts, quick-start, and library management. */

const SHORTCUTS = [
  ['Space (hold)', 'Audio FX breakdown'],
  ['← / →', 'Nudge the crossfader'],
  ['Tab', 'Move between controls'],
  ['↑ ↓ ← → on the wheel', 'Browse tracks, Enter queues one'],
  ['← / → on a waveform', 'Seek ±5% (Home/End jump)'],
  ['Right-click / long-press a slot', 'Load to a specific deck'],
  ['?', 'Open this help'],
];

/**
 * @param {HTMLElement} root
 * @param {{ onClearLibrary?: () => void }} [opts]
 */
export function createHelp(root, opts = {}) {
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'help-btn panel';
  openBtn.textContent = '?';
  openBtn.setAttribute('aria-label', 'Help and keyboard shortcuts');
  root.append(openBtn);

  const overlay = document.createElement('div');
  overlay.className = 'help-overlay';
  overlay.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'help-dialog panel';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Help and keyboard shortcuts');

  dialog.innerHTML = `
    <h2 class="help-dialog__title">How to jam</h2>
    <p class="help-dialog__intro">
      Add tracks (or use the built-in demo loops), press play on a deck, then
      slide the crossfader toward the other deck to blend. Picking a track on
      the wheel queues it on the deck you're <em>not</em> hearing, so your mix
      never cuts out.
    </p>
    <h3 class="help-dialog__subtitle">Keyboard shortcuts</h3>
    <dl class="help-shortcuts">
      ${SHORTCUTS.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
    </dl>
    <h3 class="help-dialog__subtitle">Your library</h3>
    <p class="help-dialog__intro">
      Tracks are stored in this browser only — nothing is uploaded anywhere.
    </p>
  `;

  const actions = document.createElement('div');
  actions.className = 'help-dialog__actions';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'help-dialog__danger';
  clearBtn.textContent = 'Clear library (keeps demo loops)';
  clearBtn.addEventListener('click', () => opts.onClearLibrary?.());

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'help-dialog__close';
  closeBtn.textContent = 'Close';

  actions.append(clearBtn, closeBtn);
  dialog.append(actions);
  overlay.append(dialog);
  root.append(overlay);

  /** @type {HTMLElement | null} */
  let lastFocus = null;

  function open() {
    lastFocus = /** @type {HTMLElement} */ (document.activeElement);
    overlay.hidden = false;
    closeBtn.focus();
  }
  function close() {
    overlay.hidden = true;
    lastFocus?.focus();
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // Simple focus trap between the dialog's two buttons.
    if (e.key === 'Tab') {
      const focusables = [clearBtn, closeBtn];
      const idx = focusables.indexOf(/** @type {any} */ (document.activeElement));
      const next = e.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx + 1) % focusables.length;
      focusables[next].focus();
      e.preventDefault();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.defaultPrevented) {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest('input, textarea, [contenteditable]')) return;
      if (overlay.hidden) open();
      else close();
      e.preventDefault();
    }
  });

  return { open, close };
}
