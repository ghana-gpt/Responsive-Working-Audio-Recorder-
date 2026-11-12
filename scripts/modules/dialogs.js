/**
 * Modal dialogs: a promise-based confirmation and the trim editor.
 *
 * Uses native <dialog> so focus trapping, the backdrop and Escape handling come
 * from the platform. Both dialogs resolve a promise instead of firing callbacks,
 * which keeps the orchestrator's async flows readable.
 */

import { $, restoreFocus } from './dom.js';
import { formatSeconds } from './format.js';

/** Read a CSS custom property, with a sane fallback for exotic browsers. */
function customColor(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {{ root?: Document|HTMLElement, t: (key: string, params?: object) => string }} options
 */
export function createDialogs({ root = document, t }) {
  const confirmDialog = $('#confirm-dialog', root);
  const confirmTitle = $('#confirm-title', root);
  const confirmBody = $('#confirm-body', root);
  const confirmAccept = $('#confirm-accept', root);
  const confirmCancel = $('#confirm-cancel', root);

  const trimDialog = $('#trim-dialog', root);
  const trimDescription = $('#trim-description', root);
  const trimCanvas = $('#trim-canvas', root);
  const startInput = $('#trim-start', root);
  const endInput = $('#trim-end', root);
  const startValue = $('#trim-start-value', root);
  const endValue = $('#trim-end-value', root);
  const trimInvalid = $('#trim-invalid', root);
  const trimApply = $('#trim-apply', root);
  const trimCancel = $('#trim-cancel', root);

  /** Minimum clip length, in seconds. */
  const MIN_SECONDS = 0.1;

  function open(dialog) {
    if (!dialog) return;
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
  }

  function close(dialog) {
    if (!dialog) return;
    try {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } catch {
      dialog.removeAttribute('open');
    }
  }

  /**
   * Ask the user to confirm a destructive action.
   *
   * @param {{ title: string, body: string, acceptLabel?: string }} options
   * @returns {Promise<boolean>}
   */
  function confirm({ title, body, acceptLabel }) {
    return new Promise((resolve) => {
      if (!confirmDialog) {
        resolve(
          typeof globalThis.confirm === 'function' && globalThis.confirm(`${title}\n\n${body}`),
        );
        return;
      }
      const lastFocus = document.activeElement;
      confirmTitle.textContent = title;
      confirmBody.textContent = body;
      confirmAccept.textContent = acceptLabel ?? t('actions.delete');
      confirmCancel.textContent = t('actions.cancel');

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        confirmAccept.removeEventListener('click', onAccept);
        confirmCancel.removeEventListener('click', onCancel);
        confirmDialog.removeEventListener('cancel', onDismiss);
        close(confirmDialog);
        restoreFocus(lastFocus);
        resolve(result);
      };
      const onAccept = () => finish(true);
      const onCancel = () => finish(false);
      const onDismiss = (event) => {
        event.preventDefault();
        finish(false);
      };

      confirmAccept.addEventListener('click', onAccept);
      confirmCancel.addEventListener('click', onCancel);
      confirmDialog.addEventListener('cancel', onDismiss);
      open(confirmDialog);
      confirmCancel.focus();
    });
  }

  /**
   * Open the trim editor and resolve with the chosen range (or null).
   *
   * @param {{
   *   name: string,
   *   duration: number,
   *   peaks?: { min: Float32Array, max: Float32Array }|null,
   * }} input
   * @returns {Promise<{ startSeconds: number, endSeconds: number }|null>}
   */
  function openTrim({ name, duration, peaks = null }) {
    return new Promise((resolve) => {
      if (!trimDialog || !(duration > 0)) {
        resolve(null);
        return;
      }
      const lastFocus = document.activeElement;
      let settled = false;

      const startFraction = () => Math.min(100, Math.max(0, Number(startInput?.value ?? 0))) / 100;
      const endFraction = () => Math.min(100, Math.max(0, Number(endInput?.value ?? 100))) / 100;
      const startSeconds = () => startFraction() * duration;
      const endSeconds = () => endFraction() * duration;
      const minGapFraction = (MIN_SECONDS / duration) * 100;

      function updateReadouts() {
        const start = startSeconds();
        const end = endSeconds();
        if (startValue) startValue.textContent = formatSeconds(start);
        if (endValue) endValue.textContent = formatSeconds(end);
        const valid = end - start >= MIN_SECONDS;
        if (trimInvalid) {
          trimInvalid.textContent = valid ? '' : t('dialog.trimInvalid');
          trimInvalid.hidden = valid;
        }
        if (trimApply) trimApply.disabled = !valid;
        return valid;
      }

      function drawWaveform() {
        if (!trimCanvas) return;
        const context = trimCanvas.getContext('2d');
        if (!context) return;
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
        const width = trimCanvas.clientWidth || 480;
        const height = trimCanvas.clientHeight || 120;
        trimCanvas.width = Math.round(width * ratio);
        trimCanvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);

        const barColor = customColor('--color-primary', '#6366f1');
        const mutedColor = customColor('--color-border', '#d7deea');
        const startX = startFraction() * width;
        const endX = endFraction() * width;

        // Dim everything outside the selection.
        context.globalAlpha = 0.22;
        context.fillStyle = mutedColor;
        context.fillRect(0, 0, startX, height);
        context.fillRect(endX, 0, width - endX, height);
        context.globalAlpha = 1;

        const buckets = peaks?.max?.length ?? 0;
        const middle = height / 2;
        if (buckets > 0) {
          const barWidth = Math.max(1, width / buckets - 0.5);
          for (let index = 0; index < buckets; index += 1) {
            const max = Math.min(1, Math.abs(Number(peaks.max[index]) || 0));
            const min = Math.min(1, Math.abs(Number(peaks.min[index]) || 0));
            const x = (index / buckets) * width;
            const top = middle - max * middle * 0.95;
            const bottom = middle + min * middle * 0.95;
            context.fillStyle = x + barWidth >= startX && x <= endX ? barColor : mutedColor;
            context.fillRect(x, top, barWidth, Math.max(1, bottom - top));
          }
        } else {
          context.strokeStyle = mutedColor;
          context.beginPath();
          context.moveTo(0, middle);
          context.lineTo(width, middle);
          context.stroke();
        }

        // Selection handles.
        context.fillStyle = barColor;
        context.fillRect(startX - 1, 0, 2, height);
        context.fillRect(endX - 1, 0, 2, height);
      }

      function clampHandles(which) {
        let start = Number(startInput?.value ?? 0);
        let end = Number(endInput?.value ?? 100);
        if (which === 'start' && start > end - minGapFraction)
          start = Math.max(0, end - minGapFraction);
        if (which === 'end' && end < start + minGapFraction)
          end = Math.min(100, start + minGapFraction);
        if (startInput) startInput.value = String(start);
        if (endInput) endInput.value = String(end);
        updateReadouts();
        drawWaveform();
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        startInput?.removeEventListener('input', onStartInput);
        endInput?.removeEventListener('input', onEndInput);
        trimApply?.removeEventListener('click', onApply);
        trimCancel?.removeEventListener('click', onCancel);
        trimDialog.removeEventListener('cancel', onDismiss);
        close(trimDialog);
        restoreFocus(lastFocus);
        resolve(result);
      };
      const onStartInput = () => clampHandles('start');
      const onEndInput = () => clampHandles('end');
      const onApply = () => {
        if (updateReadouts()) finish({ startSeconds: startSeconds(), endSeconds: endSeconds() });
      };
      const onCancel = () => finish(null);
      const onDismiss = (event) => {
        event.preventDefault();
        finish(null);
      };

      trimDescription.textContent = t('dialog.trimDescription', { name });
      if (startInput) startInput.value = '0';
      if (endInput) endInput.value = '100';

      startInput?.addEventListener('input', onStartInput);
      endInput?.addEventListener('input', onEndInput);
      trimApply?.addEventListener('click', onApply);
      trimCancel?.addEventListener('click', onCancel);
      trimDialog.addEventListener('cancel', onDismiss);

      open(trimDialog);
      updateReadouts();
      // The canvas has no layout until the dialog is visible.
      requestAnimationFrame(() => drawWaveform());
      startInput?.focus();
    });
  }

  return { confirm, openTrim };
}
