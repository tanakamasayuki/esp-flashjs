// @ts-check
/**
 * Little-endian byte writer with a growable backing buffer.
 *
 * @module binary/writer
 */

import { encodeCString } from '../util/hex.js';

export class ByteWriter {
  /**
   * @param {number} [initialCapacity]
   */
  constructor(initialCapacity = 256) {
    /** @type {Uint8Array} */
    this.buffer = new Uint8Array(initialCapacity);
    /** @type {number} */
    this.length = 0;
    /** @type {DataView} */
    this.view = new DataView(this.buffer.buffer);
  }

  /**
   * Creates a writer over a fixed-size region pre-filled with `fill`.
   *
   * Useful for building flash structures, where the padding value is 0xFF
   * (erased flash) rather than zero.
   *
   * @param {number} size
   * @param {number} [fill]
   * @returns {ByteWriter}
   */
  static fixed(size, fill = 0xff) {
    const w = new ByteWriter(size);
    w.buffer.fill(fill);
    return w;
  }

  /** @param {number} extra */
  reserve(extra) {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length * 2 || 256;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer);
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  /**
   * Moves the cursor. Bytes skipped over keep whatever the buffer was
   * initialized with, which is how `ByteWriter.fixed()` produces 0xFF padding.
   *
   * @param {number} offset
   * @returns {this}
   */
  seek(offset) {
    this.reserve(Math.max(0, offset - this.length));
    this.length = offset;
    return this;
  }

  /** @param {number} value @returns {this} */
  u8(value) {
    this.reserve(1);
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  /** @param {number} value @returns {this} */
  u16(value) {
    this.reserve(2);
    this.view.setUint16(this.length, value & 0xffff, true);
    this.length += 2;
    return this;
  }

  /** @param {number} value @returns {this} */
  u32(value) {
    this.reserve(4);
    this.view.setUint32(this.length, value >>> 0, true);
    this.length += 4;
    return this;
  }

  /** @param {number} value @returns {this} */
  i32(value) {
    this.reserve(4);
    this.view.setInt32(this.length, value | 0, true);
    this.length += 4;
    return this;
  }

  /** @param {bigint} value @returns {this} */
  u64(value) {
    this.reserve(8);
    this.view.setBigUint64(this.length, BigInt.asUintN(64, value), true);
    this.length += 8;
    return this;
  }

  /** @param {bigint} value @returns {this} */
  i64(value) {
    this.reserve(8);
    this.view.setBigInt64(this.length, BigInt.asIntN(64, value), true);
    this.length += 8;
    return this;
  }

  /** @param {Uint8Array} data @returns {this} */
  bytes(data) {
    this.reserve(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
    return this;
  }

  /**
   * @param {string} text
   * @param {number} width
   * @returns {this}
   */
  cstring(text, width) {
    return this.bytes(encodeCString(text, width));
  }

  /**
   * @param {number} count
   * @param {number} [value]
   * @returns {this}
   */
  fill(count, value = 0) {
    this.reserve(count);
    this.buffer.fill(value, this.length, this.length + count);
    this.length += count;
    return this;
  }

  /**
   * Pads with `value` until the length is a multiple of `alignment`.
   * @param {number} alignment
   * @param {number} [value]
   * @returns {this}
   */
  align(alignment, value = 0) {
    const rem = this.length % alignment;
    if (rem !== 0) this.fill(alignment - rem, value);
    return this;
  }

  /**
   * Overwrites bytes already written, without moving the cursor.
   * @param {number} offset
   * @param {Uint8Array} data
   * @returns {this}
   */
  patch(offset, data) {
    this.buffer.set(data, offset);
    return this;
  }

  /**
   * @returns {Uint8Array} A copy of the written region.
   */
  toBytes() {
    return this.buffer.slice(0, this.length);
  }
}
