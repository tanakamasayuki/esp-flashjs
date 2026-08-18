// @ts-check
/**
 * A Transport backed by tools/serial-bridge.py.
 *
 * Node has no serial API and this project must not ship a native dependency,
 * so a small Python process owns the port and this speaks to it over stdio.
 * It exists to drive the library against real hardware; nothing in `src/`
 * depends on it.
 *
 * The shape is the one docs/transports.md prescribes, background pump
 * included: bytes are collected as they arrive, so a read that times out
 * stops the waiter rather than abandoning data in flight.
 */

import { spawn } from 'node:child_process';

const BRIDGE = new URL('./serial-bridge.py', import.meta.url).pathname;

/**
 * A transport backed by the Python bridge.
 *
 * Shaped exactly as docs/transports.md describes, including the background
 * pump: bytes are collected as they arrive rather than being read on demand,
 * so a timeout stops the waiter and never abandons data in flight.
 */
export class BridgeTransport {
  /**
   * @param {string} path
   * @param {number} [baudRate]
   */
  constructor(path, baudRate = 115200) {
    this.path = path;
    this.baudRate = baudRate;
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
    this.child = null;
    this.pending = /** @type {Uint8Array[]} */ ([]);
    this.waiters = /** @type {Array<() => void>} */ ([]);
    this.closed = false;
  }

  get description() {
    return `${this.path} @ ${this.baudRate}`;
  }

  isOpen() {
    return this.child !== null && !this.closed;
  }

  async open() {
    const child = spawn('python3', [BRIDGE, this.path, String(this.baudRate)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = /** @type {any} */ (child);
    this.closed = false;

    child.stdout.on('data', (buf) => {
      this.pending.push(new Uint8Array(buf));
      for (const wake of this.waiters.splice(0)) wake();
    });
    child.on('exit', () => {
      this.closed = true;
      for (const wake of this.waiters.splice(0)) wake();
    });

    // The bridge prints its banner to stderr once the port is open; a short
    // settle avoids racing the first write against that.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async close() {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.closed = true;
  }

  /** @param {Uint8Array} data */
  async write(data) {
    const header = Buffer.alloc(5);
    header.write('W', 0, 'ascii');
    header.writeUInt32LE(data.length, 1);
    this.child?.stdin.write(Buffer.concat([header, Buffer.from(data)]));
  }

  /** @param {{timeoutMs?: number, signal?: AbortSignal}} [options] */
  async read({ timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const total = this.pending.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of this.pending.splice(0)) {
          out.set(chunk, at);
          at += chunk.length;
        }
        return out;
      }
      if (this.closed) throw new Error('bridge closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`read timed out after ${timeoutMs}ms`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
  }

  /** @param {{dtr?: boolean, rts?: boolean}} signals */
  async setSignals({ dtr, rts }) {
    const flags = (dtr ? 1 : 0) | (rts ? 2 : 0);
    this.child?.stdin.write(Buffer.from([0x53, flags]));
  }

  /** @param {number} baudRate */
  async setBaudRate(baudRate) {
    this.baudRate = baudRate;
    const header = Buffer.alloc(5);
    header.write('B', 0, 'ascii');
    header.writeUInt32LE(baudRate, 1);
    this.child?.stdin.write(header);
  }

  async flushInput() {
    this.pending.length = 0;
    this.child?.stdin.write(Buffer.from('F', 'ascii'));
  }
}

