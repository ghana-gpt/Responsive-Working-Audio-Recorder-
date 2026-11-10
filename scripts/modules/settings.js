/**
 * Preferences that survive a reload (localStorage).
 *
 * Every value is validated on read: a corrupted or hand-edited localStorage
 * entry must never put the UI into an unusable state.
 */

export const SETTINGS_KEY = 'audio-recorder:settings:v2';
export const THEME_KEY = 'audio-recorder:theme';
export const LOCALE_KEY = 'audio-recorder:locale';

export const THEMES = ['system', 'light', 'dark'];
export const BITRATES = [32000, 64000, 96000, 128000, 256000];

export const DEFAULT_SETTINGS = Object.freeze({
  format: 'auto',
  bitrate: 96000,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  theme: 'system',
  locale: 'auto',
  showCredit: true,
  sort: 'newest',
});

/** @returns {Storage|null} */
export function safeStorage() {
  try {
    const storage = globalThis.localStorage;
    // Safari in private mode throws on setItem; probe once.
    const probe = '__audio_recorder_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Validate/repair a settings object (used for both defaults and stored data).
 * @param {object} [input]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const format = ['auto', 'webm', 'ogg', 'mp4', 'wav', 'mp3'].includes(source.format)
    ? source.format
    : DEFAULT_SETTINGS.format;
  const bitrate = BITRATES.includes(Number(source.bitrate))
    ? Number(source.bitrate)
    : DEFAULT_SETTINGS.bitrate;
  const theme = THEMES.includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme;
  const sort = ['newest', 'oldest', 'name', 'longest'].includes(source.sort)
    ? source.sort
    : DEFAULT_SETTINGS.sort;
  const boolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  return {
    format,
    bitrate,
    noiseSuppression: boolean(source.noiseSuppression, DEFAULT_SETTINGS.noiseSuppression),
    echoCancellation: boolean(source.echoCancellation, DEFAULT_SETTINGS.echoCancellation),
    autoGainControl: boolean(source.autoGainControl, DEFAULT_SETTINGS.autoGainControl),
    theme,
    locale: typeof source.locale === 'string' && source.locale ? source.locale : 'auto',
    showCredit: boolean(source.showCredit, DEFAULT_SETTINGS.showCredit),
    sort,
  };
}

/**
 * @param {Storage|null} [storage]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings(storage = safeStorage()) {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a partial update and return the merged settings.
 * @param {object} patch
 * @param {Storage|null} [storage]
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function saveSettings(patch, storage = safeStorage()) {
  const next = normalizeSettings({ ...loadSettings(storage), ...patch });
  if (!storage) return next;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: settings simply are not persisted */
  }
  return next;
}

/** @param {Storage|null} [storage] */
export function resetSettings(storage = safeStorage()) {
  try {
    storage?.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Apply a theme to the document. `system` follows `prefers-color-scheme` via CSS,
 * so the attribute is only used for explicit choices.
 *
 * @param {'system'|'light'|'dark'} theme
 * @param {Document} [doc]
 * @returns {'system'|'light'|'dark'}
 */
export function applyTheme(theme, doc = globalThis.document) {
  const next = THEMES.includes(theme) ? theme : 'system';
  if (doc?.documentElement) {
    doc.documentElement.dataset.theme = next;
  }
  return next;
}

/**
 * React to OS theme changes (only relevant when the user chose "system").
 * @param {(theme: 'light'|'dark') => void} callback
 * @returns {() => void} unsubscribe
 */
export function watchSystemTheme(callback) {
  try {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return () => {};
    const handler = (event) => callback(event.matches ? 'dark' : 'light');
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  } catch {
    return () => {};
  }
}

/**
 * Current effective theme (resolves "system").
 * @param {'system'|'light'|'dark'} theme
 * @returns {'light'|'dark'}
 */
export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
