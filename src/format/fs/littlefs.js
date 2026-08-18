// @ts-check
/**
 * LittleFS parsing.
 *
 * LittleFS stores a directory as a *pair* of blocks holding an append-only log
 * of commits. Reading one means replaying that log rather than looking up a
 * table, which is what makes this longer than the SPIFFS parser: the current
 * state of a directory is the sum of every commit in it, and entries are
 * addressed by an id that earlier commits can shift.
 *
 * ```text
 * Metadata block
 *   0   4  revision count, little endian; the higher of a pair is current
 *   4   .  commits, each a run of tags ending in a commit CRC
 *
 * Tag (4 bytes, big endian, XORed with the previous decoded tag)
 *   bit 31     valid; a 1 here means the log has ended
 *   bits 30-20 type
 *   bits 19-10 id, the entry within the directory
 *   bits  9-0  length of the data that follows
 * ```
 *
 * Two details cost real time to find, and both produce a plausible-looking
 * empty filesystem when wrong:
 *
 *   - Tags are chained against the *decoded* previous tag, not the bytes as
 *     stored. Chaining the raw bytes decodes the first tag correctly and every
 *     later one as garbage, so the log appears to end after one entry.
 *   - A commit ends with a CRC tag (0x500), but modern LittleFS writes a
 *     forward-CRC tag (0x5ff) just before it. Both share the same top three
 *     type bits, so treating the forward CRC as the commit CRC applies the
 *     valid-bit inversion one tag early and, again, ends the log.
 *
 * @module format/fs/littlefs
 */

import { crc32 } from '../../binary/hash.js';

/**
 * A running CRC-32, without the final inversion.
 *
 * `crc32` returns a finished checksum, which cannot be fed back in as the seed
 * for the next chunk. LittleFS compares the raw running value against what it
 * stored, so the inversion has to be undone between chunks — leaving it in
 * makes every commit fail its check and the whole image read as unmounted.
 *
 * @param {number} crc
 * @param {Uint8Array} data
 * @returns {number}
 */
const crcUpdate = (crc, data) => (crc32(data, crc) ^ 0xffffffff) >>> 0;

/**
 * @typedef {import('../partition.js').Issue} Issue
 * @typedef {import('./types.js').FsFile} FsFile
 * @typedef {import('./types.js').FsImage} FsImage
 */

/** Full 11-bit tag types. */
export const LFS_TYPE = {
  REG: 0x001,
  DIR: 0x002,
  SUPERBLOCK: 0x0ff,
  DIRSTRUCT: 0x200,
  INLINESTRUCT: 0x201,
  CTZSTRUCT: 0x202,
  USERATTR: 0x300,
  CREATE: 0x401,
  DELETE: 0x4ff,
  CCRC: 0x500,
  FCRC: 0x5ff,
  SOFTTAIL: 0x600,
  HARDTAIL: 0x601,
  MOVESTATE: 0x7ff,
};

/** The magic an image must open with, at offset 8 of either block of the pair. */
export const LITTLEFS_MAGIC = 'littlefs';

const TAG_VALID = 0x80000000;

/** @param {number} tag */
const tagType = (tag) => (tag >>> 20) & 0x7ff;
/** @param {number} tag */
const tagId = (tag) => (tag >>> 10) & 0x3ff;
/** @param {number} tag */
const tagSize = (tag) => tag & 0x3ff;
/** A size of 0x3ff means "no data follows". @param {number} tag */
const tagIsDelete = (tag) => tagSize(tag) === 0x3ff;
/** @param {number} tag */
const tagDataSize = (tag) => 4 + (tagIsDelete(tag) ? 0 : tagSize(tag));
/** Top three bits of the type, which is how LittleFS groups them. @param {number} tag */
const tagType1 = (tag) => (tag >>> 28) & 0x7;
/** Low eight bits of the type; its bottom bit carries the valid-bit inversion. @param {number} tag */
const tagChunk = (tag) => (tag >>> 20) & 0xff;

/** @param {Uint8Array} d @param {number} o */
const beU32 = (d, o) => (((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
/** @param {Uint8Array} d @param {number} o */
const leU32 = (d, o) => ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0);

/**
 * Count of set bits, for the CTZ index arithmetic.
 * @param {number} n
 * @returns {number}
 */
function popcount(n) {
  let c = 0;
  for (let v = n >>> 0; v !== 0; v >>>= 1) c += v & 1;
  return c;
}

/**
 * Count of trailing zeros.
 * @param {number} n
 * @returns {number}
 */
function ctz(n) {
  if (n === 0) return 32;
  let c = 0;
  let v = n >>> 0;
  while ((v & 1) === 0) {
    v >>>= 1;
    c += 1;
  }
  return c;
}

/**
 * One decoded attribute from a metadata log.
 *
 * @typedef {object} LfsAttr
 * @property {number} type
 * @property {number} id
 * @property {Uint8Array} data
 */

/**
 * Replays the commit log in one metadata block.
 *
 * @param {Uint8Array} data
 * @param {number} block
 * @param {number} blockSize
 * @returns {{rev: number, attrs: LfsAttr[], valid: boolean}}
 */
function readMetadataBlock(data, block, blockSize) {
  const base = block * blockSize;
  if (base + blockSize > data.length) return { rev: -1, attrs: [], valid: false };

  const rev = leU32(data, base);
  /** @type {LfsAttr[]} */
  const attrs = [];
  /** Attributes of the commit being read; only kept once its CRC checks out. */
  let pending = [];
  let ptag = 0xffffffff >>> 0;
  let off = 4;
  let sawCommit = false;

  // The running CRC covers the revision count and then every byte of the
  // commit, tags included.
  let crc = crcUpdate(0xffffffff, data.subarray(base, base + 4));

  while (off + 4 <= blockSize) {
    const raw = beU32(data, base + off);
    const tag = (raw ^ ptag) >>> 0;
    if ((tag & TAG_VALID) !== 0) break;
    const dsize = tagDataSize(tag);
    if (off + dsize > blockSize) break;

    const type = tagType(tag);

    if (tagType1(tag) === 5 && type !== LFS_TYPE.FCRC) {
      // Commit CRC. Everything from the start of the commit up to and
      // including this tag is covered; the stored value follows it.
      const covered = crcUpdate(crc, data.subarray(base + off, base + off + 4));
      const stored = leU32(data, base + off + 4);
      if (covered !== stored) break;

      attrs.push(...pending);
      pending = [];
      sawCommit = true;

      // The bottom bit of the type inverts the valid bit of the next tag, so
      // an interrupted commit cannot be mistaken for a complete one.
      ptag = (tag ^ ((tagChunk(tag) & 1) << 31)) >>> 0;
      off += dsize;
      crc = 0xffffffff;
      continue;
    }

    crc = crcUpdate(crc, data.subarray(base + off, base + off + dsize));

    if (type !== LFS_TYPE.FCRC) {
      pending.push({
        type,
        id: tagId(tag),
        data: tagIsDelete(tag)
          ? new Uint8Array(0)
          : data.subarray(base + off + 4, base + off + 4 + tagSize(tag)),
      });
    }

    ptag = tag;
    off += dsize;
  }

  return { rev, attrs, valid: sawCommit };
}

/**
 * Picks the current block of a metadata pair.
 *
 * Both blocks hold the same directory at different points in time; the one
 * with the newer revision wins, and revisions wrap, so they are compared as a
 * signed difference rather than by magnitude.
 *
 * @param {Uint8Array} data
 * @param {[number, number]} pair
 * @param {number} blockSize
 * @returns {{rev: number, attrs: LfsAttr[], valid: boolean}}
 */
function readMetadataPair(data, pair, blockSize) {
  const candidates = pair
    .map((block) => readMetadataBlock(data, block, blockSize))
    .filter((c) => c.valid);
  if (candidates.length === 0) return { rev: -1, attrs: [], valid: false };
  return candidates.reduce((best, c) => (((c.rev - best.rev) | 0) > 0 ? c : best));
}

/**
 * @typedef {object} LfsEntry
 * @property {number} type   LFS_TYPE.REG or LFS_TYPE.DIR
 * @property {string} name
 * @property {{kind: 'inline', data: Uint8Array}
 *   | {kind: 'ctz', head: number, size: number}
 *   | {kind: 'dir', pair: [number, number]}
 *   | null} struct
 */

/**
 * Turns one directory's attributes into its entries.
 *
 * Ids are positional: a CREATE inserts at an index and shifts everything after
 * it up, a DELETE removes and shifts down. Treating the id as a stable key
 * instead attaches names and contents to the wrong entries as soon as anything
 * has been deleted.
 *
 * @param {LfsAttr[]} attrs
 * @returns {{entries: LfsEntry[], tail: [number, number]|null, hardTail: boolean}}
 */
function replayDirectory(attrs) {
  /** @type {LfsEntry[]} */
  const entries = [];
  /** @type {[number, number]|null} */
  let tail = null;
  let hardTail = false;
  const decoder = new TextDecoder();

  for (const attr of attrs) {
    const { type, id, data } = attr;

    if (type === LFS_TYPE.CREATE) {
      entries.splice(id, 0, { type: LFS_TYPE.REG, name: '', struct: null });
      continue;
    }
    if (type === LFS_TYPE.DELETE) {
      entries.splice(id, 1);
      continue;
    }
    if (type === LFS_TYPE.SOFTTAIL || type === LFS_TYPE.HARDTAIL) {
      tail = [leU32(data, 0), leU32(data, 4)];
      hardTail = type === LFS_TYPE.HARDTAIL;
      continue;
    }
    if (type === LFS_TYPE.SUPERBLOCK || type === LFS_TYPE.USERATTR || type === LFS_TYPE.MOVESTATE) {
      continue;
    }

    // Everything below addresses an entry, and a name tag may arrive for an id
    // that no CREATE announced.
    while (entries.length <= id) {
      entries.push({ type: LFS_TYPE.REG, name: '', struct: null });
    }
    const entry = entries[id];

    if (type === LFS_TYPE.REG || type === LFS_TYPE.DIR) {
      entry.type = type;
      entry.name = decoder.decode(data);
    } else if (type === LFS_TYPE.INLINESTRUCT) {
      entry.struct = { kind: 'inline', data };
    } else if (type === LFS_TYPE.CTZSTRUCT) {
      entry.struct = { kind: 'ctz', head: leU32(data, 0), size: leU32(data, 4) };
    } else if (type === LFS_TYPE.DIRSTRUCT) {
      entry.struct = { kind: 'dir', pair: [leU32(data, 0), leU32(data, 4)] };
    }
  }

  return { entries, tail, hardTail };
}

/**
 * How many skip pointers block `index` of a CTZ list carries.
 *
 * The first block carries none; after that a block carries one pointer per
 * trailing zero in its index, plus one. Those pointers sit at the front of the
 * block and are not part of the file.
 *
 * @param {number} index
 * @returns {number}
 */
export function ctzPointerCount(index) {
  return index === 0 ? 0 : ctz(index) + 1;
}

/**
 * Which block of a CTZ list holds a given byte offset.
 *
 * Transcribed from LittleFS's own arithmetic rather than re-derived: the
 * capacity of a block depends on how many pointers it carries, which depends
 * on its index, so the mapping is not a simple division.
 *
 * @param {number} size Byte offset within the file.
 * @param {number} blockSize
 * @returns {number} Block index.
 */
export function ctzIndexOf(size, blockSize) {
  const b = blockSize - 2 * 4;
  let i = Math.floor(size / b);
  if (i === 0) return 0;
  i = Math.floor((size - 4 * (popcount(i - 1) + 2)) / b);
  return i;
}

/**
 * Collects the blocks of a CTZ list, in file order.
 *
 * Pointer 0 of every block points at the block before it, so walking that one
 * pointer back from the head visits every block exactly once. The skip
 * pointers exist to make random access fast and are not needed to read a file
 * from start to end.
 *
 * @param {Uint8Array} data
 * @param {number} head
 * @param {number} size
 * @param {number} blockSize
 * @returns {{blocks: number[], complete: boolean}}
 */
function ctzBlocks(data, head, size, blockSize) {
  if (size === 0) return { blocks: [], complete: true };
  const lastIndex = ctzIndexOf(size - 1, blockSize);
  /** @type {number[]} */
  const blocks = new Array(lastIndex + 1);
  let block = head;
  let complete = true;

  for (let index = lastIndex; index >= 0; index--) {
    if (block * blockSize + blockSize > data.length) {
      complete = false;
      break;
    }
    blocks[index] = block;
    if (index === 0) break;
    block = leU32(data, block * blockSize);
  }

  return { blocks, complete: complete && blocks.every((b) => b !== undefined) };
}

/**
 * @param {Uint8Array} data
 * @param {number} head
 * @param {number} size
 * @param {number} blockSize
 * @returns {Uint8Array}
 */
function readCtz(data, head, size, blockSize) {
  const { blocks } = ctzBlocks(data, head, size, blockSize);
  const out = new Uint8Array(size);
  let written = 0;

  for (let index = 0; index < blocks.length && written < size; index++) {
    const block = blocks[index];
    if (block === undefined) break;
    const skip = 4 * ctzPointerCount(index);
    const available = blockSize - skip;
    const take = Math.min(available, size - written);
    out.set(data.subarray(block * blockSize + skip, block * blockSize + skip + take), written);
    written += take;
  }
  return out;
}

/**
 * Parses a LittleFS image.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.blockSize] Overrides the superblock's own value.
 * @returns {FsImage}
 */
export function parseLittlefs(data, { blockSize } = {}) {
  /** @type {Issue[]} */
  const issues = [];

  // The superblock lives in the first metadata pair, and its own inline struct
  // states the geometry — so unlike SPIFFS there is nothing to guess, provided
  // the pair can be read with a plausible block size first.
  const probe = blockSize ?? detectBlockSize(data);
  const geometry = { blockSize: probe, blockCount: 0, version: 0, nameMax: 0 };

  if (!probe) {
    issues.push({ level: 'error', code: 'littlefs.noSuperblock', params: {} });
    return { type: 'littlefs', files: [], geometry, issues };
  }

  const root = readMetadataPair(data, [0, 1], probe);
  if (!root.valid) {
    issues.push({ level: 'error', code: 'littlefs.noSuperblock', params: {} });
    return { type: 'littlefs', files: [], geometry, issues };
  }

  const superblock = root.attrs.find(
    (a) => a.type === LFS_TYPE.INLINESTRUCT && a.data.length >= 24,
  );
  if (superblock) {
    geometry.version = leU32(superblock.data, 0);
    geometry.blockSize = leU32(superblock.data, 4);
    geometry.blockCount = leU32(superblock.data, 8);
    geometry.nameMax = leU32(superblock.data, 12);
  }

  const size = geometry.blockSize || probe;
  if (size !== probe) {
    // Re-read with the geometry the image itself states.
    return parseLittlefs(data, { blockSize: size });
  }

  /** @type {FsFile[]} */
  const files = [];
  const seen = new Set();
  walkDirectory(data, [0, 1], '', size, files, issues, seen, 0);

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { type: 'littlefs', files, geometry, issues };
}

/**
 * @param {Uint8Array} data
 * @returns {number} A block size the first metadata pair reads cleanly at.
 */
function detectBlockSize(data) {
  for (const candidate of [4096, 8192, 512, 256, 16384, 32768, 65536]) {
    if (data.length < candidate * 2) continue;
    // The superblock name sits right after the first tag in either block.
    for (const block of [0, 1]) {
      const at = block * candidate + 8;
      if (matchesAscii(data, at, LITTLEFS_MAGIC)) return candidate;
    }
  }
  return 0;
}

/** @param {Uint8Array} data @param {number} at @param {string} text */
function matchesAscii(data, at, text) {
  for (let i = 0; i < text.length; i++) {
    if (data[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * @param {Uint8Array} data
 * @param {[number, number]} pair
 * @param {string} prefix
 * @param {number} blockSize
 * @param {FsFile[]} files
 * @param {Issue[]} issues
 * @param {Set<string>} seen
 * @param {number} depth
 */
function walkDirectory(data, pair, prefix, blockSize, files, issues, seen, depth) {
  // A corrupted tail can point back into a directory already visited. Without
  // this the walk would loop until the stack gives out.
  const key = pair.join(',');
  if (seen.has(key) || depth > 64) {
    issues.push({ level: 'warning', code: 'littlefs.cycle', params: { pair: key } });
    return;
  }
  seen.add(key);

  const meta = readMetadataPair(data, pair, blockSize);
  if (!meta.valid) {
    issues.push({ level: 'warning', code: 'littlefs.unreadablePair', params: { pair: key } });
    return;
  }

  const { entries, tail, hardTail } = replayDirectory(meta.attrs);

  for (const entry of entries) {
    if (!entry.name) continue;
    const path = `${prefix}/${entry.name}`;

    if (entry.type === LFS_TYPE.DIR) {
      files.push({ path, size: 0, read: () => new Uint8Array(0), pageIndices: [], complete: true, directory: true });
      if (entry.struct?.kind === 'dir') {
        walkDirectory(data, entry.struct.pair, path, blockSize, files, issues, seen, depth + 1);
      }
      continue;
    }

    if (entry.struct?.kind === 'inline') {
      const bytes = entry.struct.data;
      files.push({
        path,
        size: bytes.length,
        read: () => new Uint8Array(bytes),
        pageIndices: [pair[0], pair[1]],
        complete: true,
      });
    } else if (entry.struct?.kind === 'ctz') {
      const { head, size } = entry.struct;
      const { blocks, complete } = ctzBlocks(data, head, size, blockSize);
      if (!complete) {
        issues.push({ level: 'warning', code: 'littlefs.missingBlocks', params: { path } });
      }
      files.push({
        path,
        size,
        read: () => readCtz(data, head, size, blockSize),
        pageIndices: blocks.filter((b) => b !== undefined),
        complete,
      });
    } else {
      // A name with no struct is an empty file: LittleFS stores zero bytes
      // inline, and an inline struct of length zero is easy to lose.
      files.push({ path, size: 0, read: () => new Uint8Array(0), pageIndices: [], complete: true });
    }
  }

  // A directory too large for one pair continues in another. A hard tail is
  // part of the same directory; a soft tail chains to the next directory in
  // the filesystem's flat list and must not be followed as if it were.
  if (tail && hardTail) {
    walkDirectory(data, tail, prefix, blockSize, files, issues, seen, depth + 1);
  }
}
