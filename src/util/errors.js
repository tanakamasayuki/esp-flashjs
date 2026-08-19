// @ts-check
/**
 * Error hierarchy for ESP FlashJS.
 *
 * Every error carries a stable `code` string. Consumers branch on `code`,
 * never on `message` — `message` is an English developer-facing string and is
 * not intended for display to end users. UI layers translate `code` + `details`
 * into localized text.
 *
 * @module util/errors
 */

/**
 * Base class for every error thrown by this library.
 */
export class EspFlashError extends Error {
  /**
   * @param {string} code    Stable machine-readable identifier.
   * @param {string} message English developer-facing description.
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = details;
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export class TransportError extends EspFlashError {}

export class TransportTimeoutError extends TransportError {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    super('TRANSPORT_TIMEOUT', `No data received within ${timeoutMs} ms.`, { timeoutMs });
  }
}

export class TransportClosedError extends TransportError {
  constructor() {
    super('TRANSPORT_CLOSED', 'The transport is not open.');
  }
}

/* -------------------------------------------------------------------------- */
/* Protocol                                                                    */
/* -------------------------------------------------------------------------- */

export class ProtocolError extends EspFlashError {}

export class SyncFailedError extends ProtocolError {
  /** @param {number} attempts */
  constructor(attempts) {
    super(
      'SYNC_FAILED',
      `Failed to synchronize with the device after ${attempts} attempts. ` +
        'Try holding BOOT while pressing EN, then retry.',
      { attempts },
    );
  }
}

export class CommandFailedError extends ProtocolError {
  /**
   * @param {number} op        Command opcode.
   * @param {number} status    Status byte (non-zero means failure).
   * @param {number} errorCode Device error code.
   */
  constructor(op, status, errorCode) {
    super(
      'COMMAND_FAILED',
      `Command 0x${op.toString(16)} failed (status 0x${status.toString(16)}, ` +
        `error 0x${errorCode.toString(16)}).`,
      { op, status, errorCode },
    );
  }
}

export class UnknownChipError extends ProtocolError {
  /**
   * @param {number|null} chipId
   * @param {number|null} magic
   */
  constructor(chipId, magic) {
    super(
      'UNKNOWN_CHIP',
      `Unrecognized chip (chip id ${chipId ?? 'n/a'}, magic ` +
        `${magic === null ? 'n/a' : '0x' + magic.toString(16)}).`,
      { chipId, magic },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Device                                                                      */
/* -------------------------------------------------------------------------- */

export class DeviceError extends EspFlashError {}

export class StubLoadError extends DeviceError {
  /** @param {string} reason */
  constructor(reason) {
    super('STUB_LOAD_FAILED', `Could not load the flasher stub: ${reason}`, { reason });
  }
}

export class SecureDownloadModeError extends DeviceError {
  constructor() {
    super(
      'SECURE_DOWNLOAD_MODE',
      'The device is in Secure Download Mode; reading flash and writing RAM are disabled.',
    );
  }
}

export class UnsupportedOperationError extends DeviceError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(code, message, details);
  }

  /** @param {string} operation */
  static requiresStub(operation) {
    return new UnsupportedOperationError(
      'REQUIRES_STUB',
      `${operation} is not supported by the ROM loader; the flasher stub must be loaded first.`,
      { operation },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Formats                                                                     */
/* -------------------------------------------------------------------------- */

export class FormatError extends EspFlashError {}

export class InvalidMagicError extends FormatError {
  /**
   * @param {string} format
   * @param {number} expected
   * @param {number} actual
   * @param {number} [offset]
   */
  constructor(format, expected, actual, offset = 0) {
    super(
      'INVALID_MAGIC',
      `Not a valid ${format}: expected magic 0x${expected.toString(16)} at offset ` +
        `0x${offset.toString(16)}, found 0x${actual.toString(16)}.`,
      { format, expected, actual, offset },
    );
  }
}

export class ChecksumError extends FormatError {
  /**
   * @param {string} format
   * @param {string} expected
   * @param {string} actual
   */
  constructor(format, expected, actual) {
    super('CHECKSUM_MISMATCH', `${format} checksum mismatch: expected ${expected}, got ${actual}.`, {
      format,
      expected,
      actual,
    });
  }
}

export class TruncatedDataError extends FormatError {
  /**
   * @param {string} format
   * @param {number} needed
   * @param {number} available
   */
  constructor(format, needed, available) {
    super(
      'TRUNCATED_DATA',
      `${format} is truncated: needed ${needed} bytes, only ${available} available.`,
      { format, needed, available },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Arguments and capacity                                                      */
/* -------------------------------------------------------------------------- */

export class AlignmentError extends EspFlashError {
  /**
   * @param {string} what
   * @param {number} value
   * @param {number} alignment
   */
  constructor(what, value, alignment) {
    super(
      'BAD_ALIGNMENT',
      `${what} 0x${value.toString(16)} must be a multiple of 0x${alignment.toString(16)}.`,
      { what, value, alignment },
    );
  }

  /**
   * Throws unless `value` is a multiple of `alignment`.
   * @param {string} what
   * @param {number} value
   * @param {number} alignment
   */
  static check(what, value, alignment) {
    if (value % alignment !== 0) throw new AlignmentError(what, value, alignment);
  }
}

export class OutOfRangeError extends EspFlashError {
  /**
   * @param {number} address
   * @param {number} size
   * @param {number} limit
   */
  constructor(address, size, limit) {
    super(
      'OUT_OF_RANGE',
      `Range 0x${address.toString(16)}+0x${size.toString(16)} exceeds the ` +
        `0x${limit.toString(16)} byte limit.`,
      { address, size, limit },
    );
  }
}

export class NvsCapacityError extends EspFlashError {
  /**
   * @param {number} required
   * @param {number} available
   */
  constructor(required, available) {
    super(
      'NVS_CAPACITY',
      `NVS data does not fit: needs at least ${required} bytes, partition is ${available}.`,
      { required, available },
    );
  }
}

/**
 * Thrown when a filesystem image cannot hold what it was asked to hold.
 *
 * Reported in the format's own storage unit rather than in bytes, because that
 * is what actually ran out: a 4 KB SPIFFS page holds 251 bytes of a file, and
 * a LittleFS block holds one file's worth of data however small the file is.
 * Quoting bytes would suggest the shortfall can be closed by shaving bytes off
 * a file, which is usually false.
 */
export class FsCapacityError extends EspFlashError {
  /**
   * @param {string} format  'spiffs', 'littlefs' or 'fat'.
   * @param {string} unit    What ran out: 'page', 'block', 'cluster', …
   * @param {number} required
   * @param {number} available
   */
  constructor(format, unit, required, available) {
    super(
      'FS_CAPACITY',
      `${format} image does not fit: needs ${required} ${unit}s, has ${available}.`,
      { format, unit, required, available },
    );
  }
}

/**
 * Thrown when a path cannot be stored in the target filesystem.
 *
 * The three formats disagree about what a path is, and the disagreement is not
 * cosmetic: SPIFFS has no directories at all and stores `/a/b.txt` as a
 * 31-character name, so a path that fits LittleFS may be unrepresentable in
 * the image next to it.
 */
export class FsPathError extends EspFlashError {
  /**
   * @param {string} path
   * @param {string} reason
   */
  constructor(path, reason) {
    super('FS_PATH', `Cannot store "${path}": ${reason}`, { path, reason });
  }
}

/**
 * Thrown when an operation is cancelled through an AbortSignal.
 *
 * Flash state after a cancelled write or erase is undefined; that fact is part
 * of the message so it survives into logs and bug reports.
 */
export class OperationAbortedError extends EspFlashError {
  /** @param {string} phase */
  constructor(phase) {
    super(
      'ABORTED',
      `Operation aborted during "${phase}". If this was a write or erase, the ` +
        'flash contents of the target region are now undefined.',
      { phase },
    );
  }
}

/**
 * Throws OperationAbortedError if the signal has been aborted.
 * @param {AbortSignal|undefined} signal
 * @param {string} phase
 */
export function throwIfAborted(signal, phase) {
  if (signal?.aborted) throw new OperationAbortedError(phase);
}
