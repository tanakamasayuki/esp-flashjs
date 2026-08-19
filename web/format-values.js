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
 * The name a single extracted file is saved under.
 *
 * Its own name, not a decorated one. Prefixing with the partition and folding
 * the directories into the filename kept two images' worth of `hello.txt`
 * apart, but it meant `hello.txt` never once arrived called `hello.txt` — and
 * the collision it was avoiding is one browsers already handle by appending a
 * number. Extracting everything at once produces a ZIP, which keeps the real
 * paths, so the case this was solving for has a better answer now.
 *
 * A slash cannot survive: browsers either strip it or refuse the download.
 *
 * @param {string} path
 * @returns {string}
 */
export function downloadName(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  // Reserved on Windows and awkward everywhere; a filesystem image can carry
  // names a host will not.
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'file';
}

/**
 * The name for a whole extracted filesystem.
 *
 * @param {string} prefix Usually the partition label.
 * @returns {string}
 */
export function archiveName(prefix) {
  return `${prefix.replace(/[\\/:*?"<>|]/g, '_') || 'fs'}-files.zip`;
}

/**
 * The text in a file, or null when it is not text.
 *
 * Strict UTF-8 is most of the test — a decoder that substitutes replacement
 * characters would happily "decode" a firmware image and offer it for editing,
 * and saving that back would replace every undecodable byte with U+FFFD. A NUL
 * rules a file out too: it decodes cleanly and means the file is not text.
 *
 * @param {Uint8Array} bytes
 * @param {number} [limit] Above this, no. A text box is not a hex editor, and
 *   a megabyte in a textarea is a frozen tab.
 * @returns {string|null}
 */
export function decodeTextFile(bytes, limit = 256 * 1024) {
  if (bytes.length > limit) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}
