// @ts-check
/**
 * Byte and text search over binary buffers.
 *
 * @module binary/search
 */

/**
 * @typedef {object} BytePattern
 * @property {Uint8Array} bytes Pattern bytes. Positions where `mask` is 0 are ignored.
 * @property {Uint8Array} mask  0xFF to compare, 0x00 to treat as a wildcard.
 */

/**
 * Parses a hex search pattern, where `??` (or `**`) matches any byte.
 *
 * @example parseHexPattern('AA 50 ?? 02')
 * @param {string} text
 * @returns {BytePattern}
 * @throws {Error} On malformed input.
 */
export function parseHexPattern(text) {
  const tokens = text.trim().split(/[\s:_-]+/).filter(Boolean);
  /** @type {number[]} */
  const bytes = [];
  /** @type {number[]} */
  const mask = [];

  for (const token of tokens) {
    // A run of hex digits without separators, e.g. "AA50", is split into pairs.
    if (/^[0-9a-fA-F]+$/.test(token)) {
      if (token.length % 2 !== 0) {
        throw new Error(`"${token}" has an odd number of hex digits.`);
      }
      for (let i = 0; i < token.length; i += 2) {
        bytes.push(Number.parseInt(token.substr(i, 2), 16));
        mask.push(0xff);
      }
      continue;
    }
    if (/^(\?\?|\*\*)$/.test(token)) {
      bytes.push(0);
      mask.push(0);
      continue;
    }
    throw new Error(`"${token}" is not a hex byte or a wildcard.`);
  }

  if (bytes.length === 0) throw new Error('Search pattern is empty.');
  return { bytes: new Uint8Array(bytes), mask: new Uint8Array(mask) };
}

/**
 * Finds every occurrence of a byte pattern.
 *
 * @param {Uint8Array} data
 * @param {Uint8Array|BytePattern} pattern
 * @param {object} [options]
 * @param {number} [options.from]  Offset to start at.
 * @param {number} [options.limit] Maximum number of hits to return.
 * @returns {number[]} Offsets, ascending.
 */
export function searchBytes(data, pattern, { from = 0, limit = 1000 } = {}) {
  const { bytes, mask } = pattern instanceof Uint8Array
    ? { bytes: pattern, mask: null }
    : pattern;

  /** @type {number[]} */
  const hits = [];
  if (bytes.length === 0 || bytes.length > data.length) return hits;

  const last = data.length - bytes.length;
  const first = bytes[0];
  const firstIsWildcard = mask !== null && mask[0] === 0;

  for (let i = Math.max(0, from); i <= last; i++) {
    // Cheap rejection on the first byte before the inner loop.
    if (!firstIsWildcard && data[i] !== first) continue;

    let matched = true;
    for (let j = 1; j < bytes.length; j++) {
      if (mask !== null && mask[j] === 0) continue;
      if (data[i + j] !== bytes[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      hits.push(i);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * Finds every occurrence of a text string.
 *
 * @param {Uint8Array} data
 * @param {string} text
 * @param {object} [options]
 * @param {'utf-8'|'ascii'|'utf-16le'} [options.encoding]
 * @param {boolean} [options.caseInsensitive] ASCII-only case folding.
 * @param {number} [options.from]
 * @param {number} [options.limit]
 * @returns {number[]}
 */
export function searchText(data, text, options = {}) {
  const {
    encoding = 'utf-8',
    caseInsensitive = false,
    from = 0,
    limit = 1000,
  } = options;

  if (text === '') return [];

  if (!caseInsensitive) {
    return searchBytes(data, encodeText(text, encoding), { from, limit });
  }

  // Case-insensitive search runs both cases through a masked pattern so a
  // single pass finds either. Only ASCII letters differ by bit 5, so this is
  // exact for ASCII and falls back to case-sensitive for anything else.
  const lower = encodeText(text.toLowerCase(), encoding);
  const upper = encodeText(text.toUpperCase(), encoding);
  if (lower.length !== upper.length) {
    // Case folding changed the byte length (e.g. 'ß'); do two exact searches.
    const merged = new Set([
      ...searchBytes(data, lower, { from, limit }),
      ...searchBytes(data, upper, { from, limit }),
    ]);
    return [...merged].sort((a, b) => a - b).slice(0, limit);
  }

  /** @type {number[]} */
  const hits = [];
  const last = data.length - lower.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let matched = true;
    for (let j = 0; j < lower.length; j++) {
      const b = data[i + j];
      if (b !== lower[j] && b !== upper[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      hits.push(i);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * @param {string} text
 * @param {'utf-8'|'ascii'|'utf-16le'} encoding
 * @returns {Uint8Array}
 */
function encodeText(text, encoding) {
  if (encoding === 'utf-16le') {
    const out = new Uint8Array(text.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    return out;
  }
  if (encoding === 'ascii') {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
    return out;
  }
  return new TextEncoder().encode(text);
}

/**
 * Extracts printable ASCII runs, the way `strings(1)` does.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.minLength]
 * @param {number} [options.limit]
 * @returns {Array<{offset: number, text: string}>}
 */
export function extractStrings(data, { minLength = 4, limit = 10000 } = {}) {
  /** @type {Array<{offset: number, text: string}>} */
  const out = [];
  let start = -1;

  for (let i = 0; i <= data.length; i++) {
    const b = i < data.length ? data[i] : 0;
    const printable = b >= 0x20 && b < 0x7f;
    if (printable) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) {
      if (i - start >= minLength) {
        let text = '';
        for (let k = start; k < i; k++) text += String.fromCharCode(data[k]);
        out.push({ offset: start, text });
        if (out.length >= limit) return out;
      }
      start = -1;
    }
  }
  return out;
}
