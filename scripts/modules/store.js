/**
 * Recording repository: a metadata cache in front of IndexedDB.
 *
 * Audio payloads live in their own object store (`blobs`) and are only read
 * when something actually needs the bytes (playback, download, export). The
 * cache therefore holds small metadata objects, which keeps the library fast
 * and memory flat no matter how many hours of audio are stored.
 *
 * Every mutation writes through to the database first, so a failed write never
 * leaves the UI showing data that is not persisted.
 */

import { StorageError, recordingsDb } from './db.js';
import {
  buildRecording,
  computeStats,
  filterRecordings,
  findRecording,
  nextDefaultName,
  sortRecordings,
} from './library.js';

/**
 * RFC4122 v4 id with a fallback for browsers without crypto.randomUUID.
 * @returns {string}
 */
export function createId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keep metadata objects free of payload-sized properties. */
function stripPayload(record) {
  if (!record || typeof record !== 'object') return null;
  const { blob, ...meta } = record;
  if (!Number.isFinite(Number(meta.size)) && blob && Number.isFinite(blob.size)) {
    meta.size = blob.size;
  }
  return meta;
}

/**
 * @param {{
 *   db?: typeof recordingsDb,
 *   now?: () => number,
 *   idFactory?: () => string,
 * }} [dependencies]
 */
export function createRepository({
  db = recordingsDb,
  now = () => Date.now(),
  idFactory = createId,
} = {}) {
  /** @type {object[]} metadata only — never any audio bytes */
  let cache = [];
  let loaded = false;

  const ensureLoaded = async () => {
    if (!loaded) await refresh();
    return cache;
  };

  /** Reload every recording's metadata from IndexedDB into the cache. */
  async function refresh() {
    const records = await db.getAll();
    cache = (Array.isArray(records) ? records : [])
      .map(stripPayload)
      .filter((record) => record?.id);
    loaded = true;
    return cache.slice();
  }

  /**
   * Persist a new recording produced by the recorder.
   *
   * @param {{
   *   blob: Blob,
   *   name?: string,
   *   tags?: string[],
   *   markers?: Array<{ atMs?: number, note?: string }>,
   *   durationMs?: number,
   *   mimeType?: string,
   *   extension?: string,
   *   sourceId?: string|null,
   *   trimmed?: boolean,
   * }} input
   * @returns {Promise<object>} the stored metadata record
   */
  async function create(input) {
    await ensureLoaded();
    const timestamp = now();
    const record = buildRecording({
      ...input,
      id: idFactory(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.put(record, input?.blob ?? null);
    cache = [...cache, record];
    return record;
  }

  /**
   * Update an existing recording (rename, retag, replace audio after trimming).
   *
   * Pass `blob` in the patch to replace the stored audio payload; omit it to
   * keep the existing bytes.
   *
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async function update(id, patch) {
    await ensureLoaded();
    const existing = findRecording(cache, id);
    if (!existing) throw new StorageError('not-found', `Recording ${id} does not exist`);
    // A replaced payload defines the new size unless the caller is explicit;
    // otherwise a trim would keep reporting the old (too large) size.
    const replacedBlob = patch?.blob instanceof Blob ? patch.blob : null;
    const size =
      replacedBlob && !Number.isFinite(Number(patch?.size)) ? replacedBlob.size : patch?.size;
    const merged = buildRecording({
      ...existing,
      ...patch,
      ...(size !== undefined ? { size } : {}),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now(),
    });
    await db.put(merged, replacedBlob);
    cache = cache.map((record) => (record.id === id ? merged : record));
    return merged;
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} true when a record was removed
   */
  async function remove(id) {
    await ensureLoaded();
    if (!findRecording(cache, id)) return false;
    await db.remove(id);
    cache = cache.filter((record) => record.id !== id);
    return true;
  }

  /**
   * Remove several recordings in a single transaction.
   *
   * @param {Iterable<string>} ids
   * @returns {Promise<number>} how many were actually removed
   */
  async function removeMany(ids) {
    await ensureLoaded();
    const existing = [...new Set(ids ?? [])].filter((id) => findRecording(cache, id));
    if (existing.length === 0) return 0;
    await db.removeMany(existing);
    const removed = new Set(existing);
    cache = cache.filter((record) => !removed.has(record.id));
    return existing.length;
  }

  /**
   * Insert recordings restored from a backup. Rows whose id already exists get
   * a fresh id, so a restore never silently overwrites local audio.
   *
   * Entries are normalised first: a manifest row without an id or without a
   * `size` is repaired from the payload instead of aborting the whole restore,
   * and rows that cannot be interpreted at all are skipped.
   *
   * @param {Array<{ record: object, blob: Blob|null }>} entries
   * @returns {Promise<object[]>} the inserted metadata records
   */
  async function restore(entries) {
    await ensureLoaded();
    const taken = new Set(cache.map((record) => record.id));
    const inserted = [];
    const payloads = [];

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.record) continue;
      const blob = entry.blob instanceof Blob ? entry.blob : null;
      const wanted = entry.record.id ? String(entry.record.id) : '';
      let record;
      try {
        record = buildRecording({
          ...entry.record,
          // The payload is passed through so `size` can be derived from it.
          blob,
          id: wanted && !taken.has(wanted) ? wanted : idFactory(),
        });
      } catch {
        continue; // unusable row: skip it rather than losing the whole archive
      }
      taken.add(record.id);
      inserted.push(record);
      payloads.push({ record, blob });
    }

    if (inserted.length === 0) return [];
    await db.putMany(payloads);
    cache = [...cache, ...inserted];
    return inserted;
  }

  /**
   * The audio payload for a recording, read from IndexedDB on demand.
   *
   * @param {string} id
   * @returns {Promise<Blob|null>}
   */
  async function blobFor(id) {
    if (!id) return null;
    return db.getBlob(id);
  }

  /** Remove every recording. */
  async function clear() {
    await db.clear();
    cache = [];
    loaded = true;
    return true;
  }

  /**
   * Records matching a search term, sorted as requested.
   * @param {{ query?: string, sort?: string }} [options]
   */
  function list({ query = '', sort = 'newest' } = {}) {
    return sortRecordings(filterRecordings(cache, query), sort);
  }

  /** @param {string} id */
  function get(id) {
    return findRecording(cache, id);
  }

  function stats() {
    return computeStats(cache);
  }

  /** Suggested name for the next recording ("Recording 4"). */
  function suggestName(base = 'Recording') {
    return nextDefaultName(cache, base);
  }

  return {
    refresh,
    create,
    update,
    remove,
    removeMany,
    restore,
    blobFor,
    clear,
    list,
    get,
    stats,
    suggestName,
    all: () => cache.slice(),
    isLoaded: () => loaded,
  };
}
