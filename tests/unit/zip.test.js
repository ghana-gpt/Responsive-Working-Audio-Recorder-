import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, crc32, dedupeNames, dosDateTime } from '../../scripts/modules/zip.js';

const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text);

test('crc32 matches known reference values', () => {
  assert.equal(crc32(bytes('')), 0);
  assert.equal(crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
});

test('dosDateTime packs fields per the ZIP spec', () => {
  const { time, date } = dosDateTime(new Date(2026, 10, 9, 13, 45, 2));
  assert.equal(time, (13 << 11) | (45 << 5) | 1);
  assert.equal(date, ((2026 - 1980) << 9) | (11 << 5) | 9);
  // years before the DOS epoch are clamped to 1980
  assert.equal(dosDateTime(new Date(1970, 0, 1)).date >> 9, 0);
});

test('dedupeNames keeps archive entry names unique', () => {
  assert.deepEqual(dedupeNames(['a.webm', 'a.webm', 'a.webm']), [
    'a.webm',
    'a (2).webm',
    'a (3).webm',
  ]);
  assert.deepEqual(dedupeNames(['noext', 'noext']), ['noext', 'noext (2)']);
});

test('createZip writes local headers, central directory and EOCD', () => {
  const archive = createZip(
    [
      { name: 'one.txt', data: bytes('hello') },
      { name: 'two.txt', data: bytes('world!') },
    ],
    { date: new Date(2026, 10, 9, 13, 45, 2) },
  );
  const view = new DataView(archive.buffer);

  assert.equal(view.getUint32(0, true), 0x04034b50, 'local header signature');
  assert.equal(view.getUint16(6, true), 0x0800, 'utf-8 flag');
  assert.equal(view.getUint16(8, true), 0, 'store method');
  assert.equal(view.getUint32(14, true), crc32(bytes('hello')));

  const eocdOffset = archive.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2, 'total entries');
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);

  // payloads are stored verbatim
  assert.equal(Buffer.from(archive).includes('hello'), true);
  assert.equal(Buffer.from(archive).includes('world!'), true);
});

test('createZip accepts an empty list and rejects bad payloads', () => {
  const empty = createZip([]);
  assert.equal(empty.length, 22);
  const emptyView = new DataView(empty.buffer);
  assert.equal(emptyView.getUint32(0, true), 0x06054b50);
  assert.equal(emptyView.getUint16(8, true), 0);
  assert.equal(emptyView.getUint16(10, true), 0);
  assert.throws(() => createZip([{ name: 'x', data: 'not-bytes' }]), TypeError);
});

test('generated archive passes `unzip -t` and extracts identical files', () => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    console.warn('unzip not available — skipping archive integrity check');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    const payloads = [
      { name: 'note-one.webm', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'note-two.wav', data: bytes('second payload') },
      { name: 'dossier/note-three.txt', data: bytes('nested entry') },
      { name: 'résumé.txt', data: bytes('unicode name') },
    ];
    const archive = createZip(payloads, { date: new Date(2026, 10, 9, 9, 0, 0) });
    const zipPath = join(directory, 'bundle.zip');
    writeFileSync(zipPath, archive);

    const testOutput = execFileSync('unzip', ['-t', zipPath]).toString();
    assert.match(testOutput, /No errors detected/);

    const outDir = join(directory, 'out');
    execFileSync('unzip', ['-q', zipPath, '-d', outDir]);
    const extracted = readdirSync(outDir).sort();
    assert.ok(extracted.includes('note-one.webm'));
    assert.ok(extracted.includes('note-two.wav'));
    assert.ok(extracted.includes('dossier'));
    assert.deepEqual([...readFileSync(join(outDir, 'note-one.webm'))], [1, 2, 3, 4, 5]);
    assert.equal(readFileSync(join(outDir, 'note-two.wav'), 'utf8'), 'second payload');
    assert.equal(readFileSync(join(outDir, 'dossier', 'note-three.txt'), 'utf8'), 'nested entry');

    // Unicode entry names are stored verbatim as UTF-8 with the language flag set.
    const storedNames = Buffer.from(archive).toString('utf8');
    assert.ok(storedNames.includes('résumé.txt'), 'utf-8 file name stored verbatim');
    const firstLocalFlags = new DataView(archive.buffer).getUint16(6, true);
    assert.equal(firstLocalFlags & 0x0800, 0x0800, 'language encoding flag set');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('forced ZIP64 archives pass `unzip -t`', () => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    console.warn('unzip not available — skipping ZIP64 integrity check');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'zip64-test-'));
  try {
    const archive = createZip(
      [
        { name: 'note-one.webm', data: new Uint8Array([1, 2, 3, 4, 5]) },
        { name: 'note-two.wav', data: bytes('second payload') },
      ],
      { date: new Date(2026, 10, 9, 9, 0, 0), forceZip64: true },
    );
    const zipPath = join(directory, 'zip64.zip');
    writeFileSync(zipPath, archive);

    const testOutput = execFileSync('unzip', ['-t', zipPath]).toString();
    assert.match(testOutput, /No errors detected/);

    const outDir = join(directory, 'out');
    execFileSync('unzip', ['-q', zipPath, '-d', outDir]);
    assert.equal(readFileSync(join(outDir, 'note-two.wav'), 'utf8'), 'second payload');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
