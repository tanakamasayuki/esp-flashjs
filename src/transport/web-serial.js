// @ts-check
/**
 * Web Serial transport.
 *
 * This is the only module in `src/` that touches a browser global. Everything
 * else stays runnable under Node.js and in workers.
 *
 * @module transport/web-serial
 */

import { TransportClosedError, TransportTimeoutError } from '../util/errors.js';
import { OperationAbortedError } from '../util/errors.js';
import { delay } from './transport.js';

/**
 * @typedef {import('./transport.js').Transport} Transport
 * @typedef {import('./transport.js').ReadOptions} ReadOptions
 */

/**
 * Espressif Systems' USB vendor id. Ports enumerating under it are the chip
 * speaking USB directly (USB-Serial/JTAG on C3/S3/C6/H2/P4, USB CDC on S2/S3);
 * a separate bridge chip always enumerates under its own maker's id.
 */
export const ESPRESSIF_USB_VENDOR_ID = 0x303a;

/**
 * @implements {Transport}
 */
export class WebSerialTransport {
  /**
   * @param {SerialPort} port
   * @param {object} [options]
   * @param {number} [options.baudRate]
   * @param {number} [options.bufferSize]
   */
  constructor(port, { baudRate = 115200, bufferSize = 16 * 1024 } = {}) {
    /** @type {SerialPort} */
    this.port = port;
    /** @type {number} */
    this.baudRate = baudRate;
    /** @type {number} */
    this.bufferSize = bufferSize;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    this.reader = null;
    /** @type {WritableStreamDefaultWriter<Uint8Array>|null} */
    this.writer = null;
    /** @type {boolean} */
    this.opened = false;
    /**
     * Bytes read from the port but not yet consumed. A single serial read can
     * span several SLIP frames, and a frame can arrive split across reads.
     * @type {Uint8Array}
     */
    this.pending = new Uint8Array(0);
    /**
     * Callbacks waiting for `pending` to become non-empty.
     * @type {Array<() => void>}
     */
    this.waiters = [];
    /** @type {Promise<void>|null} The background read loop. */
    this.pump = null;
    /** @type {boolean} Set once the stream ends. */
    this.streamClosed = false;
    /** @type {unknown} An error raised by the stream, delivered to the next read. */
    this.streamError = null;
  }

  /**
   * Returns true when the current context can use Web Serial at all.
   *
   * Web Serial requires a secure context, so this is false on plain HTTP
   * origins other than localhost, and on browsers that do not implement it.
   *
   * @returns {boolean}
   */
  static isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /**
   * Prompts the user to pick a port.
   *
   * Must be called from within a user gesture; the browser rejects it
   * otherwise. Opening is deliberately a separate step.
   *
   * @param {object} [options]
   * @param {SerialPortFilter[]} [options.filters]
   * @param {number} [options.baudRate]
   * @returns {Promise<WebSerialTransport>}
   */
  static async request({ filters, baudRate } = {}) {
    if (!WebSerialTransport.isSupported()) {
      throw new Error('Web Serial is not available in this browser.');
    }
    const port = await navigator.serial.requestPort(filters ? { filters } : undefined);
    return new WebSerialTransport(port, baudRate === undefined ? {} : { baudRate });
  }

  /**
   * Lists ports the user has already granted access to.
   * @returns {Promise<WebSerialTransport[]>}
   */
  static async list() {
    if (!WebSerialTransport.isSupported()) return [];
    const ports = await navigator.serial.getPorts();
    return ports.map((p) => new WebSerialTransport(p));
  }

  /** @returns {string} */
  /**
   * Whether the port is the chip's own USB peripheral rather than a bridge.
   *
   * On a USB-Serial/JTAG or USB CDC port there is no UART between host and
   * chip, so the line rate is nominal: setting it changes nothing about how
   * fast bytes move, and going through with a change means closing and
   * reopening the port for no gain. Espressif's vendor id is enough to tell —
   * every one of these ports enumerates under it, whereas a CP210x, CH340 or
   * FTDI bridge enumerates under its own maker's.
   *
   * @returns {boolean}
   */
  get isNativeUsb() {
    return this.port.getInfo?.()?.usbVendorId === ESPRESSIF_USB_VENDOR_ID;
  }

  get description() {
    const info = this.port.getInfo?.();
    if (info?.usbVendorId !== undefined) {
      const vid = info.usbVendorId.toString(16).padStart(4, '0');
      const pid = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
      return `USB ${vid}:${pid} @ ${this.baudRate}`;
    }
    return `Serial port @ ${this.baudRate}`;
  }

  /** @returns {boolean} */
  isOpen() {
    return this.opened;
  }

  /** @returns {Promise<void>} */
  async open() {
    if (this.opened) return;
    await this.port.open({ baudRate: this.baudRate, bufferSize: this.bufferSize });
    this.reader = this.port.readable?.getReader() ?? null;
    this.writer = this.port.writable?.getWriter() ?? null;
    if (!this.reader || !this.writer) {
      await this.port.close();
      throw new Error('Serial port opened without readable/writable streams.');
    }
    this.opened = true;
    this.pending = new Uint8Array(0);
    this.waiters = [];
    this.streamClosed = false;
    this.streamError = null;
    this.pump = this.readLoop();
  }

  /**
   * Drains the port into `pending` for as long as it is open.
   *
   * Reading has to run continuously rather than once per `read()` call. A
   * `reader.read()` raced against a timeout stays in flight when the timeout
   * wins, and then swallows the next chunk to arrive — which is exactly the
   * situation the SYNC retry loop creates, with a 100 ms timeout on a device
   * that has not answered yet. Nothing may abandon a read.
   *
   * @returns {Promise<void>}
   */
  async readLoop() {
    const reader = this.reader;
    if (!reader) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          this.append(value);
          this.wake();
        }
      }
    } catch (error) {
      // Unplugging the cable lands here. Hand it to whoever reads next.
      this.streamError = error;
    } finally {
      this.streamClosed = true;
      this.wake();
    }
  }

  /**
   * @param {Uint8Array} chunk
   */
  append(chunk) {
    if (this.pending.length === 0) {
      this.pending = chunk;
      return;
    }
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    this.pending = merged;
  }

  /** Releases everyone waiting on new data. */
  wake() {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /** @returns {Promise<void>} */
  async close() {
    if (!this.opened) return;
    this.opened = false;
    this.streamClosed = true;
    this.wake();
    try {
      await this.reader?.cancel();
    } catch {
      // Cancelling a reader that is already errored is not actionable.
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* already released */
    }
    try {
      await this.writer?.close();
    } catch {
      /* stream may already be closed */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    await this.port.close();
  }

  /**
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(data) {
    if (!this.opened || !this.writer) throw new TransportClosedError();
    await this.writer.write(data);
  }

  /**
   * Returns whatever the pump has buffered, waiting up to `timeoutMs` for it.
   *
   * @param {ReadOptions} [options]
   * @returns {Promise<Uint8Array>}
   */
  async read({ timeoutMs = 3000, signal } = {}) {
    if (!this.opened) throw new TransportClosedError();

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const out = this.pending;
        this.pending = new Uint8Array(0);
        return out;
      }
      if (this.streamError !== null) {
        const error = this.streamError;
        this.streamError = null;
        throw error;
      }
      if (this.streamClosed) throw new TransportClosedError();

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      // Times out without disturbing the pump, so a late chunk still lands in
      // `pending` and reaches the next caller.
      await this.waitForData(remaining, timeoutMs, signal);
    }
  }

  /**
   * Resolves when the pump reports new data, or rejects on timeout or abort.
   *
   * @param {number} remainingMs
   * @param {number} timeoutMs Reported in the error, for a readable message.
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  waitForData(remainingMs, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new OperationAbortedError('reading'));
        return;
      }

      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      /** @type {(() => void)|undefined} */
      let onAbort;

      const waiter = () => finish();

      /** @param {unknown} [error] */
      const finish = (error) => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        if (error) reject(error);
        else resolve();
      };

      this.waiters.push(waiter);
      timer = setTimeout(() => finish(new TransportTimeoutError(timeoutMs)), remainingMs);
      if (signal) {
        onAbort = () => finish(new OperationAbortedError('reading'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Pushes bytes back so the next `read()` returns them first.
   * @param {Uint8Array} data
   */
  unread(data) {
    if (data.length === 0) return;
    const merged = new Uint8Array(data.length + this.pending.length);
    merged.set(data);
    merged.set(this.pending, data.length);
    this.pending = merged;
  }

  /**
   * Changes the line rate by reopening the port.
   *
   * Web Serial offers no way to alter the baud rate of an open port, so the
   * port is closed and reopened. Callers must have already told the device to
   * switch, and must allow it time to do so.
   *
   * @param {number} baudRate
   * @returns {Promise<void>}
   */
  async setBaudRate(baudRate) {
    if (baudRate === this.baudRate && this.opened) return;
    const wasOpen = this.opened;
    if (wasOpen) await this.close();
    this.baudRate = baudRate;
    if (wasOpen) {
      // The device needs a moment to reconfigure its own UART before it will
      // understand anything sent at the new rate.
      await delay(50);
      await this.open();
    }
  }

  /**
   * Drives the DTR and RTS lines, which the reset sequences use to pull EN and
   * IO0 on the board.
   *
   * The Transport interface speaks in `dtr`/`rts` because that is what the
   * hardware documentation calls them; Web Serial spells them out, so translate
   * here rather than leaking the browser's naming into the protocol layer.
   *
   * @param {{dtr?: boolean, rts?: boolean}} signals
   * @returns {Promise<void>}
   */
  async setSignals({ dtr, rts }) {
    if (!this.opened) throw new TransportClosedError();
    /** @type {SerialOutputSignals} */
    const out = {};
    if (dtr !== undefined) out.dataTerminalReady = dtr;
    if (rts !== undefined) out.requestToSend = rts;
    await this.port.setSignals(out);
  }

  /** @returns {Promise<void>} */
  async flushInput() {
    this.pending = new Uint8Array(0);
    // Give the pump a turn to hand over anything the OS had already buffered,
    // then drop that too.
    await delay(20);
    this.pending = new Uint8Array(0);
  }
}
