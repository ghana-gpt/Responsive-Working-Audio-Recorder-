/**
 * Recorder panel view.
 *
 * Owns every DOM read/write for the recording controls, status line, timer,
 * level meter and error panel. It never calls MediaRecorder directly: user
 * intent is forwarded to callbacks and rendering is driven by the state store,
 * so the state machine and the visuals cannot desync.
 */

import { $, announce, createElement, setFlag } from './dom.js';
import { formatDuration } from './format.js';
import { ACTIONS, MODES, getControls, statusKeyForMode } from './state.js';

/**
 * @param {{
 *   root?: Document|HTMLElement,
 *   t: (key: string, params?: object) => string,
 *   onAction: (action: string) => void,
 *   onRetry?: () => void,
 * }} options
 */
export function createRecorderView({ root = document, t, onAction, onRetry }) {
  const panel = $('#recorder-panel', root);
  const statusLine = $('#status-message', root);
  const liveRegion = $('#recording-live', root);
  const recordButton = $('#record-btn', root);
  const pauseButton = $('#pause-btn', root);
  const stopButton = $('#stop-btn', root);
  const timerOutput = $('#timer', root);
  const timerLabel = $('#timer-label', root);
  const meter = $('#level-meter', root);
  const formatHint = $('#format-hint', root);
  const errorPanel = $('#error-panel', root);
  const errorMessage = $('#error-message', root);
  const retryButton = $('#error-retry', root);

  let lastStatus = '';
  let lastTimer = '';
  let meterUpdate = 0;

  recordButton?.addEventListener('click', () => onAction(ACTIONS.REQUEST));
  pauseButton?.addEventListener('click', () => {
    const paused = panel?.dataset.mode === MODES.PAUSED;
    onAction(paused ? ACTIONS.RESUME : ACTIONS.PAUSE);
  });
  stopButton?.addEventListener('click', () => onAction(ACTIONS.FINISH));
  retryButton?.addEventListener('click', () => (onRetry ? onRetry() : onAction(ACTIONS.REQUEST)));

  /** Static labels that do not depend on state. */
  function setStaticLabels() {
    if (recordButton) {
      recordButton.setAttribute('aria-label', t('controls.record'));
      recordButton.title = t('controls.record');
    }
    if (stopButton) {
      stopButton.setAttribute('aria-label', t('controls.stop'));
      stopButton.title = t('controls.stop');
    }
    if (timerLabel) timerLabel.textContent = t('controls.timer');
    if (meter) meter.setAttribute('aria-label', t('controls.meter'));
    const group = $('#recorder-controls', root);
    if (group) group.setAttribute('aria-label', t('controls.groupLabel'));
    if (retryButton) retryButton.textContent = t('actions.retry');
  }

  /**
   * Render everything that depends on the recorder mode.
   *
   * @param {string} mode
   * @param {{ recordingName?: string, error?: { code: string, message: string }|null }} [extra]
   */
  function render(mode, extra = {}) {
    if (panel) panel.dataset.mode = mode;
    const controls = getControls(mode);

    setFlag(recordButton, 'disabled', !controls.record);
    setFlag(recordButton, 'aria-busy', controls.busy);
    setFlag(recordButton, 'data-recording', mode === MODES.RECORDING || mode === MODES.PAUSED);

    const pauseVisible = controls.pause || controls.resume;
    setFlag(pauseButton, 'hidden', !pauseVisible);
    setFlag(pauseButton, 'disabled', !pauseVisible);
    if (pauseButton && pauseVisible) {
      const isPaused = controls.resume;
      const label = isPaused ? t('controls.resume') : t('controls.pause');
      pauseButton.setAttribute('aria-label', label);
      pauseButton.title = label;
      pauseButton.dataset.action = isPaused ? ACTIONS.RESUME : ACTIONS.PAUSE;
      const text = pauseButton.querySelector('.btn__text');
      if (text) text.textContent = label;
      const icon = pauseButton.querySelector('.btn__icon');
      if (icon) icon.textContent = isPaused ? '▶' : '❚❚';
    }

    setFlag(stopButton, 'hidden', !controls.stop);
    setFlag(stopButton, 'disabled', !controls.stop);

    // Status line + live region: only touch the DOM when the text really changed.
    const statusKey = statusKeyForMode(mode);
    const statusText =
      mode === MODES.READY && extra.recordingName
        ? `${t('status.ready')} ${extra.recordingName}`
        : t(statusKey);
    if (statusLine && statusText !== lastStatus) {
      statusLine.textContent = statusText;
      lastStatus = statusText;
    }
    if (liveRegion) {
      const announcement =
        mode === MODES.RECORDING
          ? t('status.recording')
          : mode === MODES.PAUSED
            ? t('status.paused')
            : mode === MODES.READY
              ? t('status.ready')
              : '';
      if (announcement) announce(liveRegion, announcement);
    }

    // Error panel replaces the status line for failures.
    const hasError = mode === MODES.ERROR;
    setFlag(errorPanel, 'hidden', !hasError);
    if (hasError && errorMessage) {
      const code = extra.error?.code ?? 'unknown';
      const key = `errors.${code}`;
      const message = t(key, { message: extra.error?.message ?? '' });
      errorMessage.textContent = message === key ? t('errors.unknown', { message: code }) : message;
      announce(liveRegion, errorMessage.textContent);
      retryButton?.focus({ preventScroll: true });
    }

    if (mode === MODES.IDLE || mode === MODES.READY || mode === MODES.ERROR) setLevel(0);
    if (mode === MODES.IDLE) setElapsed(0);
  }

  /** @param {number} level 0..1 */
  function setLevel(level) {
    if (!meter) return;
    const clamped = Math.min(1, Math.max(0, Number(level) || 0));
    meter.style.setProperty('--level', clamped.toFixed(3));
    // Throttle the ARIA value: 60 announcements per second would be unusable.
    const now = Date.now();
    if (now - meterUpdate > 250) {
      meterUpdate = now;
      meter.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
    }
  }

  /** @param {number} milliseconds */
  function setElapsed(milliseconds) {
    if (!timerOutput) return;
    const text = formatDuration(milliseconds);
    if (text !== lastTimer) {
      timerOutput.textContent = text;
      lastTimer = text;
    }
    timerOutput.setAttribute('datetime', `PT${Math.floor(Math.max(0, milliseconds) / 1000)}S`);
  }

  /** @param {string} text */
  function setFormatHint(text) {
    if (formatHint) formatHint.textContent = text;
  }

  /** Show sample rate / channel count once the microphone opens. */
  function setMicrophoneHint(trackSettings) {
    if (!formatHint) return;
    const parts = [];
    if (trackSettings?.sampleRate) parts.push(`${Math.round(trackSettings.sampleRate / 1000)} kHz`);
    if (trackSettings?.channelCount) {
      parts.push(trackSettings.channelCount === 1 ? t('misc.mono') : t('misc.stereo'));
    }
    if (parts.length) formatHint.textContent = parts.join(' · ');
  }

  /** Build the static parts of the panel; call once at startup. */
  function setStatic() {
    setStaticLabels();
    const title = errorPanel?.querySelector('.error-panel__title');
    if (title) title.textContent = t('errors.title');
    const meterTicks = $('#meter-ticks', root);
    if (meterTicks) {
      meterTicks.replaceChildren(
        ...Array.from({ length: 12 }, () => createElement('span', { class: 'meter__tick' })),
      );
    }
  }

  return {
    render,
    setLevel,
    setElapsed,
    setFormatHint,
    setMicrophoneHint,
    setStatic,
    /** Refresh labels after a language change. */
    relabel: () => {
      setStaticLabels();
      const title = errorPanel?.querySelector('.error-panel__title');
      if (title) title.textContent = t('errors.title');
      lastStatus = '';
      lastTimer = '';
    },
    focusRecordButton: () => recordButton?.focus(),
  };
}
