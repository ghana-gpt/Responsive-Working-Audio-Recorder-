/**
 * Recording repository: an in-memory cache in front of IndexedDB.
 *
 * The cache keeps the library instant to render while IndexedDB provides
 * durability. Every mutation writes through to the database first, so a failed
 * write never leaves the UI showing data that is not persisted.
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
  /** @type {object[]} */
  let cache = [];
  let loaded = false;

  const ensureLoaded = async () => {
    if (!loaded) await refresh();
    return cache;
  };

  /** Reload everything from IndexedDB into the cache. */
  async function refresh() {
    const records = await db.getAll();
    cache = Array.isArray(records) ? records.filter((record) => record?.blob) : [];
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
   *   durationMs?: number,
   *   mimeType?: string,
   *   extension?: string,
   *   sourceId?: string|null,
   *   trimmed?: boolean,
   * }} input
   * @returns {Promise<object>} the stored record
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
    await db.put(record);
    cache = [...cache, record];
    return record;
  }

  /**
   * Update an existing recording (rename, retag, replace audio after trimming).
   *
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async function update(id, patch) {
    await ensureLoaded();
    const existing = findRecording(cache, id);
    if (!existing) throw new StorageError('not-found', `Recording ${id} does not exist`);
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now(),
    };
    await db.put(merged);
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
    clear,
    list,
    get,
    stats,
    suggestName,
    all: () => cache.slice(),
    isLoaded: () => loaded,
  };
}
