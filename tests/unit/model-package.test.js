import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

import { ASR_MODEL_BYTES, ASR_MODEL_LABEL } from '../../scripts/modules/asr.js';
import {
  DEFAULT_MANIFEST,
  ModelPackageError,
  createTar,
  extractTarGz,
  installModel,
  installedBytes,
  listModelFiles,
  packageModel,
  parseTar,
  readManifest,
  sha256Buffer,
  verifyTree,
} from '../../tools/models.mjs';

/** A throwaway directory removed by the caller. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rar-model-'));
}

/** Write `{ path: contents }` into `dir`, creating folders as needed. */
function writeTree(dir, tree) {
  for (const [path, contents] of Object.entries(tree)) {
    const file = join(dir, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
  }
}

/**
 * Build a manifest + archive for a fake model folder, exactly like the release
 * pipeline does, so `installModel` can be exercised without the real 45 MB model.
 */
async function buildPackage({ name = 'whisper-tiny', tree } = {}) {
  const root = tempDir();
  const modelDir = join(root, 'source', name);
  writeTree(modelDir, tree);

  /** @type {Record<string, { bytes: number, sha256: string }>} */
  const files = {};
  let modelBytes = 0;
  for (const path of listModelFiles(modelDir)) {
    const data = readFileSync(join(modelDir, ...path.split('/')));
    files[path] = { bytes: data.length, sha256: sha256Buffer(data) };
    if (path !== 'LICENSE') modelBytes += data.length;
  }

  const manifest = {
    name,
    version: 'v1',
    release: `${name}-test`,
    archive: `${name}-v1.tar.gz`,
    url: 'http://127.0.0.1:1/not-used.tar.gz',
    sha256: '0'.repeat(64),
    bytes: 0,
    modelBytes,
    files,
  };

  const packed = await packageModel({ manifest, modelDir, outDir: join(root, 'dist') });
  manifest.sha256 = packed.sha256;
  manifest.bytes = packed.bytes;

  const manifestPath = join(root, 'model-package.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { root, modelDir, manifest, manifestPath, archive: packed.path };
}

/** Serve exactly one file from a local port; other paths get a 404. */
async function serveFile(file) {
  const data = readFileSync(file);
  const server = createServer((request, response) => {
    if (request.url !== `/${basename(file)}`) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', length: data.length });
    response.end(data);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}/${basename(file)}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('model-package.json describes the published model', () => {
  const manifest = readManifest(DEFAULT_MANIFEST);

  assert.equal(manifest.name, 'whisper-tiny');
  assert.equal(manifest.release, 'models-whisper-tiny-v1');
  assert.match(manifest.url, /\/releases\/download\/models-whisper-tiny-v1\//);
  assert.match(manifest.archive, /\.tar\.gz$/);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.bytes > 0);

  // The recorder advertises this size in Settings, so the packaged files must
  // keep adding up to it (LICENSE excluded: it is attribution, not model data).
  assert.equal(manifest.modelBytes, ASR_MODEL_BYTES, `${ASR_MODEL_LABEL} size drifted`);

  const files = Object.keys(manifest.files);
  assert.ok(files.includes('onnx/encoder_model_quantized.onnx'));
  assert.ok(files.includes('onnx/decoder_model_merged_quantized.onnx'));
  assert.ok(files.includes('tokenizer.json'));
  assert.ok(files.includes('LICENSE'), 'the model licence must ship with the download');

  const total = Object.values(manifest.files).reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(total, manifest.modelBytes + manifest.files.LICENSE.bytes);

  // `models:verify` reports the space the installed tree takes, not the archive.
  assert.equal(installedBytes(manifest), total);
  assert.ok(total > manifest.bytes, 'the archive must be smaller than the installed tree');
});

test('tar round-trips file contents, including 512-byte boundaries', () => {
  const entries = [
    { name: 'whisper-tiny/empty.txt', data: Buffer.alloc(0) },
    { name: 'whisper-tiny/exact.bin', data: Buffer.alloc(512, 7) },
    { name: 'whisper-tiny/onnx/model.onnx', data: Buffer.from('not really a graph') },
  ];
  const parsed = parseTar(createTar(entries));

  assert.deepEqual(
    parsed.map((entry) => entry.name),
    entries.map((entry) => entry.name),
  );
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(parsed[index].data, entry.data);
  }
});

test('a corrupted tar header is rejected instead of being extracted', () => {
  const archive = createTar([{ name: 'whisper-tiny/a.txt', data: Buffer.from('hello') }]);
  archive[0] = 'x'.charCodeAt(0); // break the stored name, and with it the checksum

  assert.throws(
    () => parseTar(archive),
    (error) => {
      assert.ok(error instanceof ModelPackageError);
      assert.equal(error.code, 'tarInvalid');
      assert.match(error.message, /checksum/);
      return true;
    },
  );
});

test('extraction refuses paths outside the target folder', () => {
  const root = tempDir();
  try {
    const escape = gzipSync(createTar([{ name: '../escape.txt', data: Buffer.from('nope') }]));
    const absolute = gzipSync(createTar([{ name: '/tmp/absolute.txt', data: Buffer.from('x') }]));

    assert.throws(() => extractTarGz(escape, root), /unsafe archive path/);
    assert.throws(() => extractTarGz(absolute, root), /unsafe archive path/);
    assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extraction reports a damaged archive instead of a raw zlib error', () => {
  const root = tempDir();
  try {
    assert.throws(
      () => extractTarGz(Buffer.from('this is not gzip'), root),
      (error) => {
        assert.ok(error instanceof ModelPackageError);
        assert.equal(error.code, 'archiveInvalid');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyTree reports missing and modified files', async () => {
  const root = tempDir();
  try {
    const manifest = {
      files: {
        'a.txt': { bytes: 5, sha256: sha256Buffer('hello') },
        'nested/b.bin': { bytes: 3, sha256: sha256Buffer('abc') },
      },
    };
    writeTree(root, { 'a.txt': 'hello', 'nested/b.bin': 'abd' });

    const result = await verifyTree({ manifest, modelDir: root });
    assert.deepEqual(result.ok, ['a.txt']);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(
      result.mismatched.map((entry) => entry.path),
      ['nested/b.bin'],
    );

    rmSync(join(root, 'a.txt'));
    const after = await verifyTree({ manifest, modelDir: root });
    assert.deepEqual(after.missing, ['a.txt']);
    assert.equal(after.ok.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installModel downloads, verifies and installs the archive once', async () => {
  const pkg = await buildPackage({
    tree: {
      LICENSE: 'MIT',
      'config.json': '{"model_type":"whisper"}',
      'onnx/encoder_model_quantized.onnx': Buffer.alloc(700, 3),
      'onnx/decoder_model_merged_quantized.onnx': Buffer.alloc(1200, 9),
    },
  });
  const server = await serveFile(pkg.archive);
  const logs = [];
  const modelDir = join(pkg.root, 'models', pkg.manifest.name);

  try {
    const first = await installModel({
      manifest: pkg.manifest,
      modelDir,
      url: server.url,
      log: (...args) => logs.push(args.join(' ')),
    });
    assert.equal(first.installed, true);
    assert.equal(first.files, 4);
    assert.equal(readFileSync(join(modelDir, 'config.json'), 'utf8'), '{"model_type":"whisper"}');
    assert.equal(readFileSync(join(modelDir, 'onnx', 'encoder_model_quantized.onnx')).length, 700);
    assert.equal(existsSync(join(pkg.root, 'models', '.download')), false, 'temp folder removed');
    assert.ok(logs.some((line) => line.includes('archive checksum matches')));

    const verified = await verifyTree({ manifest: pkg.manifest, modelDir });
    assert.equal(verified.missing.length, 0);
    assert.equal(verified.mismatched.length, 0);

    const second = await installModel({
      manifest: pkg.manifest,
      modelDir,
      url: server.url,
      log: () => {},
    });
    assert.equal(second.installed, false, 'a verified install is not downloaded again');
  } finally {
    await server.close();
    rmSync(pkg.root, { recursive: true, force: true });
  }
});

test('installModel discards a download whose checksum does not match', async () => {
  const pkg = await buildPackage({
    tree: { 'config.json': '{"model_type":"whisper"}', LICENSE: 'MIT' },
  });
  const server = await serveFile(pkg.archive);
  const modelDir = join(pkg.root, 'models', pkg.manifest.name);
  writeTree(modelDir, { 'config.json': 'keep me' });

  try {
    await assert.rejects(
      installModel({
        manifest: { ...pkg.manifest, sha256: 'b'.repeat(64) },
        modelDir,
        url: server.url,
        log: () => {},
        force: true,
      }),
      (error) => {
        assert.ok(error instanceof ModelPackageError);
        assert.equal(error.code, 'checksumMismatch');
        assert.match(error.message, /expected b{64}/);
        return true;
      },
    );

    // The old folder survives untouched and the rejected download is gone.
    assert.equal(readFileSync(join(modelDir, 'config.json'), 'utf8'), 'keep me');
    assert.equal(existsSync(join(pkg.root, 'models', '.download')), false);
  } finally {
    await server.close();
    rmSync(pkg.root, { recursive: true, force: true });
  }
});

test('installModel explains a missing release asset', async () => {
  const pkg = await buildPackage({ tree: { 'config.json': '{}', LICENSE: 'MIT' } });
  const server = await serveFile(pkg.archive);

  try {
    await assert.rejects(
      installModel({
        manifest: { ...pkg.manifest, url: `${server.url}.missing` },
        modelDir: join(pkg.root, 'models', pkg.manifest.name),
        url: `${server.url}.missing`,
        log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof ModelPackageError);
        assert.equal(error.code, 'downloadFailed');
        assert.match(error.message, /HTTP 404/);
        assert.match(error.message, /release asset is missing/);
        return true;
      },
    );
    assert.equal(existsSync(join(pkg.root, 'models', '.download')), false);
  } finally {
    await server.close();
    rmSync(pkg.root, { recursive: true, force: true });
  }
});
