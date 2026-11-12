/**
 * Pure text sanitising helpers (filenames, recording names, tags).
 * No DOM access so they can run in Node during tests.
 */

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * Turn arbitrary user text into a safe file name slug.
 * Keeps letters (including non-latin), digits, spaces, dots, dashes and
 * underscores; everything else is replaced.
 *
 * @param {string} input
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeFileName(input, fallback = 'recording', maxLength = 80) {
  const cleaned = String(input ?? '')
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, Math.max(1, maxLength))
    .replace(/[.\-\s]+$/, '');
  return cleaned || fallback;
}

/**
 * Trim and collapse whitespace for a display name. Empty input falls back.
 *
 * @param {string} input
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeDisplayName(input, fallback = 'Untitled recording', maxLength = 80) {
  const cleaned = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLength))
    .trim();
  return cleaned || fallback;
}

/**
 * Parse a comma separated tag string into a deduplicated list.
 * Tags are case-insensitively deduplicated but keep their original casing.
 *
 * @param {string|string[]} input
 * @param {{ maxTags?: number, maxLength?: number }} [options]
 * @returns {string[]}
 */
export function parseTags(input, { maxTags = 8, maxLength = 24 } = {}) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const tags = [];
  for (const raw of list) {
    const tag = String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= maxTags) break;
  }
  return tags;
}

/**
 * Serialise a tag list back into the input format.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTags(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

/**
 * Clamp a number into an inclusive range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

/**
 * Escape a string for safe interpolation into HTML.
 *
 * Defence in depth: the UI sets text with `textContent` and never assigns
 * `innerHTML`, so nothing needs escaping today — this stays available (and
 * tested) for any future markup that has to interpolate user text.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
