// @ts-check
/**
 * SPIFFS building — turning a store back into a mountable image.
 *
 * Reading a SPIFFS image and writing one need different parts of the format.
 * The parser never looks at an object index: it sweeps every page and groups
 * them by object id and span, which is robust and is what you want when the
 * image may be damaged. A device does the opposite. It finds the object index
 * header through the lookup table and then reads the file's data pages *from
 * the page numbers listed in that index*. An image whose index arrays are
 * wrong therefore parses perfectly here and mounts empty on hardware.
 *
 * That asymmetry is why {@link readSpiffsViaIndex} exists, and why the build
 * self-check goes through it rather than through `parseSpiffs`.
 *
 * Three details below were taken from images the reference devices wrote, not
 * from the headers, and each of them is silent when wrong:
 *
 *   - Every block carries a magic in the last four bytes of its lookup area,
 *     `0x20140529 ^ pageSize ^ (blockCount - block)` truncated to 16 bits, and
 *     an erase count in the two bytes after it. A block without the magic is
 *     not "slightly off"; the device declines to mount and offers to format.
 *   - The object index array starts after the name *and* a four-byte metadata
 *     field, so at offset 49 for a 32-byte name. Putting it at 45 shifts every
 *     page number by two.
 *   - Page flags are active low. A live data page is 0xFC and a live object
 *     index header is 0xF8; the difference is the INDEX bit.
 *
 * @module format/fs/spiffs-build
 */

import { FsCapacityError, FsPathError } from '../../util/errors.js';
import { verifyFsBuild } from './verify.js';
import {
  SPIFFS_FLAG,
  SPIFFS_NAME_OFFSET,
  SPIFFS_OBJ_ID_IX_FLAG,
  SPIFFS_PAGE_HEADER_SIZE,
  spiffsLookupPages,
} from './spiffs.js';

/**
 * @typedef {import('./store.js').FsStore} FsStore
 * @typedef {import('./types.js').FsImage} FsImage
 * @typedef {import('./types.js').FsFile} FsFile
 * @typedef {import('../partition.js').Issue} Issue
 */

/**
 * Bytes of metadata between the name and the object index array.
 *
 * ESP-IDF compiles SPIFFS with `CONFIG_SPIFFS_META_LENGTH=4` and stores the
 * modification time there. The value is not interesting; its *width* is, since
 * it sits between the name and the page numbers.
 */
export const SPIFFS_META_LENGTH = 4;

/** Name field width, including the terminator. */
export const SPIFFS_OBJ_NAME_LEN = 32;

/** Flags byte of a live data page: USED and FINAL asserted, INDEX not. */
export const SPIFFS_DATA_PAGE_FLAGS = 0xff & ~(SPIFFS_FLAG.USED | SPIFFS_FLAG.FINAL);

/** Flags byte of a live object index page: USED, FINAL and INDEX asserted. */
export const SPIFFS_INDEX_PAGE_FLAGS =
  0xff & ~(SPIFFS_FLAG.USED | SPIFFS_FLAG.FINAL | SPIFFS_FLAG.INDEX);

/** Highest object id available; bit 15 is the index flag and 0/0xFFFF are reserved. */
const MAX_OBJ_ID = 0x7ffe;

/**
 * The value a block must carry for a device to accept the image.
 *
 * The block count is mixed in, which is what makes a SPIFFS image refuse to
 * mount in a partition of a different size instead of reading garbage out of
 * it.
 *
 * @param {number} pageSize
 * @param {number} blockCount
 * @param {number} blockIndex
 * @returns {number} 16-bit.
 */
export function spiffsMagic(pageSize, blockCount, blockIndex) {
  return (0x20140529 ^ pageSize ^ (blockCount - blockIndex)) & 0xffff;
}

/**
 * Where the object index array begins in each kind of index page.
 *
 * @param {number} objNameLen
 * @param {number} metaLength
 * @returns {{header: number, continuation: number}}
 */
export function spiffsIndexOffsets(objNameLen, metaLength) {
  return {
    header: SPIFFS_NAME_OFFSET + objNameLen + metaLength,
    // A continuation page is just the 5-byte page header rounded up to the
    // next four-byte boundary by the same struct alignment as the header page.
    continuation: 8,
  };
}

/**
 * Serialises a store into a SPIFFS partition image.
 *
 * @param {FsStore} store
 * @param {object} [options]
 * @param {number} [options.size]        Image size; defaults to the store geometry.
 * @param {number} [options.pageSize]
 * @param {number} [options.blockSize]
 * @param {number} [options.objNameLen]
 * @param {number} [options.metaLength]
 * @param {boolean} [options.selfCheck]  Read the result back through the
 *   object indexes and compare. On by default.
 * @returns {Uint8Array}
 */
export function buildSpiffs(store, options = {}) {
  const pageSize = options.pageSize ?? store.geometry.pageSize ?? 256;
  const blockSize = options.blockSize ?? store.geometry.blockSize ?? 4096;
  const objNameLen = options.objNameLen ?? SPIFFS_OBJ_NAME_LEN;
  const metaLength = options.metaLength ?? SPIFFS_META_LENGTH;
  const size = options.size ?? (store.geometry.blocks ?? 0) * blockSize;
  const selfCheck = options.selfCheck ?? true;

  if (!Number.isInteger(size) || size <= 0 || size % blockSize !== 0) {
    throw new RangeError(`SPIFFS size must be a positive multiple of ${blockSize}; got ${size}.`);
  }
  if (blockSize % pageSize !== 0) {
    throw new RangeError(`SPIFFS block size ${blockSize} is not a multiple of page size ${pageSize}.`);
  }

  const pagesPerBlock = blockSize / pageSize;
  const lookupPages = spiffsLookupPages(pageSize, blockSize);
  const dataPerPage = pageSize - SPIFFS_PAGE_HEADER_SIZE;
  const blocks = size / blockSize;
  const offsets = spiffsIndexOffsets(objNameLen, metaLength);
  const headerEntries = Math.floor((pageSize - offsets.header) / 2);
  const continuationEntries = Math.floor((pageSize - offsets.continuation) / 2);

  if (blocks < 2) {
    throw new FsCapacityError('spiffs', 'block', 2, blocks);
  }
  if (headerEntries < 1) {
    throw new RangeError(
      `SPIFFS page size ${pageSize} leaves no room for an object index after a ${objNameLen}-byte name.`,
    );
  }

  const data = new Uint8Array(size).fill(0xff);

  // The magic goes in before anything else so that a build which then runs out
  // of pages still fails with a capacity error rather than leaving a
  // half-written image that looks unformatted.
  for (let block = 0; block < blocks; block++) {
    const at = block * blockSize + lookupPages * pageSize;
    writeU16(data, at - 4, spiffsMagic(pageSize, blocks, block));
    writeU16(data, at - 2, 0); // erase count, as a freshly formatted block has
  }

  /**
   * Pages available for data and indexes, in allocation order.
   *
   * The last block is held back. SPIFFS reclaims deleted pages by copying a
   * whole block elsewhere and erasing it, so an image with no free block
   * leaves the device able to read and unable to write — the same trap the NVS
   * builder avoids by keeping a page free.
   *
   * @type {number[]}
   */
  const free = [];
  for (let block = 0; block < blocks - 1; block++) {
    for (let page = lookupPages; page < pagesPerBlock; page++) {
      free.push(block * pagesPerBlock + page);
    }
  }
  const files = store.entries.filter((entry) => !entry.directory);

  // Worked out before anything is written so that a capacity error can quote
  // what the image would have needed in total, rather than the point at which
  // it happened to give up.
  let requiredPages = 0;
  for (const file of files) {
    const dataPages = Math.ceil(file.data.length / dataPerPage);
    requiredPages += 1 + dataPages + indexContinuationCount(dataPages, headerEntries, continuationEntries);
  }

  let next = 0;
  /** @returns {number} An absolute page index. */
  const allocate = () => {
    if (next >= free.length) {
      throw new FsCapacityError('spiffs', 'page', requiredPages, free.length);
    }
    return free[next++];
  };

  const encoder = new TextEncoder();
  let objId = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    if (name.length > objNameLen - 1) {
      throw new FsPathError(
        file.path,
        `SPIFFS has no directories, so the whole path is the name and must fit ` +
          `in ${objNameLen - 1} bytes; this one is ${name.length}`,
      );
    }
    if (++objId > MAX_OBJ_ID) {
      throw new FsCapacityError('spiffs', 'object', files.length, MAX_OBJ_ID);
    }

    const dataPages = Math.ceil(file.data.length / dataPerPage);
    const indexHeaderPage = allocate();

    /** Absolute page numbers of the file's data, in span order. */
    const pages = [];
    for (let span = 0; span < dataPages; span++) {
      const page = allocate();
      pages.push(page);
      const at = page * pageSize;
      writeU16(data, at, objId);
      writeU16(data, at + 2, span);
      data[at + 4] = SPIFFS_DATA_PAGE_FLAGS;
      const chunk = file.data.subarray(span * dataPerPage, (span + 1) * dataPerPage);
      data.set(chunk, at + SPIFFS_PAGE_HEADER_SIZE);
      writeLookup(data, page, objId);
    }

    // Object index header, span 0.
    const hdrAt = indexHeaderPage * pageSize;
    writeU16(data, hdrAt, objId | SPIFFS_OBJ_ID_IX_FLAG);
    writeU16(data, hdrAt + 2, 0);
    data[hdrAt + 4] = SPIFFS_INDEX_PAGE_FLAGS;
    // Bytes 5..7 are struct alignment. Real devices leave whatever was on the
    // stack there — three different values across the three reference boards —
    // which is how we know nothing reads them.
    writeU32(data, hdrAt + 8, file.data.length);
    data[hdrAt + 12] = 1; // SPIFFS_TYPE_FILE
    data.set(name, hdrAt + SPIFFS_NAME_OFFSET);
    data.fill(0, hdrAt + SPIFFS_NAME_OFFSET + name.length, hdrAt + SPIFFS_NAME_OFFSET + objNameLen);
    // Metadata is a modification time the device sets from its own clock. We
    // do not have one, and inventing a plausible timestamp would be worse than
    // leaving the field erased.
    writeLookup(data, indexHeaderPage, objId | SPIFFS_OBJ_ID_IX_FLAG);

    let written = 0;
    for (let i = 0; i < Math.min(pages.length, headerEntries); i++) {
      writeU16(data, hdrAt + offsets.header + i * 2, pages[i]);
      written++;
    }

    // Anything that did not fit continues in further index pages, found by the
    // device through the same lookup table and their span number.
    let span = 1;
    while (written < pages.length) {
      const page = allocate();
      const at = page * pageSize;
      writeU16(data, at, objId | SPIFFS_OBJ_ID_IX_FLAG);
      writeU16(data, at + 2, span);
      data[at + 4] = SPIFFS_INDEX_PAGE_FLAGS;
      writeLookup(data, page, objId | SPIFFS_OBJ_ID_IX_FLAG);
      for (let i = 0; i < continuationEntries && written < pages.length; i++) {
        writeU16(data, at + offsets.continuation + i * 2, pages[written++]);
      }
      span++;
    }
  }

  if (selfCheck) {
    verifyFsBuild(
      readSpiffsViaIndex(data, { pageSize, blockSize, objNameLen, metaLength }),
      files,
      'spiffs',
    );
  }
  return data;

  /**
   * @param {Uint8Array} image
   * @param {number} page Absolute page index.
   * @param {number} value
   */
  function writeLookup(image, page, value) {
    const block = Math.floor(page / pagesPerBlock);
    const slot = (page % pagesPerBlock) - lookupPages;
    writeU16(image, block * blockSize + slot * 2, value);
  }
}

/**
 * How many continuation index pages a file of `dataPages` pages needs.
 *
 * @param {number} dataPages
 * @param {number} headerEntries
 * @param {number} continuationEntries
 * @returns {number}
 */
function indexContinuationCount(dataPages, headerEntries, continuationEntries) {
  if (dataPages <= headerEntries) return 0;
  return Math.ceil((dataPages - headerEntries) / continuationEntries);
}

/**
 * Reads a SPIFFS image the way a device does: through the object indexes.
 *
 * `parseSpiffs` sweeps every page and groups them by object id and span, which
 * recovers files from an image whose indexes are damaged. A device cannot do
 * that — it looks up the index header, reads the page numbers out of it, and
 * trusts them. The two readers therefore disagree exactly when the indexes are
 * wrong, which is the failure a builder can produce and a parser round-trip
 * can never catch.
 *
 * Running this against the captured hardware images is what makes it worth
 * anything: it agrees with the parser on bytes this project did not write, so
 * when it also agrees on bytes this project *did* write, the indexes are right.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @param {number} [options.blockSize]
 * @param {number} [options.objNameLen]
 * @param {number} [options.metaLength]
 * @returns {FsImage}
 */
export function readSpiffsViaIndex(data, options = {}) {
  const pageSize = options.pageSize ?? 256;
  const blockSize = options.blockSize ?? 4096;
  const objNameLen = options.objNameLen ?? SPIFFS_OBJ_NAME_LEN;
  const metaLength = options.metaLength ?? SPIFFS_META_LENGTH;

  const pagesPerBlock = Math.floor(blockSize / pageSize);
  const lookupPages = spiffsLookupPages(pageSize, blockSize);
  const dataPerPage = pageSize - SPIFFS_PAGE_HEADER_SIZE;
  const blocks = Math.floor(data.length / blockSize);
  const offsets = spiffsIndexOffsets(objNameLen, metaLength);
  const headerEntries = Math.floor((pageSize - offsets.header) / 2);
  const continuationEntries = Math.floor((pageSize - offsets.continuation) / 2);

  const geometry = { pageSize, blockSize, pagesPerBlock, blocks, lookupPages, dataPerPage };
  /** @type {Issue[]} */
  const issues = [];
  /** @type {FsFile[]} */
  const files = [];

  if (blocks === 0 || pagesPerBlock <= lookupPages) {
    issues.push({ level: 'error', code: 'spiffs.tooSmall', params: { length: data.length, blockSize } });
    return { type: 'spiffs', files, geometry, issues };
  }

  // The magic is checked because a device checks it. An image that parses and
  // would not mount is a failure worth naming.
  for (let block = 0; block < blocks; block++) {
    const at = block * blockSize + lookupPages * pageSize - 4;
    const found = readU16(data, at);
    const expected = spiffsMagic(pageSize, blocks, block);
    if (found !== expected) {
      issues.push({ level: 'error', code: 'spiffs.badMagic', params: { block, found, expected } });
      break;
    }
  }

  /** Live index pages by object id, then span. @type {Map<number, Map<number, number>>} */
  const indexPages = new Map();

  for (let block = 0; block < blocks; block++) {
    for (let slot = 0; slot < pagesPerBlock - lookupPages; slot++) {
      const id = readU16(data, block * blockSize + slot * 2);
      if (id === 0xffff || id === 0x0000 || (id & SPIFFS_OBJ_ID_IX_FLAG) === 0) continue;

      const page = block * pagesPerBlock + slot + lookupPages;
      const at = page * pageSize;
      if (at + pageSize > data.length) continue;
      const flags = data[at + 4];
      // Active low: a cleared DELET bit means the page is gone.
      if ((flags & SPIFFS_FLAG.DELET) === 0) continue;
      if ((flags & SPIFFS_FLAG.USED) !== 0) continue;

      const objId = id & ~SPIFFS_OBJ_ID_IX_FLAG;
      let spans = indexPages.get(objId);
      if (!spans) indexPages.set(objId, (spans = new Map()));
      spans.set(readU16(data, at + 2), page);
    }
  }

  for (const [objId, spans] of [...indexPages].sort((a, b) => a[0] - b[0])) {
    const headerPage = spans.get(0);
    if (headerPage === undefined) {
      issues.push({ level: 'warning', code: 'spiffs.noIndexHeader', params: { objId } });
      continue;
    }
    const hdrAt = headerPage * pageSize;
    if (data[hdrAt + 12] !== 1) continue; // not a file

    const rawSize = readU32(data, hdrAt + 8);
    const size = rawSize === 0xffffffff ? 0 : rawSize;
    const name = decodeName(data, hdrAt + SPIFFS_NAME_OFFSET, objNameLen);
    if (name.length === 0) continue;

    const needed = Math.ceil(size / dataPerPage);
    /** @type {number[]} */
    const pages = [];
    let complete = true;

    for (let span = 0; span < needed; span++) {
      const page =
        span < headerEntries
          ? readU16(data, hdrAt + offsets.header + span * 2)
          : continuationEntry(span);
      if (page === undefined || page === 0xffff) {
        complete = false;
        pages.push(-1);
        continue;
      }
      // A device trusts the index. Checking the page actually belongs to this
      // file is the whole point of reading it a second way.
      const at = page * pageSize;
      if (at + pageSize > data.length || readU16(data, at) !== objId || readU16(data, at + 2) !== span) {
        issues.push({ level: 'error', code: 'spiffs.indexMismatch', params: { path: name, span, page } });
        complete = false;
        pages.push(-1);
        continue;
      }
      pages.push(page);
    }

    files.push({
      path: name,
      size,
      pageIndices: pages.filter((p) => p >= 0),
      complete,
      read: () => {
        const out = new Uint8Array(size);
        let written = 0;
        for (const page of pages) {
          if (written >= size) break;
          const take = Math.min(dataPerPage, size - written);
          if (page >= 0) {
            out.set(data.subarray(page * pageSize + SPIFFS_PAGE_HEADER_SIZE, page * pageSize + SPIFFS_PAGE_HEADER_SIZE + take), written);
          }
          written += take;
        }
        return out;
      },
    });

    /**
     * @param {number} span
     * @returns {number|undefined}
     */
    function continuationEntry(span) {
      const beyond = span - headerEntries;
      const ixSpan = Math.floor(beyond / continuationEntries) + 1;
      const page = spans.get(ixSpan);
      if (page === undefined) return undefined;
      return readU16(data, page * pageSize + offsets.continuation + (beyond % continuationEntries) * 2);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { type: 'spiffs', files, geometry, issues };
}

/** @param {Uint8Array} d @param {number} at @param {number} max */
function decodeName(d, at, max) {
  let end = at;
  while (end < at + max && d[end] !== 0 && d[end] !== 0xff) end++;
  return new TextDecoder().decode(d.subarray(at, end));
}

/** @param {Uint8Array} d @param {number} o @param {number} v */
function writeU16(d, o, v) {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
}

/** @param {Uint8Array} d @param {number} o @param {number} v */
function writeU32(d, o, v) {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
  d[o + 3] = (v >>> 24) & 0xff;
}

/** @param {Uint8Array} d @param {number} o */
const readU16 = (d, o) => d[o] | (d[o + 1] << 8);

/** @param {Uint8Array} d @param {number} o */
const readU32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
