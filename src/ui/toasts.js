// @ts-check
/** Non-blocking toast messages with an ARIA live region. */

/** @type {HTMLElement | null} */
let stack = null;

/**
 * Mount the toast stack into the HUD root. Call once at startup.
 * @param {HTMLElement} root
 */
export function initToasts(root) {
  stack = document.createElement('div');
  stack.className = 'toast-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  root.append(stack);
}

/**
 * Show a toast message.
 * @param {string} message
 * @param {{ type?: 'info' | 'error' | 'success', duration?: number }} [opts]
 */
export function showToast(message, opts = {}) {
  if (!stack) return;
  const { type = 'info', duration = 4200 } = opts;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  stack.append(el);

  // Keep the stack from growing unbounded if errors burst.
  while (stack.children.length > 4) stack.firstElementChild?.remove();

  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 300);
  };
  const timer = setTimeout(dismiss, duration);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });
}
