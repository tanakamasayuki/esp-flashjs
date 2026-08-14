// @ts-check
/**
 * ESP firmware image parsing.
 *
 * @module format/image
 */

import { ByteReader } from '../binary/reader.js';
import { espChecksum, sha256 } from '../binary/hash.js';
import { bytesToHex, decodeCString } from '../util/hex.js';
import { InvalidMagicError } from '../util/errors.js';

export const ESP_IMAGE_MAGIC = 0xe9;
export const APP_DESC_MAGIC = 0xabcd5432;
/** Offset of the app description structure within the first segment. */
export const APP_DESC_OFFSET = 0x20;

/** @type {Record<number, string>} */
const SPI_MODES = { 0: 'qio', 1: 'qout', 2: 'dio', 3: 'dout', 4: 'fastrd', 15: 'slowrd' };

/** @type {Record<number, string>} */
const FLASH_FREQ = { 0x0: '40m', 0x1: '26m', 0x2: '20m', 0xf: '80m' };

/** @type {Record<number, string>} */
const FLASH_SIZE = {
  0x0: '1MB',
  0x1: '2MB',
  0x2: '4MB',
  0x3: '8MB',
  0x4: '16MB',
  0x5: '32MB',
  0x6: '64MB',
  0x7: '128MB',
};

/**
 * IMAGE_CHIP_ID values, as used in the extended image header.
 * @type {Record<number, string>}
 */
export const IMAGE_CHIP_IDS = {
  0: 'ESP32',
  2: 'ESP32-S2',
  5: 'ESP32-C3',
  9: 'ESP32-S3',
  12: 'ESP32-C2',
  13: 'ESP32-C6',
  16: 'ESP32-H2',
  18: 'ESP32-P4',
  20: 'ESP32-C61',
  23: 'ESP32-C5',
};

/**
 * @typedef {import('./partition.js').Issue} Issue
 */

/**
 * @typedef {object} Segment
 * @property {number} index
 * @property {number} loadAddress
 * @property {number} length
 * @property {number} fileOffset  Offset of the segment payload within the image.
 */

/**
 * @typedef {object} AppDescription
 * @property {string} version
 * @property {string} projectName
 * @property {string} time
 * @property {string} date
 * @property {string} idfVersion
 * @property {string} elfSha256
 */

/**
 * @typedef {object} EspImage
 * @property {number} entryPoint
 * @property {number} segmentCount
 * @property {string} spiMode
 * @property {string} flashSize
 * @property {string} flashFreq
 * @property {number|null} chipId
 * @property {string} chipName
 * @property {number|null} minChipRev
 * @property {Segment[]} segments
 * @property {number} checksum
 * @property {boolean} checksumValid
 * @property {boolean} hashAppended
 * @property {string|null} sha256
 * @property {AppDescription|null} app
 * @property {number} imageLength  Bytes actually used by the image.
 * @property {Issue[]} issues
 */

/**
 * Parses an ESP firmware image header, segment table and trailer.
 *
 * SHA-256 verification is not performed here because it is asynchronous; use
 * {@link verifyImageHash} when the result matters.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.offset]
 * @returns {EspImage}
 * @throws {InvalidMagicError} If the image magic byte is absent.
 */
export function parseEspImage(data, { offset = 0 } = {}) {
  // An empty or absent buffer is "not an image", not "a truncated image".
  if (offset >= data.length) {
    throw new InvalidMagicError('ESP image', ESP_IMAGE_MAGIC, -1, offset);
  }

  const reader = new ByteReader(data, offset, 'ESP image');
  /** @type {Issue[]} */
  const issues = [];

  const magic = reader.u8();
  if (magic !== ESP_IMAGE_MAGIC) {
    throw new InvalidMagicError('ESP image', ESP_IMAGE_MAGIC, magic, offset);
  }

  const segmentCount = reader.u8();
  const spiModeRaw = reader.u8();
  const sizeFreq = reader.u8();
  const entryPoint = reader.u32();

  // Extended header. Present on all ESP32-family images; ESP8266 images stop
  // after the 8-byte common header, which we do not target.
  reader.skip(1); // WP pin
  reader.skip(3); // SPI pin drive settings
  const chipId = reader.u16();
  const minChipRev = reader.u8();
  reader.skip(2); // min_chip_rev_full
  reader.skip(2); // max_chip_rev_full
  reader.skip(4); // reserved
  const hashAppended = reader.u8() === 1;

  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    if (reader.remaining < 8) {
      issues.push({
        level: 'error',
        code: 'image.truncatedSegmentHeader',
        params: { index: i, declared: segmentCount },
      });
      break;
    }
    const loadAddress = reader.u32();
    const length = reader.u32();
    if (length > reader.remaining) {
      issues.push({
        level: 'error',
        code: 'image.truncatedSegment',
        params: { index: i, length, available: reader.remaining },
      });
      break;
    }
    segments.push({ index: i, loadAddress, length, fileOffset: reader.offset - offset });
    reader.skip(length);
  }

  // The checksum byte sits at the end of a 16-byte-aligned block, and is the
  // XOR of every segment payload seeded with 0xEF.
  const afterSegments = reader.offset - offset;
  const checksumOffset = (afterSegments + 16) & ~15; // next multiple of 16, minus 1 for the byte
  const checksumIndex = checksumOffset - 1;

  let checksum = 0;
  let checksumValid = false;
  if (offset + checksumIndex < data.length) {
    checksum = data[offset + checksumIndex];
    let computed = 0xef;
    for (const seg of segments) {
      computed = espChecksum(data.subarray(offset + seg.fileOffset, offset + seg.fileOffset + seg.length), computed);
    }
    checksumValid = computed === checksum;
    if (!checksumValid) {
      issues.push({
        level: 'error',
        code: 'image.checksumMismatch',
        params: { expected: checksum, actual: computed },
      });
    }
  } else {
    issues.push({ level: 'error', code: 'image.truncatedChecksum' });
  }

  let sha = null;
  let imageLength = checksumIndex + 1;
  if (hashAppended) {
    if (offset + imageLength + 32 <= data.length) {
      sha = bytesToHex(data.subarray(offset + imageLength, offset + imageLength + 32));
      imageLength += 32;
    } else {
      issues.push({ level: 'warning', code: 'image.truncatedHash' });
    }
  }

  const app = segments.length > 0 ? parseAppDescription(data, offset + segments[0].fileOffset) : null;

  return {
    entryPoint,
    segmentCount,
    spiMode: SPI_MODES[spiModeRaw] ?? 'unknown',
    flashSize: FLASH_SIZE[(sizeFreq >> 4) & 0xf] ?? 'unknown',
    flashFreq: FLASH_FREQ[sizeFreq & 0xf] ?? 'unknown',
    chipId,
    chipName: IMAGE_CHIP_IDS[chipId] ?? 'unknown',
    minChipRev,
    segments,
    checksum,
    checksumValid,
    hashAppended,
    sha256: sha,
    app,
    imageLength,
    issues,
  };
}

/**
 * Reads the esp_app_desc_t structure that IDF places at the start of the first
 * segment of an application image.
 *
 * @param {Uint8Array} data
 * @param {number} segmentStart
 * @returns {AppDescription|null} `null` when the magic does not match.
 */
export function parseAppDescription(data, segmentStart) {
  const start = segmentStart + APP_DESC_OFFSET;
  if (start + 256 > data.length) return null;

  const reader = new ByteReader(data, start, 'app description');
  if (reader.u32() !== APP_DESC_MAGIC) return null;

  const version = decodeCString(reader.bytes(32));
  const projectName = decodeCString(reader.bytes(32));
  const time = decodeCString(reader.bytes(16));
  const date = decodeCString(reader.bytes(16));
  const idfVersion = decodeCString(reader.bytes(32));
  const elfSha256 = bytesToHex(reader.bytes(32));

  return { version, projectName, time, date, idfVersion, elfSha256 };
}

/**
 * Verifies the appended SHA-256, if the image has one.
 *
 * @param {Uint8Array} data
 * @param {EspImage} image
 * @param {number} [offset]
 * @returns {Promise<boolean|null>} `null` when there is no hash, or when the
 *   platform provides no SHA-256 implementation.
 */
export async function verifyImageHash(data, image, offset = 0) {
  if (!image.hashAppended || image.sha256 === null) return null;
  const body = data.subarray(offset, offset + image.imageLength - 32);
  const digest = await sha256(body);
  if (digest === null) return null;
  return bytesToHex(digest) === image.sha256;
}

/**
 * Classifies a load address using the chip's memory map.
 *
 * @param {number} address
 * @param {Array<{start: number, end: number, name: string}>} memoryMap
 * @returns {string}
 */
export function memoryRegionFor(address, memoryMap) {
  for (const region of memoryMap) {
    if (address >= region.start && address < region.end) return region.name;
  }
  return 'unknown';
}
