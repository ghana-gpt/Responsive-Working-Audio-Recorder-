/**
 * Preferences view: recording format, quality, microphone processing, local
 * statistics and the sponsor-credit switch.
 *
 * The view never writes to localStorage — it reports changes through `onChange`
 * so a single place (main.js) validates and persists them.
 */

import { $, createElement, setFlag } from './dom.js';
import { formatBytes, formatDuration } from './format.js';
import { FORMAT_OPTIONS, formatAvailability, neverSupported } from './mime.js';
import { BITRATES } from './settings.js';

/**
 * @param {{
 *   root?: Document|HTMLElement,
 *   t: (key: string, params?: object) => string,
 *   isTypeSupported?: (mimeType: string) => boolean,
 *   onChange: (patch: object) => void,
 *   onReset: () => void,
 * }} options
 */
export function createSettingsView({
  root = document,
  t,
  isTypeSupported = neverSupported,
  onChange,
  onReset,
}) {
  const formatContainer = $('#format-options', root);
  const qualitySelect = $('#quality-select', root);
  const noiseBox = $('#noise-suppression', root);
  const echoBox = $('#echo-cancellation', root);
  const gainBox = $('#auto-gain', root);
  const creditBox = $('#show-credit', root);
  const statsLine = $('#storage-stats', root);
  const storageLine = $('#storage-status', root);
  const usageLine = $('#storage-usage', root);
  const usageMeter = $('#storage-meter', root);
  const topList = $('#storage-top', root);
  const resetButton = $('#reset-settings-btn', root);
  const form = $('#settings-form', root);

  // The form is presentational: every control persists immediately.
  form?.addEventListener('submit', (event) => event.preventDefault());

  formatContainer?.addEventListener('change', (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.name === 'format') {
      onChange({ format: input.value });
    }
  });

  qualitySelect?.addEventListener('change', () => {
    onChange({ bitrate: Number(qualitySelect.value) });
  });

  const checkboxBindings = [
    [noiseBox, 'noiseSuppression'],
    [echoBox, 'echoCancellation'],
    [gainBox, 'autoGainControl'],
    [creditBox, 'showCredit'],
  ];

  for (const [box, key] of checkboxBindings) {
    box?.addEventListener('change', () => onChange({ [key]: Boolean(box.checked) }));
  }

  resetButton?.addEventListener('click', () => onReset());

  /** Build the format radios and quality options (only once). */
  function setStatic() {
    if (qualitySelect) {
      qualitySelect.replaceChildren(
        ...BITRATES.map((bitrate) =>
          createElement('option', {
            attrs: { value: String(bitrate) },
            text: t(`settings.quality${Math.round(bitrate / 1000)}`),
          }),
        ),
      );
    }

    if (!formatContainer) return;
    const availability = formatAvailability(isTypeSupported);
    const radios = FORMAT_OPTIONS.map((option) => {
      const info = availability[option.id] ?? { available: false, reason: 'unsupported' };
      const input = createElement('input', {
        attrs: {
          type: 'radio',
          name: 'format',
          value: option.id,
          'aria-describedby': `format-note-${option.id}`,
        },
      });
      if (!info.available) input.disabled = true;

      const text = createElement('span', { text: t(option.labelKey) });
      let note = null;
      if (!info.available) {
        const noteKey =
          info.reason === 'needs-encoder'
            ? 'settings.formatNeedsEncoder'
            : 'settings.formatUnavailable';
        note = createElement('span', {
          class: 'radio__note',
          text: t(noteKey),
          attrs: { id: `format-note-${option.id}` },
        });
      }

      const label = createElement('label', {
        class: 'radio',
        dataset: { unavailable: info.available ? 'false' : 'true' },
        children: [input, createElement('span', { children: note ? [text, note] : [text] })],
      });
      return label;
    });
    formatContainer.replaceChildren(...radios);
  }

  /**
   * @param {object} settings
   * @param {{
   *   stats?: object,
   *   storageProtected?: boolean|null,
   *   storage?: { usage: number, quota: number, percent: number|null, level: string }|null,
   *   topRecordings?: object[],
   * }} [extra]
   */
  function render(
    settings,
    { stats, storageProtected = null, storage = null, topRecordings = [] } = {},
  ) {
    if (formatContainer) {
      const chosen = Array.from(formatContainer.querySelectorAll('input[name="format"]')).find(
        (input) => input.value === settings.format && !input.disabled,
      );
      const fallback = formatContainer.querySelector('input[name="format"][value="auto"]');
      const target = chosen ?? fallback;
      if (target) target.checked = true;
    }

    if (qualitySelect) {
      qualitySelect.value = String(settings.bitrate);
      // WAV is uncompressed: the bitrate has no effect there.
      const usesBitrate = settings.format !== 'wav';
      qualitySelect.disabled = !usesBitrate;
    }

    if (noiseBox) noiseBox.checked = Boolean(settings.noiseSuppression);
    if (echoBox) echoBox.checked = Boolean(settings.echoCancellation);
    if (gainBox) gainBox.checked = Boolean(settings.autoGainControl);
    if (creditBox) creditBox.checked = Boolean(settings.showCredit);

    if (statsLine) {
      const summary = stats ?? { count: 0, totalDurationMs: 0, totalBytes: 0 };
      statsLine.textContent = [
        t('settings.statsRecordings', { count: summary.count }),
        t('settings.statsDuration', { duration: formatDuration(summary.totalDurationMs) }),
        t('settings.statsStorage', { size: formatBytes(summary.totalBytes) }),
      ].join('\n');
    }

    if (storageLine) {
      const notes = [];
      if (storageProtected !== null) {
        notes.push(
          storageProtected ? t('settings.storageProtected') : t('settings.storageBestEffort'),
        );
      }
      if (storage?.level === 'critical') notes.push(t('settings.storageCritical'));
      else if (storage?.level === 'warn') notes.push(t('settings.storageLow'));
      storageLine.textContent = notes.join(' ');
    }

    if (usageLine) {
      usageLine.textContent =
        storage && storage.percent !== null
          ? t('settings.storageUsageValue', {
              used: formatBytes(storage.usage),
              quota: formatBytes(storage.quota),
              percent: storage.percent,
            })
          : t('settings.storageUnknown');
    }

    if (usageMeter) {
      const known = Boolean(storage) && storage.percent !== null;
      setFlag(usageMeter, 'hidden', !known);
      if (known) {
        usageMeter.value = storage.percent;
        usageMeter.textContent = `${storage.percent}%`;
        usageMeter.dataset.level = storage.level ?? 'ok';
      }
    }

    if (topList) {
      const largest = Array.isArray(topRecordings) ? topRecordings : [];
      if (largest.length === 0) {
        topList.replaceChildren(
          createElement('li', {
            class: 'storage__item storage__item--empty',
            text: t('settings.storageTopEmpty'),
          }),
        );
      } else {
        topList.replaceChildren(
          ...largest.map((record) =>
            createElement('li', {
              class: 'storage__item',
              children: [
                createElement('span', {
                  class: 'storage__name',
                  text: record.name || t('recording.untitled'),
                }),
                createElement('span', {
                  class: 'storage__size',
                  text: formatBytes(record.size),
                }),
              ],
            }),
          ),
        );
      }
    }
  }

  return { setStatic, render };
}
