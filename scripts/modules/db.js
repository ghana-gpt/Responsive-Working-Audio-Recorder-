/**
 * IndexedDB persistence layer.
 *
 * Recordings are stored as Blobs in IndexedDB (localStorage cannot hold binary
 * data reliably). A tiny promise wrapper keeps the rest of the app free of
 * request/transaction bookkeeping. Writes resolve on `transaction.oncomplete`
 * so callers only continue once the data is actually durable.
 */

export const DB_NAME = 'audio-recorder';
export const DB_VERSION = 1;
export const STORE_RECORDINGS = 'recordings';

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

/** @type {Promise<IDBDatabase>|null} */
let databasePromise = null;

/**
 * Open (and upgrade if needed) the database once per page load.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  if (!isIndexedDbSupported()) {
    return Promise.reject(
      new StorageError('storage-unavailable', 'IndexedDB is not available in this browser'),
    );
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new StorageError('storage-unavailable', error.message, error));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const store = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('name', 'name', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab requested a version change: close so it is not blocked.
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      databasePromise = null;
      reject(new StorageError('storage-unavailable', request.error?.message, request.error));
    };
  });

  return databasePromise;
}

/**
 * Run a callback against the object store and resolve when the transaction
 * completes (so writes are durable, not merely queued).
 *
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => T} work
 * @returns {Promise<T>}
 */
async function runTransaction(mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE_RECORDINGS, mode);
    } catch (error) {
      reject(new StorageError('storage-unavailable', error.message, error));
      return;
    }

    let result;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      const code = error?.name === 'QuotaExceededError' ? 'quota-exceeded' : 'storage-unavailable';
      reject(new StorageError(code, error?.message, error));
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);

    try {
      result = work(transaction.objectStore(STORE_RECORDINGS));
    } catch (error) {
      fail(error);
      try {
        transaction.abort();
      } catch {
        /* already finished */
      }
    }
  });
}

/** Promisify a single IDBRequest. */
const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Repository used by the app. */
export const recordingsDb = {
  /** @returns {Promise<Array<object>>} */
  getAll() {
    return runTransaction('readonly', (store) => requestToPromise(store.getAll()));
  },

  /** @param {string} id */
  get(id) {
    return runTransaction('readonly', (store) => requestToPromise(store.get(id)));
  },

  /** @param {object} record */
  put(record) {
    return runTransaction('readwrite', (store) => {
      store.put({ ...record });
      return record;
    });
  },

  /** @param {object[]} records */
  putMany(records) {
    return runTransaction('readwrite', (store) => {
      for (const record of records) store.put({ ...record });
      return records;
    });
  },

  /** @param {string} id */
  remove(id) {
    return runTransaction('readwrite', (store) => {
      store.delete(id);
      return id;
    });
  },

  clear() {
    return runTransaction('readwrite', (store) => {
      store.clear();
      return true;
    });
  },

  count() {
    return runTransaction('readonly', (store) => requestToPromise(store.count()));
  },
};

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
 * Estimated quota/usage for the status line in settings.
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
