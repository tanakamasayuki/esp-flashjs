// @ts-check
/**
 * OTA data partition parsing.
 *
 * The otadata partition is two 4 KB sectors, each holding an `ota_seq` counter
 * and a CRC. The valid sector with the higher sequence number wins, and
 * `seq % ota_slot_count` selects the app partition to boot.
 *
 * @module format/otadata
 */

import { ByteReader } from '../binary/reader.js';
import { espCrc32Le } from '../binary/hash.js';

export const OTADATA_SECTOR_SIZE = 0x1000;
export const OTA_SEQ_EMPTY = 0xffffffff;

/**
 * @typedef {import('./partition.js').Issue} Issue
 */

/**
 * @typedef {object} OtaSector
 * @property {number} index
 * @property {number} seq
 * @property {number} crc
 * @property {number} computedCrc
 * @property {boolean} valid
 * @property {boolean} empty   Sequence number is 0xFFFFFFFF.
 * @property {boolean} erased  The whole 4 KB sector is still 0xFF.
 */

/**
 * @typedef {object} OtaData
 * @property {OtaSector[]} sectors
 * @property {number|null} activeSector  Index of the winning sector.
 * @property {number|null} bootSlot      `seq - 1` modulo the OTA slot count.
 * @property {Issue[]} issues
 */

/**
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.otaSlotCount] Number of ota_N app partitions.
 * @returns {OtaData}
 */
export function parseOtaData(data, { otaSlotCount = 2 } = {}) {
  /** @type {OtaSector[]} */
  const sectors = [];
  /** @type {Issue[]} */
  const issues = [];

  for (let i = 0; i < 2; i++) {
    const base = i * OTADATA_SECTOR_SIZE;
    if (base + 8 > data.length) {
      issues.push({ level: 'warning', code: 'otadata.missingSector', params: { index: i } });
      continue;
    }
    const reader = new ByteReader(data, base, 'otadata');
    const seq = reader.u32();
    // The CRC covers only the 4-byte sequence number.
    const crc = new DataView(data.buffer, data.byteOffset + base + 28, 4).getUint32(0, true);
    // IDF: esp_crc32_le(UINT32_MAX, &s->ota_seq, 4) — over the sequence number
    // alone, in the ROM's inverted-seed convention.
    const computedCrc = espCrc32Le(0xffffffff, data.subarray(base, base + 4));
    // "Never written" is the whole sector still erased, not merely a 0xFFFFFFFF
    // sequence number — a partially written sector has neither a usable
    // sequence nor a valid CRC, and calling that "unused" would be wrong.
    const sectorBytes = data.subarray(base, Math.min(base + OTADATA_SECTOR_SIZE, data.length));
    const erased = sectorBytes.every((b) => b === 0xff);
    const empty = seq === OTA_SEQ_EMPTY;

    sectors.push({
      index: i,
      seq,
      crc,
      computedCrc,
      valid: !empty && crc === computedCrc,
      empty,
      erased,
    });
  }

  const valid = sectors.filter((s) => s.valid);
  let activeSector = null;
  let bootSlot = null;

  if (valid.length > 0) {
    const winner = valid.reduce((a, b) => (b.seq > a.seq ? b : a));
    activeSector = winner.index;
    // IDF stores seq as "boot count"; slot = (seq - 1) % slots.
    bootSlot = otaSlotCount > 0 ? (winner.seq - 1) % otaSlotCount : null;
  } else if (sectors.every((s) => s.erased)) {
    issues.push({ level: 'warning', code: 'otadata.neverWritten' });
  } else {
    issues.push({ level: 'error', code: 'otadata.noValidSector' });
  }

  return { sectors, activeSector, bootSlot, issues };
}
