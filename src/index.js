// @ts-check
/**
 * ESP FlashJS — full entry point.
 *
 * Re-exports everything from `core.js` plus the device-facing layers:
 * transports, the bootloader protocol, and flash operations.
 *
 * Use `esp-flashjs/core` instead if you only analyze files and do not talk to
 * hardware; it leaves out the serial machinery entirely.
 *
 * @module index
 */

export * from './core.js';

/**
 * Device-facing types, aliased for the same reason as in core.js.
 *
 * @typedef {import('./transport/transport.js').Transport} Transport
 * @typedef {import('./transport/transport.js').ReadOptions} ReadOptions
 * @typedef {import('./protocol/chips.js').ChipDef} ChipDef
 * @typedef {import('./protocol/chips.js').MemoryRegion} MemoryRegion
 * @typedef {import('./protocol/commands.js').ResponsePacket} ResponsePacket
 * @typedef {import('./protocol/loader.js').SecurityInfo} SecurityInfo
 * @typedef {import('./protocol/stub-loader.js').StubImage} StubImage
 * @typedef {import('./device/device-info.js').DeviceInfo} DeviceInfo
 * @typedef {import('./device/esp-flash.js').OperationOptions} OperationOptions
 * @typedef {import('./util/events.js').Progress} Progress
 * @typedef {import('./util/events.js').ProgressCallback} ProgressCallback
 * @typedef {import('./util/events.js').ProgressPhase} ProgressPhase
 */

/* Transports -------------------------------------------------------------- */
export { canAutoReset, delay } from './transport/transport.js';
export { WebSerialTransport } from './transport/web-serial.js';
export { MockTransport } from './testing/mock-transport.js';

/* Protocol ---------------------------------------------------------------- */
export { EspLoader } from './protocol/loader.js';
export { SlipDecoder, slipEncode, slipUnescape } from './protocol/slip.js';
export { CMD, STUB_ONLY_COMMANDS, decodeResponse, encodeRequest } from './protocol/commands.js';
export { fetchStub, registerStub, stubUrl, loadStub } from './protocol/stub-loader.js';
export { CHIP_DETECT_MAGIC_REG, FLASH_SIZE_BY_ID } from './protocol/chips.js';

/* Device ------------------------------------------------------------------ */
export { EspFlash, FLASH_SECTOR_SIZE, READ_BLOCK_SIZE } from './device/esp-flash.js';
export { readDeviceInfo, readMac } from './device/device-info.js';

/** Library version. Kept in step with package.json by scripts/build.js. */
export const VERSION = '1.0.0';
