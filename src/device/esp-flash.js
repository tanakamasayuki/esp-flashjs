// @ts-check
/**
 * Flash read, write, erase and verify.
 *
 * @module device/esp-flash
 */

import { CMD, flashBeginPayload, flashDataPayload, flashEndPayload, eraseRegionPayload, readFlashPayload, spiFlashMd5Payload } from '../protocol/commands.js';
import { md5Hex } from '../binary/hash.js';
import { isUniform } from '../binary/diff.js';
import { slipEncode } from '../protocol/slip.js';
import { bytesToHex } from '../util/hex.js';
import { createProgressReporter } from '../util/events.js';
import {
  AlignmentError,
  ChecksumError,
  OutOfRangeError,
  UnsupportedOperationError,
  throwIfAborted,
  OperationAbortedError,
} from '../util/errors.js';
import { readDeviceInfo } from './device-info.js';

/**
 * @typedef {import('../protocol/loader.js').EspLoader} EspLoader
 * @typedef {import('../util/events.js').ProgressCallback} ProgressCallback
 * @typedef {import('./device-info.js').DeviceInfo} DeviceInfo
 */

export const FLASH_SECTOR_SIZE = 0x1000;
/** Block size used for stub reads. Larger blocks mean fewer round trips. */
export const READ_BLOCK_SIZE = 0x1000;

/**
 * How much a single READ_FLASH transfer covers.
 *
 * A transfer is all-or-nothing: the stub sends one MD5 for the whole range, so
 * a single lost byte discards everything read so far. Over a link that drops
 * bytes at all, a multi-megabyte read therefore never completes however often
 * it is retried, while a quarter-megabyte one succeeds routinely. Splitting the
 * range makes progress survive a hiccup instead of restarting from zero.
 */
export const READ_CHUNK_SIZE = 0x40000;

/** Attempts per chunk before a read is reported as failed. */
export const READ_ATTEMPTS = 3;

/**
 * @typedef {object} OperationOptions
 * @property {ProgressCallback} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {number} [chunkSize] Bytes per READ_FLASH transfer.
 * @property {number} [attempts] Tries per chunk before the read fails.
 */

export class EspFlash {
  /**
   * @param {EspLoader} loader
   */
  constructor(loader) {
    /** @type {EspLoader} */
    this.loader = loader;
    /** @type {number|null} */
    this.flashSize = null;
    /** @type {DeviceInfo|null} */
    this.info = null;
  }

  /**
   * Reads chip identity and flash geometry.
   *
   * @param {object} [options]
   * @param {boolean} [options.refresh]
   * @returns {Promise<DeviceInfo>}
   */
  async getInfo({ refresh = false } = {}) {
    if (this.info && !refresh) return this.info;
    this.info = await readDeviceInfo(this.loader);
    this.flashSize = this.info.flashSize;
    return this.info;
  }

  /**
   * Reads a range of flash.
   *
   * @param {number} address
   * @param {number} size
   * @param {OperationOptions} [options]
   * @returns {Promise<Uint8Array>}
   * @throws {UnsupportedOperationError} Without the stub loaded.
   */
  async read(
    address,
    size,
    { onProgress, signal, chunkSize = READ_CHUNK_SIZE, attempts = READ_ATTEMPTS } = {},
  ) {
    if (!this.loader.isStub) throw UnsupportedOperationError.requiresStub('Flash read');
    this.checkRange(address, size);
    if (size === 0) return new Uint8Array(0);

    const progress = createProgressReporter(onProgress, 'reading', size);
    const out = new Uint8Array(size);
    let done = 0;

    while (done < size) {
      const length = Math.min(chunkSize, size - done);
      let failure;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        throwIfAborted(signal, 'reading');
        try {
          await this.readChunk(address + done, out.subarray(done, done + length), {
            signal,
            onBytes: (n) => progress.report(done + n),
          });
          failure = undefined;
          break;
        } catch (error) {
          if (error instanceof OperationAbortedError) throw error;
          failure = error;
          // The stub is very likely still streaming the remainder of the
          // transfer it just failed. Those bytes would be decoded as the reply
          // to the retry, so drop them before asking again.
          await this.loader.resync({ settleMs: 100 });
          this.loader.log('warn', 'flash.readRetry', {
            address: address + done,
            attempt,
            attempts,
            message: /** @type {Error} */ (error).message,
          });
        }
      }
      if (failure) throw failure;
      done += length;
    }

    progress.finish();
    return out;
  }

  /**
   * One READ_FLASH transfer, verified end to end by the stub's own MD5.
   *
   * @param {number} address
   * @param {Uint8Array} out Exactly the range to fill.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(bytes: number) => void} [options.onBytes]
   * @returns {Promise<void>}
   */
  async readChunk(address, out, { signal, onBytes } = {}) {
    const size = out.length;
    let received = 0;

    // READ_FLASH streams the data back as a series of unsolicited SLIP frames.
    // After each one the host sends the running byte total as an acknowledgement,
    // which is how the stub paces itself.
    await this.loader.command(
      CMD.READ_FLASH,
      readFlashPayload(address, size, READ_BLOCK_SIZE, 64),
      { signal, timeoutMs: 10000 },
    );

    while (received < size) {
      throwIfAborted(signal, 'reading');
      const frame = await this.loader.readFrame({ timeoutMs: 10000, signal });

      // Only the final frame may be short. A short one in the middle means the
      // stream lost bytes, and continuing would return silently wrong data.
      if (frame.length < READ_BLOCK_SIZE && received + frame.length < size) {
        throw new ChecksumError(
          'flash read',
          `${READ_BLOCK_SIZE} bytes`,
          `${frame.length} bytes at offset ${received}`,
        );
      }

      const take = Math.min(frame.length, size - received);
      out.set(frame.subarray(0, take), received);
      received += take;
      onBytes?.(received);

      // The acknowledgement is itself a SLIP frame — sending the four raw bytes
      // leaves the stub waiting forever, which stalls the transfer.
      const ack = new Uint8Array(4);
      new DataView(ack.buffer).setUint32(0, received, true);
      await this.loader.transport.write(slipEncode(ack));
    }

    const digestFrame = await this.loader.readFrame({ timeoutMs: 10000, signal });
    if (digestFrame.length !== 16) {
      throw new ChecksumError('flash read', '16-byte digest', `${digestFrame.length} bytes`);
    }
    const expected = bytesToHex(digestFrame);
    const actual = md5Hex(out);
    if (expected !== actual) {
      // Returning data the device says is not what it sent would be the worst
      // possible outcome for a tool people trust with firmware.
      throw new ChecksumError('flash read', expected, actual);
    }
  }

  /**
   * Reads the head of each partition to classify what is in it.
   *
   * Answers "is this partition actually used?" up front, which otherwise takes
   * a read per partition and a look at a hex dump. Only the first sector is
   * fetched, so the cost stays at a few KB per partition.
   *
   * @param {import('../format/partition.js').Partition[]} partitions
   * @param {OperationOptions & {probeBytes?: number}} [options]
   * @returns {Promise<Map<string, 'erased'|'zeroed'|'data'|'unreadable'>>} Keyed by label.
   */
  async probePartitions(partitions, { probeBytes = FLASH_SECTOR_SIZE, onProgress, signal } = {}) {
    /** @type {Map<string, 'erased'|'zeroed'|'data'|'unreadable'>} */
    const states = new Map();
    if (!this.loader.isStub) return states;

    const progress = createProgressReporter(onProgress, 'reading', partitions.length);
    for (const [index, p] of partitions.entries()) {
      throwIfAborted(signal, 'reading');
      try {
        const head = await this.read(p.offset, Math.min(probeBytes, p.size), { signal });
        states.set(p.label, classifyRegion(head));
      } catch (error) {
        if (/** @type {Error & {code?: string}} */ (error).code === 'ABORTED') throw error;
        // One unreadable partition must not abandon the rest of the sweep.
        states.set(p.label, 'unreadable');
      }
      progress.report(index + 1);
    }
    progress.finish();
    return states;
  }

  /**
   * Writes data to flash.
   *
   * @param {number} address
   * @param {Uint8Array} data
   * @param {OperationOptions & {compress?: boolean, verify?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async write(address, data, { onProgress, signal, compress = true, verify = false } = {}) {
    AlignmentError.check('Write address', address, 4);
    this.checkRange(address, data.length);
    if (data.length === 0) return;

    const chip = this.loader.requireChip();
    await this.loader.attachSpiFlash();

    const useCompression = compress && (await canCompress());
    const payload = useCompression ? await deflate(data) : data;
    const blockSize = chip.flashWriteSize;
    const blocks = Math.ceil(payload.length / blockSize);
    const progress = createProgressReporter(onProgress, 'writing', data.length);

    const beginCmd = useCompression ? CMD.FLASH_DEFL_BEGIN : CMD.FLASH_BEGIN;
    const dataCmd = useCompression ? CMD.FLASH_DEFL_DATA : CMD.FLASH_DATA;
    const endCmd = useCompression ? CMD.FLASH_DEFL_END : CMD.FLASH_END;

    // Erasing is implied by FLASH_BEGIN, and on the ROM loader it happens
    // synchronously before the reply, so allow a generous timeout.
    await this.loader.command(
      beginCmd,
      flashBeginPayload({
        // For the compressed form the ROM wants the *uncompressed* size when
        // running the stub, but the erase size when running from ROM.
        size: useCompression && !this.loader.isStub ? eraseSizeFor(address, data.length) : data.length,
        blocks,
        blockSize,
        offset: address,
      }),
      { signal, timeoutMs: 60000 },
    );

    for (let i = 0; i < blocks; i++) {
      throwIfAborted(signal, 'writing');
      const chunk = payload.subarray(i * blockSize, (i + 1) * blockSize);
      await this.loader.command(dataCmd, flashDataPayload(chunk, i), {
        signal,
        timeoutMs: 15000,
      });
      // Report against the uncompressed length so the bar tracks real work.
      progress.report(Math.min(data.length, Math.round(((i + 1) / blocks) * data.length)));
    }

    await this.loader.command(endCmd, flashEndPayload(false), { signal, timeoutMs: 10000 });
    progress.finish();

    if (verify) {
      const result = await this.verify(address, data);
      if (!result.ok) {
        throw new UnsupportedOperationError(
          'VERIFY_FAILED',
          `Verification failed after writing ${data.length} bytes at 0x${address.toString(16)}.`,
          result,
        );
      }
    }
  }

  /**
   * Erases a sector-aligned region.
   *
   * @param {number} address
   * @param {number} size
   * @param {OperationOptions} [options]
   * @returns {Promise<void>}
   * @throws {UnsupportedOperationError} Without the stub loaded.
   */
  async eraseRegion(address, size, { signal } = {}) {
    if (!this.loader.isStub) throw UnsupportedOperationError.requiresStub('Erase region');
    AlignmentError.check('Erase address', address, FLASH_SECTOR_SIZE);
    AlignmentError.check('Erase size', size, FLASH_SECTOR_SIZE);
    this.checkRange(address, size);
    if (size === 0) return;

    await this.loader.attachSpiFlash();
    await this.loader.command(CMD.ERASE_REGION, eraseRegionPayload(address, size), {
      signal,
      // Erasing several megabytes is slow, and the reply only comes at the end.
      timeoutMs: Math.max(30000, (size / FLASH_SECTOR_SIZE) * 100),
    });
  }

  /**
   * Erases the entire flash chip.
   *
   * @param {OperationOptions} [options]
   * @returns {Promise<void>}
   */
  async eraseAll({ signal } = {}) {
    if (!this.loader.isStub) throw UnsupportedOperationError.requiresStub('Chip erase');
    await this.loader.attachSpiFlash();
    await this.loader.command(CMD.ERASE_FLASH, new Uint8Array(0), { signal, timeoutMs: 120000 });
  }

  /**
   * Compares a region against the given data using the device's own MD5.
   *
   * @param {number} address
   * @param {Uint8Array} data
   * @param {OperationOptions} [options]
   * @returns {Promise<{ok: boolean, expected: string, actual: string}>}
   */
  async verify(address, data, { signal } = {}) {
    this.checkRange(address, data.length);
    await this.loader.attachSpiFlash();

    // The ROM loader returns the digest as 32 hex characters; the stub returns
    // 16 raw bytes. The status bytes sit immediately after, so the expected
    // length has to be declared up front.
    const digestLength = this.loader.isStub ? 16 : 32;
    const response = await this.loader.command(
      CMD.SPI_FLASH_MD5,
      spiFlashMd5Payload(address, data.length),
      {
        signal,
        timeoutMs: Math.max(10000, data.length / 1024),
        responseDataLength: (bodyLength) => (bodyLength >= 34 ? 32 : digestLength),
      },
    );

    const actual = response.data.length === 32
      ? new TextDecoder().decode(response.data)
      : bytesToHex(response.data.subarray(0, 16));
    const expected = md5Hex(data);

    return { ok: actual === expected, expected, actual };
  }

  /**
   * Reads the whole flash chip.
   *
   * @param {OperationOptions & {size?: number}} [options]
   * @returns {Promise<Uint8Array>}
   */
  async dump({ size, onProgress, signal } = {}) {
    const total = size ?? this.flashSize ?? (await this.getInfo()).flashSize;
    if (total === null) {
      throw new UnsupportedOperationError(
        'UNKNOWN_FLASH_SIZE',
        'Flash size could not be detected; pass an explicit size to dump().',
      );
    }
    return this.read(0, total, { onProgress, signal });
  }

  /**
   * @param {number} address
   * @param {number} size
   * @throws {OutOfRangeError}
   */
  checkRange(address, size) {
    if (address < 0 || size < 0) {
      throw new OutOfRangeError(address, size, this.flashSize ?? 0);
    }
    if (this.flashSize !== null && address + size > this.flashSize) {
      throw new OutOfRangeError(address, size, this.flashSize);
    }
  }
}

/**
 * Classifies a region by its contents.
 *
 * Erased flash is all 0xFF; a region that has been written and then zeroed is
 * all 0x00. Either way there is nothing to parse, and saying so beats letting
 * someone hunt through a hex dump of padding.
 *
 * @param {Uint8Array} data
 * @returns {'erased'|'zeroed'|'data'}
 */
function classifyRegion(data) {
  if (isUniform(data, 0xff)) return 'erased';
  if (isUniform(data, 0x00)) return 'zeroed';
  return 'data';
}

/**
 * Rounds a write up to whole sectors, which is what the ROM loader erases.
 * @param {number} address
 * @param {number} length
 * @returns {number}
 */
function eraseSizeFor(address, length) {
  const start = Math.floor(address / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
  const end = Math.ceil((address + length) / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
  return end - start;
}

/**
 * @returns {Promise<boolean>}
 */
async function canCompress() {
  return typeof globalThis.CompressionStream === 'function';
}

/**
 * Deflates data using the platform's CompressionStream, keeping the runtime
 * dependency count at zero.
 *
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function deflate(data) {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // Copy into a buffer this function owns: `data` may be a view into a larger
  // array, and the stream reads it asynchronously.
  void writer.write(/** @type {BufferSource} */ (/** @type {unknown} */ (data.slice())));
  void writer.close();

  /** @type {Uint8Array[]} */
  const chunks = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
