// @ts-check
/**
 * Hex and byte formatting helpers.
 *
 * These produce technical notation that is deliberately not localized —
 * `0x00009000` reads the same in every language.
 *
 * @module util/hex
 */

const HEX = /** @type {string[]} */ (
  Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
);

/**
 * Formats an address as `0x` + zero-padded uppercase-free hex.
 * @param {number} value
 * @param {number} [digits] Minimum digit count. Defaults to 8 (32-bit).
 * @returns {string}
 */
export function toHexAddress(value, digits = 8) {
  return '0x' + value.toString(16).padStart(digits, '0');
}

/**
 * Converts bytes to a lowercase hex string.
 * @param {Uint8Array} bytes
 * @param {string} [separator]
 * @returns {string}
 */
export function bytesToHex(bytes, separator = '') {
  if (separator === '') {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
    return out;
  }
  const parts = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX[bytes[i]];
  return parts.join(separator);
}

/**
 * Parses a hex string into bytes. Whitespace, `:` and `-` separators are
 * ignored, so `"AA 50"`, `"aa:50"` and `"AA50"` are all accepted.
 *
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {Error} If the string contains non-hex characters or has odd length.
 */
export function hexToBytes(text) {
  const clean = text.replace(/[\s:_-]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Hex string must have an even number of digits, got ${clean.length}.`);
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Hex string contains non-hexadecimal characters.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Parses an address written as `0x1000`, `1000h`, or decimal `4096`.
 *
 * A bare string of hex digits without a prefix is treated as decimal when it
 * parses as decimal, so callers that need hex must use the `0x` prefix. This
 * avoids the classic ambiguity of `"10"` meaning 16.
 *
 * @param {string} text
 * @returns {number}
 * @throws {Error} If the text is not a valid non-negative integer.
 */
export function parseAddress(text) {
  const t = text.trim();
  let value;
  if (/^0x[0-9a-fA-F]+$/.test(t)) value = Number.parseInt(t.slice(2), 16);
  else if (/^[0-9a-fA-F]+h$/i.test(t)) value = Number.parseInt(t.slice(0, -1), 16);
  else if (/^\d+$/.test(t)) value = Number.parseInt(t, 10);
  else throw new Error(`"${text}" is not a valid address.`);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`"${text}" is not a valid address.`);
  }
  return value;
}

/**
 * Renders bytes as a `0000  AA 50 ..  |ASCII|` style dump. Intended for logs
 * and tests; the interactive viewer renders its own rows.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {number} [options.baseAddress]
 * @param {number} [options.bytesPerRow]
 * @returns {string}
 */
export function hexDump(bytes, { baseAddress = 0, bytesPerRow = 16 } = {}) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    const row = bytes.subarray(offset, offset + bytesPerRow);
    const hexPart = [];
    for (let i = 0; i < bytesPerRow; i++) {
      hexPart.push(i < row.length ? HEX[row[i]] : '  ');
      if (i === bytesPerRow / 2 - 1) hexPart.push('');
    }
    lines.push(
      `${(baseAddress + offset).toString(16).padStart(8, '0')}  ` +
        `${hexPart.join(' ')}  |${toPrintableAscii(row)}|`,
    );
  }
  return lines.join('\n');
}

/**
 * Maps bytes to printable ASCII, substituting `.` for anything else.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toPrintableAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return out;
}

/**
 * Formats a byte count for display, e.g. `4.0 MB`.
 *
 * Uses binary units because flash geometry is always a power of two. The unit
 * suffixes are intentionally not localized.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // Whole numbers are the common case (4 MB, 16 MB) and look wrong as "4.0".
  return Number.isInteger(value) ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Decodes a fixed-width NUL-terminated ASCII field, as used by partition
 * labels and NVS keys.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeCString(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  let out = '';
  for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Encodes a string into a fixed-width NUL-padded field.
 *
 * @param {string} text
 * @param {number} width
 * @returns {Uint8Array}
 * @throws {Error} If the text does not fit, leaving room for the terminator.
 */
export function encodeCString(text, width) {
  const out = new Uint8Array(width);
  if (text.length >= width) {
    throw new Error(`"${text}" is too long for a ${width}-byte field (max ${width - 1} chars).`);
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new Error(`"${text}" contains non-ASCII characters.`);
    out[i] = code;
  }
  return out;
}
