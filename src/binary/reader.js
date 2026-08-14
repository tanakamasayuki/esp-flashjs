// @ts-check
/**
 * Little-endian byte reader.
 *
 * Every on-flash structure Espressif defines is little-endian, so LE is the
 * default rather than an option.
 *
 * @module binary/reader
 */

import { TruncatedDataError } from '../util/errors.js';
import { decodeCString } from '../util/hex.js';

export class ByteReader {
  /**
   * @param {Uint8Array} data
   * @param {number} [offset] Starting position.
   * @param {string} [context] Format name, used in truncation errors.
   */
  constructor(data, offset = 0, context = 'data') {
    /** @type {Uint8Array} */
    this.data = data;
    /** @type {number} */
    this.offset = offset;
    /** @type {string} */
    this.context = context;
    /** @type {DataView} */
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Bytes remaining after the cursor. @returns {number} */
  get remaining() {
    return this.data.length - this.offset;
  }

  /** @returns {boolean} */
  get atEnd() {
    return this.offset >= this.data.length;
  }

  /**
   * @param {number} count
   * @throws {TruncatedDataError}
   */
  require(count) {
    if (this.remaining < count) {
      throw new TruncatedDataError(this.context, this.offset + count, this.data.length);
    }
  }

  /**
   * @param {number} offset
   * @returns {this}
   */
  seek(offset) {
    this.offset = offset;
    return this;
  }

  /**
   * @param {number} count
   * @returns {this}
   */
  skip(count) {
    this.offset += count;
    return this;
  }

  /** @returns {number} */
  u8() {
    this.require(1);
    return this.data[this.offset++];
  }

  /** @returns {number} */
  i8() {
    this.require(1);
    return this.view.getInt8(this.offset++);
  }

  /** @returns {number} */
  u16() {
    this.require(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  /** @returns {number} */
  i16() {
    this.require(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  /** @returns {number} */
  u32() {
    this.require(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  /** @returns {number} */
  i32() {
    this.require(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  /** @returns {bigint} */
  u64() {
    this.require(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** @returns {bigint} */
  i64() {
    this.require(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /**
   * Returns a **view** into the underlying buffer, not a copy. Callers that
   * retain the result must copy it if the source may be reused.
   *
   * @param {number} count
   * @returns {Uint8Array}
   */
  bytes(count) {
    this.require(count);
    const out = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /**
   * @param {number} count
   * @returns {Uint8Array}
   */
  copy(count) {
    return new Uint8Array(this.bytes(count));
  }

  /**
   * Reads a fixed-width NUL-terminated ASCII field.
   * @param {number} width
   * @returns {string}
   */
  cstring(width) {
    return decodeCString(this.bytes(width));
  }

  /**
   * Reads without advancing the cursor.
   * @param {number} count
   * @param {number} [at] Absolute offset. Defaults to the cursor.
   * @returns {Uint8Array}
   */
  peek(count, at = this.offset) {
    return this.data.subarray(at, at + count);
  }
}
