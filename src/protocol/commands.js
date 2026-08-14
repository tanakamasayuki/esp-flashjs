// @ts-check
/**
 * ESP serial bootloader command constants and packet codec.
 *
 * @module protocol/commands
 */

import { ByteWriter } from '../binary/writer.js';

/** Commands understood by both the ROM loader and the stub. */
export const CMD = {
  FLASH_BEGIN: 0x02,
  FLASH_DATA: 0x03,
  FLASH_END: 0x04,
  MEM_BEGIN: 0x05,
  MEM_END: 0x06,
  MEM_DATA: 0x07,
  SYNC: 0x08,
  WRITE_REG: 0x09,
  READ_REG: 0x0a,
  SPI_SET_PARAMS: 0x0b,
  SPI_ATTACH: 0x0d,
  CHANGE_BAUDRATE: 0x0f,
  FLASH_DEFL_BEGIN: 0x10,
  FLASH_DEFL_DATA: 0x11,
  FLASH_DEFL_END: 0x12,
  SPI_FLASH_MD5: 0x13,
  GET_SECURITY_INFO: 0x14,

  // Stub loader only.
  ERASE_FLASH: 0xd0,
  ERASE_REGION: 0xd1,
  READ_FLASH: 0xd2,
  RUN_USER_CODE: 0xd3,
};

/** Commands whose payload is covered by the header checksum field. */
const CHECKSUMMED = new Set([CMD.FLASH_DATA, CMD.MEM_DATA, CMD.FLASH_DEFL_DATA]);

/** Commands the ROM loader does not implement. */
export const STUB_ONLY_COMMANDS = new Set([
  CMD.ERASE_FLASH,
  CMD.ERASE_REGION,
  CMD.READ_FLASH,
  CMD.RUN_USER_CODE,
]);

export const DIRECTION_REQUEST = 0x00;
export const DIRECTION_RESPONSE = 0x01;

/** Seed for the payload checksum. */
export const CHECKSUM_MAGIC = 0xef;

/** The 36-byte SYNC payload, fixed by the protocol. */
export const SYNC_PAYLOAD = (() => {
  const out = new Uint8Array(36);
  out.set([0x07, 0x07, 0x12, 0x20]);
  out.fill(0x55, 4);
  return out;
})();

/**
 * Device error codes returned in the status bytes.
 * @type {Record<number, string>}
 */
export const ROM_ERROR = {
  0x05: 'Received message is invalid',
  0x06: 'Failed to act on received message',
  0x07: 'Invalid CRC in message',
  0x08: 'Flash write error',
  0x09: 'Flash read error',
  0x0a: 'Flash read length error',
  0x0b: 'Deflate error',
};

/**
 * @typedef {object} ResponsePacket
 * @property {number} command
 * @property {number} value    Meaningful for READ_REG.
 * @property {Uint8Array} body Whole payload, including status and reserved bytes.
 * @property {Uint8Array} data The expected response data, status bytes removed.
 * @property {number} status   Non-zero means failure.
 * @property {number} errorCode
 */

/**
 * Computes the payload checksum used by the data-carrying commands.
 *
 * @param {Uint8Array} payload
 * @returns {number}
 */
export function payloadChecksum(payload) {
  let sum = CHECKSUM_MAGIC;
  for (let i = 0; i < payload.length; i++) sum ^= payload[i];
  return sum & 0xff;
}

/**
 * Builds a request packet, ready to be SLIP-encoded.
 *
 * @param {number} command
 * @param {Uint8Array} [payload]
 * @param {number} [checksum] Overrides the computed value; rarely needed.
 * @returns {Uint8Array}
 */
export function encodeRequest(command, payload = new Uint8Array(0), checksum) {
  const w = new ByteWriter(8 + payload.length);
  w.u8(DIRECTION_REQUEST);
  w.u8(command);
  w.u16(payload.length);
  w.u32(checksum ?? (CHECKSUMMED.has(command) ? payloadChecksum(payload) : 0));
  w.bytes(payload);
  return w.toBytes();
}

/**
 * Parses a response packet.
 *
 * The payload is laid out as `[data][status(2)][reserved(2)]`, where `data` is
 * however many bytes the issued command is defined to return and the reserved
 * pair is only present on ESP32-family ROM loaders. The status position
 * therefore cannot be inferred from the payload length — the caller has to say
 * how much data it expects, which is what `responseDataLength` is for.
 *
 * @param {Uint8Array} frame Unescaped SLIP frame body.
 * @param {number} [responseDataLength] Bytes of data this command returns.
 * @returns {ResponsePacket|null} `null` if the frame is not a valid response.
 */
export function decodeResponse(frame, responseDataLength = 0) {
  if (frame.length < 8) return null;
  if (frame[0] !== DIRECTION_RESPONSE) return null;

  const command = frame[1];
  const size = frame[2] | (frame[3] << 8);
  const value = (frame[4] | (frame[5] << 8) | (frame[6] << 16) | (frame[7] << 24)) >>> 0;
  const body = frame.subarray(8, 8 + size);

  // Too short for the declared layout: fall back to reading the status from
  // the front, which is what a device signalling an early failure sends.
  if (body.length < responseDataLength + 2) {
    return {
      command,
      value,
      body,
      data: new Uint8Array(0),
      status: body.length >= 1 ? body[0] : 0,
      errorCode: body.length >= 2 ? body[1] : 0,
    };
  }

  return {
    command,
    value,
    body,
    data: body.subarray(0, responseDataLength),
    status: body[responseDataLength],
    errorCode: body[responseDataLength + 1],
  };
}

/* -------------------------------------------------------------------------- */
/* Payload builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {number} address
 * @returns {Uint8Array}
 */
export function readRegPayload(address) {
  return new ByteWriter(4).u32(address).toBytes();
}

/**
 * @param {number} address
 * @param {number} value
 * @param {number} [mask]
 * @param {number} [delayUs]
 * @returns {Uint8Array}
 */
export function writeRegPayload(address, value, mask = 0xffffffff, delayUs = 0) {
  return new ByteWriter(16).u32(address).u32(value).u32(mask).u32(delayUs).toBytes();
}

/**
 * @param {object} params
 * @param {number} params.size       Total bytes to be written.
 * @param {number} params.blocks     Number of FLASH_DATA packets that will follow.
 * @param {number} params.blockSize
 * @param {number} params.offset
 * @param {boolean} [params.encrypted] Only meaningful on ROM loaders that accept the field.
 * @param {boolean} [params.includeEncryptedField]
 * @returns {Uint8Array}
 */
export function flashBeginPayload({
  size,
  blocks,
  blockSize,
  offset,
  encrypted = false,
  includeEncryptedField = false,
}) {
  const w = new ByteWriter(20).u32(size).u32(blocks).u32(blockSize).u32(offset);
  if (includeEncryptedField) w.u32(encrypted ? 1 : 0);
  return w.toBytes();
}

/**
 * @param {Uint8Array} data
 * @param {number} sequence
 * @returns {Uint8Array}
 */
export function flashDataPayload(data, sequence) {
  return new ByteWriter(16 + data.length)
    .u32(data.length)
    .u32(sequence)
    .u32(0)
    .u32(0)
    .bytes(data)
    .toBytes();
}

/**
 * @param {boolean} reboot
 * @returns {Uint8Array}
 */
export function flashEndPayload(reboot) {
  // The field is "stay in loader": 0 means reboot into the application.
  return new ByteWriter(4).u32(reboot ? 0 : 1).toBytes();
}

/**
 * @param {number} size
 * @param {number} blocks
 * @param {number} blockSize
 * @param {number} address
 * @returns {Uint8Array}
 */
export function memBeginPayload(size, blocks, blockSize, address) {
  return new ByteWriter(16).u32(size).u32(blocks).u32(blockSize).u32(address).toBytes();
}

/**
 * @param {Uint8Array} data
 * @param {number} sequence
 * @returns {Uint8Array}
 */
export function memDataPayload(data, sequence) {
  return flashDataPayload(data, sequence);
}

/**
 * @param {number} entryPoint 0 to stay in the loader.
 * @returns {Uint8Array}
 */
export function memEndPayload(entryPoint) {
  return new ByteWriter(8).u32(entryPoint === 0 ? 1 : 0).u32(entryPoint).toBytes();
}

/**
 * @param {number} address
 * @param {number} size
 * @returns {Uint8Array}
 */
export function spiFlashMd5Payload(address, size) {
  return new ByteWriter(16).u32(address).u32(size).u32(0).u32(0).toBytes();
}

/**
 * @param {number} address
 * @param {number} size
 * @returns {Uint8Array}
 */
export function eraseRegionPayload(address, size) {
  return new ByteWriter(8).u32(address).u32(size).toBytes();
}

/**
 * @param {number} address
 * @param {number} size
 * @param {number} blockSize
 * @param {number} maxInFlight
 * @returns {Uint8Array}
 */
export function readFlashPayload(address, size, blockSize, maxInFlight) {
  return new ByteWriter(16)
    .u32(address)
    .u32(size)
    .u32(blockSize)
    .u32(maxInFlight)
    .toBytes();
}

/**
 * @param {number} newRate
 * @param {number} currentRate 0 when talking to the ROM loader.
 * @returns {Uint8Array}
 */
export function changeBaudRatePayload(newRate, currentRate) {
  return new ByteWriter(8).u32(newRate).u32(currentRate).toBytes();
}

/**
 * @param {number} [hspiConfig] 0 selects the default SPI pins.
 * @returns {Uint8Array}
 */
export function spiAttachPayload(hspiConfig = 0) {
  // ROM loaders expect 8 bytes here; the stub accepts 4. Sending 8 works for both.
  return new ByteWriter(8).u32(hspiConfig).u32(0).toBytes();
}

/**
 * @param {object} params
 * @param {number} params.flashId
 * @param {number} params.totalSize
 * @param {number} [params.blockSize]
 * @param {number} [params.sectorSize]
 * @param {number} [params.pageSize]
 * @param {number} [params.statusMask]
 * @returns {Uint8Array}
 */
export function spiSetParamsPayload({
  flashId,
  totalSize,
  blockSize = 64 * 1024,
  sectorSize = 4 * 1024,
  pageSize = 256,
  statusMask = 0xffff,
}) {
  return new ByteWriter(24)
    .u32(flashId)
    .u32(totalSize)
    .u32(blockSize)
    .u32(sectorSize)
    .u32(pageSize)
    .u32(statusMask)
    .toBytes();
}
