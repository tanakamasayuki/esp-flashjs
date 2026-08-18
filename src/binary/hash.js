// @ts-check
/**
 * Checksums and hashes.
 *
 * MD5 is implemented here rather than delegated because `crypto.subtle` does
 * not offer it, and the device's `SPI_FLASH_MD5` command makes it the only way
 * to verify a write without reading the region back.
 *
 * @module binary/hash
 */

import { bytesToHex } from '../util/hex.js';

/* -------------------------------------------------------------------------- */
/* CRC-32 (IEEE 802.3, reflected, as used by NVS)                              */
/* -------------------------------------------------------------------------- */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Uint8Array} data
 * @param {number} [seed] Initial value, already inverted. Defaults to 0xFFFFFFFF.
 * @returns {number} Unsigned 32-bit CRC.
 */
export function crc32(data, seed = 0xffffffff) {
  let crc = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * CRC-32 in the convention ESP-IDF's `esp_rom_crc32_le` uses.
 *
 * That function inverts its first argument before starting and inverts the
 * result on the way out, so the argument is the *bitwise inverse of the
 * initial value*, not the initial value:
 *
 * ```c
 * crc = ~crc;
 * for (...) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >> 8);
 * return ~crc;
 * ```
 *
 * `espCrc32Le(0, data)` therefore equals the standard CRC-32 above, while
 * `espCrc32Le(0xFFFFFFFF, data)` — what IDF passes for otadata and NVS — starts
 * the loop at zero and produces a different value. Using {@link crc32} for
 * those structures rejects perfectly valid data.
 *
 * @param {number} seed Bitwise inverse of the initial value; IDF passes 0xFFFFFFFF.
 * @param {Uint8Array} data
 * @returns {number} Unsigned 32-bit CRC.
 */
export function espCrc32Le(seed, data) {
  let crc = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/* -------------------------------------------------------------------------- */
/* XOR checksum (ESP image segments)                                           */
/* -------------------------------------------------------------------------- */

export const ESP_CHECKSUM_MAGIC = 0xef;

/**
 * @param {Uint8Array} data
 * @param {number} [seed]
 * @returns {number} A single byte.
 */
export function espChecksum(data, seed = ESP_CHECKSUM_MAGIC) {
  let sum = seed;
  for (let i = 0; i < data.length; i++) sum ^= data[i];
  return sum & 0xff;
}

/* -------------------------------------------------------------------------- */
/* MD5                                                                         */
/* -------------------------------------------------------------------------- */

const MD5_S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return k;
})();

/**
 * Computes the MD5 digest of a byte array.
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array} 16 bytes.
 */
export function md5(data) {
  const bitLength = data.length * 8;
  // Message + 0x80 + zero padding to 56 mod 64 + 8-byte length.
  const paddedLength = ((data.length + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(paddedLength);
  buf.set(data);
  buf[data.length] = 0x80;

  const view = new DataView(buf.buffer);
  // Length is 64-bit little-endian; lengths above 2^32 bits are not reachable
  // here because inputs are bounded by flash size.
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0;
      b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {string} 32 lowercase hex characters.
 */
export function md5Hex(data) {
  return bytesToHex(md5(data));
}

/* -------------------------------------------------------------------------- */
/* SHA-256                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Computes SHA-256 using the platform's WebCrypto.
 *
 * Returns `null` where WebCrypto is unavailable rather than falling back to a
 * hand-rolled implementation: a caller that cannot verify an image hash must
 * know that, not be handed a value of unclear provenance.
 *
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array|null>}
 */
export async function sha256(data) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') return null;
  // Copy into a standalone buffer; `data` may be a view into a larger array.
  const copy = new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
}
