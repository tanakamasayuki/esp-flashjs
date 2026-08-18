// @ts-check
/**
 * NVS building — turning a store back into a partition image.
 *
 * The layout written here was derived from real hardware rather than from the
 * spec alone: a device was provisioned with every type, an overwrite, a delete
 * and a blob large enough to be split, and the resulting image was read back
 * and inspected byte by byte. Three conventions came out of that and are easy
 * to get wrong from the documentation:
 *
 *   - Keys are NUL-terminated and **zero**-padded, while the 8-byte data field
 *     is padded with **0xFF**. The entry CRC covers both, so a mismatch here
 *     produces an image IDF rejects.
 *   - Every slot a multi-entry record occupies is marked WRITTEN in the page
 *     bitmap, not just the header slot.
 *   - A blob chunk is sized to the space left in the current page, not to some
 *     fixed maximum. On the reference device a 5000-byte blob became a
 *     3424-byte chunk (the 108 entries left on that page) followed by a
 *     1576-byte one, rather than 4000 + 1000.
 *
 * @module format/nvs/build
 */

import { espCrc32Le } from '../../binary/hash.js';
import { encodeCString } from '../../util/hex.js';
import { NvsCapacityError } from '../../util/errors.js';
import {
  ENTRY_STATE,
  NVS_ENTRY_COUNT,
  NVS_ENTRY_DATA_OFFSET,
  NVS_ENTRY_SIZE,
  NVS_HEADER_SIZE,
  NVS_KEY_SIZE,
  NVS_PAGE_SIZE,
  NVS_TYPE,
  NVS_VERSION_V2,
  PAGE_STATE,
  entryCrc32,
  pageHeaderCrc32,
  parseNvs,
} from './parse.js';
import { sameValue } from './store.js';

/**
 * @typedef {import('./parse.js').NvsEntry} NvsEntry
 * @typedef {import('./store.js').NvsStore} NvsStore
 */

/** Smallest partition NVS will work in: one page to write, one to fill, one for GC. */
export const NVS_MIN_PAGES = 3;

/** Most data one variable-length record can hold: a whole page bar its header entry. */
export const NVS_MAX_CHUNK_SIZE = (NVS_ENTRY_COUNT - 1) * NVS_ENTRY_SIZE;

/** Namespace indices start at 1; 0 marks a namespace definition and 0xFF is erased flash. */
const MAX_NAMESPACES = 254;

/** Entries with no chunk of their own carry 0xFF here. */
const NO_CHUNK = 0xff;

const TYPE_BY_NAME = /** @type {Record<string, number>} */ ({
  U8: NVS_TYPE.U8,
  I8: NVS_TYPE.I8,
  U16: NVS_TYPE.U16,
  I16: NVS_TYPE.I16,
  U32: NVS_TYPE.U32,
  I32: NVS_TYPE.I32,
  U64: NVS_TYPE.U64,
  I64: NVS_TYPE.I64,
  STR: NVS_TYPE.STR,
  BLOB: NVS_TYPE.BLOB,
});

/**
 * Writes entries into a fixed run of pages, moving on when one fills up.
 *
 * NVS never rewrites a slot, so this only ever appends. Page state, sequence
 * numbers and CRCs are settled at the end, once it is known which page was the
 * last one used.
 */
class ImageWriter {
  /**
   * @param {number} size Partition size in bytes.
   * @param {number} version
   */
  constructor(size, version) {
    /** Erased flash, which is what an untouched page must look like. */
    this.data = new Uint8Array(size).fill(0xff);
    this.pageCount = size / NVS_PAGE_SIZE;
    /**
     * One page is held back. NVS needs somewhere to compact into, and an image
     * with every page full leaves a device unable to write at all — which is
     * exactly how the reference fixture lost its erased entries.
     */
    this.usablePages = this.pageCount - 1;
    this.version = version;
    this.page = 0;
    this.slot = 0;
    /** Highest page index actually written to. */
    this.lastPage = 0;
  }

  /** @returns {number} Entries left on the current page. */
  get remaining() {
    return NVS_ENTRY_COUNT - this.slot;
  }

  /** Abandons whatever is left of the current page and opens the next. */
  nextPage() {
    this.page += 1;
    this.slot = 0;
    if (this.page >= this.usablePages) {
      // Report what a working image would have needed, including the page kept
      // free, so the number is directly usable as a partition size.
      throw new NvsCapacityError((this.page + 2) * NVS_PAGE_SIZE, this.data.length);
    }
  }

  /**
   * Makes sure `span` consecutive entries are available, moving to the next
   * page if they are not. A record never straddles a page boundary.
   *
   * @param {number} span
   */
  reserve(span) {
    if (span > NVS_ENTRY_COUNT) {
      throw new NvsCapacityError(span * NVS_ENTRY_SIZE, NVS_PAGE_SIZE - NVS_ENTRY_DATA_OFFSET);
    }
    if (span <= this.remaining) return;
    this.nextPage();
  }

  /**
   * Appends one record: a 32-byte header plus its payload entries.
   *
   * @param {object} record
   * @param {number} record.namespaceIndex
   * @param {number} record.type
   * @param {string} record.key
   * @param {number} [record.chunkIndex]
   * @param {Uint8Array} [record.inline]  Up to 8 bytes placed in the header.
   * @param {Uint8Array} [record.payload] Data spilling into following entries.
   */
  write({ namespaceIndex, type, key, chunkIndex = NO_CHUNK, inline, payload }) {
    const payloadEntries = payload ? Math.ceil(payload.length / NVS_ENTRY_SIZE) : 0;
    const span = 1 + payloadEntries;
    this.reserve(span);

    const base = this.page * NVS_PAGE_SIZE + NVS_ENTRY_DATA_OFFSET + this.slot * NVS_ENTRY_SIZE;
    const entry = this.data.subarray(base, base + NVS_ENTRY_SIZE);
    entry.fill(0xff);
    entry[0] = namespaceIndex;
    entry[1] = type;
    entry[2] = span;
    entry[3] = chunkIndex;
    // Zero-padded, unlike the rest of the entry. The CRC covers this field.
    entry.set(encodeCString(key, NVS_KEY_SIZE), 8);
    if (inline) entry.set(inline, 24);

    const crc = entryCrc32(entry);
    new DataView(entry.buffer, entry.byteOffset, NVS_ENTRY_SIZE).setUint32(4, crc, true);

    if (payload) {
      this.data.set(payload, base + NVS_ENTRY_SIZE);
    }

    for (let i = 0; i < span; i++) this.markWritten(this.page, this.slot + i);
    this.slot += span;
    this.lastPage = this.page;
  }

  /**
   * @param {number} page
   * @param {number} index
   */
  markWritten(page, index) {
    // The bitmap starts as 0xFF (EMPTY = 3) and bits are only ever cleared,
    // which is what lets a device advance a state without erasing.
    const at = page * NVS_PAGE_SIZE + NVS_HEADER_SIZE + (index >> 2);
    const shift = (index & 3) * 2;
    this.data[at] = (this.data[at] & ~(3 << shift)) | (ENTRY_STATE.WRITTEN << shift);
  }

  /** Stamps page headers now that the last used page is known. */
  finish() {
    for (let page = 0; page <= this.lastPage; page++) {
      const at = page * NVS_PAGE_SIZE;
      const view = new DataView(this.data.buffer, at, NVS_HEADER_SIZE);
      // Only the final page stays ACTIVE; earlier ones are done being written.
      view.setUint32(0, page === this.lastPage ? PAGE_STATE.ACTIVE : PAGE_STATE.FULL, true);
      view.setUint32(4, page, true);
      this.data[at + 8] = this.version;
      // Bytes 9..27 stay 0xFF, as on a real device.
      view.setUint32(28, pageHeaderCrc32(this.data.subarray(at, at + NVS_PAGE_SIZE)), true);
    }
    return this.data;
  }
}

/**
 * Serializes a store into an NVS partition image.
 *
 * @param {NvsStore} store
 * @param {object} options
 * @param {number} options.size          Partition size; a multiple of 4096.
 * @param {number} [options.version]
 * @param {boolean} [options.selfCheck]  Re-parse the result and compare.
 * @returns {Uint8Array}
 * @throws {NvsCapacityError} When the data does not fit. Never truncates.
 */
export function buildNvs(store, { size, version = NVS_VERSION_V2, selfCheck = true }) {
  if (!Number.isInteger(size) || size <= 0 || size % NVS_PAGE_SIZE !== 0) {
    throw new RangeError(`NVS size must be a positive multiple of ${NVS_PAGE_SIZE}; got ${size}.`);
  }
  if (size < NVS_MIN_PAGES * NVS_PAGE_SIZE) {
    throw new NvsCapacityError(NVS_MIN_PAGES * NVS_PAGE_SIZE, size);
  }

  const entries = store.entries;
  const namespaces = namespaceOrder(store, entries);
  if (namespaces.length > MAX_NAMESPACES) {
    throw new NvsCapacityError(namespaces.length, MAX_NAMESPACES);
  }

  const writer = new ImageWriter(size, version);

  // Namespace definitions come first so that a reader knows every index before
  // it meets an entry using one.
  const indexOf = new Map();
  namespaces.forEach((name, i) => {
    const index = i + 1;
    indexOf.set(name, index);
    writer.write({
      namespaceIndex: 0,
      type: NVS_TYPE.U8,
      key: name,
      inline: Uint8Array.of(index),
    });
  });

  for (const entry of entries) {
    const namespaceIndex = indexOf.get(entry.namespace);
    if (namespaceIndex === undefined) continue;
    writeEntry(writer, namespaceIndex, entry);
  }

  const image = writer.finish();

  if (selfCheck) verifyRoundTrip(image, entries);
  return image;
}

/**
 * Namespaces in a stable order, including any that hold no entries.
 *
 * @param {NvsStore} store
 * @param {NvsEntry[]} entries
 * @returns {string[]}
 */
function namespaceOrder(store, entries) {
  const names = new Set(store.namespaces);
  for (const entry of entries) names.add(entry.namespace);
  return [...names].sort();
}

/**
 * @param {ImageWriter} writer
 * @param {number} namespaceIndex
 * @param {NvsEntry} entry
 */
function writeEntry(writer, namespaceIndex, entry) {
  const type = TYPE_BY_NAME[entry.type];
  if (type === undefined) {
    throw new TypeError(`Cannot write NVS entry ${entry.namespace}.${entry.key}: unknown type "${entry.type}".`);
  }

  if (type === NVS_TYPE.STR) {
    const text = String(entry.value);
    // Stored with its terminator; the parser strips it again.
    const bytes = new TextEncoder().encode(text);
    const payload = new Uint8Array(align32(bytes.length + 1)).fill(0xff);
    payload.set(bytes);
    payload[bytes.length] = 0;
    writeVarLength(writer, namespaceIndex, entry.key, NVS_TYPE.STR, bytes.length + 1, payload, NO_CHUNK);
    return;
  }

  if (type === NVS_TYPE.BLOB) {
    writeBlob(writer, namespaceIndex, entry);
    return;
  }

  writer.write({
    namespaceIndex,
    type,
    key: entry.key,
    inline: encodePrimitive(type, entry.value, entry),
  });
}

/**
 * A blob is always a run of BLOB_DATA chunks followed by a BLOB_IDX, even when
 * it would fit in one chunk — that is what a device writes, and matching it
 * keeps the parser's blob path exercised by round-trip tests.
 *
 * @param {ImageWriter} writer
 * @param {number} namespaceIndex
 * @param {NvsEntry} entry
 */
function writeBlob(writer, namespaceIndex, entry) {
  const data = entry.value instanceof Uint8Array ? entry.value : new Uint8Array(0);
  let written = 0;
  let chunkIndex = 0;

  while (written < data.length) {
    // Two entries is the smallest useful chunk: a header and something to hold.
    if (writer.remaining < 2) writer.nextPage();
    const room = (writer.remaining - 1) * NVS_ENTRY_SIZE;
    const take = Math.min(data.length - written, room, NVS_MAX_CHUNK_SIZE);
    const slice = data.subarray(written, written + take);
    const payload = new Uint8Array(align32(take)).fill(0xff);
    payload.set(slice);
    writeVarLength(
      writer,
      namespaceIndex,
      entry.key,
      NVS_TYPE.BLOB_DATA,
      take,
      payload,
      chunkIndex,
    );
    written += take;
    chunkIndex += 1;
  }

  // blobIndex: dataSize(4) chunkCount(1) chunkStart(1) reserved(2)
  const inline = new Uint8Array(8).fill(0xff);
  new DataView(inline.buffer).setUint32(0, data.length, true);
  inline[4] = chunkIndex;
  inline[5] = 0;
  writer.write({
    namespaceIndex,
    type: NVS_TYPE.BLOB_IDX,
    key: entry.key,
    inline,
  });
}

/**
 * @param {ImageWriter} writer
 * @param {number} namespaceIndex
 * @param {string} key
 * @param {number} type
 * @param {number} dataSize
 * @param {Uint8Array} payload Already padded to a multiple of the entry size.
 * @param {number} chunkIndex
 */
function writeVarLength(writer, namespaceIndex, key, type, dataSize, payload, chunkIndex) {
  if (dataSize > NVS_MAX_CHUNK_SIZE) {
    throw new NvsCapacityError(dataSize, NVS_MAX_CHUNK_SIZE);
  }
  // varLength header: dataSize(2) reserved(2) dataCrc32(4)
  const inline = new Uint8Array(8).fill(0xff);
  const view = new DataView(inline.buffer);
  view.setUint16(0, dataSize, true);
  view.setUint32(4, espCrc32Le(0xffffffff, payload.subarray(0, dataSize)), true);
  writer.write({ namespaceIndex, type, key, chunkIndex, inline, payload });
}

/**
 * @param {number} type
 * @param {unknown} value
 * @param {NvsEntry} entry For error messages.
 * @returns {Uint8Array}
 */
function encodePrimitive(type, value, entry) {
  const out = new Uint8Array(8).fill(0xff);
  const view = new DataView(out.buffer);
  const where = `${entry.namespace}.${entry.key}`;

  switch (type) {
    case NVS_TYPE.U8:
      view.setUint8(0, checkInt(value, 0, 0xff, where));
      break;
    case NVS_TYPE.I8:
      view.setInt8(0, checkInt(value, -0x80, 0x7f, where));
      break;
    case NVS_TYPE.U16:
      view.setUint16(0, checkInt(value, 0, 0xffff, where), true);
      break;
    case NVS_TYPE.I16:
      view.setInt16(0, checkInt(value, -0x8000, 0x7fff, where), true);
      break;
    case NVS_TYPE.U32:
      view.setUint32(0, checkInt(value, 0, 0xffffffff, where), true);
      break;
    case NVS_TYPE.I32:
      view.setInt32(0, checkInt(value, -0x80000000, 0x7fffffff, where), true);
      break;
    case NVS_TYPE.U64:
      view.setBigUint64(0, BigInt(/** @type {number|bigint} */ (value)), true);
      break;
    default:
      view.setBigInt64(0, BigInt(/** @type {number|bigint} */ (value)), true);
      break;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} where
 * @returns {number}
 */
function checkInt(value, min, max, where) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`${where}: ${String(value)} does not fit the declared type (${min}..${max}).`);
  }
  return n;
}

/** @param {number} n */
const align32 = (n) => Math.ceil(n / NVS_ENTRY_SIZE) * NVS_ENTRY_SIZE;

/**
 * Reads the image back and compares it with what went in.
 *
 * On by default because the cost of a wrong image is a device that will not
 * boot, and because a writer that shares its constants with the parser can
 * agree with it while both are wrong — the failure mode this project has hit
 * repeatedly. This catches disagreement between the two at least.
 *
 * @param {Uint8Array} image
 * @param {NvsEntry[]} expected
 */
function verifyRoundTrip(image, expected) {
  const reparsed = parseNvs(image);
  const errors = reparsed.issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new Error(`buildNvs produced an image its own parser rejects: ${errors.map((e) => e.code).join(', ')}`);
  }

  const got = new Map(reparsed.entries.map((e) => [`${e.namespace} ${e.key}`, e]));
  if (got.size !== expected.length) {
    throw new Error(`buildNvs wrote ${got.size} entries but was given ${expected.length}.`);
  }
  for (const entry of expected) {
    const id = `${entry.namespace} ${entry.key}`;
    const after = got.get(id);
    if (!after) throw new Error(`buildNvs lost ${id}.`);
    if (after.type !== entry.type) {
      throw new Error(`buildNvs changed the type of ${id}: ${entry.type} -> ${after.type}.`);
    }
    if (!sameStoredValue(entry.type, entry.value, after.value)) {
      throw new Error(`buildNvs changed the value of ${id}.`);
    }
  }
}

/**
 * Compares a value that went in with the one that came back out.
 *
 * The declared type decides how: `store.set` accepts a number for U64 while
 * the parser always returns BigInt, so those two must be compared as integers
 * rather than with `===`, which would report every 64-bit entry as changed.
 *
 * @param {string} type
 * @param {unknown} before
 * @param {unknown} after
 * @returns {boolean}
 */
function sameStoredValue(type, before, after) {
  if (type === 'U64' || type === 'I64') {
    try {
      return BigInt(/** @type {number|bigint|string} */ (before)) ===
        BigInt(/** @type {number|bigint|string} */ (after));
    } catch {
      return false;
    }
  }
  return sameValue(before, after);
}
