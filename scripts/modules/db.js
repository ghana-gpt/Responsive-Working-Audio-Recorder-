/**
 * IndexedDB access.
 *
 * Schema v2 keeps recording metadata and audio payloads in separate stores:
 *
 *   recordings  { id, name, createdAt, durationMs, mimeType, extension,
 *                 size, trimmed, tags, markers }
 *   blobs       { id, blob }
 *
 * The split means the library can be listed, searched and sorted without ever
 * pulling audio bytes into memory. v1 databases (one store holding `blob`) are
 * migrated in place on upgrade.
 */

export const DB_NAME = 'audio-recorder';
export const DB_VERSION = 2;

export const STORE_RECORDINGS = 'recordings';
export const STORE_BLOBS = 'blobs';

/** @type {Promise<IDBDatabase>|null} */
let databasePromise = null;

/** Error thrown for every storage failure, with a stable `code` for i18n. */
export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message ?? code);
    this.name = 'StorageError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** @returns {boolean} */
export function isIndexedDbSupported() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Strip the audio payload so only serialisable metadata remains. */
function metadataOnly(record) {
  if (!record || typeof record !== 'object') return null;
  const { blob, ...meta } = record;
  if (!Number.isFinite(Number(meta.size)) && blob && Number.isFinite(blob.size)) {
    meta.size = blob.size;
  }
  return meta;
}

/**
 * Create the v2 object stores and migrate v1 rows.
 *
 * @param {IDBDatabase} db
 * @param {IDBTransaction} transaction
 * @param {number} oldVersion
 */
function upgrade(db, transaction, oldVersion) {
  if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
    const store = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
    store.createIndex('createdAt', 'createdAt');
    store.createIndex('name', 'name');
    store.createIndex('size', 'size');
  } else if (oldVersion > 0 && oldVersion < 2) {
    const store = transaction.objectStore(STORE_RECORDINGS);
    if (!store.indexNames.contains('size')) store.createIndex('size', 'size');
  }

  if (!db.objectStoreNames.contains(STORE_BLOBS)) {
    db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
  }

  if (oldVersion > 0 && oldVersion < 2) migrateV1(transaction);
}

/** Move `blob` out of v1 recording rows into the dedicated blobs store. */
function migrateV1(transaction) {
  const recordings = transaction.objectStore(STORE_RECORDINGS);
  const blobs = transaction.objectStore(STORE_BLOBS);
  const request = recordings.openCursor();

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const value = cursor.value;
    if (value && typeof value === 'object' && value.blob) {
      blobs.put({ id: value.id, blob: value.blob });
      cursor.update(metadataOnly(value));
    }
    cursor.continue();
  };
}

/** Open (and cache) the database, upgrading the schema when required. */
export function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!isIndexedDbSupported()) {
    return Promise.reject(
      new StorageError('storage-unavailable', 'IndexedDB is not available in this browser'),
    );
  }

  databasePromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      databasePromise = null;
      reject(new StorageError('storage-unavailable', error.message, error));
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db) throw new Error('IndexedDB upgrade failed');
      upgrade(db, request.transaction, Number(event.oldVersion) || 0);
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema, release our handle so the next
      // call reopens a current connection.
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };

    request.onblocked = () => {
      // Another tab holds an old connection open; the upgrade waits for it.
    };
  });

  return databasePromise;
}

/** Wrap an IDBRequest in a promise. */
export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Map DOMException names to actionable error codes for the UI. */
function transactionError(error) {
  const name = error && typeof error === 'object' ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageError('quota-exceeded', 'Storage is full', error);
  }
  if (name === 'InvalidStateError') {
    return new StorageError('connection-closed', 'The database connection was closed', error);
  }
  return error instanceof StorageError
    ? error
    : new StorageError('storage-failed', error?.message ?? String(error), error);
}

/**
 * Run `work` inside a transaction over `storeNames`.
 *
 * Read-write work resolves once the transaction commits, so a resolved promise
 * means the data is durable.
 *
 * @template T
 * @param {string|string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore, transaction: IDBTransaction) => T} work
 * @returns {Promise<T>}
 */
async function runTransaction(storeNames, mode, work) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(names, mode);
    } catch (error) {
      reject(transactionError(error));
      return;
    }

    let result;
    try {
      result = work(transaction.objectStore(names[0]), transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* already finished */
      }
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transactionError(transaction.error));
    transaction.onabort = () => reject(transactionError(transaction.error));
  });
}

/**
 * Convenience for read-only requests.
 *
 * The request handlers must be attached synchronously (before the transaction
 * commits): listening after `oncomplete` would miss the already-dispatched
 * `success` event and leave the promise pending forever.
 */
async function read(storeName, requestFactory) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeName, 'readonly');
    } catch (error) {
      reject(transactionError(error));
      return;
    }

    let request;
    try {
      request = requestFactory(transaction.objectStore(storeName));
    } catch (error) {
      reject(error);
      return;
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(transactionError(request.error));
    transaction.onabort = () => reject(transactionError(transaction.error));
  });
}

/* -------------------------------------------------------------------------- */
/* Recordings                                                                  */
/* -------------------------------------------------------------------------- */

/** All recording metadata (never includes blobs). */
export async function getAll() {
  const records = await read(STORE_RECORDINGS, (store) => store.getAll());
  return (Array.isArray(records) ? records : []).map(metadataOnly).filter(Boolean);
}

/** Recording metadata by id, or `null`. */
export async function get(id) {
  const record = await read(STORE_RECORDINGS, (store) => store.get(id));
  return metadataOnly(record) ?? null;
}

/** Audio payload by id, or `null`. */
export async function getBlob(id) {
  const entry = await read(STORE_BLOBS, (store) => store.get(id));
  return entry?.blob instanceof Blob ? entry.blob : null;
}

/**
 * Insert or replace a recording and its audio payload atomically.
 *
 * @param {Record<string, unknown>} record metadata (a `blob` property is
 *   accepted for convenience and routed to the blobs store)
 * @param {Blob|null} [blob]
 */
export async function put(record, blob) {
  const payload = blob instanceof Blob ? blob : record?.blob instanceof Blob ? record.blob : null;
  const meta = metadataOnly(record);
  if (!meta?.id) throw new TypeError('put(record) needs a record with an id');
  if (payload && !Number.isFinite(Number(meta.size))) meta.size = payload.size;

  return runTransaction([STORE_RECORDINGS, STORE_BLOBS], 'readwrite', (store, transaction) => {
    store.put(meta);
    // Metadata-only writes (rename, retag) must leave the payload untouched.
    if (payload) transaction.objectStore(STORE_BLOBS).put({ id: meta.id, blob: payload });
    return meta;
  });
}

/**
 * Insert many recordings in a single transaction.
 *
 * @param {{ record: Record<string, unknown>, blob?: Blob|null }[]} entries
 * @returns {Promise<number>} number of rows written
 */
export async function putMany(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.record?.id) : [];
  if (list.length === 0) return 0;
  return runTransaction([STORE_RECORDINGS, STORE_BLOBS], 'readwrite', (store, transaction) => {
    const blobStore = transaction.objectStore(STORE_BLOBS);
    for (const { record, blob } of list) {
      const meta = metadataOnly(record);
      if (blob instanceof Blob && !Number.isFinite(Number(meta.size))) meta.size = blob.size;
      store.put(meta);
      if (blob instanceof Blob) blobStore.put({ id: meta.id, blob });
    }
    return list.length;
  });
}

/** Update metadata without touching the stored payload. */
export async function update(record) {
  const meta = metadataOnly(record);
  if (!meta?.id) throw new TypeError('update(record) needs a record with an id');
  return runTransaction(STORE_RECORDINGS, 'readwrite', (store) => {
    store.put(meta);
    return meta;
  });
}

/** Delete one recording and its payload. */
export async function remove(id) {
  return removeMany([id]);
}

/** Delete many recordings and their payloads in one transaction. */
export async function removeMany(ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  if (list.length === 0) return 0;
  return runTransaction([STORE_RECORDINGS, STORE_BLOBS], 'readwrite', (store, transaction) => {
    const blobStore = transaction.objectStore(STORE_BLOBS);
    for (const id of list) {
      store.delete(id);
      blobStore.delete(id);
    }
    return list.length;
  });
}

/** Remove every recording and payload. */
export async function clear() {
  return runTransaction([STORE_RECORDINGS, STORE_BLOBS], 'readwrite', (store, transaction) => {
    transaction.objectStore(STORE_BLOBS).clear();
    store.clear();
  });
}

/** Number of stored recordings. */
export async function count() {
  return read(STORE_RECORDINGS, (store) => store.count());
}

/** The public recordings API used by the store module. */
export const recordingsDb = {
  getAll,
  get,
  getBlob,
  put,
  putMany,
  update,
  remove,
  removeMany,
  clear,
  count,
};

/* -------------------------------------------------------------------------- */
/* Quota helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ask the browser to keep this origin's storage (best effort — prevents the
 * recordings from being evicted when the device runs low on space).
 * @returns {Promise<boolean>}
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    const already = (await navigator.storage.persisted?.()) ?? false;
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Estimated quota/usage for the storage panel.
 * @returns {Promise<{ usage: number, quota: number }|null>}
 */
export async function estimateStorage() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Share of the quota above which the UI warns about running out of space. */
export const STORAGE_WARN_RATIO = 0.9;

/** Share of the quota above which new recordings are at risk of failing. */
export const STORAGE_CRITICAL_RATIO = 0.98;

/**
 * Percentage (0–100) of the quota in use, or `null` when the browser does not
 * report an estimate.
 *
 * @param {{ usage?: number, quota?: number }|null} estimate
 * @returns {number|null}
 */
export function storagePercent(estimate) {
  if (!estimate) return null;
  const quota = Number(estimate.quota);
  if (!Number.isFinite(quota) || quota <= 0) return null;
  const usage = Math.max(0, Number(estimate.usage) || 0);
  return Math.min(100, Math.round((usage / quota) * 100));
}

/**
 * Severity of the current usage, used to colour the storage meter.
 *
 * @param {{ usage?: number, quota?: number }|null} estimate
 * @returns {'unknown'|'ok'|'warn'|'critical'}
 */
export function storageLevel(estimate) {
  if (!estimate) return 'unknown';
  const quota = Number(estimate.quota);
  if (!Number.isFinite(quota) || quota <= 0) return 'unknown';
  const ratio = Math.max(0, Number(estimate.usage) || 0) / quota;
  if (ratio >= STORAGE_CRITICAL_RATIO) return 'critical';
  if (ratio >= STORAGE_WARN_RATIO) return 'warn';
  return 'ok';
}
