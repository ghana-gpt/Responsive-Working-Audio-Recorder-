/**
 * Pure helpers for the recording library (search, sort, statistics).
 * No IndexedDB or DOM access — covered by tests/unit/library.test.js.
 */

export const SORT_NEWEST = 'newest';
export const SORT_OLDEST = 'oldest';
export const SORT_NAME = 'name';
export const SORT_LONGEST = 'longest';
export const SORT_LARGEST = 'largest';

export const SORT_OPTIONS = [SORT_NEWEST, SORT_OLDEST, SORT_NAME, SORT_LONGEST, SORT_LARGEST];

/** How many rows the library renders before the "show more" button. */
export const LIBRARY_PAGE_SIZE = 50;

/** Markers are clamped to this many per recording to keep metadata small. */
export const MAX_MARKERS = 500;

/**
 * Case-insensitive search across the recording name and its tags.
 * An empty query returns everything (a copy, so callers can sort safely).
 *
 * @param {Array<{ name?: string, tags?: string[] }>} records
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterRecordings(records, query) {
  const list = Array.isArray(records) ? records : [];
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return list.slice();
  return list.filter((record) => {
    const name = String(record?.name ?? '').toLowerCase();
    if (name.includes(needle)) return true;
    const tags = Array.isArray(record?.tags) ? record.tags : [];
    return tags.some((tag) => String(tag).toLowerCase().includes(needle));
  });
}

/**
 * Return a new sorted array. Unknown keys fall back to newest-first.
 *
 * @param {Array<object>} records
 * @param {string} [sort]
 * @returns {Array<object>}
 */
export function sortRecordings(records, sort = SORT_NEWEST) {
  const list = Array.isArray(records) ? records.slice() : [];
  const byNewest = (a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0);
  switch (sort) {
    case SORT_OLDEST:
      return list.sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0));
    case SORT_NAME:
      return list.sort(
        (a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, {
            numeric: true,
            sensitivity: 'base',
          }) || byNewest(a, b),
      );
    case SORT_LONGEST:
      return list.sort((a, b) => (b?.durationMs ?? 0) - (a?.durationMs ?? 0) || byNewest(a, b));
    case SORT_LARGEST:
      return list.sort((a, b) => (b?.size ?? 0) - (a?.size ?? 0) || byNewest(a, b));
    case SORT_NEWEST:
    default:
      return list.sort(byNewest);
  }
}

/**
 * Aggregate statistics shown in the settings panel.
 *
 * @param {Array<{ durationMs?: number, size?: number, createdAt?: number }>} records
 * @returns {{ count: number, totalDurationMs: number, totalBytes: number, newestAt: number|null }}
 */
export function computeStats(records) {
  const list = Array.isArray(records) ? records : [];
  let totalDurationMs = 0;
  let totalBytes = 0;
  let newestAt = null;
  for (const record of list) {
    totalDurationMs += Number(record?.durationMs) || 0;
    totalBytes += Number(record?.size) || 0;
    const createdAt = Number(record?.createdAt) || 0;
    if (createdAt && (newestAt === null || createdAt > newestAt)) newestAt = createdAt;
  }
  return { count: list.length, totalDurationMs, totalBytes, newestAt };
}

/**
 * The `limit` heaviest recordings, used by the storage panel to point at what
 * is worth deleting first.
 *
 * @param {Array<{ size?: number }>} records
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function topRecordings(records, limit = 5) {
  const count = Math.max(0, Math.round(Number(limit) || 0));
  return (Array.isArray(records) ? records.slice() : [])
    .sort((a, b) => (Number(b?.size) || 0) - (Number(a?.size) || 0))
    .slice(0, count);
}

/**
 * Slice a list down to the visible window for incremental rendering.
 *
 * `visible` is rounded up to whole pages so "show more" always adds exactly one
 * page and never reflows existing rows.
 *
 * @param {Array<object>} records
 * @param {number} visible
 * @param {number} [pageSize]
 * @returns {{ records: Array<object>, shown: number, total: number, hasMore: boolean }}
 */
export function pageWindow(records, visible, pageSize = LIBRARY_PAGE_SIZE) {
  const list = Array.isArray(records) ? records : [];
  const size = Math.max(1, Math.round(Number(pageSize) || LIBRARY_PAGE_SIZE));
  const requested = Math.max(size, Math.round(Number(visible) || size));
  const limit = Math.min(list.length, Math.ceil(requested / size) * size);
  return {
    records: list.slice(0, limit),
    shown: limit,
    total: list.length,
    hasMore: limit < list.length,
  };
}

/**
 * Clamp marker input to the persisted shape: `{ atMs, note }`, sorted by time.
 *
 * @param {Array<{ atMs?: number, note?: string }>} input
 * @returns {{ atMs: number, note: string }[]}
 */
export function normalizeMarkers(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const markers = [];
  for (const marker of list) {
    const atMs = Math.max(0, Math.round(Number(marker?.atMs) || 0));
    const note = String(marker?.note ?? '')
      .trim()
      .slice(0, 120);
    const key = `${atMs}:${note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ atMs, note });
  }
  return markers.sort((a, b) => a.atMs - b.atMs).slice(0, MAX_MARKERS);
}

/**
 * Find a record by id.
 * @param {Array<{ id: string }>} records
 * @param {string} id
 * @returns {object|undefined}
 */
export function findRecording(records, id) {
  return (Array.isArray(records) ? records : []).find((record) => record?.id === id);
}

/**
 * Suggest a name that does not collide with existing ones, e.g. "Recording 3".
 *
 * @param {Array<{ name?: string }>} records
 * @param {string} [base] localised word for "recording"
 * @returns {string}
 */
export function nextDefaultName(records, base = 'Recording') {
  const list = Array.isArray(records) ? records : [];
  const escaped = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s+(\\d+)$`, 'i');
  let highest = 0;
  for (const record of list) {
    const match = pattern.exec(String(record?.name ?? '').trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const existing = new Set(
    list.map((record) =>
      String(record?.name ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  let candidate = highest + 1;
  while (existing.has(`${base} ${candidate}`.toLowerCase())) candidate += 1;
  return `${base} ${candidate}`;
}

/**
 * Normalise the persisted shape of a recording. Keeps every field the UI needs
 * and never throws for missing values, so old records keep loading.
 *
 * Audio bytes are passed separately when creating a recording (the store keeps
 * metadata and payload in different object stores). `size` alone is enough for
 * restoring metadata from a backup manifest.
 *
 * @param {{
 *   id: string,
 *   name: string,
 *   tags?: string[],
 *   markers?: Array<{ atMs?: number, note?: string }>,
 *   blob?: Blob|null,
 *   mimeType: string,
 *   extension: string,
 *   durationMs?: number,
 *   size?: number,
 *   createdAt?: number,
 *   updatedAt?: number,
 *   sourceId?: string|null,
 *   trimmed?: boolean,
 * }} input
 * @returns {object}
 */
export function buildRecording(input) {
  const {
    id,
    name,
    tags = [],
    markers = [],
    blob,
    mimeType = 'audio/webm',
    extension = 'webm',
    durationMs = 0,
    size,
    createdAt = 0,
    updatedAt,
    sourceId = null,
    trimmed = false,
  } = input ?? {};
  if (!id) throw new TypeError('buildRecording requires an id');

  const blobSize = blob && typeof blob.size === 'number' ? blob.size : null;
  const declaredSize = Number(size);
  const finalSize = Number.isFinite(declaredSize) ? declaredSize : blobSize;
  if (finalSize === null || finalSize === undefined || !Number.isFinite(finalSize)) {
    throw new TypeError('buildRecording requires a Blob or a size');
  }

  return {
    id: String(id),
    name: String(name ?? '').trim(),
    tags: Array.isArray(tags)
      ? tags
          .map((tag) => String(tag).trim())
          .filter(Boolean)
          .slice(0, 12)
      : [],
    markers: normalizeMarkers(markers),
    mimeType,
    extension,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    size: Math.max(0, Number(finalSize)),
    createdAt: Number(createdAt) || 0,
    updatedAt: Number(updatedAt) || Number(createdAt) || 0,
    sourceId: sourceId ? String(sourceId) : null,
    trimmed: Boolean(trimmed),
  };
}
