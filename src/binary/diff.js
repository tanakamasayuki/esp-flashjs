// @ts-check
/**
 * Binary comparison.
 *
 * Differences are grouped into runs so that a handful of scattered byte
 * changes in a 4 MB image produce a handful of chunks rather than thousands.
 *
 * @module binary/diff
 */

/**
 * @typedef {object} BinaryDiffChunk
 * @property {number} offset
 * @property {Uint8Array} before
 * @property {Uint8Array} after
 * @property {'modified'|'added'|'removed'} kind
 */

/**
 * @typedef {object} DiffOptions
 * @property {number} [minGap] Runs of identical bytes shorter than this do not
 *   split a chunk. Prevents one changed string from becoming twenty chunks.
 * @property {number} [maxChunks] Stop after this many chunks.
 */

/**
 * Compares two buffers.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {DiffOptions} [options]
 * @returns {BinaryDiffChunk[]}
 */
export function diffBinary(a, b, options = {}) {
  /** @type {BinaryDiffChunk[]} */
  const chunks = [];
  for (const chunk of diffCommon(a, b, options)) chunks.push(chunk);
  return chunks;
}

/**
 * Async generator variant that yields control periodically.
 *
 * Comparing two 16 MB dumps synchronously blocks the main thread long enough
 * to freeze the page, so the UI always uses this form.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {DiffOptions & {chunkBytes?: number}} [options]
 * @returns {AsyncGenerator<BinaryDiffChunk, void, void>}
 */
export async function* diffBinaryStream(a, b, options = {}) {
  const yieldEvery = options.chunkBytes ?? 1024 * 1024;
  let sinceYield = 0;
  let lastOffset = 0;

  for (const chunk of diffCommon(a, b, options)) {
    sinceYield += chunk.offset - lastOffset;
    lastOffset = chunk.offset;
    if (sinceYield >= yieldEvery) {
      sinceYield = 0;
      // Hand the event loop a turn so the UI can paint and stay responsive.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    yield chunk;
  }
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {DiffOptions} options
 * @returns {Generator<BinaryDiffChunk, void, void>}
 */
function* diffCommon(a, b, options) {
  const minGap = options.minGap ?? 16;
  const maxChunks = options.maxChunks ?? Infinity;
  const common = Math.min(a.length, b.length);

  let emitted = 0;
  let runStart = -1; // First differing byte of the open chunk.
  let lastDiff = -1; // Most recent differing byte.

  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) {
      if (runStart === -1) runStart = i;
      lastDiff = i;
      continue;
    }
    // Close the chunk only once `minGap` identical bytes have gone by, so a
    // short identical stretch inside a changed region does not split it.
    if (runStart !== -1 && i - lastDiff >= minGap) {
      yield {
        offset: runStart,
        before: a.slice(runStart, lastDiff + 1),
        after: b.slice(runStart, lastDiff + 1),
        kind: 'modified',
      };
      if (++emitted >= maxChunks) return;
      runStart = -1;
    }
  }

  if (runStart !== -1) {
    yield {
      offset: runStart,
      before: a.slice(runStart, lastDiff + 1),
      after: b.slice(runStart, lastDiff + 1),
      kind: 'modified',
    };
    if (++emitted >= maxChunks) return;
  }

  // Trailing bytes present in only one of the two buffers.
  if (a.length > common) {
    yield {
      offset: common,
      before: a.slice(common),
      after: new Uint8Array(0),
      kind: 'removed',
    };
  } else if (b.length > common) {
    yield {
      offset: common,
      before: new Uint8Array(0),
      after: b.slice(common),
      kind: 'added',
    };
  }
}

/**
 * Summarizes a diff without materializing the changed bytes.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {{identical: boolean, differingBytes: number, firstDifference: number|null, lengthDelta: number}}
 */
export function diffSummary(a, b) {
  const common = Math.min(a.length, b.length);
  let differing = 0;
  let first = null;
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) {
      if (first === null) first = i;
      differing++;
    }
  }
  const lengthDelta = b.length - a.length;
  if (lengthDelta !== 0 && first === null) first = common;
  return {
    identical: differing === 0 && lengthDelta === 0,
    differingBytes: differing + Math.abs(lengthDelta),
    firstDifference: first,
    lengthDelta,
  };
}

/**
 * Reports whether a region is entirely one byte value.
 *
 * Used to distinguish "erased" (all 0xFF) and "zeroed" regions from real data,
 * which matters when deciding whether a partition has ever been written.
 *
 * @param {Uint8Array} data
 * @param {number} value
 * @returns {boolean}
 */
export function isUniform(data, value) {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== value) return false;
  }
  return true;
}

/**
 * Shannon entropy in bits per byte, used to flag likely-encrypted regions.
 *
 * @param {Uint8Array} data
 * @returns {number} 0 to 8.
 */
export function entropy(data) {
  if (data.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) counts[data[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / data.length;
    h -= p * Math.log2(p);
  }
  return h;
}
