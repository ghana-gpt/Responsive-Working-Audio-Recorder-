/**
 * Toast notifications.
 *
 * Errors use `role="alert"` (assertive) so a microphone permission failure is
 * announced immediately; everything else uses `role="status"` (polite).
 * Toasts are limited in number and auto-dismiss with a pause on hover/focus.
 */

import { createElement } from './dom.js';

const MAX_TOASTS = 4;

/**
 * @param {HTMLElement} host container element (fixed position, aria-live region)
 * @param {{ timeout?: number, labels?: { dismiss?: string } }} [options]
 */
export function createToaster(host, { timeout = 6000, labels = {} } = {}) {
  if (!host) {
    return { show: () => () => {}, clear: () => {} };
  }

  const dismissLabel = labels.dismiss ?? 'Dismiss';

  /** @param {{ message: string, tone?: 'info'|'success'|'error', action?: { label: string, onClick: () => void } }} options */
  function show({ message, tone = 'info', action }) {
    const toast = createElement('div', {
      class: ['toast', `toast--${tone}`],
      attrs: { role: tone === 'error' ? 'alert' : 'status' },
    });

    toast.append(createElement('p', { class: 'toast__message', text: message }));

    if (action) {
      const actionButton = createElement('button', {
        class: 'toast__action',
        attrs: { type: 'button' },
        text: action.label,
      });
      actionButton.addEventListener('click', () => {
        try {
          action.onClick();
        } finally {
          dismiss();
        }
      });
      toast.append(actionButton);
    }

    const closeButton = createElement('button', {
      class: 'toast__close',
      attrs: { type: 'button', 'aria-label': dismissLabel },
      text: '×',
    });

    let timer = null;
    let remaining = timeout;
    let startedAt = 0;

    const dismiss = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      toast.classList.add('toast--leaving');
      const remove = () => toast.remove();
      toast.addEventListener('animationend', remove, { once: true });
      // Fallback for reduced-motion users (no animation events).
      setTimeout(remove, 300);
    };

    const schedule = () => {
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
    };
    const pause = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining -= Date.now() - startedAt;
    };
    const resume = () => {
      if (timer !== null) return;
      schedule();
    };

    closeButton.addEventListener('click', dismiss);
    toast.addEventListener('mouseenter', pause);
    toast.addEventListener('mouseleave', resume);
    toast.addEventListener('focusin', pause);
    toast.addEventListener('focusout', resume);

    toast.append(closeButton);
    host.append(toast);

    while (host.children.length > MAX_TOASTS) {
      host.firstElementChild?.remove();
    }

    if (timeout > 0) schedule();
    return dismiss;
  }

  function clear() {
    host.replaceChildren();
  }

  return { show, clear };
}
