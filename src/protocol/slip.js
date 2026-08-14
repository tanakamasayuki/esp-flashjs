// @ts-check
/**
 * SLIP framing (RFC 1055) as used by the ESP serial bootloader.
 *
 * Frames are delimited by 0xC0. Inside a frame, 0xC0 becomes 0xDB 0xDC and
 * 0xDB becomes 0xDB 0xDD. Escaping happens after the checksum is computed.
 *
 * @module protocol/slip
 */

export const SLIP_END = 0xc0;
export const SLIP_ESC = 0xdb;
export const SLIP_ESC_END = 0xdc;
export const SLIP_ESC_ESC = 0xdd;

/**
 * Wraps a payload in a SLIP frame.
 *
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function slipEncode(payload) {
  // Worst case every byte needs escaping, plus the two delimiters.
  const out = new Uint8Array(payload.length * 2 + 2);
  let n = 0;
  out[n++] = SLIP_END;
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (b === SLIP_END) {
      out[n++] = SLIP_ESC;
      out[n++] = SLIP_ESC_END;
    } else if (b === SLIP_ESC) {
      out[n++] = SLIP_ESC;
      out[n++] = SLIP_ESC_ESC;
    } else {
      out[n++] = b;
    }
  }
  out[n++] = SLIP_END;
  return out.subarray(0, n);
}

/**
 * Removes SLIP escaping from a frame body.
 *
 * @param {Uint8Array} frame
 * @returns {Uint8Array}
 */
export function slipUnescape(frame) {
  const out = new Uint8Array(frame.length);
  let n = 0;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === SLIP_ESC && i + 1 < frame.length) {
      const next = frame[++i];
      if (next === SLIP_ESC_END) out[n++] = SLIP_END;
      else if (next === SLIP_ESC_ESC) out[n++] = SLIP_ESC;
      // An unrecognized escape sequence is dropped rather than passed through;
      // it can only come from corruption, and inventing a byte would be worse.
      continue;
    }
    out[n++] = frame[i];
  }
  return out.subarray(0, n);
}

/**
 * Incremental SLIP frame assembler.
 *
 * Serial reads have no relationship to frame boundaries: one read can contain
 * several frames, and one frame can span several reads. Feed everything that
 * arrives into `push()` and take whatever complete frames come back.
 */
export class SlipDecoder {
  /**
   * @param {object} [options]
   * @param {number} [options.maxFrameSize] Guards against a missing delimiter
   *   growing the buffer without bound.
   */
  constructor({ maxFrameSize = 64 * 1024 } = {}) {
    /** @type {number[]} */
    this.buffer = [];
    /** @type {boolean} */
    this.inFrame = false;
    /** @type {number} */
    this.maxFrameSize = maxFrameSize;
    /** @type {number} */
    this.discarded = 0;
  }

  /**
   * Feeds received bytes in and returns any frames that completed.
   *
   * @param {Uint8Array} chunk
   * @returns {Uint8Array[]} Unescaped frame bodies, in arrival order.
   */
  push(chunk) {
    /** @type {Uint8Array[]} */
    const frames = [];

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      if (b === SLIP_END) {
        if (this.inFrame) {
          if (this.buffer.length > 0) {
            frames.push(slipUnescape(Uint8Array.from(this.buffer)));
            this.buffer.length = 0;
            this.inFrame = false;
          }
          // An empty frame means back-to-back delimiters; treat the second
          // 0xC0 as the start of the next frame rather than a zero-length one.
        } else {
          this.inFrame = true;
          this.buffer.length = 0;
        }
        continue;
      }

      if (!this.inFrame) {
        // Bytes outside a frame are boot log noise from the device.
        this.discarded++;
        continue;
      }

      this.buffer.push(b);
      if (this.buffer.length > this.maxFrameSize) {
        this.buffer.length = 0;
        this.inFrame = false;
      }
    }

    return frames;
  }

  /** Drops any partially received frame. */
  reset() {
    this.buffer.length = 0;
    this.inFrame = false;
    this.discarded = 0;
  }
}
