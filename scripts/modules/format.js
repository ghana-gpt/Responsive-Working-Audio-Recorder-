/**
 * Pure formatting helpers.
 *
 * This module must stay free of DOM/browser APIs so it can be unit tested in
 * Node (see tests/unit/format.test.js) and reused by the service worker.
 */

/**
 * Format a duration in milliseconds as MM:SS, or H:MM:SS when it is an hour or
 * longer. Negative/NaN input is normalised to 0 so the UI never shows "-1:-1".
 *
 * @param {number} milliseconds
 * @returns {string} e.g. "00:07", "12:34", "1:02:03"
 */
export function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Format a position inside a clip where sub-second precision matters (the trim
 * handles). Below a minute it keeps one decimal so 0.4 s and 0.9 s do not both
 * collapse to "00:00"; longer values fall back to `formatDuration`.
 *
 * @param {number} seconds
 * @returns {string} e.g. "0.0 s", "0.9 s", "01:02"
 */
export function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value.toFixed(1)} s`;
  return formatDuration(Math.round(value * 1000));
}

/**
 * Human readable file size using binary multiples (1 KB = 1024 B).
 *
 * @param {number} bytes
 * @returns {string} e.g. "0 B", "948 B", "12.4 KB", "1.2 MB"
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Format a date as a locale aware date + time string.
 *
 * @param {number|Date} date
 * @param {string} [locale] BCP-47 tag, defaults to the runtime locale
 * @returns {string}
 */
export function formatDateTime(date, locale) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      value,
    );
  } catch {
    return value.toLocaleString();
  }
}

/**
 * Locale aware "5 minutes ago" helper built on Intl.RelativeTimeFormat.
 *
 * @param {number} timestamp epoch milliseconds
 * @param {number} [now] epoch milliseconds used as "now"
 * @param {string} [locale]
 * @returns {string}
 */
export function formatRelativeTime(timestamp, now = Date.now(), locale) {
  const diffSeconds = Math.round((Number(timestamp) - Number(now)) / 1000);
  const thresholds = [
    { limit: 60, divisor: 1, unit: 'second' },
    { limit: 3600, divisor: 60, unit: 'minute' },
    { limit: 86400, divisor: 3600, unit: 'hour' },
    { limit: 604800, divisor: 86400, unit: 'day' },
    { limit: 2629800, divisor: 604800, unit: 'week' },
    { limit: 31557600, divisor: 2629800, unit: 'month' },
    { limit: Infinity, divisor: 31557600, unit: 'year' },
  ];
  const abs = Math.abs(diffSeconds);
  const bucket = thresholds.find((entry) => abs < entry.limit) ?? thresholds[thresholds.length - 1];
  const value = Math.round(diffSeconds / bucket.divisor);
  // -0 reads badly ("0 seconds ago" is fine, "-0" is not).
  const normalised = value === 0 ? 0 : value;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(normalised, bucket.unit);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/**
 * Build a filesystem friendly timestamp, e.g. "2026-11-09_13-45-02".
 *
 * @param {Date|number} [date]
 * @returns {string}
 */
export function timestampForFilename(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return 'unknown-date';
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}-${pad(value.getMinutes())}-${pad(value.getSeconds())}`;
  return `${day}_${time}`;
}

/**
 * Compose a download file name: "<slug>_<timestamp>.<ext>".
 * The slug is sanitised by the caller (see sanitize.js).
 *
 * @param {{ name?: string, date?: Date|number, extension: string }} options
 * @returns {string}
 */
export function buildFileName({ name = '', date = new Date(), extension = 'webm' }) {
  const stamp = timestampForFilename(date);
  const safeName = String(name || '').trim() || 'recording';
  const safeExtension = String(extension || 'webm').replace(/^\./, '');
  return `${safeName}_${stamp}.${safeExtension}`;
}
