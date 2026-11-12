/**
 * Minimal ZIP reader used by the restore flow.
 *
 * Parses the central directory from a Blob without loading the archive into
 * memory, honours ZIP64 records, and can verify/extract individual entries.
 * STORE entries are sliced straight out of the Blob; DEFLATE entries are
 * inflated with `DecompressionStream` when the browser provides it.
 */

import { crc32 } from './zip.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/**
 * Upper bound for a single entry, in bytes (1 GiB — more than 3 hours of 16-bit
 * mono WAV). It stops a crafted "zip bomb" whose 10 KB of DEFLATE data would
 * otherwise inflate until the tab runs out of memory.
 */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

/** @param {string} code @param {string} message */
export class ZipError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ZipError';
    this.code = code;
  }
}

/** @param {Blob|ArrayBuffer|Uint8Array} source */
export function toBlob(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
  if (source instanceof Uint8Array) return new Blob([source]);
  if (source instanceof ArrayBuffer) return new Blob([new Uint8Array(source)]);
  throw new TypeError('A Blob, ArrayBuffer or Uint8Array is required');
}

/** @returns {Promise<Uint8Array>} */
async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function readUint64(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

/**
 * Parse the ZIP64 extra field, returning the values it overrides.
 *
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function parseZip64Extra(bytes, start, end) {
  let cursor = start;
  const result = {};
  while (cursor + 4 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4);
    const id = view.getUint16(0, true);
    const length = view.getUint16(2, true);
    const dataStart = cursor + 4;
    if (dataStart + length > end) break;
    if (id === ZIP64_EXTRA_ID) {
      const field = new DataView(bytes.buffer, bytes.byteOffset + dataStart, length);
      let offset = 0;
      if (offset + 8 <= length) {
        result.size = readUint64(field, offset);
        offset += 8;
      }
      if (offset + 8 <= length) {
        result.compressedSize = readUint64(field, offset);
        offset += 8;
      }
      if (offset + 8 <= length) {
        result.localOffset = readUint64(field, offset);
      }
    }
    cursor = dataStart + length;
  }
  return result;
}

/**
 * Read the central directory.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @returns {Promise<{ entries: Array<object>, zip64: boolean }>}
 */
export async function readZipDirectory(source) {
  const blob = toBlob(source);
  if (blob.size < 22) throw new ZipError('too-small', 'File is too small to be a ZIP archive');

  const tailLength = Math.min(blob.size, 22 + MAX_UINT16);
  const tailStart = blob.size - tailLength;
  const tail = await readRange(blob, tailStart, blob.size);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (
      tail[index] === 0x50 &&
      tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 &&
      tail[index + 3] === 0x06
    ) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not-a-zip', 'No end-of-central-directory record found');

  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let entryCount = tailView.getUint16(eocd + 10, true);
  let centralSize = tailView.getUint32(eocd + 12, true);
  let centralOffset = tailView.getUint32(eocd + 16, true);
  let zip64 = false;

  if (entryCount === MAX_UINT16 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0) throw new ZipError('zip64-locator-missing', 'ZIP64 locator is missing');
    const locator = new DataView(tail.buffer, tail.byteOffset + locatorAt, 20);
    if (locator.getUint32(0, true) !== SIG_ZIP64_LOCATOR) {
      throw new ZipError('zip64-locator-missing', 'ZIP64 locator is missing');
    }
    const endOffset = readUint64(locator, 8);
    const end = await readRange(blob, endOffset, endOffset + 56);
    const endView = new DataView(end.buffer, end.byteOffset, end.byteLength);
    if (endView.getUint32(0, true) !== SIG_ZIP64_END) {
      throw new ZipError('zip64-end-missing', 'ZIP64 end record is missing');
    }
    entryCount = readUint64(endView, 32);
    centralSize = readUint64(endView, 40);
    centralOffset = readUint64(endView, 48);
    zip64 = true;
  }

  if (centralOffset + centralSize > blob.size) {
    throw new ZipError('truncated', 'The central directory extends past the end of the file');
  }

  const central = await readRange(blob, centralOffset, centralOffset + centralSize);
  const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  let cursor = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length)
      throw new ZipError('truncated', 'Central directory is truncated');
    if (centralView.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw new ZipError('bad-central-header', 'Unexpected central directory signature');
    }
    const flags = centralView.getUint16(cursor + 8, true);
    const method = centralView.getUint16(cursor + 10, true);
    const crc = centralView.getUint32(cursor + 16, true);
    let compressedSize = centralView.getUint32(cursor + 20, true);
    let size = centralView.getUint32(cursor + 24, true);
    const nameLength = centralView.getUint16(cursor + 28, true);
    const extraLength = centralView.getUint16(cursor + 30, true);
    const commentLength = centralView.getUint16(cursor + 32, true);
    let localOffset = centralView.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const entryEnd = extraStart + extraLength + commentLength;
    if (entryEnd > central.length)
      throw new ZipError('truncated', 'Central directory is truncated');

    if (size === MAX_UINT32 || compressedSize === MAX_UINT32 || localOffset === MAX_UINT32) {
      const extra = parseZip64Extra(central, extraStart, extraStart + extraLength);
      size = extra.size ?? size;
      compressedSize = extra.compressedSize ?? compressedSize;
      localOffset = extra.localOffset ?? localOffset;
    }

    entries.push({
      name: decoder.decode(central.subarray(nameStart, extraStart)),
      flags,
      method,
      crc,
      size,
      compressedSize,
      localOffset,
      dataOffset: -1,
    });
    cursor = entryEnd;
  }

  for (const entry of entries) {
    if (entry.localOffset < 0 || entry.localOffset + 30 > blob.size) {
      throw new ZipError('truncated', `Missing local header for ${entry.name}`);
    }
    const header = await readRange(blob, entry.localOffset, entry.localOffset + 30);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (headerView.getUint32(0, true) !== SIG_LOCAL) {
      throw new ZipError('bad-local-header', `Missing local header for ${entry.name}`);
    }
    entry.dataOffset =
      entry.localOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
    if (entry.dataOffset + entry.compressedSize > blob.size) {
      throw new ZipError('truncated', `Entry ${entry.name} extends past the end of the archive`);
    }
  }

  return { entries, zip64 };
}

/**
 * Inflate a raw-deflate payload (method 8).
 *
 * The output is accumulated in bounded chunks and aborted as soon as it exceeds
 * `maxBytes`, so a decompression bomb fails instead of exhausting memory.
 *
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes]
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes, maxBytes = MAX_ENTRY_BYTES) {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('unsupported-compression', 'This browser cannot inflate DEFLATE entries');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ZipError('entry-too-large', 'Entry is larger than the allowed maximum');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * Read one entry's bytes, decompressing when needed.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @param {{ method: number, dataOffset: number, compressedSize: number, size?: number }} entry
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(source, entry, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  if (Number(entry.size) > maxBytes) {
    throw new ZipError('entry-too-large', 'Entry is larger than the allowed maximum');
  }
  const blob = toBlob(source);
  const raw = await readRange(blob, entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw, maxBytes);
  throw new ZipError(
    'unsupported-compression',
    `Unsupported ZIP compression method ${entry.method}`,
  );
}

/**
 * Return an entry as a Blob, avoiding a copy for STORE entries.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @param {{ method: number, dataOffset: number, compressedSize: number, size?: number, type?: string }} entry
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Blob>}
 */
export async function extractZipEntry(source, entry, options = {}) {
  const blob = toBlob(source);
  const type = entry.type || 'application/octet-stream';
  if (Number(entry.size) > (options.maxBytes ?? MAX_ENTRY_BYTES)) {
    throw new ZipError('entry-too-large', 'Entry is larger than the allowed maximum');
  }
  if (entry.method === 0) {
    return new Blob([blob.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize)], {
      type,
    });
  }
  return new Blob([await readZipEntry(blob, entry, options)], { type });
}

/**
 * Verify an entry against the size and CRC-32 recorded in the central directory.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @param {{ name: string, method: number, dataOffset: number, compressedSize: number, size: number, crc: number }} entry
 * @returns {Promise<{ ok: boolean, reason?: string, bytes?: Uint8Array }>}
 */
export async function verifyZipEntry(source, entry) {
  let bytes;
  try {
    bytes = await readZipEntry(source, entry);
  } catch (error) {
    return { ok: false, reason: error?.message ?? 'Could not read entry' };
  }
  if (bytes.length !== entry.size) {
    return { ok: false, reason: `Size mismatch (expected ${entry.size}, got ${bytes.length})` };
  }
  const actual = crc32(bytes);
  if (actual !== entry.crc >>> 0) {
    return { ok: false, reason: 'Checksum mismatch (file is corrupted)' };
  }
  return { ok: true, bytes };
}

/**
 * Convenience wrapper: parse an archive and verify every entry.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @param {(progress: {index: number, total: number, name: string}) => void} [onProgress]
 * @returns {Promise<{ entries: Array<object>, failed: Array<{ name: string, reason: string }> }>}
 */
export async function verifyZip(source, onProgress) {
  const { entries } = await readZipDirectory(source);
  const failed = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    onProgress?.({ index, total: entries.length, name: entry.name });
    const result = await verifyZipEntry(source, entry);
    if (!result.ok) failed.push({ name: entry.name, reason: result.reason });
  }
  return { entries, failed };
}
