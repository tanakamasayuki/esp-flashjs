// @ts-check
/**
 * NVS parsing.
 *
 * Layout verified against ESP-IDF `nvs_page.hpp` and `nvs_types.hpp`:
 *
 * ```text
 * Page (4096 bytes)
 *   0    32  header: state(4) seqNo(4) version(1) reserved(19) crc32(4)
 *   32   32  entry state bitmap, 2 bits per entry, LSB first
 *   64 4032  126 entries of 32 bytes
 *
 * Entry (32 bytes)
 *   0     1  namespace index (0 = the namespace definition itself)
 *   1     1  type
 *   2     1  span, in 32-byte units
 *   3     1  chunk index (0xFF unless part of a blob)
 *   4     4  crc32
 *   8    16  key, NUL-terminated ASCII
 *   24    8  payload, interpreted by type
 * ```
 *
 * @module format/nvs/parse
 */

import { espCrc32Le } from '../../binary/hash.js';
import { decodeCString } from '../../util/hex.js';
import { NvsStore } from './store.js';

export const NVS_PAGE_SIZE = 4096;
export const NVS_ENTRY_SIZE = 32;
export const NVS_ENTRY_COUNT = 126;
export const NVS_HEADER_SIZE = 32;
export const NVS_BITMAP_SIZE = 32;
export const NVS_ENTRY_DATA_OFFSET = NVS_HEADER_SIZE + NVS_BITMAP_SIZE;
export const NVS_KEY_SIZE = 16;
/** Longest key that still leaves room for the NUL terminator. */
export const NVS_MAX_KEY_LENGTH = NVS_KEY_SIZE - 1;

/** Page states. Bits are only ever cleared, so advancing never needs an erase. */
export const PAGE_STATE = {
  UNINITIALIZED: 0xffffffff,
  ACTIVE: 0xfffffffe,
  FULL: 0xfffffffc,
  FREEING: 0xfffffff8,
  CORRUPT: 0xfffffff0,
};

/** @type {Record<number, string>} */
export const PAGE_STATE_NAMES = {
  0xffffffff: 'uninitialized',
  0xfffffffe: 'active',
  0xfffffffc: 'full',
  0xfffffff8: 'freeing',
  0xfffffff0: 'corrupt',
};

/** Two bits per entry. */
export const ENTRY_STATE = { EMPTY: 3, WRITTEN: 2, ERASED: 0 };

export const NVS_VERSION_V1 = 0xff;
export const NVS_VERSION_V2 = 0xfe;

/** Item type codes, from IDF's `ItemType`. */
export const NVS_TYPE = {
  U8: 0x01,
  I8: 0x11,
  U16: 0x02,
  I16: 0x12,
  U32: 0x04,
  I32: 0x14,
  U64: 0x08,
  I64: 0x18,
  STR: 0x21,
  BLOB: 0x41,
  BLOB_DATA: 0x42,
  BLOB_IDX: 0x48,
};

/** @type {Record<number, string>} */
export const NVS_TYPE_NAMES = Object.fromEntries(
  Object.entries(NVS_TYPE).map(([name, code]) => [code, name]),
);

/** Fixed-width types and their width in bytes. */
const PRIMITIVE_WIDTH = {
  [NVS_TYPE.U8]: 1,
  [NVS_TYPE.I8]: 1,
  [NVS_TYPE.U16]: 2,
  [NVS_TYPE.I16]: 2,
  [NVS_TYPE.U32]: 4,
  [NVS_TYPE.I32]: 4,
  [NVS_TYPE.U64]: 8,
  [NVS_TYPE.I64]: 8,
};

/**
 * @typedef {import('../partition.js').Issue} Issue
 */

/**
 * @typedef {object} NvsEntry
 * @property {string} namespace
 * @property {string} key
 * @property {string} type          Name from {@link NVS_TYPE_NAMES}.
 * @property {number|bigint|string|Uint8Array} value
 * @property {Uint8Array} raw       The 32-byte entry as stored.
 * @property {number} pageIndex
 * @property {number} entryIndex
 * @property {number} span
 * @property {number} namespaceIndex
 * @property {boolean} crcValid
 * @property {boolean} [partial]    A blob with chunks missing.
 */

/**
 * @typedef {object} NvsPageInfo
 * @property {number} index
 * @property {number} state
 * @property {string} stateName
 * @property {number} seqNo
 * @property {number} version
 * @property {boolean} crcValid
 * @property {number} usedEntries
 */

/**
 * Computes the CRC of a 32-byte entry, the way IDF does.
 *
 * IDF chains three `esp_rom_crc32_le` calls covering the entry with its own CRC
 * field skipped. Chaining that function equals one call over the concatenation,
 * because it inverts on the way in and out.
 *
 * @param {Uint8Array} entry 32 bytes.
 * @returns {number}
 */
export function entryCrc32(entry) {
  const joined = new Uint8Array(4 + NVS_KEY_SIZE + 8);
  joined.set(entry.subarray(0, 4), 0);
  joined.set(entry.subarray(8, 8 + NVS_KEY_SIZE), 4);
  joined.set(entry.subarray(24, 32), 4 + NVS_KEY_SIZE);
  return espCrc32Le(0xffffffff, joined);
}

/**
 * Page header CRC: bytes 4 to 28, everything but the state and the CRC itself.
 *
 * @param {Uint8Array} page
 * @returns {number}
 */
export function pageHeaderCrc32(page) {
  return espCrc32Le(0xffffffff, page.subarray(4, 28));
}

/**
 * Reads the two-bit state of one entry out of a page's bitmap.
 *
 * @param {Uint8Array} page
 * @param {number} index
 * @returns {number}
 */
export function entryState(page, index) {
  const byte = page[NVS_HEADER_SIZE + (index >> 2)];
  return (byte >> ((index & 3) * 2)) & 3;
}

/**
 * Parses an NVS partition image.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {boolean} [options.strict] Throw instead of collecting issues.
 * @returns {NvsStore}
 */
export function parseNvs(data, { strict = false } = {}) {
  /** @type {Issue[]} */
  const issues = [];
  /** @type {NvsPageInfo[]} */
  const pages = [];
  /** @type {NvsEntry[]} */
  const erasedEntries = [];

  const pageCount = Math.floor(data.length / NVS_PAGE_SIZE);
  if (pageCount === 0) {
    if (strict) throw new Error(`NVS image is shorter than one ${NVS_PAGE_SIZE}-byte page.`);
    issues.push({ level: 'error', code: 'nvs.tooShort', params: { length: data.length } });
    return new NvsStore({ pages, entries: [], erasedEntries, issues, size: data.length });
  }

  /** Namespace index to name, from the entries with nsIndex 0. */
  const namespaces = new Map();
  /** Every record seen, resolved to values once namespaces are known. */
  const records = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const page = data.subarray(pageIndex * NVS_PAGE_SIZE, (pageIndex + 1) * NVS_PAGE_SIZE);
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const state = view.getUint32(0, true);
    const seqNo = view.getUint32(4, true);
    const version = page[8];
    const storedCrc = view.getUint32(28, true);
    const crcValid = state === PAGE_STATE.UNINITIALIZED || storedCrc === pageHeaderCrc32(page);

    const info = {
      index: pageIndex,
      state,
      stateName: PAGE_STATE_NAMES[state] ?? 'unknown',
      seqNo,
      version,
      crcValid,
      usedEntries: 0,
    };
    pages.push(info);

    if (state === PAGE_STATE.UNINITIALIZED) continue;
    if (!crcValid) {
      issues.push({ level: 'error', code: 'nvs.pageCrc', params: { page: pageIndex } });
    }
    if (version !== NVS_VERSION_V2 && version !== NVS_VERSION_V1) {
      issues.push({
        level: 'warning',
        code: 'nvs.unknownVersion',
        params: { page: pageIndex, version },
      });
    }

    for (let i = 0; i < NVS_ENTRY_COUNT; i++) {
      const slot = entryState(page, i);
      if (slot === ENTRY_STATE.EMPTY) continue;

      const start = NVS_ENTRY_DATA_OFFSET + i * NVS_ENTRY_SIZE;
      const record = readEntry(page, page.subarray(start, start + NVS_ENTRY_SIZE), pageIndex, i, seqNo);
      if (!record) continue;

      record.erased = slot === ENTRY_STATE.ERASED;
      if (!record.erased) {
        info.usedEntries += record.span;
        if (record.namespaceIndex === 0 && record.typeCode === NVS_TYPE.U8) {
          // A namespace definition: key is the name, value the assigned index.
          namespaces.set(record.value, record.key);
        }
      }
      // Skip the payload slots a multi-span record occupies.
      i += record.span - 1;
      records.push(record);
    }
  }

  // Later pages win: NVS writes the new entry then erases the old, and the page
  // sequence number is what orders those two events.
  records.sort((a, b) => a.seqNo - b.seqNo || a.entryIndex - b.entryIndex);

  /** @type {Map<string, NvsEntry>} */
  const live = new Map();

  for (const record of records) {
    if (record.namespaceIndex === 0) continue; // namespace definitions are not user data

    const namespace = namespaces.get(record.namespaceIndex);
    if (namespace === undefined) {
      issues.push({
        level: 'warning',
        code: 'nvs.orphanNamespace',
        params: { index: record.namespaceIndex, key: record.key },
      });
      continue;
    }

    /** @type {NvsEntry} */
    const entry = {
      namespace,
      key: record.key,
      type: NVS_TYPE_NAMES[record.typeCode] ?? `unknown(0x${record.typeCode.toString(16)})`,
      value: record.value,
      raw: record.raw,
      pageIndex: record.pageIndex,
      entryIndex: record.entryIndex,
      span: record.span,
      namespaceIndex: record.namespaceIndex,
      crcValid: record.crcValid,
    };

    if (!record.crcValid) {
      if (strict) throw new Error(`NVS entry CRC mismatch for ${namespace}.${record.key}`);
      issues.push({
        level: 'error',
        code: 'nvs.entryCrc',
        params: { namespace, key: record.key, page: record.pageIndex },
      });
    }

    const id = `${namespace}\0${record.key}`;
    if (record.erased) {
      erasedEntries.push(entry);
      live.delete(id);
      continue;
    }
    // BLOB_DATA chunks are assembled by their BLOB_IDX; alone they are not values.
    if (record.typeCode === NVS_TYPE.BLOB_DATA) continue;
    live.set(id, entry);
  }

  // Stitch blobs together now that every chunk has been seen.
  for (const entry of live.values()) {
    if (entry.type !== 'BLOB_IDX') continue;
    const assembled = assembleBlob(entry, records, issues);
    entry.type = 'BLOB';
    entry.value = assembled.data;
    if (assembled.partial) entry.partial = true;
  }

  const entries = [...live.values()].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key),
  );

  return new NvsStore({
    pages,
    entries,
    erasedEntries,
    issues,
    size: data.length,
    namespaces: [...new Set(namespaces.values())].sort(),
  });
}

/**
 * @param {Uint8Array} page
 * @param {Uint8Array} raw
 * @param {number} pageIndex
 * @param {number} entryIndex
 * @param {number} seqNo
 * @returns {any}
 */
function readEntry(page, raw, pageIndex, entryIndex, seqNo) {
  if (raw.length < NVS_ENTRY_SIZE) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const typeCode = raw[1];
  const storedCrc = view.getUint32(4, true);

  const base = {
    namespaceIndex: raw[0],
    typeCode,
    span: raw[2] || 1,
    chunkIndex: raw[3],
    key: decodeCString(raw.subarray(8, 8 + NVS_KEY_SIZE)),
    raw: new Uint8Array(raw),
    pageIndex,
    entryIndex,
    seqNo,
    crcValid: storedCrc === entryCrc32(raw),
    erased: false,
  };

  if (PRIMITIVE_WIDTH[typeCode] !== undefined) {
    return { ...base, value: readPrimitive(view, typeCode) };
  }

  if (typeCode === NVS_TYPE.STR || typeCode === NVS_TYPE.BLOB_DATA || typeCode === NVS_TYPE.BLOB) {
    // varLength: dataSize(2) reserved(2) dataCrc32(4)
    const size = view.getUint16(24, true);
    const dataCrc = view.getUint32(28, true);
    const start = NVS_ENTRY_DATA_OFFSET + (entryIndex + 1) * NVS_ENTRY_SIZE;
    const payload = page.subarray(start, start + size);
    const dataCrcValid = payload.length === size && espCrc32Le(0xffffffff, payload) === dataCrc;
    return {
      ...base,
      // A stored string keeps its NUL terminator; the value should not.
      value: typeCode === NVS_TYPE.STR ? decodeCString(payload) : new Uint8Array(payload),
      dataSize: size,
      dataCrcValid,
    };
  }

  if (typeCode === NVS_TYPE.BLOB_IDX) {
    // blobIndex: dataSize(4) chunkCount(1) chunkStart(1) reserved(2)
    return {
      ...base,
      value: new Uint8Array(0),
      blobSize: view.getUint32(24, true),
      chunkCount: raw[28],
      chunkStart: raw[29],
    };
  }

  return { ...base, value: new Uint8Array(raw.subarray(24, 32)) };
}

/**
 * @param {DataView} view
 * @param {number} typeCode
 * @returns {number|bigint}
 */
function readPrimitive(view, typeCode) {
  switch (typeCode) {
    case NVS_TYPE.U8:
      return view.getUint8(24);
    case NVS_TYPE.I8:
      return view.getInt8(24);
    case NVS_TYPE.U16:
      return view.getUint16(24, true);
    case NVS_TYPE.I16:
      return view.getInt16(24, true);
    case NVS_TYPE.U32:
      return view.getUint32(24, true);
    case NVS_TYPE.I32:
      return view.getInt32(24, true);
    case NVS_TYPE.U64:
      return view.getBigUint64(24, true);
    default:
      return view.getBigInt64(24, true);
  }
}

/**
 * Joins the BLOB_DATA chunks a BLOB_IDX points at.
 *
 * @param {NvsEntry} index
 * @param {any[]} records
 * @param {Issue[]} issues
 * @returns {{data: Uint8Array, partial: boolean}}
 */
function assembleBlob(index, records, issues) {
  const source = records.find(
    (r) => r.pageIndex === index.pageIndex && r.entryIndex === index.entryIndex,
  );
  const expected = source?.chunkCount ?? 0;
  const chunkStart = source?.chunkStart ?? 0;

  /** @type {Uint8Array[]} */
  const parts = [];
  let missing = 0;

  for (let c = 0; c < expected; c++) {
    const chunk = records.find(
      (r) =>
        r.typeCode === NVS_TYPE.BLOB_DATA &&
        r.namespaceIndex === index.namespaceIndex &&
        r.key === index.key &&
        r.chunkIndex === chunkStart + c &&
        !r.erased,
    );
    if (!chunk) {
      missing++;
      continue;
    }
    parts.push(/** @type {Uint8Array} */ (chunk.value));
  }

  if (missing > 0) {
    issues.push({
      level: 'error',
      code: 'nvs.blobChunkMissing',
      params: { namespace: index.namespace, key: index.key, missing, expected },
    });
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    data.set(p, offset);
    offset += p.length;
  }
  return { data, partial: missing > 0 };
}
