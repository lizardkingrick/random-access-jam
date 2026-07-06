// @ts-check
/** "?" help overlay: keyboard shortcuts, quick-start, and library management. */

const SHORTCUTS = [
  ['Space (hold)', 'Audio FX breakdown'],
  ['1 / 2 / 3 / 4', 'Focus vocals, drums, bass, or lead'],
  ['M / S', 'Mute / solo the focused position'],
  ['↑ / ↓', 'Volume of the focused position'],
  ['← / →', 'Nudge the master BPM'],
  ['Arrows on the wheel', 'Browse tracks; Enter assigns to the focused position'],
  ['Right-click / long-press a slot', 'Assign to a specific position, or remove'],
  ['Tab', 'Move between controls'],
  ['?', 'Open this help'],
];

/**
 * @param {HTMLElement} root
 * @param {{
 *   onClearLibrary?: () => void,
 *   onToggleMastering?: (enabled: boolean) => void,
 * }} [opts]
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
      The rack has four positions — vocals, drums, bass, lead — and they all
      play <em>together</em>, locked to one master tempo and key. Point each
      position at any track's matching stem (mix songs freely!), press play,
      and shape the groove with mute/solo, volume, and the FX hold.
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

  // Mastering glue A/B toggle (compressor + limiter on the master bus).
  const masteringRow = document.createElement('label');
  masteringRow.className = 'help-dialog__option';
  const masteringCheck = document.createElement('input');
  masteringCheck.type = 'checkbox';
  masteringCheck.checked = true;
  masteringCheck.addEventListener('change', () => opts.onToggleMastering?.(masteringCheck.checked));
  const masteringText = document.createElement('span');
  masteringText.textContent = 'Mastering glue (compressor + limiter) — untick to A/B';
  masteringRow.append(masteringCheck, masteringText);
  dialog.append(masteringRow);

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
    // Simple focus trap across the dialog's interactive elements.
    if (e.key === 'Tab') {
      const focusables = [masteringCheck, clearBtn, closeBtn];
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
