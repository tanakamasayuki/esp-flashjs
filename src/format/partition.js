// @ts-check
/**
 * ESP32 partition table parsing, validation and generation.
 *
 * Layout: up to 95 entries of 32 bytes at flash offset 0x8000, optionally
 * followed by an MD5 checksum entry, padded to 0xC00 with 0xFF.
 *
 * @module format/partition
 */

import { ByteReader } from '../binary/reader.js';
import { ByteWriter } from '../binary/writer.js';
import { md5 } from '../binary/hash.js';
import { bytesToHex, decodeCString } from '../util/hex.js';
import { InvalidMagicError } from '../util/errors.js';

export const PARTITION_TABLE_OFFSET = 0x8000;
export const PARTITION_TABLE_SIZE = 0xc00;
export const PARTITION_ENTRY_SIZE = 32;
/**
 * Magic at the start of a partition entry, as the bytes appear on flash: AA 50.
 *
 * Mind the byte order. Espressif's tooling defines this as the byte string
 * `b"\xAA\x50"` and compares it raw, so read back as a little-endian u16 it is
 * **0x50AA, not 0xAA50**. Having it backwards yields a parser that accepts only
 * the tables it generated itself — which is exactly what shipped in 0.1.0, and
 * why a parse/build round trip could not detect it.
 */
export const PARTITION_MAGIC_BYTES = Object.freeze([0xaa, 0x50]);

/** The same two bytes read as a little-endian u16. */
export const PARTITION_MAGIC = PARTITION_MAGIC_BYTES[0] | (PARTITION_MAGIC_BYTES[1] << 8);

/** Magic of the trailing MD5 entry: EB EB, a palindrome, so order is moot. */
export const PARTITION_MD5_MAGIC_BYTES = Object.freeze([0xeb, 0xeb]);
export const PARTITION_MD5_MAGIC = 0xebeb;
export const MAX_PARTITIONS = 95;

/** App partitions must start on a 64 KB boundary. */
export const APP_ALIGNMENT = 0x10000;
/** Data partitions must start on a 4 KB boundary. */
export const DATA_ALIGNMENT = 0x1000;

export const PARTITION_TYPE = { APP: 0x00, DATA: 0x01 };

/** @type {Record<number, string>} */
const TYPE_NAMES = { 0x00: 'app', 0x01: 'data' };

/** @type {Record<number, Record<number, string>>} */
const SUBTYPE_NAMES = {
  0x00: {
    0x00: 'factory',
    0x20: 'test',
    // 0x10-0x1F are ota_0 .. ota_15, filled in below.
  },
  0x01: {
    0x00: 'ota',
    0x01: 'phy',
    0x02: 'nvs',
    0x03: 'coredump',
    0x04: 'nvs_keys',
    0x05: 'efuse',
    0x06: 'undefined',
    0x80: 'esphttpd',
    0x81: 'fat',
    0x82: 'spiffs',
    0x83: 'littlefs',
  },
};
for (let i = 0; i < 16; i++) SUBTYPE_NAMES[0x00][0x10 + i] = `ota_${i}`;

/**
 * @typedef {object} Issue
 * @property {'error'|'warning'} level
 * @property {string} code                     Stable identifier, used as a translation key.
 * @property {Record<string, unknown>} [params] Interpolation values for the message.
 * @property {number} [partitionIndex]
 */

/**
 * @typedef {object} Partition
 * @property {string} label
 * @property {number} type
 * @property {number} subtype
 * @property {string} typeName
 * @property {string} subtypeName
 * @property {number} offset
 * @property {number} size
 * @property {number} flags
 * @property {boolean} encrypted
 * @property {number} entryIndex
 */

/**
 * @typedef {object} PartitionTable
 * @property {Partition[]} partitions
 * @property {boolean} hasMd5
 * @property {boolean} md5Valid   True when there is no MD5 entry to disagree with.
 * @property {Issue[]} issues
 */

/**
 * @param {number} type
 * @returns {string}
 */
export function typeName(type) {
  return TYPE_NAMES[type] ?? 'unknown';
}

/**
 * @param {number} type
 * @param {number} subtype
 * @returns {string}
 */
export function subtypeName(type, subtype) {
  return SUBTYPE_NAMES[type]?.[subtype] ?? 'unknown';
}

/**
 * Parses a partition table.
 *
 * Parsing never aborts on inconsistency: malformed entries are reported
 * through `issues` and everything recoverable is returned. Only data that is
 * not a partition table at all throws.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.offset] Offset of the table within `data`.
 * @returns {PartitionTable}
 * @throws {InvalidMagicError} If the first entry has no partition magic.
 */
export function parsePartitionTable(data, { offset = 0 } = {}) {
  const reader = new ByteReader(data, offset, 'partition table');
  /** @type {Partition[]} */
  const partitions = [];
  /** @type {Issue[]} */
  const issues = [];

  let hasMd5 = false;
  let md5Valid = true;
  let entryIndex = 0;

  const firstMagic = reader.remaining >= 2 ? new DataView(
    data.buffer, data.byteOffset + offset, 2,
  ).getUint16(0, true) : 0;
  if (firstMagic !== PARTITION_MAGIC && firstMagic !== PARTITION_MD5_MAGIC) {
    throw new InvalidMagicError('partition table', PARTITION_MAGIC, firstMagic, offset);
  }

  while (reader.remaining >= PARTITION_ENTRY_SIZE && entryIndex < MAX_PARTITIONS + 1) {
    const entryStart = reader.offset;
    const magic = reader.u16();

    if (magic === PARTITION_MD5_MAGIC) {
      hasMd5 = true;
      reader.skip(14); // Reserved; the digest lives in the last 16 bytes.
      const stored = reader.copy(16);
      const computed = md5(data.subarray(offset, entryStart));
      md5Valid = bytesToHex(stored) === bytesToHex(computed);
      if (!md5Valid) {
        issues.push({
          level: 'error',
          code: 'partition.md5Mismatch',
          params: { expected: bytesToHex(stored), actual: bytesToHex(computed) },
        });
      }
      break;
    }

    // 0xFFFF (erased) or 0x0000 marks the end of the table.
    if (magic !== PARTITION_MAGIC) break;

    const type = reader.u8();
    const subtype = reader.u8();
    const partOffset = reader.u32();
    const size = reader.u32();
    const label = decodeCString(reader.bytes(16));
    const flags = reader.u32();

    partitions.push({
      label,
      type,
      subtype,
      typeName: typeName(type),
      subtypeName: subtypeName(type, subtype),
      offset: partOffset,
      size,
      flags,
      encrypted: (flags & 0x1) !== 0,
      entryIndex,
    });
    entryIndex++;
  }

  if (partitions.length === 0) {
    issues.push({ level: 'error', code: 'partition.empty' });
  }

  return { partitions, hasMd5, md5Valid, issues };
}

/**
 * Checks a table for problems that would brick or confuse a device.
 *
 * @param {PartitionTable|Partition[]} table
 * @param {object} [options]
 * @param {number|null} [options.flashSize]
 * @returns {Issue[]}
 */
export function validatePartitionTable(table, { flashSize = null } = {}) {
  const partitions = Array.isArray(table) ? table : table.partitions;
  /** @type {Issue[]} */
  const issues = [];

  if (partitions.length > MAX_PARTITIONS) {
    issues.push({
      level: 'error',
      code: 'partition.tooMany',
      params: { count: partitions.length, max: MAX_PARTITIONS },
    });
  }

  const seenLabels = new Map();
  let hasOtaData = false;
  let hasFactory = false;
  const otaSlots = [];

  partitions.forEach((p, index) => {
    if (p.size === 0) {
      issues.push({ level: 'error', code: 'partition.zeroSize', params: { label: p.label }, partitionIndex: index });
    }

    const alignment = p.type === PARTITION_TYPE.APP ? APP_ALIGNMENT : DATA_ALIGNMENT;
    if (p.offset % alignment !== 0) {
      issues.push({
        level: 'error',
        code: p.type === PARTITION_TYPE.APP ? 'partition.appAlignment' : 'partition.dataAlignment',
        params: { label: p.label, offset: p.offset, alignment },
        partitionIndex: index,
      });
    }

    if (p.offset < PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE) {
      issues.push({
        level: 'error',
        code: 'partition.overlapsTable',
        params: { label: p.label, offset: p.offset },
        partitionIndex: index,
      });
    }

    if (flashSize !== null && p.offset + p.size > flashSize) {
      issues.push({
        level: 'error',
        code: 'partition.exceedsFlash',
        params: { label: p.label, end: p.offset + p.size, flashSize },
        partitionIndex: index,
      });
    }

    if (p.label === '') {
      issues.push({ level: 'warning', code: 'partition.emptyLabel', partitionIndex: index });
    } else if (seenLabels.has(p.label)) {
      issues.push({
        level: 'error',
        code: 'partition.duplicateLabel',
        params: { label: p.label, other: seenLabels.get(p.label) },
        partitionIndex: index,
      });
    } else {
      seenLabels.set(p.label, index);
    }

    // Derive the names from the raw values rather than trusting the cached
    // fields: callers building a table by hand often leave them blank, and a
    // silently skipped OTA check is worse than a redundant lookup.
    const sub = subtypeName(p.type, p.subtype);
    if (p.type === PARTITION_TYPE.DATA && sub === 'ota') hasOtaData = true;
    if (p.type === PARTITION_TYPE.APP && sub === 'factory') hasFactory = true;
    if (p.type === PARTITION_TYPE.APP && /^ota_\d+$/.test(sub)) otaSlots.push(p.label);
  });

  // Overlap detection, on a copy sorted by offset.
  const sorted = [...partitions].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.offset + prev.size > cur.offset) {
      issues.push({
        level: 'error',
        code: 'partition.overlap',
        params: { a: prev.label, b: cur.label, at: cur.offset },
      });
    }
  }

  if (otaSlots.length > 0 && !hasOtaData) {
    issues.push({ level: 'error', code: 'partition.missingOtaData', params: { count: otaSlots.length } });
  }
  if (otaSlots.length === 1) {
    issues.push({ level: 'warning', code: 'partition.singleOtaSlot' });
  }
  if (hasFactory && otaSlots.length > 0) {
    issues.push({ level: 'warning', code: 'partition.factoryWithOta' });
  }

  return issues;
}

/**
 * Serializes a partition table back to its 0xC00-byte on-flash form.
 *
 * @param {PartitionTable|Partition[]} table
 * @param {object} [options]
 * @param {boolean} [options.md5] Append the MD5 checksum entry.
 * @returns {Uint8Array}
 * @throws {Error} If there are more entries than the table can hold.
 */
export function buildPartitionTable(table, { md5: withMd5 = true } = {}) {
  const partitions = Array.isArray(table) ? table : table.partitions;
  if (partitions.length > MAX_PARTITIONS) {
    throw new Error(`Too many partitions: ${partitions.length} (max ${MAX_PARTITIONS}).`);
  }

  const writer = ByteWriter.fixed(PARTITION_TABLE_SIZE, 0xff);

  for (const p of partitions) {
    writer
      .u8(PARTITION_MAGIC_BYTES[0])
      .u8(PARTITION_MAGIC_BYTES[1])
      .u8(p.type)
      .u8(p.subtype)
      .u32(p.offset)
      .u32(p.size)
      .cstring(p.label, 16)
      .u32(p.flags ?? 0);
  }

  if (withMd5) {
    const digest = md5(writer.buffer.subarray(0, writer.length));
    writer
      .u8(PARTITION_MD5_MAGIC_BYTES[0])
      .u8(PARTITION_MD5_MAGIC_BYTES[1])
      .fill(14, 0xff)
      .bytes(digest);
  }

  // Pad the remainder with 0xFF, matching erased flash.
  const out = new Uint8Array(PARTITION_TABLE_SIZE).fill(0xff);
  out.set(writer.buffer.subarray(0, writer.length));
  return out;
}

/**
 * Builds the list of gaps between partitions, so the UI can show unallocated
 * flash rather than silently omitting it.
 *
 * @param {Partition[]} partitions
 * @param {number|null} flashSize
 * @returns {Array<{offset: number, size: number}>}
 */
export function findUnallocatedRegions(partitions, flashSize) {
  const sorted = [...partitions].sort((a, b) => a.offset - b.offset);
  /** @type {Array<{offset: number, size: number}>} */
  const gaps = [];
  let cursor = 0;

  for (const p of sorted) {
    if (p.offset > cursor) gaps.push({ offset: cursor, size: p.offset - cursor });
    cursor = Math.max(cursor, p.offset + p.size);
  }
  if (flashSize !== null && cursor < flashSize) {
    gaps.push({ offset: cursor, size: flashSize - cursor });
  }
  return gaps;
}

/**
 * @typedef {object} FlashRegion
 * @property {'bootloader'|'partition-table'|'partition'|'unallocated'} kind
 * @property {number} offset
 * @property {number} size
 * @property {Partition} [partition] Present when `kind` is "partition".
 */

/**
 * Describes the whole flash, including the parts no partition entry covers.
 *
 * A partition table describes neither itself nor the bootloader, so treating
 * every gap between entries as free space labels the two most dangerous
 * regions on the device as "unallocated" — which is how a flash map ends up
 * inviting someone to erase the bootloader. Those regions are named here
 * instead.
 *
 * @param {Partition[]} partitions
 * @param {object} [options]
 * @param {number|null} [options.flashSize]
 * @param {number} [options.bootloaderOffset] Chip-specific; 0x1000 on the
 *   original ESP32, 0 on the S3 and C3, 0x2000 on the P4 and C5.
 * @returns {FlashRegion[]} Ordered by offset, with no gaps.
 */
export function describeFlashLayout(partitions, { flashSize = null, bootloaderOffset = 0x1000 } = {}) {
  /** @type {FlashRegion[]} */
  const known = [
    // The bootloader owns everything from its offset up to the table; the
    // image itself is smaller, but that is the space reserved for it.
    {
      kind: /** @type {const} */ ('bootloader'),
      offset: bootloaderOffset,
      size: PARTITION_TABLE_OFFSET - bootloaderOffset,
    },
    {
      kind: /** @type {const} */ ('partition-table'),
      offset: PARTITION_TABLE_OFFSET,
      size: PARTITION_TABLE_SIZE,
    },
    ...partitions.map((p) => ({
      kind: /** @type {const} */ ('partition'),
      offset: p.offset,
      size: p.size,
      partition: p,
    })),
  ]
    .filter((r) => r.size > 0)
    .sort((a, b) => a.offset - b.offset);

  /** @type {FlashRegion[]} */
  const out = [];
  let cursor = 0;

  for (const region of known) {
    // Overlaps are reported by validatePartitionTable; here just do not let
    // one swallow the region before it.
    if (region.offset < cursor) {
      cursor = Math.max(cursor, region.offset + region.size);
      out.push(region);
      continue;
    }
    if (region.offset > cursor) {
      out.push({ kind: 'unallocated', offset: cursor, size: region.offset - cursor });
    }
    out.push(region);
    cursor = region.offset + region.size;
  }

  if (flashSize !== null && cursor < flashSize) {
    out.push({ kind: 'unallocated', offset: cursor, size: flashSize - cursor });
  }
  return out;
}

/**
 * @param {Partition[]} partitions
 * @param {string} label
 * @returns {Partition|undefined}
 */
export function findPartitionByLabel(partitions, label) {
  return partitions.find((p) => p.label === label);
}

/**
 * @param {Partition[]} partitions
 * @param {number} address
 * @returns {Partition|undefined}
 */
export function findPartitionAt(partitions, address) {
  return partitions.find((p) => address >= p.offset && address < p.offset + p.size);
}
