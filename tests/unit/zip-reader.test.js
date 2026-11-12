import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createZipParts, crc32 } from '../../scripts/modules/zip.js';
import {
  MAX_ENTRY_BYTES,
  ZipError,
  extractZipEntry,
  readZipDirectory,
  readZipEntry,
  toBlob,
  verifyZip,
  verifyZipEntry,
} from '../../scripts/modules/zip-reader.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text) => encoder.encode(text);
const text = (data) => decoder.decode(data);

/** Serialise `createZipParts` output into the single Blob a download produces. */
function archive(entries, options) {
  return new Blob(createZipParts(entries, options).parts, { type: 'application/zip' });
}

/** Flip one byte of an entry's payload so its CRC no longer matches. */
async function corruptPayload(blob, name) {
  const { entries } = await readZipDirectory(blob);
  const entry = entries.find((item) => item.name === name);
  const raw = new Uint8Array(await blob.arrayBuffer());
  raw[entry.dataOffset] ^= 0xff;
  return new Blob([raw], { type: 'application/zip' });
}

/** Collect every chunk of a readable stream into one buffer. */
async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * Hand-build an archive whose entries use DEFLATE (method 8), which the writer
 * never produces but other tools do.
 */
async function deflateArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const source = bytes(entry.text);
    const compressed = await drain(
      new Blob([source]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    );
    const nameBytes = bytes(entry.name);
    const crc = crc32(source) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 8, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x21, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, source.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    locals.push(local, compressed);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 8, true);
    centralView.setUint16(12, 0x21, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, source.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBytes = new Uint8Array(centrals.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of centrals) {
    centralBytes.set(part, cursor);
    cursor += part.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, offset, true);

  return new Blob([...locals, centralBytes, end], { type: 'application/zip' });
}

test('toBlob accepts Blobs, Uint8Arrays and ArrayBuffers', () => {
  const source = bytes('audio');
  assert.equal(toBlob(source).size, 5);
  assert.equal(toBlob(source.buffer).size, 5);

  const blob = new Blob(['audio']);
  assert.equal(toBlob(blob), blob);
  assert.throws(() => toBlob('audio'), TypeError);
});

test('readZipDirectory lists every entry in archive order', async () => {
  const blob = archive([
    { name: 'Bulk 01.wav', data: bytes('first') },
    { name: 'Bulk 02.wav', data: bytes('second') },
  ]);

  const { entries, zip64 } = await readZipDirectory(blob);
  assert.equal(zip64, false);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['Bulk 01.wav', 'Bulk 02.wav'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.size),
    [5, 6],
  );
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].crc, crc32(bytes('first')));
});

test('readZipDirectory reads the central directory from a Uint8Array', async () => {
  const blob = archive([{ name: 'one.wav', data: bytes('hello') }]);
  const raw = new Uint8Array(await blob.arrayBuffer());

  const { entries } = await readZipDirectory(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'one.wav');
});

test('readZipDirectory rejects files that are not ZIP archives', async () => {
  await assert.rejects(
    () => readZipDirectory(new Blob([bytes('too small')])),
    (error) => error instanceof ZipError && error.code === 'too-small',
  );
  await assert.rejects(
    () => readZipDirectory(new Blob([bytes('x'.repeat(64))])),
    (error) => error instanceof ZipError && error.code === 'not-a-zip',
  );
});

test('readZipDirectory rejects a truncated central directory', async () => {
  const blob = archive([{ name: 'one.wav', data: bytes('hello') }]);
  const raw = new Uint8Array(await blob.arrayBuffer());
  // Keep the EOCD but drop bytes from the middle of the central directory.
  const crippled = new Blob([raw.subarray(0, raw.length - 60), raw.subarray(raw.length - 22)]);

  await assert.rejects(
    () => readZipDirectory(crippled),
    (error) => error instanceof ZipError && error.code === 'truncated',
  );
});

test('readZipDirectory parses ZIP64 archives', async () => {
  const blob = archive([{ name: 'one.wav', data: bytes('hello') }], { forceZip64: true });

  // Small archives keep a classic EOCD, so only the entries carry 64-bit fields.
  const { entries, zip64 } = await readZipDirectory(blob);
  assert.equal(zip64, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, 5);
  assert.equal(entries[0].compressedSize, 5);
  assert.equal(entries[0].crc, crc32(bytes('hello')));
  assert.equal(text(await readZipEntry(blob, entries[0])), 'hello');
});

test('extractZipEntry slices stored payloads without re-encoding them', async () => {
  const payload = bytes('recording bytes');
  const blob = archive([{ name: 'one.wav', data: payload }]);
  const { entries } = await readZipDirectory(blob);

  const extracted = await extractZipEntry(blob, { ...entries[0], type: 'audio/wav' });
  assert.equal(extracted.type, 'audio/wav');
  assert.equal(extracted.size, payload.length);
  assert.deepEqual(new Uint8Array(await extracted.arrayBuffer()), payload);
});

test('verifyZipEntry accepts intact entries and catches corruption', async () => {
  const blob = archive([
    { name: 'keep.wav', data: bytes('good audio') },
    { name: 'damaged.wav', data: bytes('bad audio') },
  ]);
  const { entries } = await readZipDirectory(blob);

  const good = await verifyZipEntry(blob, entries[0]);
  assert.equal(good.ok, true);
  assert.equal(text(good.bytes), 'good audio');

  const damaged = await corruptPayload(blob, 'damaged.wav');
  const bad = await verifyZipEntry(damaged, entries[1]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /checksum/i);
});

test('verifyZip reports every damaged entry without throwing', async () => {
  const blob = archive([
    { name: 'one.wav', data: bytes('first') },
    { name: 'two.wav', data: bytes('second') },
  ]);
  const damaged = await corruptPayload(blob, 'two.wav');
  const seen = [];

  const { entries, failed } = await verifyZip(damaged, (progress) => seen.push(progress.name));
  assert.equal(entries.length, 2);
  assert.deepEqual(seen, ['one.wav', 'two.wav']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'two.wav');
});

test('readZipDirectory lists entries the importer would ignore', async () => {
  // The writer normalises paths, so "backup/" becomes a plain "backup" entry.
  const blob = archive([
    { name: 'backup/', data: new Uint8Array(0) },
    { name: 'notes.txt', data: bytes('not audio') },
    { name: 'backup/one.wav', data: bytes('hello') },
  ]);

  const { entries } = await readZipDirectory(blob);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['backup', 'notes.txt', 'backup/one.wav'],
  );
});

test(
  'deflated entries are inflated when the platform can decompress',
  { skip: typeof DecompressionStream !== 'function' || typeof CompressionStream !== 'function' },
  async () => {
    const blob = await deflateArchive([{ name: 'one.wav', text: 'compressed audio' }]);
    const { entries } = await readZipDirectory(blob);

    assert.equal(entries[0].method, 8);
    assert.equal(text(await readZipEntry(blob, entries[0])), 'compressed audio');

    const extracted = await extractZipEntry(blob, { ...entries[0], type: 'audio/wav' });
    assert.equal(text(new Uint8Array(await extracted.arrayBuffer())), 'compressed audio');

    const verified = await verifyZipEntry(blob, entries[0]);
    assert.equal(verified.ok, true);
  },
);

test('MAX_ENTRY_BYTES is a sane upper bound', () => {
  assert.equal(MAX_ENTRY_BYTES, 1024 * 1024 * 1024);
});

test('entries above the byte limit are refused before they are read', async () => {
  const blob = archive([{ name: 'one.wav', data: bytes('hello') }]);
  const { entries } = await readZipDirectory(blob);
  const tooLarge = (error) => error instanceof ZipError && error.code === 'entry-too-large';

  await assert.rejects(() => readZipEntry(blob, entries[0], { maxBytes: 2 }), tooLarge);
  await assert.rejects(() => extractZipEntry(blob, entries[0], { maxBytes: 2 }), tooLarge);
});

test('readZipDirectory rejects an entry whose payload is not in the file', async () => {
  const blob = archive([{ name: 'one.wav', data: bytes('hello') }]);
  // Claim a compressed size far beyond the end of the archive.
  const raw = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(raw.buffer);
  for (let index = 0; index + 46 <= raw.length; index += 1) {
    if (view.getUint32(index, true) === 0x02014b50) {
      view.setUint32(index + 20, 999_999, true);
      break;
    }
  }

  await assert.rejects(
    () => readZipDirectory(new Blob([raw])),
    (error) => error instanceof ZipError && error.code === 'truncated',
  );
});

test(
  'a decompression bomb is cut off instead of exhausting memory',
  { skip: typeof DecompressionStream !== 'function' || typeof CompressionStream !== 'function' },
  async () => {
    // 200 KB of repeated text deflates to a few hundred bytes: a classic bomb.
    const blob = await deflateArchive([{ name: 'bomb.wav', text: 'a'.repeat(200_000) }]);
    const raw = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(raw.buffer);
    for (let index = 0; index + 46 <= raw.length; index += 1) {
      if (view.getUint32(index, true) === 0x02014b50) {
        // Lie about the uncompressed size so the pre-flight check passes.
        view.setUint32(index + 24, 64, true);
        break;
      }
    }

    const lying = new Blob([raw]);
    const { entries } = await readZipDirectory(lying);
    assert.equal(entries[0].size, 64, 'the directory understates the real size');

    await assert.rejects(
      () => readZipEntry(lying, entries[0], { maxBytes: 4096 }),
      (error) => error instanceof ZipError && error.code === 'entry-too-large',
    );
  },
);
