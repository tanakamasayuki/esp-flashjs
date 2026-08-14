// @ts-check
/**
 * Fixture builders shared by the test suite.
 *
 * Synthesizing fixtures in code beats committing binaries: the intent of each
 * case stays readable, and edge cases can be parameterized.
 */

import { ByteWriter } from '../src/binary/writer.js';
import {
  buildPartitionTable,
  subtypeName,
  typeName,
  PARTITION_TYPE,
} from '../src/format/partition.js';
import { espChecksum } from '../src/binary/hash.js';

/**
 * A conventional single-app layout for a 4 MB device.
 * @returns {import('../src/format/partition.js').Partition[]}
 */
export function singleAppPartitions() {
  return [
    part('nvs', PARTITION_TYPE.DATA, 0x02, 0x9000, 0x6000),
    part('phy_init', PARTITION_TYPE.DATA, 0x01, 0xf000, 0x1000),
    part('factory', PARTITION_TYPE.APP, 0x00, 0x10000, 0x100000),
    part('spiffs', PARTITION_TYPE.DATA, 0x82, 0x110000, 0x2f0000),
  ];
}

/**
 * A dual-OTA layout, including the otadata partition.
 * @returns {import('../src/format/partition.js').Partition[]}
 */
export function otaPartitions() {
  return [
    part('nvs', PARTITION_TYPE.DATA, 0x02, 0x9000, 0x5000),
    part('otadata', PARTITION_TYPE.DATA, 0x00, 0xe000, 0x2000),
    part('app0', PARTITION_TYPE.APP, 0x10, 0x10000, 0x140000),
    part('app1', PARTITION_TYPE.APP, 0x11, 0x150000, 0x140000),
    part('spiffs', PARTITION_TYPE.DATA, 0x82, 0x290000, 0x160000),
  ];
}

/**
 * @param {string} label
 * @param {number} type
 * @param {number} subtype
 * @param {number} offset
 * @param {number} size
 * @param {number} [flags]
 * @returns {import('../src/format/partition.js').Partition}
 */
export function part(label, type, subtype, offset, size, flags = 0) {
  return {
    label,
    type,
    subtype,
    typeName: typeName(type),
    subtypeName: subtypeName(type, subtype),
    offset,
    size,
    flags,
    encrypted: (flags & 1) !== 0,
    entryIndex: 0,
  };
}

/**
 * @param {import('../src/format/partition.js').Partition[]} [partitions]
 * @returns {Uint8Array}
 */
export function partitionTableBytes(partitions = singleAppPartitions()) {
  return buildPartitionTable(partitions);
}

/**
 * Builds a syntactically valid ESP firmware image.
 *
 * @param {object} [options]
 * @param {number} [options.chipId]
 * @param {number} [options.entryPoint]
 * @param {Array<{loadAddress: number, data: Uint8Array}>} [options.segments]
 * @param {boolean} [options.appendHash]
 * @param {boolean} [options.corruptChecksum]
 * @param {object} [options.appDesc]
 * @returns {Uint8Array}
 */
export function espImageBytes(options = {}) {
  const {
    chipId = 9,
    entryPoint = 0x40080000,
    appendHash = false,
    corruptChecksum = false,
    appDesc = null,
  } = options;

  let segments = options.segments;
  if (!segments) {
    const first = new Uint8Array(512);
    if (appDesc) writeAppDesc(first, appDesc);
    segments = [{ loadAddress: 0x3fc80000, data: first }];
  }

  const w = new ByteWriter(1024);
  w.u8(0xe9);
  w.u8(segments.length);
  w.u8(0x02); // dio
  w.u8((0x02 << 4) | 0x0f); // 4MB @ 80m
  w.u32(entryPoint);
  // Extended header.
  w.u8(0xee); // wp pin
  w.fill(3, 0); // spi pin drive
  w.u16(chipId);
  w.u8(0); // min chip rev
  w.u16(0); // min chip rev full
  w.u16(0xffff); // max chip rev full
  w.fill(4, 0); // reserved
  w.u8(appendHash ? 1 : 0);

  let checksum = 0xef;
  for (const seg of segments) {
    w.u32(seg.loadAddress);
    w.u32(seg.data.length);
    w.bytes(seg.data);
    checksum = espChecksum(seg.data, checksum);
  }

  // Pad so the checksum byte lands at the end of a 16-byte block.
  w.fill((16 - ((w.length + 1) % 16)) % 16, 0);
  w.u8(corruptChecksum ? checksum ^ 0xff : checksum);

  if (appendHash) w.fill(32, 0xaa);
  return w.toBytes();
}

/**
 * @param {Uint8Array} segment
 * @param {{version?: string, projectName?: string, idfVersion?: string}} desc
 */
function writeAppDesc(segment, desc) {
  const w = new ByteWriter(256);
  w.u32(0xabcd5432);
  w.cstring(desc.version ?? '1.0.0', 32);
  w.cstring(desc.projectName ?? 'test-app', 32);
  w.cstring('12:00:00', 16);
  w.cstring('Jan  1 2026', 16);
  w.cstring(desc.idfVersion ?? 'v5.2', 32);
  w.fill(32, 0);
  segment.set(w.toBytes(), 0x20);
}

/**
 * Builds an otadata partition image.
 *
 * @param {Array<number|null>} sequences `null` leaves the sector erased.
 * @returns {Uint8Array}
 */
export function otaDataBytes(sequences = [1, null]) {
  const out = new Uint8Array(0x2000).fill(0xff);
  const view = new DataView(out.buffer);
  sequences.forEach((seq, i) => {
    if (seq === null) return;
    const base = i * 0x1000;
    view.setUint32(base, seq, true);
    // The stored CRC covers only the sequence number.
    const crc = crcOf(out.subarray(base, base + 4));
    view.setUint32(base + 28, crc, true);
  });
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {number}
 */
function crcOf(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a 4 MB flash image with a bootloader stub, partition table and app.
 *
 * @param {object} [options]
 * @param {number} [options.size]
 * @param {import('../src/format/partition.js').Partition[]} [options.partitions]
 * @returns {Uint8Array}
 */
export function flashImage({ size = 4 * 1024 * 1024, partitions } = {}) {
  const flash = new Uint8Array(size).fill(0xff);
  const table = buildPartitionTable(partitions ?? singleAppPartitions());
  flash.set(espImageBytes({ entryPoint: 0x40080000 }), 0x1000); // bootloader
  flash.set(table, 0x8000);
  flash.set(espImageBytes({ appDesc: { projectName: 'app' } }), 0x10000);
  return flash;
}

/** Buffers that every parser must survive. @returns {Record<string, Uint8Array>} */
export function pathologicalInputs() {
  return {
    empty: new Uint8Array(0),
    oneByte: new Uint8Array([0xe9]),
    allZero: new Uint8Array(4096),
    allErased: new Uint8Array(4096).fill(0xff),
    random: Uint8Array.from({ length: 4096 }, (_, i) => (i * 2654435761) & 0xff),
  };
}
