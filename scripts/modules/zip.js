/**
 * Tiny ZIP writer (STORE method only, no compression) with ZIP64 support.
 *
 * Used by "Download all as ZIP" and by the backup feature. Audio payloads are
 * already compressed (Opus/AAC), so storing them is both faster and effectively
 * the same size as deflating.
 *
 * Two materialisations are offered:
 *
 *   createZip(entries)       → Uint8Array (small, synchronous, used by tests)
 *   createZipParts(entries)  → { parts, size } where payloads may be Blobs, so a
 *                              multi-gigabyte archive never has to live in
 *                              memory as one contiguous buffer.
 *
 * Archives that need it (64k+ entries, 4 GiB+ payloads, `forceZip64`) are
 * written in ZIP64 form. Pure typed-array code, works in Node for tests.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const VERSION = 20;
const VERSION_ZIP64 = 45;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UINT32_RANGE = 0x100000000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * Standard CRC-32 (IEEE 802.3) over a byte array.
 * @param {Uint8Array} bytes
 * @param {number} [seed]
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * CRC-32 of an entire Blob, read in chunks so memory stays bounded.
 *
 * @param {Blob} blob
 * @param {(ratio: number) => void} [onProgress] 0..1
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
export async function crc32Blob(blob, onProgress, signal) {
  if (!(blob instanceof Blob)) throw new TypeError('crc32Blob expects a Blob');
  const chunkSize = 1024 * 1024;
  let crc = 0;
  let processed = 0;
  while (processed < blob.size) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(blob.size, processed + chunkSize);
    const chunk = new Uint8Array(await blob.slice(processed, end).arrayBuffer());
    crc = crc32(chunk, crc);
    processed = end;
    onProgress?.(blob.size === 0 ? 1 : processed / blob.size);
  }
  return crc;
}

/**
 * Convert a JS date into the two 16-bit fields the ZIP format expects.
 * Years before 1980 are clamped (the DOS epoch starts there).
 *
 * @param {Date|number} [date]
 * @returns {{ time: number, date: number }}
 */
export function dosDateTime(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const safe = Number.isNaN(value.getTime()) ? new Date() : value;
  const year = Math.max(1980, safe.getFullYear());
  return {
    time: (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
  };
}

/**
 * Make entry names unique inside an archive, e.g. "note.webm" -> "note (2).webm".
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function dedupeNames(names) {
  const used = new Map();
  return names.map((rawName) => {
    const name = String(rawName || 'file');
    const count = used.get(name.toLowerCase()) ?? 0;
    used.set(name.toLowerCase(), count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`
      : `${name} (${count + 1})`;
  });
}

/**
 * Turn arbitrary user text into a safe archive path: forward slashes only, no
 * leading slash and no `..` segments.
 *
 * @param {string} name
 * @returns {string}
 */
export function zipEntryName(name) {
  const segments = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.join('/') || 'file';
}

/** Write an unsigned 64-bit little-endian value (JS numbers are exact to 2^53). */
function writeUint64(view, offset, value) {
  const number = Math.max(0, Number(value) || 0);
  view.setUint32(offset, number % UINT32_RANGE, true);
  view.setUint32(offset + 4, Math.floor(number / UINT32_RANGE), true);
}

/**
 * Normalise the accepted entry shapes into one internal record.
 *
 * @param {Array<{ name: string, data?: Uint8Array, source?: Blob, crc?: number, size?: number }>} entries
 */
function normalizeEntries(entries) {
  const encoder = new TextEncoder();
  return (entries ?? []).map((entry) => {
    const name = zipEntryName(entry?.name);
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > MAX_UINT16) {
      throw new TypeError('createZip: entry names must be shorter than 65535 bytes');
    }
    const source = entry?.data ?? entry?.source;
    if (source instanceof Uint8Array) {
      const crc = Number.isFinite(Number(entry?.crc)) ? Number(entry.crc) >>> 0 : crc32(source);
      return { name, nameBytes, source, size: source.length, crc, offset: 0 };
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      const size = Number(entry?.size ?? source.size);
      const crc = Number(entry?.crc);
      if (!Number.isFinite(size) || size < 0) {
        throw new TypeError('createZip: Blob entries need a numeric `size`');
      }
      if (!Number.isFinite(crc)) {
        throw new TypeError('createZip: Blob entries need a precomputed `crc` (see crc32Blob)');
      }
      return { name, nameBytes, source, size, crc: crc >>> 0, offset: 0 };
    }
    throw new TypeError(
      'createZip: every entry needs a Uint8Array `data` or a Blob `source` payload',
    );
  });
}

/** Decide ZIP64 usage and compute every offset up front. */
function computeLayout(records, forceZip64) {
  let offset = 0;
  for (const record of records) {
    record.sizeZip64 = forceZip64 || record.size >= MAX_UINT32;
    record.localExtra = record.sizeZip64 ? 20 : 0;
    record.offset = offset;
    offset += 30 + record.nameBytes.length + record.localExtra + record.size;
  }

  const centralOffset = offset;
  for (const record of records) {
    record.offsetZip64 = forceZip64 || record.offset >= MAX_UINT32;
    // 4-byte extra header, then the 64-bit sizes (8 + 8) and/or offset (8).
    const needsExtra = record.sizeZip64 || record.offsetZip64;
    record.centralExtra =
      (needsExtra ? 4 : 0) + (record.sizeZip64 ? 16 : 0) + (record.offsetZip64 ? 8 : 0);
    offset += 46 + record.nameBytes.length + record.centralExtra;
  }

  const centralSize = offset - centralOffset;
  const zip64 =
    forceZip64 ||
    records.length > MAX_UINT16 ||
    centralOffset >= MAX_UINT32 ||
    centralSize >= MAX_UINT32 ||
    records.some((record) => record.sizeZip64 || record.offsetZip64);

  return { centralOffset, centralSize, zip64, total: offset + (zip64 ? 76 : 0) + 22 };
}

/** Local file header followed by the entry name and its ZIP64 extra field. */
function writeLocalHeader(record, time, dosDate) {
  const bytes = new Uint8Array(30 + record.nameBytes.length + record.localExtra);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, record.sizeZip64 ? VERSION_ZIP64 : VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, METHOD_STORE, true);
  view.setUint16(10, time, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, record.crc, true);
  view.setUint32(18, record.sizeZip64 ? MAX_UINT32 : record.size, true);
  view.setUint32(22, record.sizeZip64 ? MAX_UINT32 : record.size, true);
  view.setUint16(26, record.nameBytes.length, true);
  view.setUint16(28, record.localExtra, true);
  bytes.set(record.nameBytes, 30);

  if (record.sizeZip64) {
    const extra = 30 + record.nameBytes.length;
    view.setUint16(extra, ZIP64_EXTRA_ID, true);
    view.setUint16(extra + 2, 16, true);
    writeUint64(view, extra + 4, record.size);
    writeUint64(view, extra + 12, record.size);
  }
  return bytes;
}

/** Central directory record; ZIP64 sizes/offset go into one extra field. */
function writeCentralHeader(record, time, dosDate) {
  const bytes = new Uint8Array(46 + record.nameBytes.length + record.centralExtra);
  const view = new DataView(bytes.buffer);
  const version = record.sizeZip64 || record.offsetZip64 ? VERSION_ZIP64 : VERSION;

  view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
  view.setUint16(4, version, true); // version made by
  view.setUint16(6, version, true); // version needed to extract
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, METHOD_STORE, true);
  view.setUint16(12, time, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.sizeZip64 ? MAX_UINT32 : record.size, true);
  view.setUint32(24, record.sizeZip64 ? MAX_UINT32 : record.size, true);
  view.setUint16(28, record.nameBytes.length, true);
  view.setUint16(30, record.centralExtra, true);
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number start
  view.setUint16(36, 0, true); // internal attributes
  view.setUint32(38, 0, true); // external attributes
  view.setUint32(42, record.offsetZip64 ? MAX_UINT32 : record.offset, true);
  bytes.set(record.nameBytes, 46);

  if (record.centralExtra > 0) {
    let extra = 46 + record.nameBytes.length;
    view.setUint16(extra, ZIP64_EXTRA_ID, true);
    view.setUint16(extra + 2, record.centralExtra - 4, true);
    extra += 4;
    if (record.sizeZip64) {
      writeUint64(view, extra, record.size);
      writeUint64(view, extra + 8, record.size);
      extra += 16;
    }
    if (record.offsetZip64) writeUint64(view, extra, record.offset);
  }
  return bytes;
}

/** ZIP64 end-of-central-directory record plus its locator. */
function writeZip64End(count, layout) {
  const recordStart = layout.centralOffset + layout.centralSize;
  const end = new Uint8Array(56);
  const view = new DataView(end.buffer);
  view.setUint32(0, ZIP64_END_SIGNATURE, true);
  writeUint64(view, 4, 44); // size of the remaining record
  view.setUint16(12, VERSION_ZIP64, true);
  view.setUint16(14, VERSION_ZIP64, true);
  view.setUint32(16, 0, true); // this disk
  view.setUint32(20, 0, true); // disk with the central directory
  writeUint64(view, 24, count);
  writeUint64(view, 32, count);
  writeUint64(view, 40, layout.centralSize);
  writeUint64(view, 48, layout.centralOffset);

  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, ZIP64_LOCATOR_SIGNATURE, true);
  locatorView.setUint32(4, 0, true);
  writeUint64(locatorView, 8, recordStart);
  locatorView.setUint32(16, 1, true);
  return [end, locator];
}

/** Classic end-of-central-directory record (written for both formats). */
function writeEndOfCentralDirectory(count, layout) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  const count16 = count > MAX_UINT16 ? MAX_UINT16 : count;
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count16, true);
  view.setUint16(10, count16, true);
  view.setUint32(12, layout.centralSize >= MAX_UINT32 ? MAX_UINT32 : layout.centralSize, true);
  view.setUint32(16, layout.centralOffset >= MAX_UINT32 ? MAX_UINT32 : layout.centralOffset, true);
  view.setUint16(20, 0, true);
  return bytes;
}

/**
 * Build the archive as an ordered list of parts.
 *
 * Payloads that are Blobs stay Blobs, so the browser can stream a huge archive
 * to disk without ever allocating the full size in memory.
 *
 * @param {Array<{ name: string, data?: Uint8Array, source?: Blob, crc?: number, size?: number }>} entries
 * @param {{ date?: Date|number, forceZip64?: boolean }} [options]
 * @returns {{ parts: Array<Uint8Array|Blob>, size: number }}
 */
export function createZipParts(entries, { date = new Date(), forceZip64 = false } = {}) {
  const records = normalizeEntries(entries);
  const { time, date: dosDate } = dosDateTime(date);
  const layout = computeLayout(records, forceZip64);
  /** @type {Array<Uint8Array|Blob>} */
  const parts = [];

  for (const record of records) {
    parts.push(writeLocalHeader(record, time, dosDate));
    if (record.size > 0) parts.push(record.source);
  }

  const central = new Uint8Array(layout.centralSize);
  let cursor = 0;
  for (const record of records) {
    const header = writeCentralHeader(record, time, dosDate);
    central.set(header, cursor);
    cursor += header.length;
  }
  parts.push(central);

  if (layout.zip64) parts.push(...writeZip64End(records.length, layout));
  parts.push(writeEndOfCentralDirectory(records.length, layout));

  return { parts, size: layout.total };
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @param {{ date?: Date|number, forceZip64?: boolean }} [options]
 * @returns {Uint8Array}
 */
export function createZip(entries, { date = new Date(), forceZip64 = false } = {}) {
  const records = normalizeEntries(entries);
  if (records.some((record) => record.source instanceof Blob)) {
    throw new TypeError('createZip: Blob payloads need createZipParts()');
  }
  const { time, date: dosDate } = dosDateTime(date);
  const layout = computeLayout(records, forceZip64);
  const buffer = new Uint8Array(layout.total);
  let offset = 0;

  for (const record of records) {
    const header = writeLocalHeader(record, time, dosDate);
    buffer.set(header, offset);
    offset += header.length;
    buffer.set(record.source, offset);
    offset += record.size;
  }

  const centralOffset = offset;
  for (const record of records) {
    const header = writeCentralHeader(record, time, dosDate);
    buffer.set(header, offset);
    offset += header.length;
  }
  if (offset - centralOffset !== layout.centralSize) {
    throw new Error('createZip: central directory size mismatch');
  }

  if (layout.zip64) {
    for (const part of writeZip64End(records.length, layout)) {
      buffer.set(part, offset);
      offset += part.length;
    }
  }
  buffer.set(writeEndOfCentralDirectory(records.length, layout), offset);
  offset += 22;

  if (offset !== layout.total) throw new Error('createZip: archive size mismatch');
  return buffer;
}

/**
 * Predict the archive size from names and payload sizes only (no CRC work), for
 * the pre-flight "this download is large" warning.
 *
 * @param {Array<{ name?: string, size?: number }>} entries
 * @returns {number}
 */
export function estimateZipSize(entries) {
  const encoder = new TextEncoder();
  const total = (entries ?? []).reduce(
    (sum, entry) =>
      sum +
      76 +
      encoder.encode(zipEntryName(entry?.name)).length +
      Math.max(0, Number(entry?.size) || 0),
    0,
  );
  return total + 22;
}
