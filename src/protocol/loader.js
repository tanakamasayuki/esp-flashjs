// @ts-check
/**
 * ESP serial bootloader driver.
 *
 * Owns synchronization, chip identification, command exchange and the stub
 * handoff. Higher-level flash operations live in `device/esp-flash.js`.
 *
 * @module protocol/loader
 */

import { SlipDecoder, slipEncode } from './slip.js';
import {
  CMD,
  ROM_ERROR,
  STUB_ONLY_COMMANDS,
  SYNC_PAYLOAD,
  changeBaudRatePayload,
  decodeResponse,
  encodeRequest,
  readRegPayload,
  spiAttachPayload,
  writeRegPayload,
} from './commands.js';
import { CHIP_DETECT_MAGIC_REG, FLASH_SIZE_BY_ID, chipByImageId, chipByMagic } from './chips.js';
import { loadStub } from './stub-loader.js';
import { delay } from '../transport/transport.js';
import { toHexAddress } from '../util/hex.js';
import {
  CommandFailedError,
  OperationAbortedError,
  TransportTimeoutError,
  UnknownChipError,
  throwIfAborted,
} from '../util/errors.js';

/**
 * @typedef {import('../transport/transport.js').Transport} Transport
 * @typedef {import('./chips.js').ChipDef} ChipDef
 * @typedef {import('./commands.js').ResponsePacket} ResponsePacket
 */

/**
 * @typedef {object} SecurityInfo
 * @property {number} flags
 * @property {number} flashCryptCnt
 * @property {number[]} keyPurposes
 * @property {number|null} chipId
 * @property {number|null} apiVersion
 * @property {boolean} secureBootEnabled
 * @property {boolean} secureDownloadMode
 */

/** @typedef {(level: 'info'|'warn'|'error', code: string, params?: Record<string, unknown>) => void} LogFn */

const DEFAULT_TIMEOUT_MS = 3000;
const SYNC_TIMEOUT_MS = 100;
const SYNC_ATTEMPTS = 7;

export class EspLoader {
  /**
   * @param {Transport} transport
   * @param {object} [options]
   * @param {LogFn} [options.onLog]
   */
  constructor(transport, { onLog } = {}) {
    /** @type {Transport} */
    this.transport = transport;
    /** @type {ChipDef|null} */
    this.chip = null;
    /** @type {boolean} */
    this.isStub = false;
    /** @type {SecurityInfo|null} */
    this.securityInfo = null;
    /** @type {LogFn} */
    this.log = onLog ?? (() => {});
    /** @type {SlipDecoder} */
    this.decoder = new SlipDecoder();
    /** @type {Uint8Array[]} */
    this.frameQueue = [];
    /** @type {boolean} */
    this.spiAttached = false;
  }

  /* ------------------------------------------------------------------ */
  /* Frame exchange                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Reads the next complete SLIP frame.
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Total budget, not per read.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Uint8Array>}
   */
  async readFrame({ timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (this.frameQueue.length > 0) {
      return /** @type {Uint8Array} */ (this.frameQueue.shift());
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(signal, 'reading');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);

      const chunk = await this.transport.read({ timeoutMs: remaining, signal });
      const frames = this.decoder.push(chunk);
      if (frames.length > 0) {
        this.frameQueue.push(...frames.slice(1));
        return frames[0];
      }
    }
  }

  /**
   * Sends a command and waits for the matching response.
   *
   * Responses for other opcodes are discarded: the device sometimes emits a
   * late reply to a previous command, and matching on the opcode keeps the
   * exchange in step without a full resynchronization.
   *
   * @param {number} op
   * @param {Uint8Array} [payload]
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.checksum]
   * @param {boolean} [options.expectResponse]
   * @param {number|((bodyLength: number) => number)} [options.responseDataLength]
   *   How many bytes of data this command returns, ahead of the status bytes.
   *   Pass a function when the length depends on the device, as it does for
   *   GET_SECURITY_INFO.
   * @returns {Promise<ResponsePacket>}
   */
  async command(op, payload = new Uint8Array(0), options = {}) {
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal,
      checksum,
      expectResponse = true,
      responseDataLength = 0,
    } = options;

    if (STUB_ONLY_COMMANDS.has(op) && !this.isStub) {
      throw new CommandFailedError(op, 0xff, 0x05);
    }

    await this.transport.write(slipEncode(encodeRequest(op, payload, checksum)));

    if (!expectResponse) {
      return {
        command: op,
        value: 0,
        body: new Uint8Array(0),
        data: new Uint8Array(0),
        status: 0,
        errorCode: 0,
      };
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);

      const frame = await this.readFrame({ timeoutMs: remaining, signal });
      // Peek at the body length so a caller-supplied resolver can pick the
      // layout before the status bytes are located.
      const bodyLength = frame.length >= 8 ? frame[2] | (frame[3] << 8) : 0;
      const dataLength =
        typeof responseDataLength === 'function'
          ? responseDataLength(bodyLength)
          : responseDataLength;

      const response = decodeResponse(frame, dataLength);
      if (!response || response.command !== op) continue;

      if (response.status !== 0) {
        this.log('error', 'protocol.commandFailed', {
          op,
          status: response.status,
          errorCode: response.errorCode,
          reason: ROM_ERROR[response.errorCode] ?? 'unknown',
        });
        throw new CommandFailedError(op, response.status, response.errorCode);
      }
      return response;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Connection                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Resets into the bootloader, synchronizes, and identifies the chip.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.autoReset] Set false when the user resets by hand.
   * @returns {Promise<ChipDef>}
   */
  async connect({ signal, autoReset = true } = {}) {
    if (!this.transport.isOpen()) await this.transport.open();

    let synced = false;
    /** @type {Error|null} */
    let lastError = null;

    // Two reset styles: the classic DTR/RTS dance works for external USB-UART
    // bridges, the second for parts with USB-Serial/JTAG built in.
    const strategies = autoReset && this.transport.setSignals
      ? [/** @type {const} */ ('classic'), /** @type {const} */ ('usb-jtag')]
      : [/** @type {const} */ ('none')];

    for (const strategy of strategies) {
      throwIfAborted(signal, 'connecting');
      this.log('info', 'protocol.resetting', { strategy });
      await this.reset(strategy);
      await this.transport.flushInput?.();
      this.decoder.reset();
      this.frameQueue.length = 0;

      try {
        await this.sync({ signal });
        synced = true;
        break;
      } catch (error) {
        if (error instanceof OperationAbortedError) throw error;
        lastError = /** @type {Error} */ (error);
      }
    }

    if (!synced) {
      this.log('error', 'protocol.syncFailed');
      throw lastError ?? new Error('Failed to synchronize.');
    }

    this.chip = await this.detectChip({ signal });
    this.log('info', 'protocol.chipDetected', { chip: this.chip.name });
    return this.chip;
  }

  /**
   * @param {'classic'|'usb-jtag'|'none'} strategy
   * @returns {Promise<void>}
   */
  async reset(strategy) {
    const setSignals = this.transport.setSignals?.bind(this.transport);
    if (!setSignals || strategy === 'none') return;

    if (strategy === 'classic') {
      // EN low (reset held), then IO0 low while EN is released, so the part
      // samples IO0 as low on boot and enters download mode.
      await setSignals({ dtr: false, rts: true });
      await delay(100);
      await setSignals({ dtr: true, rts: false });
      await delay(50);
      await setSignals({ dtr: false, rts: false });
      await delay(50);
      return;
    }

    // USB-Serial/JTAG parts drive both lines through the same peripheral, so
    // the classic sequence can cancel itself out. Assert both, then release.
    await setSignals({ dtr: false, rts: false });
    await delay(100);
    await setSignals({ dtr: true, rts: true });
    await delay(100);
    await setSignals({ dtr: false, rts: true });
    await delay(100);
    await setSignals({ dtr: false, rts: false });
    await delay(50);
  }

  /**
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<void>}
   */
  async sync({ signal } = {}) {
    /** @type {Error|null} */
    let lastError = null;

    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      throwIfAborted(signal, 'connecting');
      try {
        await this.command(CMD.SYNC, SYNC_PAYLOAD, { timeoutMs: SYNC_TIMEOUT_MS, signal });
        // The ROM replies to a single SYNC several times. Drain the extras so
        // they are not mistaken for the answer to the next command.
        await this.drain(50);
        this.log('info', 'protocol.synced', { attempt: attempt + 1 });
        return;
      } catch (error) {
        if (error instanceof OperationAbortedError) throw error;
        lastError = /** @type {Error} */ (error);
      }
    }

    throw lastError ?? new Error('SYNC failed.');
  }

  /**
   * Consumes and discards any frames that arrive within the window.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async drain(ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        await this.readFrame({ timeoutMs: remaining });
      } catch {
        return;
      }
    }
  }

  /**
   * Identifies the attached chip.
   *
   * Tries GET_SECURITY_INFO first, which is how every part from the ESP32-S3
   * onwards reports its identity, and falls back to the magic register for
   * ESP32 and ESP32-S2.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<ChipDef>}
   */
  async detectChip({ signal } = {}) {
    /** @type {number|null} */
    let chipId = null;

    try {
      this.securityInfo = await this.getSecurityInfo({ signal });
      chipId = this.securityInfo.chipId;
      this.log('info', 'protocol.securityInfo', {
        chipId: chipId === null ? 'n/a' : chipId,
        apiVersion: this.securityInfo.apiVersion ?? 'n/a',
      });
    } catch (error) {
      // ESP32 has no GET_SECURITY_INFO at all, and ESP32-S2 answers without a
      // chip id. Both are expected; fall through to the magic register.
      this.securityInfo = null;
      this.log('info', 'protocol.securityInfoUnavailable', {
        message: /** @type {Error} */ (error).message,
      });
    }

    if (chipId !== null) {
      const chip = chipByImageId(chipId);
      if (chip) return chip;
      this.log('warn', 'protocol.unknownChipId', { chipId });
    }

    /** @type {number|null} */
    let magic = null;
    try {
      magic = await this.readReg(CHIP_DETECT_MAGIC_REG, { signal });
      this.log('info', 'protocol.magicValue', { magic: toHexAddress(magic) });
      const chip = chipByMagic(magic);
      if (chip) return chip;
      this.log('warn', 'protocol.unknownMagic', { magic: toHexAddress(magic) });
    } catch (error) {
      // Secure Download Mode blocks register reads; nothing more to try.
      this.log('warn', 'protocol.magicReadFailed', {
        message: /** @type {Error} */ (error).message,
      });
    }

    throw new UnknownChipError(chipId, magic);
  }

  /**
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<SecurityInfo>}
   */
  async getSecurityInfo({ signal } = {}) {
    const response = await this.command(CMD.GET_SECURITY_INFO, new Uint8Array(0), {
      signal,
      timeoutMs: 1000,
      // Most parts return 20 bytes; the ESP32-S2 returns 12 and omits the chip
      // id. Both may be followed by 2 status bytes and 2 reserved bytes.
      responseDataLength: (bodyLength) => (bodyLength >= 22 ? 20 : 12),
    });
    const d = response.data;
    if (d.length < 12) throw new Error('GET_SECURITY_INFO response too short.');

    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const flags = view.getUint32(0, true);
    const flashCryptCnt = d[4];
    const keyPurposes = Array.from(d.subarray(5, 12));
    // 20-byte responses carry the chip id; the 12-byte ESP32-S2 form does not.
    const hasChipId = d.length >= 20;

    return {
      flags,
      flashCryptCnt,
      keyPurposes,
      chipId: hasChipId ? view.getUint32(12, true) : null,
      apiVersion: hasChipId ? view.getUint32(16, true) : null,
      secureBootEnabled: (flags & (1 << 0)) !== 0,
      secureDownloadMode: (flags & (1 << 2)) !== 0,
    };
  }

  /**
   * @returns {boolean}
   */
  get secureDownloadMode() {
    return this.securityInfo?.secureDownloadMode ?? false;
  }

  /* ------------------------------------------------------------------ */
  /* Registers and SPI                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} address
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<number>}
   */
  async readReg(address, { signal } = {}) {
    const response = await this.command(CMD.READ_REG, readRegPayload(address), { signal });
    return response.value;
  }

  /**
   * @param {number} address
   * @param {number} value
   * @param {number} [mask]
   * @param {number} [delayUs]
   * @returns {Promise<void>}
   */
  async writeReg(address, value, mask = 0xffffffff, delayUs = 0) {
    await this.command(CMD.WRITE_REG, writeRegPayload(address, value, mask, delayUs));
  }

  /**
   * Connects the SPI flash controller. Required before any flash command on
   * the ROM loader; the stub does it during startup.
   *
   * @returns {Promise<void>}
   */
  async attachSpiFlash() {
    if (this.spiAttached) return;
    await this.command(CMD.SPI_ATTACH, spiAttachPayload(0));
    this.spiAttached = true;
  }

  /**
   * Issues an arbitrary SPI flash command through the chip's "user command"
   * registers.
   *
   * @param {number} spiCommand
   * @param {object} [options]
   * @param {Uint8Array} [options.data]  Bytes to send after the command byte.
   * @param {number} [options.readBits]  Bits to read back (max 32).
   * @returns {Promise<number>}
   */
  async runSpiFlashCommand(spiCommand, { data = new Uint8Array(0), readBits = 0 } = {}) {
    const chip = this.requireChip();
    if (readBits > 32) throw new Error('Cannot read more than 32 bits from a SPI command.');
    if (data.length > 64) throw new Error('Cannot send more than 64 bytes with a SPI command.');

    const base = chip.spiRegBase;
    const SPI_CMD_REG = base + 0x00;
    const SPI_USR_REG = base + chip.spiUsrOffs;
    const SPI_USR1_REG = base + chip.spiUsr1Offs;
    const SPI_USR2_REG = base + chip.spiUsr2Offs;
    const SPI_W0_REG = base + chip.spiW0Offs;
    const SPI_MOSI_DLEN_REG = base + chip.spiMosiDlenOffs;
    const SPI_MISO_DLEN_REG = base + chip.spiMisoDlenOffs;

    const SPI_USR_COMMAND = 1 << 31;
    const SPI_USR_MISO = 1 << 28;
    const SPI_USR_MOSI = 1 << 27;
    const SPI_CMD_USR = 1 << 18;
    const SPI_USR2_COMMAND_LEN_SHIFT = 28;

    const dataBits = data.length * 8;
    const oldUsr = await this.readReg(SPI_USR_REG);
    const oldUsr2 = await this.readReg(SPI_USR2_REG);

    if (dataBits > 0) await this.writeReg(SPI_MOSI_DLEN_REG, dataBits - 1);
    if (readBits > 0) await this.writeReg(SPI_MISO_DLEN_REG, readBits - 1);

    let flags = SPI_USR_COMMAND;
    if (readBits > 0) flags |= SPI_USR_MISO;
    if (dataBits > 0) flags |= SPI_USR_MOSI;

    await this.writeReg(SPI_USR_REG, flags >>> 0);
    await this.writeReg(SPI_USR2_REG, ((7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiCommand) >>> 0);

    if (dataBits === 0) {
      await this.writeReg(SPI_W0_REG, 0);
    } else {
      const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
      padded.set(data);
      const view = new DataView(padded.buffer);
      for (let i = 0; i < padded.length / 4; i++) {
        await this.writeReg(SPI_W0_REG + i * 4, view.getUint32(i * 4, true));
      }
    }

    await this.writeReg(SPI_CMD_REG, SPI_CMD_USR);

    let done = false;
    for (let i = 0; i < 10; i++) {
      if (((await this.readReg(SPI_CMD_REG)) & SPI_CMD_USR) === 0) {
        done = true;
        break;
      }
    }
    if (!done) throw new Error('SPI flash command did not complete.');

    const status = await this.readReg(SPI_W0_REG);
    await this.writeReg(SPI_USR_REG, oldUsr);
    await this.writeReg(SPI_USR2_REG, oldUsr2);
    return status;
  }

  /**
   * Reads the flash chip's JEDEC id (RDID, 0x9F).
   * @returns {Promise<number>}
   */
  async readFlashId() {
    await this.attachSpiFlash();
    return this.runSpiFlashCommand(0x9f, { readBits: 24 });
  }

  /**
   * Determines the flash size from the JEDEC id's capacity byte.
   *
   * @returns {Promise<number|null>} Bytes, or `null` when the id is unknown.
   */
  async detectFlashSize() {
    try {
      const flashId = await this.readFlashId();
      const sizeId = (flashId >> 16) & 0xff;
      const size = FLASH_SIZE_BY_ID[sizeId];
      if (size === undefined) {
        this.log('warn', 'protocol.unknownFlashSize', { flashId, sizeId });
        return null;
      }
      return size;
    } catch (error) {
      this.log('warn', 'protocol.flashSizeDetectFailed', {
        message: /** @type {Error} */ (error).message,
      });
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Stub                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Uploads and starts the flasher stub.
   *
   * Returns false rather than throwing when the stub cannot be loaded: the ROM
   * loader still supports writing, so the session stays usable in a reduced
   * mode instead of failing outright.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<boolean>}
   */
  async loadStub({ signal } = {}) {
    if (this.isStub) return true;
    const chip = this.requireChip();

    if (this.secureDownloadMode) {
      this.log('warn', 'protocol.stubBlockedBySdm');
      return false;
    }

    try {
      await loadStub(this, chip, { signal });
      this.isStub = true;
      this.spiAttached = true; // The stub attaches SPI flash as it starts.
      this.log('info', 'protocol.stubLoaded', { chip: chip.name });
      return true;
    } catch (error) {
      this.log('warn', 'protocol.stubLoadFailed', {
        message: /** @type {Error} */ (error).message,
      });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Baud rate                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} baudRate
   * @returns {Promise<void>}
   */
  async changeBaudRate(baudRate) {
    if (!this.transport.setBaudRate) {
      this.log('warn', 'protocol.baudRateUnsupported');
      return;
    }
    // The stub needs to know the rate it is currently running at; the ROM
    // loader expects zero here.
    const current = this.isStub ? getTransportBaudRate(this.transport) : 0;
    await this.command(CMD.CHANGE_BAUDRATE, changeBaudRatePayload(baudRate, current));
    // The device switches immediately after replying.
    await delay(50);
    await this.transport.setBaudRate(baudRate);
    await this.transport.flushInput?.();
    this.decoder.reset();
    this.frameQueue.length = 0;
    this.log('info', 'protocol.baudRateChanged', { baudRate });
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} [options]
   * @param {boolean} [options.reset] Let the device boot the application.
   * @returns {Promise<void>}
   */
  async disconnect({ reset = true } = {}) {
    if (reset) {
      try {
        if (this.isStub) {
          // RUN_USER_CODE never replies; the stub jumps away instead.
          await this.command(CMD.RUN_USER_CODE, new Uint8Array(0), { expectResponse: false });
        } else if (this.transport.setSignals) {
          await this.transport.setSignals({ dtr: false, rts: true });
          await delay(100);
          await this.transport.setSignals({ dtr: false, rts: false });
        }
      } catch {
        // A failed reset must not prevent the port from being released.
      }
    }
    this.isStub = false;
    this.spiAttached = false;
    this.chip = null;
    this.securityInfo = null;
    await this.transport.close();
  }

  /**
   * @returns {ChipDef}
   * @throws {Error} If called before a successful connect.
   */
  requireChip() {
    if (!this.chip) throw new Error('Not connected: no chip has been detected yet.');
    return this.chip;
  }
}

/**
 * @param {Transport} transport
 * @returns {number}
 */
function getTransportBaudRate(transport) {
  const rate = /** @type {{baudRate?: number}} */ (transport).baudRate;
  return typeof rate === 'number' ? rate : 0;
}
