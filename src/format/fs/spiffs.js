// @ts-check
/**
 * SPIFFS parsing.
 *
 * The layout below was read out of images three real devices wrote, not
 * transcribed from a header file, because the on-flash struct does not match a
 * naive reading of the source: `u32 size` lands at offset 8 rather than 6,
 * with three bytes of padding after the page header, so the name starts at 13.
 * Assuming a packed struct puts every field in the wrong place while still
 * producing plausible-looking output.
 *
 * ```text
 * Block (4096 bytes by default)
 *   0        object lookup table: one u16 per *non-lookup* page in the block
 *   pageSize first data page
 *
 * Page header (5 bytes, every page)
 *   0  2  object id; bit 15 set means this page is an object index
 *   2  2  span index
 *   4  1  flags, active low
 *
 * Object index header page (span 0 of an index)
 *   5  3  padding, from struct alignment; carries no meaning
 *   8  4  file size, 0xFFFFFFFF until the file is closed
 *   12 1  type, 1 = file
 *   13 n  name, NUL-terminated, with its leading slash
 * ```
 *
 * The lookup table indexes only the pages that can hold data, so entry `i`
 * describes page `i + lookupPages`. Reading it as page `i` shifts every entry
 * by one and makes deleted pages look like live ones.
 *
 * @module format/fs/spiffs
 */

import { decodeCString } from '../../util/hex.js';

/**
 * @typedef {import('../partition.js').Issue} Issue
 * @typedef {import('./types.js').FsFile} FsFile
 * @typedef {import('./types.js').FsImage} FsImage
 */

/** Page header size, and therefore the amount each data page loses to it. */
export const SPIFFS_PAGE_HEADER_SIZE = 5;

/** Where the name begins in an object index header page. */
export const SPIFFS_NAME_OFFSET = 13;

/** Set in an object id to mark the page as an object index rather than data. */
export const SPIFFS_OBJ_ID_IX_FLAG = 0x8000;

/** An erased lookup slot or page header. */
const SPIFFS_OBJ_ID_FREE = 0xffff;

/** Written when a page is released; the id is cleared but the page is not erased. */
const SPIFFS_OBJ_ID_DELETED = 0x0000;

/** Size field of an index header that was never finalised. */
const SPIFFS_UNDEFINED_LEN = 0xffffffff;

/** SPIFFS_TYPE_FILE. */
const SPIFFS_TYPE_FILE = 1;

/**
 * Page flags, all active low: a zero bit means the property holds.
 *
 * Flash can only clear bits, so SPIFFS starts every flag at 1 and clears it to
 * record that something happened. Testing them the obvious way round inverts
 * every decision.
 */
export const SPIFFS_FLAG = {
  USED: 1 << 0,
  FINAL: 1 << 1,
  INDEX: 1 << 2,
  IXDELE: 1 << 6,
  DELET: 1 << 7,
};

/**
 * Whether a flag is asserted.
 *
 * The bit being *zero* is what asserts it, so `asserted(flags, DELET)` means
 * the page has been deleted, not that it is intact. Reading these the usual
 * way round inverts every decision at once, which looks like a filesystem full
 * of empty files rather than like a bug.
 *
 * @param {number} flags
 * @param {number} bit
 * @returns {boolean}
 */
const asserted = (flags, bit) => (flags & bit) === 0;

/** Geometries to try when the caller does not know, in the order they are tried. */
export const SPIFFS_GEOMETRIES = Object.freeze([
  { pageSize: 256, blockSize: 4096 },
  { pageSize: 256, blockSize: 8192 },
  { pageSize: 512, blockSize: 4096 },
  { pageSize: 512, blockSize: 8192 },
  { pageSize: 128, blockSize: 4096 },
]);

/**
 * @param {number} pageSize
 * @param {number} blockSize
 * @returns {number} Pages at the start of each block holding the lookup table.
 */
export function spiffsLookupPages(pageSize, blockSize) {
  const pagesPerBlock = Math.floor(blockSize / pageSize);
  return Math.ceil((pagesPerBlock * 2) / pageSize);
}

/**
 * Parses a SPIFFS image.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @param {number} [options.blockSize]
 * @param {number} [options.objNameLen]
 * @param {boolean} [options.detectGeometry] Sweep geometries when the given
 *   one yields nothing. On by default: page and block size cannot be read out
 *   of a SPIFFS image, so a wrong guess is indistinguishable from an empty
 *   filesystem until another combination is tried.
 * @returns {FsImage}
 */
export function parseSpiffs(data, options = {}) {
  const {
    pageSize = 256,
    blockSize = 4096,
    objNameLen = 32,
    detectGeometry = true,
  } = options;

  const requested = parseWithGeometry(data, pageSize, blockSize, objNameLen);
  if (!detectGeometry) return requested;

  // Taking the first geometry that finds anything is not good enough: a wrong
  // one still produces plausible output. Read with 128-byte pages, these
  // images yield all four correct filenames — and a /big.bin whose contents
  // are scrambled. Every candidate is therefore scored on whether the files it
  // finds actually hold together, not on whether it found any.
  let best = { image: requested, score: scoreGeometry(requested) };
  for (const candidate of SPIFFS_GEOMETRIES) {
    if (candidate.pageSize === pageSize && candidate.blockSize === blockSize) continue;
    const attempt = parseWithGeometry(data, candidate.pageSize, candidate.blockSize, objNameLen);
    const score = scoreGeometry(attempt);
    // Strictly better only, so the caller's geometry and then the most common
    // one win any tie.
    if (score > best.score) best = { image: attempt, score };
  }

  if (best.image !== requested) {
    best.image.issues.unshift({
      // Worth surfacing: the caller's geometry was wrong, and the one used
      // instead is inferred, so the UI should show it and allow an override.
      level: 'warning',
      code: 'spiffs.geometryDetected',
      params: { pageSize: best.image.geometry.pageSize, blockSize: best.image.geometry.blockSize },
    });
  }
  return best.image;
}

/**
 * How well a geometry explains the image.
 *
 * A file that is present but missing pages, or whose recorded length does not
 * match the pages found for it, is the signature of a misread layout. Counting
 * only files that hold together separates the right geometry from ones that
 * merely find names.
 *
 * @param {FsImage} image
 * @returns {number}
 */
function scoreGeometry(image) {
  const complete = image.files.filter((f) => f.complete).length;
  return complete * 1000 + image.files.length * 10 - image.issues.length;
}

/**
 * @param {Uint8Array} data
 * @param {number} pageSize
 * @param {number} blockSize
 * @param {number} objNameLen
 * @returns {FsImage}
 */
function parseWithGeometry(data, pageSize, blockSize, objNameLen) {
  /** @type {Issue[]} */
  const issues = [];
  const geometry = {
    pageSize,
    blockSize,
    pagesPerBlock: Math.floor(blockSize / pageSize),
    blocks: Math.floor(data.length / blockSize),
    lookupPages: spiffsLookupPages(pageSize, blockSize),
    dataPerPage: pageSize - SPIFFS_PAGE_HEADER_SIZE,
  };

  if (geometry.blocks === 0 || geometry.pagesPerBlock <= geometry.lookupPages) {
    issues.push({
      level: 'error',
      code: 'spiffs.tooSmall',
      params: { length: data.length, blockSize },
    });
    return { type: 'spiffs', files: [], geometry, issues };
  }

  /** Live object index headers, by object id. @type {Map<number, any>} */
  const indexes = new Map();
  /** Data pages by object id, then span. @type {Map<number, Map<number, number>>} */
  const dataPages = new Map();

  for (let block = 0; block < geometry.blocks; block++) {
    for (let p = geometry.lookupPages; p < geometry.pagesPerBlock; p++) {
      const at = block * blockSize + p * pageSize;
      if (at + pageSize > data.length) break;

      const objId = readU16(data, at);
      const spanIx = readU16(data, at + 2);
      const flags = data[at + 4];

      if (objId === SPIFFS_OBJ_ID_FREE || objId === SPIFFS_OBJ_ID_DELETED) continue;
      if (!asserted(flags, SPIFFS_FLAG.USED)) continue;
      // A page with DELET asserted has been superseded. Keeping it would
      // resurrect an older version of a file over the current one.
      if (asserted(flags, SPIFFS_FLAG.DELET)) continue;

      if (asserted(flags, SPIFFS_FLAG.INDEX)) {
        if (spanIx !== 0) continue; // continuation of an index, not a header
        const id = objId & ~SPIFFS_OBJ_ID_IX_FLAG;
        const type = data[at + 12];
        if (type !== SPIFFS_TYPE_FILE) continue;
        const size = readU32(data, at + 8);
        const name = decodeCString(data.subarray(at + SPIFFS_NAME_OFFSET, at + SPIFFS_NAME_OFFSET + objNameLen));
        if (name.length === 0) continue;
        indexes.set(id, { id, name, size, page: at });
      } else {
        let spans = dataPages.get(objId);
        if (!spans) dataPages.set(objId, (spans = new Map()));
        // Later pages win: a rewritten span is appended, and the loop walks
        // the image in address order.
        spans.set(spanIx, at);
      }
    }
  }

  /** @type {FsFile[]} */
  const files = [];

  for (const index of [...indexes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const spans = dataPages.get(index.id) ?? new Map();
    const size = index.size === SPIFFS_UNDEFINED_LEN ? null : index.size;

    // An empty file legitimately has no size recorded — there was never any
    // data to finalise — so warning about it would train people to ignore the
    // warning that matters, which is a file whose length was lost.
    if (size === null && spans.size > 0) {
      issues.push({ level: 'warning', code: 'spiffs.sizeUndefined', params: { path: index.name } });
    }

    const needed = size === null ? spans.size : Math.ceil(size / geometry.dataPerPage);
    /** @type {number[]} */
    const pageOffsets = [];
    let complete = true;
    for (let span = 0; span < needed; span++) {
      const offset = spans.get(span);
      if (offset === undefined) {
        complete = false;
        continue;
      }
      pageOffsets.push(offset);
    }
    if (!complete) {
      issues.push({ level: 'warning', code: 'spiffs.missingPages', params: { path: index.name } });
    }

    files.push({
      path: index.name,
      size: size ?? pageOffsets.length * geometry.dataPerPage,
      pageIndices: pageOffsets.map((o) => Math.floor(o / pageSize)),
      complete,
      read: () => readFileData(data, spans, size, needed, geometry),
    });
  }

  return { type: 'spiffs', files, geometry, issues };
}

/**
 * @param {Uint8Array} data
 * @param {Map<number, number>} spans
 * @param {number|null} size
 * @param {number} needed
 * @param {{dataPerPage: number}} geometry
 * @returns {Uint8Array}
 */
function readFileData(data, spans, size, needed, geometry) {
  const total = size ?? needed * geometry.dataPerPage;
  const out = new Uint8Array(total);
  let written = 0;

  for (let span = 0; span < needed && written < total; span++) {
    const at = spans.get(span);
    // A hole reads as zeros rather than shifting everything after it, so the
    // bytes that did survive stay at their real offsets.
    if (at === undefined) {
      written = Math.min(total, written + geometry.dataPerPage);
      continue;
    }
    const chunk = data.subarray(
      at + SPIFFS_PAGE_HEADER_SIZE,
      at + SPIFFS_PAGE_HEADER_SIZE + Math.min(geometry.dataPerPage, total - written),
    );
    out.set(chunk, written);
    written += chunk.length;
  }
  return out;
}

/** @param {Uint8Array} d @param {number} o */
const readU16 = (d, o) => d[o] | (d[o + 1] << 8);

/** @param {Uint8Array} d @param {number} o */
const readU32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
