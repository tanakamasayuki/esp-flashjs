// @ts-check
/**
 * Converting library values to and from the strings a UI shows and accepts.
 *
 * Separate from the components that use them because they are pure functions
 * over data, and a component module cannot be imported outside a browser — it
 * calls `customElements.define` at load. Keeping these here is what lets them
 * be tested at all.
 */

import { bytesToHex } from './esp-flashjs.js';

/** How much of a blob to show before giving up and stating its length. */
const BLOB_PREVIEW_BYTES = 24;

/**
 * Whether a value of this type can be edited in a text field.
 *
 * Blobs cannot. A text box is the wrong instrument for arbitrary bytes, and
 * offering one that silently truncates or mangles them would be worse than
 * offering nothing.
 *
 * @param {string} type
 * @returns {boolean}
 */
export function isEditableType(type) {
  return type !== 'BLOB';
}

/**
 * @param {{type: string, value: unknown}} entry
 * @returns {string}
 */
export function displayValue(entry) {
  const value = entry.value;
  if (value instanceof Uint8Array) {
    const head = bytesToHex(value.subarray(0, BLOB_PREVIEW_BYTES), ' ');
    return value.length > BLOB_PREVIEW_BYTES ? `${head} … (${value.length} bytes)` : head;
  }
  return String(value);
}

/**
 * A value short enough to sit in a one-line change summary.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shortValue(value) {
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  const text = String(value);
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

/**
 * Turns the text in an edit box into a value of the declared type.
 *
 * Rejecting here rather than at build time is the point. `buildNvs` would also
 * refuse — it checks every value against its type — but by then the user has
 * read a confirmation dialog and typed a partition name to get past it. A red
 * field is a better place to find out that "12.5" is not a U32.
 *
 * @param {string} type
 * @param {string} text
 * @returns {number|bigint|string}
 * @throws {TypeError} When the text cannot be a value of that type.
 */
export function parseValue(type, text) {
  if (type === 'STR') return text;

  const trimmed = text.trim();
  if (trimmed === '') throw new TypeError('A value is required.');

  if (type === 'U64' || type === 'I64') {
    // BigInt() rejects "1.5" and "abc" but accepts "0x10" and "", so the empty
    // case is handled above and the rest is left to it.
    try {
      return BigInt(trimmed);
    } catch {
      throw new TypeError(`"${text}" is not a whole number.`);
    }
  }

  // Number() accepts "1e3" and "0x10", both of which are whole numbers and
  // both of which someone might reasonably type. It also accepts "" and "  ",
  // which is why those are rejected above.
  const n = Number(trimmed);
  if (!Number.isInteger(n)) throw new TypeError(`"${text}" is not a whole number.`);
  return n;
}

/**
 * Flattens a filesystem path into something a download can be named.
 *
 * A slash in a download name is not a directory — browsers either strip it or
 * refuse the download — so separators are folded into the name. The prefix
 * keeps two images' worth of `hello.txt` apart in a downloads folder.
 *
 * @param {string} prefix
 * @param {string} path
 * @returns {string}
 */
export function downloadName(prefix, path) {
  const flat = path.replace(/^\//, '').replace(/\//g, '_') || 'file';
  return `${prefix}_${flat}`;
}
