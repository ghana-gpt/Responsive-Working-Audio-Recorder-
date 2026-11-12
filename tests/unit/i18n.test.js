import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  diffKeys,
  errorKeyForCode,
  messages,
  resolveLocale,
  t,
} from '../../scripts/modules/i18n.js';

test('every supported locale defines exactly the default key set', () => {
  for (const { code } of SUPPORTED_LOCALES) {
    const { missing, extra } = diffKeys(code);
    assert.deepEqual(missing, [], `${code} is missing keys`);
    assert.deepEqual(extra, [], `${code} has unknown keys`);
  }
});

test('every message is a non-empty string', () => {
  for (const [locale, dictionary] of Object.entries(messages)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}/${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}/${key} must not be empty`);
    }
  }
});

test('placeholders are consistent across locales', () => {
  const placeholders = (value) => (value.match(/\{(\w+)\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(messages[DEFAULT_LOCALE])) {
    const base = placeholders(messages[DEFAULT_LOCALE][key]);
    for (const { code } of SUPPORTED_LOCALES) {
      assert.equal(placeholders(messages[code][key]), base, `${code}/${key} placeholders differ`);
    }
  }
});

test('t interpolates parameters and falls back gracefully', () => {
  assert.equal(t('library.count', { count: 3 }, 'en'), '3 saved');
  assert.equal(t('library.count', { count: 3 }, 'fr'), '3 enregistré(s)');
  assert.equal(t('recording.play', { name: 'Demo' }, 'en'), 'Play “Demo”');
  assert.equal(t('unknown.key'), 'unknown.key');
  assert.equal(t('library.count', {}, 'en'), '{count} saved', 'missing params stay visible');
  assert.equal(t('library.count', { count: 1 }, 'de'), '1 saved', 'falls back to English');
});

test('createTranslator binds the locale', () => {
  const fr = createTranslator('fr');
  assert.equal(fr('controls.record'), 'Démarrer l’enregistrement');
  const en = createTranslator();
  assert.equal(en('controls.record'), 'Start recording');
});

test('resolveLocale picks the first supported candidate', () => {
  assert.equal(resolveLocale(['fr-CA', 'en']), 'fr');
  assert.equal(resolveLocale(['de-DE', 'en-US']), 'en');
  assert.equal(resolveLocale(['de-DE']), DEFAULT_LOCALE);
  assert.equal(resolveLocale([]), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
  assert.equal(resolveLocale([' FR ']), 'fr');
});

test('no locale re-uses another language verbatim for status messages', () => {
  assert.notEqual(messages.fr['status.recording'], messages.en['status.recording']);
  assert.notEqual(messages.fr['errors.micDenied'], messages.en['errors.micDenied']);
});

test('errorKeyForCode resolves recorder and storage code spellings', () => {
  assert.equal(errorKeyForCode('micDenied'), 'errors.micDenied');
  assert.equal(errorKeyForCode('quota-exceeded'), 'errors.quotaExceeded');
  assert.equal(errorKeyForCode('storage-unavailable'), 'errors.storageUnavailable');
  assert.equal(errorKeyForCode('not-found'), 'errors.notFound');
  assert.equal(errorKeyForCode('storage-failed'), 'errors.storageUnavailable');
  assert.equal(errorKeyForCode('connection-closed'), 'errors.storageUnavailable');
  assert.equal(errorKeyForCode('already-running'), 'errors.recordFailed');
  assert.equal(errorKeyForCode(''), 'errors.unknown');
  assert.equal(errorKeyForCode(undefined), 'errors.unknown');
});

test('every code used by the app maps to a message that exists', () => {
  const codes = [
    'micDenied',
    'micNotFound',
    'micInUse',
    'insecureContext',
    'unsupportedBrowser',
    'recordFailed',
    'saveFailed',
    'conversionFailed',
    'decodeFailed',
    'shareUnavailable',
    'zipFailed',
    'archiveUnreadable',
    'archiveEmpty',
    'invalidFormat',
    'noStream',
    'notFound',
    'importFailed',
    'unsupportedFile',
    'trimFailed',
    'quota-exceeded',
    'storage-unavailable',
    'storage-failed',
    'connection-closed',
    'not-found',
    'already-running',
  ];
  for (const code of codes) {
    const key = errorKeyForCode(code);
    assert.ok(key in messages[DEFAULT_LOCALE], `${code} -> ${key} is missing`);
  }
});
