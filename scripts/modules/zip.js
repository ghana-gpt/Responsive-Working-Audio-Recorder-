/**
 * Tiny ZIP writer (STORE method only, no compression).
 *
 * Used by "Download all as ZIP" so users do not have to click a dozen download
 * buttons. Audio payloads are already compressed (Opus/AAC), so storing them is
 * both faster and effectively the same size as deflating.
 *
 * Pure: accepts Uint8Array payloads only, works in Node (tests verify the
 * generated archive with the system `unzip -t`).
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;

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
 * Build a ZIP archive.
 *
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @param {{ date?: Date|number }} [options]
 * @returns {Uint8Array}
 */
export function createZip(entries, { date = new Date() } = {}) {
  const encoder = new TextEncoder();
  const records = (entries ?? []).map((entry) => {
    if (!(entry?.data instanceof Uint8Array)) {
      throw new TypeError('createZip: every entry needs a Uint8Array `data` payload');
    }
    return {
      nameBytes: encoder.encode(String(entry.name || 'file')),
      data: entry.data,
      crc: crc32(entry.data),
      offset: 0,
    };
  });

  const { time, date: dosDate } = dosDateTime(date);
  const localSize = records.reduce(
    (total, record) => total + 30 + record.nameBytes.length + record.data.length,
    0,
  );
  const centralSize = records.reduce((total, record) => total + 46 + record.nameBytes.length, 0);
  const buffer = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  for (const record of records) {
    record.offset = offset;
    view.setUint32(offset, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, UTF8_FLAG, true);
    view.setUint16(offset + 8, METHOD_STORE, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, record.crc, true);
    view.setUint32(offset + 18, record.data.length, true);
    view.setUint32(offset + 22, record.data.length, true);
    view.setUint16(offset + 26, record.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;
    buffer.set(record.nameBytes, offset);
    offset += record.nameBytes.length;
    buffer.set(record.data, offset);
    offset += record.data.length;
  }

  const centralOffset = offset;
  for (const record of records) {
    view.setUint32(offset, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, VERSION, true);
    view.setUint16(offset + 8, UTF8_FLAG, true);
    view.setUint16(offset + 10, METHOD_STORE, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, record.crc, true);
    view.setUint32(offset + 20, record.data.length, true);
    view.setUint32(offset + 24, record.data.length, true);
    view.setUint16(offset + 28, record.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra field length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number start
    view.setUint16(offset + 36, 0, true); // internal attributes
    view.setUint32(offset + 38, 0, true); // external attributes
    view.setUint32(offset + 42, record.offset, true);
    offset += 46;
    buffer.set(record.nameBytes, offset);
    offset += record.nameBytes.length;
  }

  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, records.length, true);
  view.setUint16(offset + 10, records.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);

  return buffer;
}
