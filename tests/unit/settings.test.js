import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SORT_OPTIONS } from '../../scripts/modules/library.js';
import {
  BITRATES,
  DEFAULT_SETTINGS,
  LOCALE_KEY,
  SETTINGS_KEY,
  THEMES,
  THEME_KEY,
  applyTheme,
  loadSettings,
  normalizeSettings,
  resetSettings,
  safeStorage,
  saveSettings,
} from '../../scripts/modules/settings.js';

/** Minimal in-memory Storage so tests never touch a real browser or disk. */
function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

test('defaults are a valid settings object', () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.ok(SORT_OPTIONS.includes(DEFAULT_SETTINGS.sort));
  assert.ok(THEMES.includes(DEFAULT_SETTINGS.theme));
  assert.ok(BITRATES.includes(DEFAULT_SETTINGS.bitrate));
});

test('every supported sort order survives normalisation', () => {
  for (const sort of SORT_OPTIONS) {
    assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, sort }).sort, sort);
  }
});

test('normalizeSettings repairs invalid values instead of throwing', () => {
  const repaired = normalizeSettings({
    format: 'flac',
    bitrate: '999',
    theme: 'neon',
    locale: '',
    sort: 'alphabetical',
    noiseSuppression: 'yes',
    echoCancellation: 0,
    autoGainControl: null,
    showCredit: undefined,
  });
  assert.deepEqual(repaired, { ...DEFAULT_SETTINGS });
});

test('normalizeSettings coerces numeric bitrates and keeps booleans', () => {
  const settings = normalizeSettings({
    bitrate: '128000',
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
    showCredit: false,
    locale: 'fr',
  });
  assert.equal(settings.bitrate, 128000);
  assert.equal(settings.noiseSuppression, false);
  assert.equal(settings.echoCancellation, false);
  assert.equal(settings.autoGainControl, false);
  assert.equal(settings.showCredit, false);
  assert.equal(settings.locale, 'fr');
});

test('loadSettings returns defaults without storage or stored data', () => {
  assert.deepEqual(loadSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(loadSettings(memoryStorage()), { ...DEFAULT_SETTINGS });
});

test('loadSettings survives corrupted JSON and partial objects', () => {
  assert.deepEqual(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{oops' })), {
    ...DEFAULT_SETTINGS,
  });

  const stored = memoryStorage({
    [SETTINGS_KEY]: JSON.stringify({ sort: 'largest', theme: 'dark' }),
  });
  const loaded = loadSettings(stored);
  assert.equal(loaded.sort, 'largest', 'a non-default sort must not snap back');
  assert.equal(loaded.theme, 'dark');
  assert.equal(loaded.format, DEFAULT_SETTINGS.format, 'missing keys fall back');
});

test('saveSettings merges a partial patch and persists it', () => {
  const storage = memoryStorage();
  const first = saveSettings({ theme: 'dark' }, storage);
  assert.equal(first.theme, 'dark');
  assert.equal(first.format, DEFAULT_SETTINGS.format);

  const second = saveSettings({ sort: 'oldest' }, storage);
  assert.equal(second.theme, 'dark', 'previous values are kept');
  assert.equal(second.sort, 'oldest');

  const persisted = JSON.parse(storage.getItem(SETTINGS_KEY));
  assert.deepEqual(persisted, second);
  assert.deepEqual(loadSettings(storage), second);
});

test('saveSettings repairs invalid patches instead of persisting garbage', () => {
  const storage = memoryStorage();
  saveSettings({ theme: 'dark', bitrate: 128000 }, storage);
  const next = saveSettings(
    { theme: 'neon', bitrate: 1234, sort: 'bogus', format: 'flac' },
    storage,
  );
  assert.equal(next.theme, DEFAULT_SETTINGS.theme);
  assert.equal(next.bitrate, DEFAULT_SETTINGS.bitrate);
  assert.equal(next.sort, DEFAULT_SETTINGS.sort);
  assert.equal(next.format, DEFAULT_SETTINGS.format);
  assert.deepEqual(loadSettings(storage), next, 'the repaired object is what got stored');
});

test('saveSettings returns the merged value when storage fails', () => {
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const next = saveSettings({ format: 'wav' }, storage);
  assert.equal(next.format, 'wav', 'the in-memory value is still returned');
  assert.deepEqual(loadSettings(storage), { ...DEFAULT_SETTINGS });
});

test('resetSettings removes only the settings entry and returns defaults', () => {
  const storage = memoryStorage({
    [SETTINGS_KEY]: JSON.stringify({ theme: 'dark', sort: 'name' }),
    [THEME_KEY]: 'dark',
    [LOCALE_KEY]: 'fr',
  });
  const restored = resetSettings(storage);
  assert.deepEqual(restored, { ...DEFAULT_SETTINGS });
  assert.equal(storage.getItem(SETTINGS_KEY), null);
  assert.equal(storage.getItem(THEME_KEY), 'dark', 'unrelated keys are untouched');
  assert.equal(storage.getItem(LOCALE_KEY), 'fr');
  assert.deepEqual(resetSettings(null), { ...DEFAULT_SETTINGS });
});

test('resetSettings works with a storage that throws on removeItem', () => {
  const storage = memoryStorage();
  storage.removeItem = () => {
    throw new Error('blocked');
  };
  assert.deepEqual(resetSettings(storage), { ...DEFAULT_SETTINGS });
});

test('applyTheme sets the attribute and rejects unknown themes', () => {
  const doc = { documentElement: { dataset: {} } };
  assert.equal(applyTheme('dark', doc), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');

  assert.equal(applyTheme('neon', doc), 'system');
  assert.equal(doc.documentElement.dataset.theme, 'system');

  assert.equal(applyTheme('light', null), 'light', 'a missing document is tolerated');
});

test('safeStorage returns null when storage is unavailable or blocked', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    assert.equal(safeStorage(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
      },
    });
    assert.equal(safeStorage(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
