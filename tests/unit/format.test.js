import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFileName,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatSeconds,
  formatRelativeTime,
  timestampForFilename,
} from '../../scripts/modules/format.js';

test('formatDuration renders mm:ss and h:mm:ss', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(999), '00:00');
  assert.equal(formatDuration(1000), '00:01');
  assert.equal(formatDuration(59_999), '00:59');
  assert.equal(formatDuration(60_000), '01:00');
  assert.equal(formatDuration(3_599_000), '59:59');
  assert.equal(formatDuration(3_600_000), '1:00:00');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatDuration(36_000_000), '10:00:00');
});

test('formatDuration normalises invalid input instead of printing NaN', () => {
  assert.equal(formatDuration(-5000), '00:00');
  assert.equal(formatDuration(Number.NaN), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
  assert.equal(formatDuration('4200'), '00:04');
});

test('formatSeconds keeps one decimal below a minute for trim handles', () => {
  assert.equal(formatSeconds(0), '0.0 s');
  assert.equal(formatSeconds(0.4), '0.4 s');
  assert.equal(formatSeconds(0.872), '0.9 s');
  assert.equal(formatSeconds(59.94), '59.9 s');
  assert.equal(formatSeconds(60), '01:00');
  assert.equal(formatSeconds(3723), '1:02:03');
  assert.equal(formatSeconds(-3), '0.0 s');
  assert.equal(formatSeconds(Number.NaN), '0.0 s');
});

test('formatBytes uses binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(10 * 1024), '10 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2), '1.0 MB');
  assert.equal(formatBytes(5.5 * 1024 ** 3), '5.5 GB');
  assert.equal(formatBytes(-10), '0 B');
});

test('timestampForFilename is filesystem safe and zero padded', () => {
  const date = new Date(2026, 0, 5, 7, 8, 9);
  assert.equal(timestampForFilename(date), '2026-01-05_07-08-09');
  assert.equal(timestampForFilename(new Date(Number.NaN)), 'unknown-date');
  // no characters that Windows/macOS reject
  assert.doesNotMatch(timestampForFilename(date), /[:*?"<>|/\\]/);
});

test('buildFileName combines slug, timestamp and extension', () => {
  const date = new Date(2026, 10, 9, 13, 45, 2);
  assert.equal(
    buildFileName({ name: 'meeting', date, extension: 'webm' }),
    'meeting_2026-11-09_13-45-02.webm',
  );
  assert.equal(
    buildFileName({ name: '', date, extension: '.wav' }),
    'recording_2026-11-09_13-45-02.wav',
  );
  assert.equal(buildFileName({ date }), 'recording_2026-11-09_13-45-02.webm');
});

test('formatDateTime and formatRelativeTime are locale aware', () => {
  const date = new Date(2026, 10, 9, 13, 45, 0);
  assert.match(formatDateTime(date, 'en-GB'), /2026/);
  assert.equal(formatDateTime(new Date(Number.NaN)), '');

  const now = date.getTime();
  assert.match(formatRelativeTime(now, now, 'en'), /now/i);
  assert.match(formatRelativeTime(now - 5 * 60_000, now, 'en'), /5 minutes ago/);
  assert.match(formatRelativeTime(now - 3 * 3_600_000, now, 'en'), /3 hours ago/);
  assert.match(formatRelativeTime(now - 2 * 86_400_000, now, 'en'), /2 days ago/);
});
