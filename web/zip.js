// @ts-check
/**
 * A ZIP writer, so extracting a filesystem is one download instead of forty.
 *
 * Firing a download per file was the previous answer, and it is a bad one:
 * browsers rate-limit bursts, the files land loose in a downloads folder with
 * their directory structure flattened into their names, and nothing tells you
 * whether all of them arrived.
 *
 * The reason it was done that way — "bundling would mean shipping a zip
 * encoder" — turned out not to hold. A ZIP is a handful of little-endian
 * structs, the checksum it needs is the CRC-32 the library already has, and
 * the compression is `CompressionStream`, which is part of the platform. So
 * this costs no dependency, which is the constraint that mattered.
 *
 * Deliberately not general-purpose: no Zip64, no encryption, no streaming. A
 * flash partition is at most 16 MB, so everything fits in memory and in the
 * 32-bit fields, and pretending otherwise would be code with no way to be
 * tested here.
 *
 * @module zip
 */

import { crc32 } from './esp-flashjs.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/** Bit 11: the name is UTF-8 rather than the ancient IBM code page. */
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** The earliest moment a ZIP timestamp can express. */
const DOS_EPOCH_YEAR = 1980;

/**
 * @typedef {object} ZipEntry
 * @property {string} path
 * @property {Uint8Array} [data]      Omitted for a directory.
 * @property {boolean} [directory]
 */

/**
 * Packs entries into a ZIP archive.
 *
 * @param {ZipEntry[]} entries
 * @param {object} [options]
 * @param {Date} [options.date]        Timestamp for every entry.
 * @param {boolean} [options.compress] Off falls back to stored entries.
 * @returns {Promise<Uint8Array>}
 */
export async function zip(entries, { date = new Date(), compress = true } = {}) {
  const encoder = new TextEncoder();
  const { time: dosTime, date: dosDate } = toDosTimestamp(date);
  const useDeflate = compress && canDeflate();

  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {Array<{name: Uint8Array, crc: number, method: number, packed: number, size: number, offset: number, directory: boolean}>} */
  const directory = [];
  let offset = 0;

  for (const entry of entries) {
    // A ZIP path is relative and uses forward slashes; a leading one makes
    // some extractors refuse the archive outright as a path-traversal risk.
    const clean = entry.path.replace(/^\/+/, '');
    const isDirectory = Boolean(entry.directory);
    const name = encoder.encode(isDirectory ? `${clean}/` : clean);
    const data = isDirectory ? new Uint8Array(0) : (entry.data ?? new Uint8Array(0));

    const crc = data.length === 0 ? 0 : crc32(data);
    let payload = data;
    let method = METHOD_STORED;
    if (useDeflate && data.length > 0) {
      const packed = await deflateRaw(data);
      // Compressing a file that is already compressed makes it bigger. Storing
      // it instead is legal, smaller, and faster to unpack.
      if (packed.length < data.length) {
        payload = packed;
        method = METHOD_DEFLATE;
      }
    }

    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, 20, true); // version needed to extract
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, method, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // no extra field
    header.set(name, 30);

    directory.push({
      name,
      crc,
      method,
      packed: payload.length,
      size: data.length,
      offset,
      directory: isDirectory,
    });
    parts.push(header, payload);
    offset += header.length + payload.length;
  }

  const centralStart = offset;
  for (const entry of directory) {
    const record = new Uint8Array(46 + entry.name.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, CENTRAL_HEADER, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, dosTime, true);
    view.setUint16(14, dosDate, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.packed, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true); // extra
    view.setUint16(32, 0, true); // comment
    view.setUint16(34, 0, true); // disk number
    view.setUint16(36, 0, true); // internal attributes
    // The directory bit, so an extractor recreates empty directories rather
    // than dropping them — which for SPIFFS versus LittleFS is a real
    // difference someone might be looking for.
    view.setUint32(38, entry.directory ? 0x10 : 0, true);
    view.setUint32(42, entry.offset, true);
    record.set(entry.name, 46);
    parts.push(record);
    offset += record.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true); // this disk
  endView.setUint16(6, 0, true); // disk with the central directory
  endView.setUint16(8, directory.length, true);
  endView.setUint16(10, directory.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true); // no comment
  parts.push(end);

  return concat(parts);
}

/**
 * Whether the platform can deflate.
 *
 * ZIP wants raw deflate, not the zlib wrapper `CompressionStream('deflate')`
 * produces, so the check is for that specific format rather than for the class.
 *
 * @returns {boolean}
 */
export function canDeflate() {
  if (typeof globalThis.CompressionStream !== 'function') return false;
  try {
    // Constructing it is the only way to find out: an unsupported format
    // throws, and there is no capability list to consult.
    new CompressionStream(/** @type {any} */ ('deflate-raw'));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(data) {
  const stream = new CompressionStream(/** @type {any} */ ('deflate-raw'));
  const writer = stream.writable.getWriter();
  // Copy into a buffer this function owns: `data` is usually a view into a
  // larger image, and the stream reads it asynchronously.
  void writer.write(/** @type {BufferSource} */ (/** @type {unknown} */ (data.slice())));
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Converts a date to the two 16-bit fields ZIP has been using since 1980.
 *
 * Seconds have one bit less than they need, so odd seconds do not survive.
 * That is the format, not a shortcut.
 *
 * @param {Date} date
 * @returns {{time: number, date: number}}
 */
export function toDosTimestamp(date) {
  const year = Math.max(DOS_EPOCH_YEAR, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
