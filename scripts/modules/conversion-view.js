/**
 * Conversion progress panel.
 *
 * One panel serves every conversion: saving a WAV recording after capture and
 * trimming an existing recording both report through the same contract (see
 * modules/conversion.js), so the markup, the cancel button and the screen
 * reader announcements live here instead of in each flow.
 *
 * The percentage is decorative (`aria-hidden`): announcing every frame would
 * flood a screen reader, so the live region only carries the operation label.
 */

import { $, setFlag } from './dom.js';

/**
 * @param {{
 *   root?: Document|HTMLElement,
 *   t: (key: string, params?: object) => string,
 *   onCancel?: () => void,
 * }} options
 */
export function createConversionView({ root = document, t, onCancel }) {
  const panel = $('#conversion-panel', root);
  const label = $('#conversion-label', root);
  const progress = $('#conversion-progress', root);
  const percent = $('#conversion-percent', root);
  const cancelButton = $('#conversion-cancel-btn', root);

  let visible = false;
  /** @type {string} */
  let labelKey = '';

  cancelButton?.addEventListener('click', () => {
    if (onCancel && visible) onCancel();
  });

  function paintLabel() {
    if (label && labelKey) label.textContent = t(labelKey);
  }

  /**
   * Show the panel for a new conversion.
   * @param {string} key i18n key describing the operation
   */
  function start(key) {
    visible = true;
    labelKey = key;
    paintLabel();
    setFlag(panel, 'hidden', false);
    // No `value` means indeterminate: decoding has no measurable progress.
    if (progress) {
      progress.setAttribute('max', '1');
      progress.removeAttribute('value');
    }
    if (percent) percent.textContent = '';
    if (cancelButton) cancelButton.disabled = false;
  }

  /**
   * Paint one progress update.
   * @param {{ stage?: string, fraction?: number|null }} [update]
   */
  function update({ stage = '', fraction = null } = {}) {
    if (!visible) return;
    const indeterminate = stage === 'decode' || fraction === null || fraction === undefined;
    if (progress) {
      if (indeterminate) progress.removeAttribute('value');
      else progress.value = fraction;
    }
    if (percent) {
      percent.textContent = indeterminate ? '' : `${Math.round(fraction * 100)}%`;
    }
  }

  /** Hide the panel and forget the operation. */
  function stop() {
    visible = false;
    labelKey = '';
    setFlag(panel, 'hidden', true);
    if (progress) {
      progress.value = 0;
      progress.removeAttribute('value');
    }
    if (percent) percent.textContent = '';
    if (label) label.textContent = '';
    // The cancel button may hold focus; hiding it would strand the user.
    if (panel && panel.contains(document.activeElement)) {
      const fallback = /** @type {HTMLElement|null} */ ($('#record-btn', root));
      fallback?.focus({ preventScroll: true });
    }
  }

  return {
    start,
    update,
    stop,
    /** Re-translate the visible label after a language change. */
    relabel: paintLabel,
    get visible() {
      return visible;
    },
  };
}
