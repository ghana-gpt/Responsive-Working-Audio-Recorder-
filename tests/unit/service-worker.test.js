import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SOURCE = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';

/** A `Response` shaped like a same-origin network reply (`type === 'basic'`). */
function basicResponse(body, status = 200) {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

/** Cache key: strings stay as-is, requests are keyed by their URL. */
function keyOf(target) {
  return typeof target === 'string' ? target : String(target?.url ?? target);
}

/** Reject when `promise` takes longer than `ms`, so a hung worker fails loudly. */
function within(promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

/**
 * Load service-worker.js in a sandbox with fake Cache Storage and network.
 *
 * @param {{
 *   cache?: Map<string, Response>,
 *   network?: (request: object) => Response | Promise<Response>,
 *   onPut?: (key: string, response: Response) => void | Promise<void>,
 * }} [options]
 */
function loadWorker({ cache = new Map(), network, onPut } = {}) {
  const handlers = new Map();
  const pending = [];
  const putCalls = [];
  const fetchCalls = [];
  /** @type {Promise<Response>|null} */
  let response = null;

  const cacheApi = {
    match: async (target) => cache.get(keyOf(target)),
    async put(target, value) {
      const key = keyOf(target);
      putCalls.push(key);
      await onPut?.(key, value);
      cache.set(key, value);
    },
    async add() {},
  };

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: async () => cacheApi,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: (request) => {
      fetchCalls.push(keyOf(request));
      return Promise.resolve(network ? network(request) : basicResponse('network body'));
    },
    console: { warn() {}, info() {}, error() {}, log() {} },
    URL,
    Request,
    Response,
    Promise,
  };

  createContext(sandbox);
  runInContext(SOURCE, sandbox);

  /**
   * Run the `fetch` handler for one request.
   *
   * @param {{ url: string, method?: string, mode?: string }} request
   */
  function dispatch(request) {
    const event = {
      request: { method: 'GET', ...request },
      waitUntil: (promise) => pending.push(promise),
      respondWith: (promise) => {
        response = promise;
      },
    };
    handlers.get('fetch')(event);
    return { response };
  }

  return { handlers, cache, putCalls, fetchCalls, pending, dispatch };
}

test('an asset is returned before its cache write finishes', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const worker = loadWorker({ onPut: () => gate }); // settles only when released

  const { response } = worker.dispatch({ url: `${ORIGIN}/scripts/main.js` });
  // A worker that awaited `cache.put` here would never answer, and Chromium
  // would abort multi-megabyte model downloads instead of streaming them.
  assert.equal(await within(response).then((r) => r.text()), 'network body');

  release();
  await Promise.all(worker.pending);
  assert.deepEqual(worker.putCalls, [`${ORIGIN}/scripts/main.js`]);
});

test('the cached copy keeps the whole body after the page reads it', async () => {
  /** @type {string|undefined} */
  let cachedBody;
  const worker = loadWorker({
    onPut: async (_key, value) => {
      cachedBody = await value.text();
    },
  });

  const { response } = worker.dispatch({ url: `${ORIGIN}/models/whisper-tiny/onnx/a.onnx` });
  assert.equal(await (await response).text(), 'network body');
  await Promise.all(worker.pending);
  assert.equal(cachedBody, 'network body');
});

test('a failed cache write does not break the asset', async () => {
  const worker = loadWorker({ onPut: () => Promise.reject(new Error('quota exceeded')) });

  const { response } = worker.dispatch({ url: `${ORIGIN}/styles/main.css` });
  assert.equal(await (await response).text(), 'network body');
  await Promise.all(worker.pending); // the rejection is handled by waitUntil
});

test('a cached asset is served while the network refresh runs in the background', async () => {
  const url = `${ORIGIN}/styles/main.css`;
  const worker = loadWorker({ cache: new Map([[url, new Response('cached css')]]) });

  const { response } = worker.dispatch({ url });
  assert.equal(await (await response).text(), 'cached css');
  await Promise.all(worker.pending);
  assert.deepEqual(worker.fetchCalls, [url]);
  assert.deepEqual(worker.putCalls, [url]);
});

test('a navigation falls back to the cached shell when the network is down', async () => {
  const worker = loadWorker({
    cache: new Map([['./index.html', new Response('cached shell')]]),
    network: () => {
      throw new Error('offline');
    },
  });

  const { response } = worker.dispatch({ url: `${ORIGIN}/library`, mode: 'navigate' });
  assert.equal(await (await response).text(), 'cached shell');
});

test('a navigation refreshes the cached shell without blocking', async () => {
  /** @type {string|undefined} */
  let cachedBody;
  const worker = loadWorker({
    onPut: async (_key, value) => {
      cachedBody = await value.text();
    },
  });

  const { response } = worker.dispatch({ url: `${ORIGIN}/`, mode: 'navigate' });
  assert.equal(await (await response).text(), 'network body');
  await Promise.all(worker.pending);
  assert.equal(cachedBody, 'network body');
  assert.deepEqual(worker.putCalls, ['./index.html']);
});

test('only same-origin GETs are handled', async () => {
  const worker = loadWorker();
  const ignored = [
    { url: `${ORIGIN}/api`, method: 'POST' },
    { url: 'https://cdn.example.com/lib.js' },
    { url: 'blob:https://app.test/1234' },
  ];

  for (const request of ignored) {
    assert.equal(worker.dispatch(request).response, null, `handled ${request.url}`);
  }
  assert.deepEqual(worker.fetchCalls, []);
});
