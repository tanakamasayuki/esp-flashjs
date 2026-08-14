// @ts-check
/**
 * Transport abstraction.
 *
 * `read()` returns whatever bytes have arrived rather than a requested length,
 * because SLIP frames are delimited, not length-prefixed — the framing layer
 * cannot know how many bytes to ask for. Frame assembly happens in
 * `protocol/slip.js`.
 *
 * @module transport/transport
 */

/**
 * @typedef {object} ReadOptions
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(options?: ReadOptions) => Promise<Uint8Array>} read
 * @property {(baudRate: number) => Promise<void>} [setBaudRate]
 * @property {(signals: {dtr?: boolean, rts?: boolean}) => Promise<void>} [setSignals]
 * @property {() => Promise<void>} [flushInput]
 * @property {string} [description] Human-readable identification for logs.
 */

/**
 * Reports whether a transport can drive DTR/RTS.
 *
 * Without it, the device cannot be put into bootloader mode automatically and
 * the user has to hold BOOT and tap EN by hand.
 *
 * @param {Transport} transport
 * @returns {boolean}
 */
export function canAutoReset(transport) {
  return typeof transport.setSignals === 'function';
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
