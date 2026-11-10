import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  escapeHtml,
  formatTags,
  parseTags,
  sanitizeDisplayName,
  sanitizeFileName,
} from '../../scripts/modules/sanitize.js';

test('sanitizeFileName removes path separators and reserved characters', () => {
  assert.equal(sanitizeFileName('My recording'), 'My-recording');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeFileName('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h');
  assert.equal(sanitizeFileName('   '), 'recording');
  assert.equal(sanitizeFileName(''), 'recording');
  assert.equal(sanitizeFileName(null, 'fallback'), 'fallback');
  assert.equal(sanitizeFileName('voice note 01'), 'voice-note-01');
});

test('sanitizeFileName keeps unicode letters and limits length', () => {
  assert.equal(sanitizeFileName('Réunion équipe'), 'Réunion-équipe');
  const long = sanitizeFileName('x'.repeat(200));
  assert.equal(long.length, 80);
});

test('sanitizeDisplayName collapses whitespace but keeps spaces', () => {
  assert.equal(sanitizeDisplayName('  hello   world  '), 'hello world');
  assert.equal(sanitizeDisplayName('a\u0000b'), 'a b');
  assert.equal(sanitizeDisplayName('', 'Untitled'), 'Untitled');
  assert.equal(sanitizeDisplayName(undefined), 'Untitled recording');
  assert.equal(sanitizeDisplayName('x'.repeat(200)).length, 80);
});

test('parseTags dedupes case-insensitively and trims', () => {
  assert.deepEqual(parseTags('meeting, Idea , idea,,'), ['meeting', 'Idea']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(parseTags('one, two, three', { maxTags: 2 }), ['one', 'two']);
  assert.deepEqual(parseTags('abcdefghij', { maxLength: 4 }), ['abcd']);
  assert.deepEqual(parseTags(undefined), []);
});

test('formatTags round-trips parseTags output', () => {
  const tags = parseTags('alpha, beta');
  assert.equal(formatTags(tags), 'alpha, beta');
  assert.equal(formatTags(undefined), '');
});

test('clamp keeps numbers inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp('7', 0, 10), 7);
  assert.equal(clamp('nope', 2, 10), 2);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
});
