import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';

import {
  MODEL_CACHE_NAME,
  MODEL_RUNTIME_CACHE,
  assertSpace,
  availableBytes,
  clearModel,
  downloadModel,
  manifestBytes,
  manifestFiles,
  modelFileUrl,
  modelStatus,
  parseManifest,
  readManifest,
  sha256Hex,
} from '../../scripts/modules/model-manager.js';

const ROOT = 'https://app.test/models/whisper-tiny/';
const MANIFEST_URL = 'https://app.test/model-package.json';
const encoder = new TextEncoder();

/** SHA-256 of a string, as the manifest generator writes it. */
const digest = (text) => createHash('sha256').update(text).digest('hex');

/** Build a raw manifest for `{ path: contents }`, sized and hashed like the build. */
function manifestFor(files) {
  const entries = {};
  let total = 0;
  for (const [path, body] of Object.entries(files)) {
    const data = encoder.encode(body);
    entries[path] = { bytes: data.byteLength, sha256: digest(body) };
    total += data.byteLength;
  }
  return { name: 'whisper-tiny', version: 'v1', modelBytes: total, files: entries };
}

/** A CacheStorage stand-in: one in-memory map per cache name. */
function fakeCaches() {
  const stores = new Map();
  const deleted = [];

  function open(name) {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        match: async (target) => entries.get(String(target)),
        put: async (target, response) => {
          entries.set(String(target), response);
        },
        delete: async (target) => entries.delete(String(target)),
      });
    }
    return stores.get(name);
  }

  return {
    deleted,
    open: async (name) => open(name),
    delete: async (name) => {
      deleted.push(name);
      stores.delete(name);
      return true;
    },
    entriesFor: (name) => open(name).entries,
  };
}

/** Run `fn` with `console.warn` muted so expected fallbacks stay quiet. */
async function withoutWarnings(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

test('parseManifest normalises entries and totals the file list', () => {
  const parsed = parseManifest({
    name: 'whisper-tiny',
    version: 'v2',
    files: {
      'config.json': { bytes: 12, sha256: 'A'.repeat(64) },
      'onnx/model.onnx': { bytes: 30, sha256: 'b'.repeat(64) },
    },
  });

  assert.equal(parsed.name, 'whisper-tiny');
  assert.equal(parsed.version, 'v2');
  assert.equal(parsed.modelBytes, 42);
  assert.deepEqual(parsed.files['config.json'], { bytes: 12, sha256: 'a'.repeat(64) });
});

test('parseManifest rejects anything it cannot verify', () => {
  const invalid = [
    null,
    {},
    { files: [] },
    { files: {} },
    { files: { 'a.bin': { bytes: 0, sha256: 'a'.repeat(64) } } },
    { files: { 'a.bin': { bytes: 3, sha256: 'not-a-checksum' } } },
  ];

  for (const raw of invalid) {
    assert.throws(
      () => parseManifest(raw),
      (error) => error.code === 'modelManifestInvalid',
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

test('manifestFiles resolves every entry against the model folder', () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'cfg', 'onnx/model.onnx': 'graph' }));
  const files = manifestFiles(manifest, ROOT);

  assert.deepEqual(
    files.map((file) => file.url),
    [`${ROOT}config.json`, `${ROOT}onnx/model.onnx`],
  );
  assert.equal(manifestBytes(manifest), 8);
  assert.equal(modelFileUrl('config.json', ROOT), `${ROOT}config.json`);
});

test('sha256Hex matches the reference digest and refuses unsupported browsers', async () => {
  assert.equal(
    await sha256Hex(encoder.encode('abc'), webcrypto),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  await assert.rejects(
    sha256Hex(new Uint8Array([1]), {}),
    (error) => error.code === 'modelUnsupported',
  );
});
test('readManifest serves the cached copy without touching the network', async () => {
  const cachesImpl = fakeCaches();
  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  await store.put(MANIFEST_URL, new Response(JSON.stringify(manifestFor({ 'a.bin': 'hello' }))));
  let fetched = 0;

  const manifest = await readManifest({
    url: MANIFEST_URL,
    cachesImpl,
    fetchImpl: async () => {
      fetched += 1;
      return new Response('{}');
    },
  });

  assert.equal(manifest.files['a.bin'].bytes, 5);
  assert.equal(fetched, 0, 'an installed model must be inspectable offline');
});

test('readManifest caches the network copy for the next offline check', async () => {
  const body = JSON.stringify(manifestFor({ 'a.bin': 'hello' }));
  const cachesImpl = fakeCaches();
  const calls = [];

  const manifest = await readManifest({
    url: MANIFEST_URL,
    cachesImpl,
    fetchImpl: async (url, options) => {
      calls.push([String(url), options?.cache]);
      return new Response(body);
    },
  });

  assert.equal(manifest.files['a.bin'].sha256, digest('hello'));
  assert.deepEqual(calls, [[MANIFEST_URL, 'no-store']]);
  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  assert.ok(await store.match(MANIFEST_URL));
});

test('readManifest reports an unreachable manifest as unavailable', async () => {
  await assert.rejects(
    readManifest({
      url: MANIFEST_URL,
      cachesImpl: fakeCaches(),
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    (error) => error.code === 'modelManifestUnavailable',
  );

  await assert.rejects(
    readManifest({
      url: MANIFEST_URL,
      cachesImpl: null,
      fetchImpl: async () => new Response('', { status: 404 }),
    }),
    (error) => error.code === 'modelManifestUnavailable',
  );
});

test('readManifest replaces a corrupt cached manifest with the network copy', async () => {
  const cachesImpl = fakeCaches();
  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  await store.put(MANIFEST_URL, new Response('{not json'));

  const manifest = await withoutWarnings(() =>
    readManifest({
      url: MANIFEST_URL,
      cachesImpl,
      fetchImpl: async () => new Response(JSON.stringify(manifestFor({ 'a.bin': 'a' }))),
    }),
  );

  assert.equal(manifest.files['a.bin'].bytes, 1);
});

test('modelStatus counts files found in either model cache', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'cfg', 'onnx/model.onnx': 'graph' }));
  const files = manifestFiles(manifest, ROOT);
  const cachesImpl = fakeCaches();
  const model = await cachesImpl.open(MODEL_CACHE_NAME);
  const runtime = await cachesImpl.open(MODEL_RUNTIME_CACHE);
  await model.put(files[0].url, new Response('cfg'));
  await runtime.put(files[1].url, new Response('graph'));

  const status = await modelStatus({ manifest, root: ROOT, cachesImpl });

  assert.equal(status.supported, true);
  assert.equal(status.ready, true);
  assert.equal(status.complete, 2);
  assert.equal(status.cachedBytes, 8);
  assert.deepEqual(status.missing, []);
});

test('modelStatus treats a truncated cache entry as missing', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'cfg' }));
  const cachesImpl = fakeCaches();
  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  const [file] = manifestFiles(manifest, ROOT);
  await store.put(file.url, new Response('cfg', { headers: { 'content-length': '99' } }));

  const status = await modelStatus({ manifest, root: ROOT, cachesImpl });

  assert.equal(status.ready, false);
  assert.equal(status.complete, 0);
  assert.deepEqual(status.missing, ['config.json']);
});

test('modelStatus is unsupported when the browser cannot cache files', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'cfg' }));

  const status = await modelStatus({ manifest, root: ROOT, cachesImpl: null });

  assert.equal(status.supported, false);
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ['config.json']);
});

test('downloadModel verifies every file before caching it', async () => {
  const bodies = { 'config.json': '{"model":"tiny"}', 'onnx/model.onnx': 'graph' };
  const manifest = parseManifest(manifestFor(bodies));
  const files = manifestFiles(manifest, ROOT);
  const urls = new Map(files.map((file) => [file.url, bodies[file.path]]));
  const cachesImpl = fakeCaches();
  const progress = [];
  const fetched = [];

  const result = await downloadModel({
    manifest,
    root: ROOT,
    manifestUrl: MANIFEST_URL,
    cachesImpl,
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(urls.get(String(url)));
    },
    onProgress: ({ fraction }) => progress.push(fraction),
  });

  assert.deepEqual(result, { bytes: manifestBytes(manifest), files: 2 });
  assert.deepEqual(
    fetched,
    files.map((file) => file.url),
  );

  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  for (const file of files) assert.ok(await store.match(file.url), `${file.path} was cached`);
  assert.ok(await store.match(MANIFEST_URL), 'the manifest is cached for offline checks');

  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
});

test('downloadModel refuses a file whose checksum does not match', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'good' }));
  const cachesImpl = fakeCaches();
  let calls = 0;

  await assert.rejects(
    downloadModel({
      manifest,
      root: ROOT,
      manifestUrl: MANIFEST_URL,
      cachesImpl,
      fetchImpl: async () => {
        calls += 1;
        return new Response('tampered');
      },
    }),
    (error) => error.code === 'modelCorrupt',
  );

  assert.equal(calls, 2, 'a bad copy is retried once before giving up');
  const store = await cachesImpl.open(MODEL_CACHE_NAME);
  const [file] = manifestFiles(manifest, ROOT);
  assert.equal(await store.match(file.url), undefined, 'nothing corrupt is cached');
});

test('downloadModel stops when the download is cancelled', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'good' }));
  const controller = new AbortController();
  controller.abort();
  let fetched = 0;

  await assert.rejects(
    downloadModel({
      manifest,
      root: ROOT,
      cachesImpl: fakeCaches(),
      signal: controller.signal,
      fetchImpl: async () => {
        fetched += 1;
        return new Response('good');
      },
    }),
    (error) => error.code === 'cancelled',
  );

  assert.equal(fetched, 0, 'an aborted job must not spend data');
});

test('downloadModel reports a full device as modelNoSpace', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'good' }));
  const cachesImpl = {
    open: async () => ({
      match: async () => undefined,
      put: async () => {
        const error = new Error('full');
        error.name = 'QuotaExceededError';
        throw error;
      },
      delete: async () => false,
    }),
  };

  await assert.rejects(
    downloadModel({
      manifest,
      root: ROOT,
      cachesImpl,
      fetchImpl: async () => new Response('good'),
    }),
    (error) => error.code === 'modelNoSpace',
  );
});

test('downloadModel needs CacheStorage to keep the model', async () => {
  const manifest = parseManifest(manifestFor({ 'config.json': 'good' }));

  await assert.rejects(
    downloadModel({ manifest, root: ROOT, cachesImpl: null }),
    (error) => error.code === 'modelUnsupported',
  );
});

test('clearModel deletes both caches and reports whether anything went', async () => {
  const cachesImpl = fakeCaches();
  await cachesImpl.open(MODEL_CACHE_NAME);
  await cachesImpl.open(MODEL_RUNTIME_CACHE);

  assert.equal(await clearModel({ cachesImpl }), true);
  assert.deepEqual(cachesImpl.deleted, [MODEL_CACHE_NAME, MODEL_RUNTIME_CACHE]);
  assert.equal(await clearModel({ cachesImpl: null }), false);
});

test('availableBytes and assertSpace keep a margin free', async () => {
  const manager = { estimate: async () => ({ quota: 100, usage: 40 }) };

  assert.equal(await availableBytes(manager), 60);
  await assertSpace(50, { manager, marginBytes: 8 });
  await assert.rejects(
    assertSpace(60, { manager, marginBytes: 8 }),
    (error) => error.code === 'modelNoSpace',
  );

  assert.equal(await availableBytes({ estimate: async () => ({}) }), null);
  assert.equal(
    await availableBytes({
      estimate: async () => {
        throw new Error('denied');
      },
    }),
    null,
  );
  assert.equal(await availableBytes(null), null);
});
