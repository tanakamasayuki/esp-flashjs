// @ts-check
/**
 * LittleFS building — turning a store back into a mountable image.
 *
 * A LittleFS directory is a pair of blocks holding an append-only log, and its
 * current state is the sum of the commits in it. That gives a builder a choice
 * the parser does not have: rather than replaying a history, it can write the
 * single commit a compaction would have produced. Which is what this does —
 * every directory becomes one commit in one block of its pair, with the other
 * block left erased. That is exactly the state `lfs_format` leaves behind, so
 * it is a shape the device already knows how to read and to grow from.
 *
 * The parts that are easy to get wrong, all found by reading images the
 * reference boards wrote:
 *
 *   - A compacted commit holds **no CREATE tags**. Those are deltas; a
 *     compaction writes state. The entry count is recovered from the highest
 *     id that appears, which is what both this and the device rely on.
 *   - The commit CRC tag's size field covers the padding out to the next
 *     program-unit boundary, but the CRC itself stops at the tag. Include the
 *     padding and every commit fails its own check.
 *   - Before that CRC comes a **forward CRC** of the next program unit, which
 *     is how the device tells "nothing written here yet" from "a commit was
 *     interrupted". Leaving it out still mounts, but the block is then treated
 *     as unappendable and gets compacted on the next write.
 *   - Every metadata pair must be reachable from `{0, 1}` through the tail
 *     chain. The chain is not a convenience for readers: it is how the block
 *     allocator learns which blocks are in use. A pair that is off the chain
 *     reads back perfectly here and gets handed out as free space by the
 *     device, which then overwrites it.
 *
 * @module format/fs/littlefs-build
 */

import { crc32 } from '../../binary/hash.js';
import { FsCapacityError, FsPathError } from '../../util/errors.js';
import { LFS_TYPE, LITTLEFS_MAGIC, ctzPointerCount, parseLittlefs } from './littlefs.js';
import { verifyFsBuild } from './verify.js';

/**
 * @typedef {import('./store.js').FsStore} FsStore
 * @typedef {import('./types.js').FsImage} FsImage
 * @typedef {import('../partition.js').Issue} Issue
 */

/**
 * Program unit ESP-IDF configures LittleFS with.
 *
 * Commits are padded out to a multiple of this, and the forward CRC covers
 * exactly this many bytes. Both are visible in the captured images, which is
 * where the number comes from.
 */
export const LITTLEFS_PROG_SIZE = 128;

/** On-disk format version the reference boards write: 2.1. */
export const LITTLEFS_VERSION = 0x00020001;

/** Largest value the 10-bit size field of a tag can hold. */
const MAX_TAG_SIZE = 0x3fe;

/** The id a tag uses when it belongs to the directory rather than an entry. */
const NO_ID = 0x3ff;

/** @param {number} value @param {number} to */
const alignUp = (value, to) => Math.ceil(value / to) * to;

/**
 * A running CRC-32 with the final inversion undone, as LittleFS compares it.
 *
 * @param {number} crc
 * @param {Uint8Array} data
 * @returns {number}
 */
const crcUpdate = (crc, data) => (crc32(data, crc) ^ 0xffffffff) >>> 0;

/**
 * @param {number} type
 * @param {number} id
 * @param {number} size
 * @returns {number}
 */
const mktag = (type, id, size) =>
  (((type & 0x7ff) << 20) | ((id & 0x3ff) << 10) | (size & 0x3ff)) >>> 0;

/**
 * Serialises a store into a LittleFS partition image.
 *
 * @param {FsStore} store
 * @param {object} [options]
 * @param {number} [options.size]        Image size; defaults to the store geometry.
 * @param {number} [options.blockSize]
 * @param {number} [options.progSize]
 * @param {number} [options.version]
 * @param {number} [options.nameMax]
 * @param {number} [options.fileMax]
 * @param {number} [options.attrMax]
 * @param {number} [options.inlineMax] Files at or below this many bytes are
 *   stored in their directory rather than given a block of their own.
 * @param {boolean} [options.selfCheck]
 * @returns {Uint8Array}
 */
export function buildLittlefs(store, options = {}) {
  const blockSize = options.blockSize ?? store.geometry.blockSize ?? 4096;
  const progSize = options.progSize ?? LITTLEFS_PROG_SIZE;
  const size =
    options.size ?? (store.geometry.blockCount ?? 0) * (store.geometry.blockSize ?? blockSize);
  const version = options.version || store.geometry.version || LITTLEFS_VERSION;
  const nameMax = options.nameMax || store.geometry.nameMax || 255;
  const fileMax = options.fileMax ?? 0x7fffffff;
  const attrMax = options.attrMax ?? 0x3fe;
  const selfCheck = options.selfCheck ?? true;

  if (!Number.isInteger(size) || size <= 0 || size % blockSize !== 0) {
    throw new RangeError(`LittleFS size must be a positive multiple of ${blockSize}; got ${size}.`);
  }
  if (blockSize % progSize !== 0) {
    throw new RangeError(`LittleFS block size ${blockSize} is not a multiple of ${progSize}.`);
  }

  const blockCount = size / blockSize;
  if (blockCount < 3) throw new FsCapacityError('littlefs', 'block', 3, blockCount);

  // LittleFS's own rule, with the values this image states about itself. An
  // inline file lives in its directory's log, so the ceiling is about what a
  // commit can carry, not about what the file is.
  const inlineMax = Math.min(
    options.inlineMax ?? Math.min(nameMax, Math.floor((blockSize - 40) / 8)),
    MAX_TAG_SIZE,
  );

  const tree = buildTree(store, { nameMax, blockSize, inlineMax });

  /* Lay out the directories -------------------------------------------- */

  /**
   * One metadata pair's worth of a directory.
   *
   * @typedef {object} Chunk
   * @property {string} dir           Which directory this is part of.
   * @property {Array<any>} entries
   * @property {boolean} superblock   True for the first chunk of the root.
   * @property {[number, number]} pair
   * @property {boolean} split        True when a further chunk continues this
   *   directory, which makes the tail hard rather than soft.
   */
  /** @type {Chunk[]} */
  const chunks = [];

  for (const dir of tree.order) {
    const node = /** @type {any} */ (tree.nodes.get(dir));
    /** Bytes the superblock tags add to the root's first chunk. */
    const preamble = dir === '/' ? 4 + 8 + (4 + 24) : 0;
    let current = /** @type {any[]} */ ([]);
    let used = 4 + preamble; // the revision count, then the superblock
    let first = true;

    const flush = () => {
      chunks.push({
        dir,
        entries: current,
        superblock: dir === '/' && first,
        pair: [0, 0],
        split: false,
      });
      first = false;
      current = [];
      used = 4;
    };

    for (const entry of node.entries) {
      const cost = 4 + entry.nameBytes.length + 4 + entry.structSize;
      // A tail tag may still have to be added, and the commit CRC after it.
      // Checking both here is what keeps a commit from running off the end of
      // its block; LittleFS itself reserves the last eight bytes for exactly
      // that and reports no-space rather than overrunning.
      if (used > 4 && !fits(used + cost, blockSize)) flush();
      if (!fits(used + cost, blockSize)) {
        throw new FsCapacityError('littlefs', 'byte', used + cost, blockSize);
      }
      current.push(entry);
      used += cost;
    }
    flush();
  }

  for (let i = 0; i < chunks.length; i++) {
    // A chunk is a continuation when the next one belongs to the same
    // directory; that is the whole difference between a hard and a soft tail,
    // and getting it wrong either loses half a directory or merges two.
    chunks[i].split = i + 1 < chunks.length && chunks[i + 1].dir === chunks[i].dir;
  }

  /* Allocate blocks ------------------------------------------------------ */

  let requiredBlocks = 2 * chunks.length;
  for (const dir of tree.order) {
    for (const entry of /** @type {any} */ (tree.nodes.get(dir)).entries) {
      if (entry.kind === 'ctz') requiredBlocks += entry.blocks.length;
    }
  }

  let nextBlock = 2; // {0, 1} is the root pair, by definition
  /** @returns {number} */
  const allocate = () => {
    if (nextBlock >= blockCount) {
      throw new FsCapacityError('littlefs', 'block', requiredBlocks, blockCount);
    }
    return nextBlock++;
  };

  chunks[0].pair = [0, 1];
  for (let i = 1; i < chunks.length; i++) chunks[i].pair = [allocate(), allocate()];

  /** Which pair holds a directory's first chunk, for the DIRSTRUCT tags. */
  const pairOf = new Map();
  for (const chunk of chunks) if (!pairOf.has(chunk.dir)) pairOf.set(chunk.dir, chunk.pair);

  const data = new Uint8Array(size).fill(0xff);

  /* Write file data ------------------------------------------------------ */

  for (const dir of tree.order) {
    for (const entry of /** @type {any} */ (tree.nodes.get(dir)).entries) {
      if (entry.kind === 'dir') {
        entry.pair = pairOf.get(entry.path);
        continue;
      }
      if (entry.kind !== 'ctz') continue;
      for (let i = 0; i < entry.blocks.length; i++) entry.blocks[i] = allocate();
      writeCtz(data, entry.data, entry.blocks, blockSize);
      entry.head = entry.blocks[entry.blocks.length - 1];
    }
  }

  /* Write the directories ------------------------------------------------ */

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    /** @type {Array<{type: number, id: number, data: Uint8Array}>} */
    const attrs = [];
    let id = 0;

    if (chunk.superblock) {
      attrs.push({ type: LFS_TYPE.SUPERBLOCK, id: 0, data: asciiBytes(LITTLEFS_MAGIC) });
      const sb = new Uint8Array(24);
      writeU32LE(sb, 0, version);
      writeU32LE(sb, 4, blockSize);
      writeU32LE(sb, 8, blockCount);
      writeU32LE(sb, 12, nameMax);
      writeU32LE(sb, 16, fileMax);
      writeU32LE(sb, 20, attrMax);
      attrs.push({ type: LFS_TYPE.INLINESTRUCT, id: 0, data: sb });
      id = 1;
    }

    for (const entry of chunk.entries) {
      if (entry.kind === 'dir') {
        attrs.push({ type: LFS_TYPE.DIR, id, data: entry.nameBytes });
        attrs.push({ type: LFS_TYPE.DIRSTRUCT, id, data: pairBytes(entry.pair) });
      } else if (entry.kind === 'inline') {
        attrs.push({ type: LFS_TYPE.REG, id, data: entry.nameBytes });
        attrs.push({ type: LFS_TYPE.INLINESTRUCT, id, data: entry.data });
      } else {
        attrs.push({ type: LFS_TYPE.REG, id, data: entry.nameBytes });
        const ctz = new Uint8Array(8);
        writeU32LE(ctz, 0, entry.head);
        writeU32LE(ctz, 4, entry.data.length);
        attrs.push({ type: LFS_TYPE.CTZSTRUCT, id, data: ctz });
      }
      id++;
    }

    const next = chunks[i + 1];
    const tail = next
      ? { type: chunk.split ? LFS_TYPE.HARDTAIL : LFS_TYPE.SOFTTAIL, pair: next.pair }
      : null;

    // Only one block of the pair is written. The other stays erased, which is
    // how a freshly formatted directory looks and what the device compacts
    // into the first time it changes anything here.
    commit(data, chunk.pair[0], blockSize, progSize, 1, attrs, tail);
  }

  if (selfCheck) {
    const files = store.entries.filter((entry) => !entry.directory);
    verifyFsBuild(parseLittlefs(data, { blockSize }), files, 'littlefs');

    // The parser follows hard tails and ignores soft ones, so it cannot see a
    // broken chain. The allocator cannot see anything else.
    const reachable = littlefsTraverse(data, { blockSize });
    for (const chunk of chunks) {
      for (const block of chunk.pair) {
        if (!reachable.blocks.has(block)) {
          throw new Error(
            `littlefs build self-check failed: metadata block ${block} of ` +
              `"${chunk.dir}" is not reachable through the tail chain, so the ` +
              `device would treat it as free space.`,
          );
        }
      }
    }
  }

  return data;
}

/**
 * Whether a commit that has reached `used` bytes can still be finished.
 *
 * LittleFS caps the attribute area at `block_size - 8` and puts the commit CRC
 * in the eight bytes that leaves. A tail tag costs twelve more, and one may
 * still be needed, so the room for it has to be kept back from the first entry
 * onwards rather than discovered at the end.
 *
 * @param {number} used  Offset after the revision count and every attribute.
 * @param {number} blockSize
 * @returns {boolean}
 */
function fits(used, blockSize) {
  return used + 12 <= blockSize - 8;
}

/**
 * Writes one commit into one metadata block.
 *
 * @param {Uint8Array} data
 * @param {number} block
 * @param {number} blockSize
 * @param {number} progSize
 * @param {number} rev
 * @param {Array<{type: number, id: number, data: Uint8Array}>} attrs
 * @param {{type: number, pair: [number, number]}|null} tail
 */
function commit(data, block, blockSize, progSize, rev, attrs, tail) {
  const base = block * blockSize;
  writeU32LE(data, base, rev);

  // The revision count is inside the checksum, which is what stops a stale
  // block from passing its own check after the pair is reused.
  let crc = crcUpdate(0xffffffff, data.subarray(base, base + 4));
  let ptag = 0xffffffff >>> 0;
  let off = 4;

  /**
   * @param {number} tag
   * @param {Uint8Array|null} payload
   */
  const emit = (tag, payload) => {
    const dsize = 4 + (payload ? payload.length : 0);
    if (off + dsize > blockSize) {
      throw new Error(`littlefs commit overran block ${block}; this is a builder bug.`);
    }
    // Tags are stored big-endian and XORed with the previous *decoded* tag, so
    // the chain has to be built from decoded values, not from what is on disk.
    writeU32BE(data, base + off, (tag ^ ptag) >>> 0);
    if (payload) data.set(payload, base + off + 4);
    crc = crcUpdate(crc, data.subarray(base + off, base + off + dsize));
    ptag = tag >>> 0;
    off += dsize;
  };

  for (const attr of attrs) emit(mktag(attr.type, attr.id, attr.data.length), attr.data);
  if (tail) emit(mktag(tail.type, NO_ID, 8), pairBytes(tail.pair));

  const end = alignUp(Math.min(off + 5 * 4, blockSize), progSize);
  let noff = Math.min(end - (off + 4), MAX_TAG_SIZE) + (off + 4);
  if (noff < end) noff = Math.min(noff, end - 5 * 4);

  /** The byte the device would have found at `noff`; 0xFF when there is none. */
  let perturb = 0xff;
  if (noff >= end && noff <= blockSize - progSize) {
    perturb = data[base + noff];
    const fcrc = new Uint8Array(8);
    writeU32LE(fcrc, 0, progSize);
    writeU32LE(fcrc, 4, crcUpdate(0xffffffff, data.subarray(base + noff, base + noff + progSize)));
    emit(mktag(LFS_TYPE.FCRC, NO_ID, 8), fcrc);
  }

  // The low bit of the type carries the valid-bit inversion for the next tag.
  // On erased flash the perturb byte is 0xFF and the bit is clear, which is
  // why every commit in the captured images is type 0x500 rather than 0x501.
  const type = LFS_TYPE.CCRC + ((~perturb & 0xff) >>> 7);
  const ccrc = mktag(type, NO_ID, noff - (off + 4));
  writeU32BE(data, base + off, (ccrc ^ ptag) >>> 0);
  crc = crcUpdate(crc, data.subarray(base + off, base + off + 4));
  writeU32LE(data, base + off + 4, crc);
  // Everything from here to `noff` stays erased. It is inside the tag's size
  // but outside its checksum.
}

/**
 * Writes a file as a CTZ skip-list.
 *
 * Block `i` carries `ctz(i) + 1` pointers at its front, and pointer `j` points
 * at block `i - 2^j`. Only pointer 0 is needed to read the file back; the rest
 * exist so the device can seek without walking. Omitting them therefore
 * produces a file that reads correctly here and seeks into the wrong block on
 * hardware.
 *
 * @param {Uint8Array} image
 * @param {Uint8Array} contents
 * @param {number[]} blocks Physical block for each index, in file order.
 * @param {number} blockSize
 */
function writeCtz(image, contents, blocks, blockSize) {
  let written = 0;
  for (let index = 0; index < blocks.length; index++) {
    const base = blocks[index] * blockSize;
    const pointers = ctzPointerCount(index);
    for (let j = 0; j < pointers; j++) {
      writeU32LE(image, base + 4 * j, blocks[index - (1 << j)]);
    }
    const skip = 4 * pointers;
    const take = Math.min(blockSize - skip, contents.length - written);
    image.set(contents.subarray(written, written + take), base + skip);
    written += take;
  }
}

/**
 * How many blocks a CTZ list of `size` bytes needs.
 *
 * @param {number} size
 * @param {number} blockSize
 * @returns {number}
 */
export function ctzBlockCount(size, blockSize) {
  if (size <= 0) return 0;
  let remaining = size;
  let index = 0;
  while (remaining > 0) {
    remaining -= blockSize - 4 * ctzPointerCount(index);
    index++;
  }
  return index;
}

/**
 * Follows the tail chain the way the block allocator does.
 *
 * `lfs_fs_traverse` starts at `{0, 1}` and walks tails, collecting every
 * metadata pair and every block of every file it finds. Anything it does not
 * reach is free space as far as the device is concerned. That makes this the
 * only check that can tell a correctly built image from one that reads
 * correctly today and is overwritten on the next write.
 *
 * @param {Uint8Array} data
 * @param {object} options
 * @param {number} options.blockSize
 * @returns {{blocks: Set<number>, pairs: Array<[number, number]>, issues: Issue[]}}
 */
export function littlefsTraverse(data, { blockSize }) {
  /** @type {Set<number>} */
  const blocks = new Set();
  /** @type {Array<[number, number]>} */
  const pairs = [];
  /** @type {Issue[]} */
  const issues = [];

  /** @type {[number, number]|null} */
  let pair = [0, 1];
  const seen = new Set();

  while (pair) {
    const key = pair.join(',');
    if (seen.has(key)) {
      issues.push({ level: 'error', code: 'littlefs.tailLoop', params: { pair: key } });
      break;
    }
    seen.add(key);
    pairs.push(pair);
    blocks.add(pair[0]);
    blocks.add(pair[1]);

    const meta = readPair(data, pair, blockSize);
    if (!meta) {
      issues.push({ level: 'error', code: 'littlefs.unreadablePair', params: { pair: key } });
      break;
    }

    for (const attr of meta.attrs) {
      if (attr.type === LFS_TYPE.CTZSTRUCT && attr.data.length >= 8) {
        const head = readU32LE(attr.data, 0);
        const size = readU32LE(attr.data, 4);
        for (const block of ctzChain(data, head, size, blockSize)) blocks.add(block);
      }
    }
    pair = meta.tail;
  }

  return { blocks, pairs, issues };
}

/**
 * @param {Uint8Array} data
 * @param {[number, number]} pair
 * @param {number} blockSize
 * @returns {{attrs: Array<{type: number, id: number, data: Uint8Array}>, tail: [number, number]|null}|null}
 */
function readPair(data, pair, blockSize) {
  let best = null;
  for (const block of pair) {
    const read = readBlock(data, block, blockSize);
    if (!read) continue;
    if (!best || ((read.rev - best.rev) | 0) > 0) best = read;
  }
  if (!best) return null;

  /** @type {[number, number]|null} */
  let tail = null;
  for (const attr of best.attrs) {
    if (attr.type === LFS_TYPE.SOFTTAIL || attr.type === LFS_TYPE.HARDTAIL) {
      const a = readU32LE(attr.data, 0);
      const b = readU32LE(attr.data, 4);
      tail = a === 0xffffffff && b === 0xffffffff ? null : [a, b];
    }
  }
  return { attrs: best.attrs, tail };
}

/**
 * @param {Uint8Array} data
 * @param {number} block
 * @param {number} blockSize
 * @returns {{rev: number, attrs: Array<{type: number, id: number, data: Uint8Array}>}|null}
 */
function readBlock(data, block, blockSize) {
  const base = block * blockSize;
  if (base < 0 || base + blockSize > data.length) return null;

  const rev = readU32LE(data, base);
  /** @type {Array<{type: number, id: number, data: Uint8Array}>} */
  const attrs = [];
  let pending = [];
  let ptag = 0xffffffff >>> 0;
  let off = 4;
  let crc = crcUpdate(0xffffffff, data.subarray(base, base + 4));
  let any = false;

  while (off + 4 <= blockSize) {
    const tag = (readU32BE(data, base + off) ^ ptag) >>> 0;
    if ((tag & 0x80000000) !== 0) break;
    const size = tag & 0x3ff;
    const dsize = 4 + (size === 0x3ff ? 0 : size);
    if (off + dsize > blockSize) break;
    const type = (tag >>> 20) & 0x7ff;

    if (((tag >>> 28) & 0x7) === 5 && type !== LFS_TYPE.FCRC) {
      const covered = crcUpdate(crc, data.subarray(base + off, base + off + 4));
      if (covered !== readU32LE(data, base + off + 4)) break;
      attrs.push(...pending);
      pending = [];
      any = true;
      ptag = (tag ^ ((((tag >>> 20) & 0xff) & 1) << 31)) >>> 0;
      off += dsize;
      crc = 0xffffffff;
      continue;
    }

    crc = crcUpdate(crc, data.subarray(base + off, base + off + dsize));
    if (type !== LFS_TYPE.FCRC) {
      pending.push({
        type,
        id: (tag >>> 10) & 0x3ff,
        data: size === 0x3ff ? new Uint8Array(0) : data.subarray(base + off + 4, base + off + 4 + size),
      });
    }
    ptag = tag;
    off += dsize;
  }

  return any ? { rev, attrs } : null;
}

/**
 * @param {Uint8Array} data
 * @param {number} head
 * @param {number} size
 * @param {number} blockSize
 * @returns {number[]}
 */
function ctzChain(data, head, size, blockSize) {
  /** @type {number[]} */
  const out = [];
  if (size === 0) return out;
  // Pointer 0 of every block points at the one before it, so the list is
  // walked backwards from the head. How far back is decided by the size, not
  // by a sentinel: there isn't one.
  let block = head;
  for (let index = ctzBlockCount(size, blockSize) - 1; index >= 0; index--) {
    if (block * blockSize + blockSize > data.length) break;
    out.push(block);
    if (index === 0) break;
    block = readU32LE(data, block * blockSize);
  }
  return out;
}

/**
 * Turns a store into directories and entries, deciding inline versus CTZ.
 *
 * A small file lives in its directory's log and costs only its own bytes; a
 * large one gets blocks of its own. The threshold is LittleFS's, computed from
 * what this image says about itself, so a rebuild makes the same choice the
 * device would have made.
 *
 * @param {FsStore} store
 * @param {object} limits
 * @param {number} limits.nameMax
 * @param {number} limits.blockSize
 * @param {number} limits.inlineMax
 * @returns {{nodes: Map<string, any>, order: string[]}}
 */
function buildTree(store, { nameMax, blockSize, inlineMax }) {
  const nodes = new Map();
  nodes.set('/', { path: '/', entries: [] });
  for (const dir of store.directories) nodes.set(dir, { path: dir, entries: [] });

  const encoder = new TextEncoder();
  /** @param {string} path */
  const parentOf = (path) => {
    const cut = path.lastIndexOf('/');
    return cut === 0 ? '/' : path.slice(0, cut);
  };
  /** @param {string} path */
  const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

  for (const entry of store.entries) {
    const nameBytes = encoder.encode(nameOf(entry.path));
    if (nameBytes.length > nameMax) {
      throw new FsPathError(entry.path, `the name is ${nameBytes.length} bytes, over the ${nameMax} allowed`);
    }
    const parent = nodes.get(parentOf(entry.path));
    if (!parent) continue;
    if (entry.directory) {
      parent.entries.push({ kind: 'dir', path: entry.path, nameBytes, structSize: 8, pair: [0, 0] });
    } else if (entry.data.length <= inlineMax) {
      parent.entries.push({
        kind: 'inline',
        path: entry.path,
        nameBytes,
        data: entry.data,
        structSize: entry.data.length,
      });
    } else {
      parent.entries.push({
        kind: 'ctz',
        path: entry.path,
        nameBytes,
        data: entry.data,
        structSize: 8,
        head: 0,
        blocks: new Array(ctzBlockCount(entry.data.length, blockSize)).fill(0),
      });
    }
  }

  // Depth-first, parents before children, so the tail chain runs in the order
  // a reader meets the directories.
  /** @type {string[]} */
  const order = [];
  /** @param {string} dir */
  const walk = (dir) => {
    order.push(dir);
    for (const entry of nodes.get(dir).entries) {
      if (entry.kind === 'dir') walk(entry.path);
    }
  };
  walk('/');

  return { nodes, order };
}

/** @param {string} text */
function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** @param {[number, number]} pair */
function pairBytes(pair) {
  const out = new Uint8Array(8);
  writeU32LE(out, 0, pair[0]);
  writeU32LE(out, 4, pair[1]);
  return out;
}

/** @param {Uint8Array} d @param {number} o @param {number} v */
function writeU32LE(d, o, v) {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
  d[o + 3] = (v >>> 24) & 0xff;
}

/** @param {Uint8Array} d @param {number} o @param {number} v */
function writeU32BE(d, o, v) {
  d[o] = (v >>> 24) & 0xff;
  d[o + 1] = (v >>> 16) & 0xff;
  d[o + 2] = (v >>> 8) & 0xff;
  d[o + 3] = v & 0xff;
}

/** @param {Uint8Array} d @param {number} o */
const readU32LE = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/** @param {Uint8Array} d @param {number} o */
const readU32BE = (d, o) => (((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
