// @ts-check
/**
 * In-memory ESP device simulator.
 *
 * Speaks the real SLIP protocol against a `Uint8Array` standing in for flash,
 * so the protocol and device layers can be tested without hardware. This is
 * what makes CI meaningful for a library whose whole job is talking to a chip.
 *
 * @module testing/mock-transport
 */

import { SlipDecoder, slipEncode } from '../protocol/slip.js';
import {
  CMD,
  DIRECTION_RESPONSE,
  SYNC_PAYLOAD,
  decodeResponse,
} from '../protocol/commands.js';
import { chipByName } from '../protocol/chips.js';
import { md5, md5Hex } from '../binary/hash.js';
import { registerStub } from '../protocol/stub-loader.js';
import { TransportClosedError, TransportTimeoutError } from '../util/errors.js';

/**
 * @typedef {import('../transport/transport.js').Transport} Transport
 * @typedef {import('../transport/transport.js').ReadOptions} ReadOptions
 * @typedef {import('../protocol/chips.js').ChipDef} ChipDef
 */

const SPI_CMD_USR = 1 << 18;

/**
 * A stub image that the mock accepts. Its contents are never executed; only
 * the upload handshake is simulated.
 */
export const MOCK_STUB = {
  entry: 0x40000000,
  text: 'AAAA',
  text_start: 0x40000000,
  data: 'AAAA',
  data_start: 0x3ffc0000,
};

/**
 * @implements {Transport}
 */
export class MockTransport {
  /**
   * @param {object} [options]
   * @param {string} [options.chip]        Chip name, e.g. "ESP32-S3".
   * @param {number} [options.flashSize]
   * @param {Uint8Array} [options.flash]   Initial flash contents.
   * @param {boolean} [options.supportsSecurityInfo] False emulates an ESP32.
   * @param {boolean} [options.secureDownloadMode]
   * @param {boolean} [options.allowStub]  False makes stub loading fail.
   */
  constructor(options = {}) {
    const {
      chip = 'ESP32-S3',
      flashSize = 4 * 1024 * 1024,
      flash,
      supportsSecurityInfo,
      secureDownloadMode = false,
      allowStub = true,
    } = options;

    const def = chipByName(chip);
    if (!def) throw new Error(`Unknown chip for MockTransport: ${chip}`);

    /** @type {ChipDef} */
    this.chip = def;
    /** @type {Uint8Array} */
    this.flash = flash ?? new Uint8Array(flashSize).fill(0xff);
    /** @type {boolean} */
    this.supportsSecurityInfo = supportsSecurityInfo ?? !def.usesMagicValue;
    /** @type {boolean} */
    this.secureDownloadMode = secureDownloadMode;
    /** @type {boolean} */
    this.allowStub = allowStub;

    /** @type {boolean} */
    this.opened = false;
    /** @type {boolean} */
    this.isStub = false;
    /** @type {number} */
    this.baudRate = 115200;
    /** @type {{dtr: boolean, rts: boolean}} */
    this.signals = { dtr: false, rts: false };

    /** @type {Uint8Array[]} Frames waiting to be read by the host. */
    this.outbox = [];
    /** @type {SlipDecoder} */
    this.decoder = new SlipDecoder();
    /** @type {Map<number, number>} Emulated register file. */
    this.registers = new Map();
    /** @type {{address: number, offset: number}|null} */
    this.writeSession = null;
    /** @type {number} */
    this.memBeginCount = 0;
    /** @type {string[]} Opcodes seen, for assertions in tests. */
    this.commandLog = [];

    registerStub(def.stub, MOCK_STUB);
    this.initRegisters();
  }

  initRegisters() {
    if (this.chip.usesMagicValue && this.chip.magicValue !== null) {
      this.registers.set(0x40001000, this.chip.magicValue);
    }
    // A plausible factory MAC.
    this.registers.set(this.chip.macEfuseReg, 0xc4400a24);
    this.registers.set(this.chip.macEfuseReg + 4, 0x00007c3f);
  }

  /* ------------------------------------------------------------------ */
  /* Transport surface                                                   */
  /* ------------------------------------------------------------------ */

  /** @returns {string} */
  get description() {
    return `MockTransport(${this.chip.name}, ${this.flash.length} bytes)`;
  }

  /** @returns {boolean} */
  isOpen() {
    return this.opened;
  }

  /** @returns {Promise<void>} */
  async open() {
    this.opened = true;
  }

  /** @returns {Promise<void>} */
  async close() {
    this.opened = false;
    this.outbox.length = 0;
  }

  /**
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(data) {
    if (!this.opened) throw new TransportClosedError();
    // Raw (non-SLIP) bytes are READ_FLASH acknowledgements; the decoder drops
    // them, which is the right behaviour here since the mock does not pace.
    for (const frame of this.decoder.push(data)) this.handleFrame(frame);
  }

  /**
   * @param {ReadOptions} [options]
   * @returns {Promise<Uint8Array>}
   */
  async read({ timeoutMs = 3000 } = {}) {
    if (!this.opened) throw new TransportClosedError();
    if (this.outbox.length === 0) throw new TransportTimeoutError(timeoutMs);
    return /** @type {Uint8Array} */ (this.outbox.shift());
  }

  /** @param {number} baudRate @returns {Promise<void>} */
  async setBaudRate(baudRate) {
    this.baudRate = baudRate;
  }

  /** @param {{dtr?: boolean, rts?: boolean}} signals @returns {Promise<void>} */
  async setSignals(signals) {
    Object.assign(this.signals, signals);
  }

  /** @returns {Promise<void>} */
  async flushInput() {
    this.outbox.length = 0;
    this.decoder.reset();
  }

  /* ------------------------------------------------------------------ */
  /* Device emulation                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Uint8Array} payload
   */
  send(payload) {
    this.outbox.push(slipEncode(payload));
  }

  /**
   * @param {number} op
   * @param {Uint8Array} [data]
   * @param {number} [value]
   * @param {number} [status]
   * @param {number} [errorCode]
   */
  respond(op, data = new Uint8Array(0), value = 0, status = 0, errorCode = 0) {
    const body = new Uint8Array(data.length + 2);
    body.set(data);
    body[data.length] = status;
    body[data.length + 1] = errorCode;

    const packet = new Uint8Array(8 + body.length);
    const view = new DataView(packet.buffer);
    packet[0] = DIRECTION_RESPONSE;
    packet[1] = op;
    view.setUint16(2, body.length, true);
    view.setUint32(4, value, true);
    packet.set(body, 8);
    this.send(packet);
  }

  /**
   * @param {Uint8Array} frame
   */
  handleFrame(frame) {
    if (frame.length < 8 || frame[0] !== 0x00) return;
    const op = frame[1];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const size = view.getUint16(2, true);
    const payload = frame.subarray(8, 8 + size);
    this.commandLog.push(`0x${op.toString(16).padStart(2, '0')}`);

    switch (op) {
      case CMD.SYNC:
        // The ROM answers a single SYNC several times over.
        for (let i = 0; i < 4; i++) this.respond(CMD.SYNC);
        return;

      case CMD.READ_REG: {
        if (this.secureDownloadMode) return this.respond(op, undefined, 0, 1, 0x05);
        const address = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
        return this.respond(op, undefined, this.registers.get(address) ?? 0);
      }

      case CMD.WRITE_REG: {
        const pv = new DataView(payload.buffer, payload.byteOffset);
        const address = pv.getUint32(0, true);
        const value = pv.getUint32(4, true);
        this.handleRegisterWrite(address, value);
        return this.respond(op);
      }

      case CMD.GET_SECURITY_INFO:
        if (!this.supportsSecurityInfo) return this.respond(op, undefined, 0, 1, 0x05);
        return this.respond(op, this.buildSecurityInfo());

      case CMD.SPI_ATTACH:
      case CMD.SPI_SET_PARAMS:
      case CMD.CHANGE_BAUDRATE:
        return this.respond(op);

      case CMD.MEM_BEGIN:
        if (!this.allowStub) return this.respond(op, undefined, 0, 1, 0x06);
        this.memBeginCount++;
        return this.respond(op);

      case CMD.MEM_DATA:
        return this.respond(op);

      case CMD.MEM_END:
        this.respond(op);
        // The ROM answers MEM_END, then the stub greets separately.
        this.isStub = true;
        this.send(new TextEncoder().encode('OHAI'));
        return;

      case CMD.FLASH_BEGIN:
      case CMD.FLASH_DEFL_BEGIN: {
        const pv = new DataView(payload.buffer, payload.byteOffset);
        this.writeSession = { address: pv.getUint32(12, true), offset: 0 };
        return this.respond(op);
      }

      case CMD.FLASH_DATA: {
        if (!this.writeSession) return this.respond(op, undefined, 0, 1, 0x06);
        const pv = new DataView(payload.buffer, payload.byteOffset);
        const length = pv.getUint32(0, true);
        const chunk = payload.subarray(16, 16 + length);
        const at = this.writeSession.address + this.writeSession.offset;
        // Real flash can only clear bits; AND models that, so a write over
        // un-erased data behaves the way hardware would.
        for (let i = 0; i < chunk.length && at + i < this.flash.length; i++) {
          this.flash[at + i] &= chunk[i];
        }
        this.writeSession.offset += chunk.length;
        return this.respond(op);
      }

      case CMD.FLASH_DEFL_DATA:
        // Compressed writes are acknowledged but not decompressed; tests that
        // care about content use the uncompressed path.
        return this.respond(op);

      case CMD.FLASH_END:
      case CMD.FLASH_DEFL_END:
        this.writeSession = null;
        return this.respond(op);

      case CMD.SPI_FLASH_MD5: {
        const pv = new DataView(payload.buffer, payload.byteOffset);
        const address = pv.getUint32(0, true);
        const length = pv.getUint32(4, true);
        const digest = md5Hex(this.flash.subarray(address, address + length));
        return this.respond(op, new TextEncoder().encode(digest));
      }

      case CMD.ERASE_FLASH:
        if (!this.isStub) return this.respond(op, undefined, 0, 1, 0x05);
        this.flash.fill(0xff);
        return this.respond(op);

      case CMD.ERASE_REGION: {
        if (!this.isStub) return this.respond(op, undefined, 0, 1, 0x05);
        const pv = new DataView(payload.buffer, payload.byteOffset);
        const address = pv.getUint32(0, true);
        const length = pv.getUint32(4, true);
        this.flash.fill(0xff, address, address + length);
        return this.respond(op);
      }

      case CMD.READ_FLASH: {
        if (!this.isStub) return this.respond(op, undefined, 0, 1, 0x05);
        const pv = new DataView(payload.buffer, payload.byteOffset);
        const address = pv.getUint32(0, true);
        const length = pv.getUint32(4, true);
        const blockSize = pv.getUint32(8, true);
        this.respond(op);
        const region = this.flash.subarray(address, address + length);
        for (let sent = 0; sent < region.length; sent += blockSize) {
          this.send(region.subarray(sent, Math.min(sent + blockSize, region.length)));
        }
        this.send(md5(region));
        return;
      }

      case CMD.RUN_USER_CODE:
        this.isStub = false;
        return;

      default:
        return this.respond(op, undefined, 0, 1, 0x05);
    }
  }

  /**
   * Emulates the SPI "user command" registers well enough for RDID, which is
   * how flash size is detected.
   *
   * @param {number} address
   * @param {number} value
   */
  handleRegisterWrite(address, value) {
    this.registers.set(address, value);

    const base = this.chip.spiRegBase;
    if (address !== base + 0x00 || (value & SPI_CMD_USR) === 0) return;

    const usr2 = this.registers.get(base + this.chip.spiUsr2Offs) ?? 0;
    const spiCommand = usr2 & 0xff;
    const w0 = base + this.chip.spiW0Offs;

    if (spiCommand === 0x9f) {
      // RDID: manufacturer, memory type, capacity. The capacity byte encodes
      // log2(size); 0x16 is 4 MB.
      const capacity = Math.log2(this.flash.length) | 0;
      this.registers.set(w0, (0xc8 | (0x40 << 8) | (capacity << 16)) >>> 0);
    } else {
      this.registers.set(w0, 0);
    }
    // Clear the busy bit so the poll loop terminates.
    this.registers.set(address, value & ~SPI_CMD_USR);
  }

  /** @returns {Uint8Array} */
  buildSecurityInfo() {
    // 20-byte form: flags, flash_crypt_cnt, 7 key purposes, chip id, api version.
    const out = new Uint8Array(20);
    const view = new DataView(out.buffer);
    view.setUint32(0, this.secureDownloadMode ? 1 << 2 : 0, true);
    out[4] = 0; // flash_crypt_cnt
    view.setUint32(12, this.chip.imageChipId, true);
    view.setUint32(16, 1, true);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Test helpers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Writes directly into the simulated flash, bypassing the protocol.
   * @param {number} address
   * @param {Uint8Array} data
   */
  poke(address, data) {
    this.flash.set(data, address);
  }

  /**
   * @param {Uint8Array} frame
   * @returns {import('../protocol/commands.js').ResponsePacket|null}
   */
  static decode(frame) {
    return decodeResponse(frame);
  }
}

export { SYNC_PAYLOAD };
