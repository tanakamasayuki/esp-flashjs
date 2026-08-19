// @ts-check
/**
 * FAT building, through the wear-levelling layer ESP-IDF puts underneath it.
 *
 * This one is deliberately not a from-scratch formatter. The partition holds
 * more than a FAT volume: the last three sectors carry the wear-levelling
 * layer's own state and configuration, including a device id the device chose
 * at random and a checksum whose formula is not part of any published format.
 * Regenerating those from guesswork would produce an image that parses here and
 * is rejected by the layer that has to mount it.
 *
 * So a rebuild starts from the image it came from. The boot sector, the spare
 * sector the layer is holding, and the state at the tail are all carried over
 * untouched; what gets rewritten is the file allocation tables, the root
 * directory and the data area — through the *same* logical-to-physical mapping
 * the parser used to read them. That makes the builder the parser's inverse
 * rather than an independent guess at where things go: if the mapping were
 * wrong, the parse would have failed first.
 *
 * Free clusters are zeroed rather than left alone. A real filesystem does not
 * do that — deleting a file only unlinks it — but a rebuild that quietly
 * carried the contents of a deleted file into the image someone is about to
 * publish would be a worse surprise than a slower write.
 *
 * @module format/fs/fat-build
 */

import { FsCapacityError, FsPathError } from '../../util/errors.js';
import { FAT_ATTR, FAT_ATTR_LONG_NAME, parseFat, wlMapSector } from './fat.js';
import { verifyFsBuild } from './verify.js';

/**
 * @typedef {import('./store.js').FsStore} FsStore
 * @typedef {import('./types.js').FsImage} FsImage
 */

const DIR_ENTRY_SIZE = 32;

/** Characters a short name may hold, beyond A-Z and 0-9. */
const SHORT_NAME_EXTRA = "$%'-_@~`!(){}^#&";

/** 1980-01-01, the earliest date FAT can express. */
const FAT_EPOCH_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * Serialises a store back into a FAT partition image.
 *
 * @param {FsStore} store
 * @param {object} options
 * @param {Uint8Array} options.source  The image the store was read from. Its
 *   boot sector and wear-levelling state are carried over; everything the
 *   files live in is rewritten.
 * @param {number} [options.date]      FAT date word for every entry.
 * @param {number} [options.time]      FAT time word for every entry.
 * @param {boolean} [options.selfCheck]
 * @returns {Uint8Array}
 */
export function buildFat(store, options) {
  const { source } = options ?? {};
  if (!source || source.length === 0) {
    throw new TypeError(
      'buildFat needs the image the store came from: the wear-levelling state ' +
        'at the end of the partition cannot be regenerated, only carried over.',
    );
  }
  const date = options.date ?? FAT_EPOCH_DATE;
  const time = options.time ?? 0;
  const selfCheck = options.selfCheck ?? true;

  // Read the source the same way the parser does, so the geometry and the
  // spare-sector position are exactly the ones the files were found through.
  const probe = parseFat(source);
  if (probe.issues.some((issue) => issue.level === 'error')) {
    throw new Error(
      `Cannot rebuild this FAT image: reading it reports ${probe.issues[0].code}.`,
    );
  }
  const geometry = /** @type {any} */ (probe.geometry);
  const {
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntries,
    totalSectors,
    fatSize,
    rootDirSectors,
    firstDataSector,
    clusterCount,
    bits,
    rootCluster,
    wlDummySector,
  } = geometry;

  const clusterBytes = sectorsPerCluster * bytesPerSector;
  const out = new Uint8Array(source);

  /** @param {number} sector @returns {number} Byte offset in the image. */
  const at = (sector) => wlMapSector(sector, wlDummySector) * bytesPerSector;

  // Everything from the first FAT to the end of the volume is rebuilt. Logical
  // sector 0 is left alone: the BPB does not change, and the boot code in it
  // is not ours to invent.
  for (let sector = reservedSectors; sector < totalSectors; sector++) {
    out.fill(0, at(sector), at(sector) + bytesPerSector);
  }

  /* Allocate clusters ---------------------------------------------------- */

  const fat = new Uint8Array(fatSize * bytesPerSector);
  let nextCluster = 2;
  /**
   * Takes the next run of clusters and links them into a chain.
   *
   * Sequential allocation is not a simplification here: the volume is being
   * written from nothing, so there is no fragmentation to work around, and
   * laying files out in order keeps a rebuilt image readable in a hex view.
   *
   * @param {number} count
   * @returns {number[]}
   */
  const allocate = (count) => {
    if (nextCluster + count > clusterCount + 2) {
      throw new FsCapacityError('fat', 'cluster', nextCluster + count - 2, clusterCount);
    }
    /** @type {number[]} */
    const chain = [];
    for (let i = 0; i < count; i++) chain.push(nextCluster++);
    for (let i = 0; i < chain.length; i++) {
      writeFatEntry(fat, chain[i], i + 1 < chain.length ? chain[i + 1] : endOfChain(bits), bits);
    }
    return chain;
  };

  // The media descriptor and the end-of-chain marker occupy entries 0 and 1;
  // no cluster is numbered below 2 because of them.
  writeFatEntry(fat, 0, bits === 12 ? 0xff8 : bits === 16 ? 0xfff8 : 0x0ffffff8, bits);
  writeFatEntry(fat, 1, endOfChain(bits), bits);

  /* Build the directory tree --------------------------------------------- */

  const tree = groupByDirectory(store);

  /**
   * A directory that still needs its entries written.
   *
   * @typedef {object} PendingDir
   * @property {string} path
   * @property {number[]} sectors    Where its entries go.
   * @property {number} cluster      0 for a FAT12/16 root.
   * @property {number} parent       Parent's first cluster; 0 means the root.
   * @property {Uint8Array[]} records
   */

  /** @type {Map<string, PendingDir>} */
  const dirs = new Map();

  const rootSectors = [];
  let rootFirstCluster = 0;
  if (bits === 32) {
    // The boot sector says which cluster the root lives in and is not being
    // rewritten, so the root has to go there rather than wherever the
    // allocator would have put it. Anything below it stays unallocated.
    rootFirstCluster = rootCluster || 2;
    nextCluster = rootFirstCluster;
    for (const cluster of allocate(1)) {
      for (let i = 0; i < sectorsPerCluster; i++) {
        rootSectors.push(firstDataSector + (cluster - 2) * sectorsPerCluster + i);
      }
    }
  } else {
    const first = reservedSectors + numFats * fatSize;
    for (let i = 0; i < rootDirSectors; i++) rootSectors.push(first + i);
  }
  dirs.set('/', {
    path: '/',
    sectors: rootSectors,
    cluster: rootFirstCluster,
    parent: 0,
    records: [],
  });

  // Directories first, in path order, so a parent always has its cluster
  // before a child needs to point back at it.
  for (const path of store.directories) {
    if (path === '/') continue;
    const slots = countSlots(tree.get(path) ?? []) + 2; // "." and ".."
    const clusters = allocate(Math.max(1, Math.ceil((slots * DIR_ENTRY_SIZE) / clusterBytes)));
    const sectors = [];
    for (const cluster of clusters) {
      for (let i = 0; i < sectorsPerCluster; i++) {
        sectors.push(firstDataSector + (cluster - 2) * sectorsPerCluster + i);
      }
    }
    dirs.set(path, { path, sectors, cluster: clusters[0], parent: 0, records: [] });
  }
  for (const [path, dir] of dirs) {
    if (path === '/') continue;
    const parent = dirs.get(parentOf(path));
    dir.parent = parent ? parent.cluster : 0;
  }

  /* Write files and directory records ------------------------------------ */

  for (const [path, dir] of dirs) {
    if (path !== '/') {
      dir.records.push(dotEntry('.', dir.cluster, date, time));
      dir.records.push(dotEntry('..', dir.parent, date, time));
    }

    /** Short names have to be unique within their own directory, not globally. */
    const taken = new Set(['.          ', '..         ']);

    for (const child of tree.get(path) ?? []) {
      const name = child.path.slice(child.path.lastIndexOf('/') + 1);
      const short = shortNameFor(name, taken, child.path);
      taken.add(short.text);

      let cluster = 0;
      let size = 0;
      if (child.directory) {
        const target = dirs.get(child.path);
        cluster = target ? target.cluster : 0;
      } else {
        size = child.data.length;
        if (size > 0) {
          const chain = allocate(Math.ceil(size / clusterBytes));
          cluster = chain[0];
          let written = 0;
          for (const c of chain) {
            for (let i = 0; i < sectorsPerCluster && written < size; i++) {
              const sector = firstDataSector + (c - 2) * sectorsPerCluster + i;
              const take = Math.min(bytesPerSector, size - written);
              out.set(child.data.subarray(written, written + take), at(sector));
              written += take;
            }
          }
        }
      }

      if (short.needsLongName) {
        for (const record of longNameRecords(name, short.bytes)) dir.records.push(record);
      }
      dir.records.push(
        shortEntry(short, child.directory ? FAT_ATTR.DIRECTORY : FAT_ATTR.ARCHIVE, cluster, size, date, time),
      );
    }
  }

  for (const dir of dirs.values()) {
    const capacity = dir.sectors.length * bytesPerSector;
    const needed = dir.records.length * DIR_ENTRY_SIZE;
    if (needed > capacity) {
      // The root of a FAT12/16 volume is a fixed run of sectors decided when
      // the volume was formatted, so running out there is a different problem
      // from a subdirectory running out — one can grow and one cannot.
      if (dir.path === '/' && bits !== 32) {
        throw new FsCapacityError('fat', 'root directory slot', dir.records.length, rootEntries);
      }
      throw new FsCapacityError('fat', 'byte', needed, capacity);
    }
    let offset = 0;
    for (const record of dir.records) {
      const sector = dir.sectors[Math.floor(offset / bytesPerSector)];
      out.set(record, at(sector) + (offset % bytesPerSector));
      offset += DIR_ENTRY_SIZE;
    }
  }

  /* Commit the allocation tables ----------------------------------------- */

  for (let copy = 0; copy < numFats; copy++) {
    for (let i = 0; i < fatSize; i++) {
      out.set(
        fat.subarray(i * bytesPerSector, (i + 1) * bytesPerSector),
        at(reservedSectors + copy * fatSize + i),
      );
    }
  }

  if (bits === 32) invalidateFsInfo(out, at, source);

  if (selfCheck) {
    const files = store.entries.filter((entry) => !entry.directory);
    verifyFsBuild(parseFat(out, { wlDummySector }), files, 'fat');
  }
  return out;
}

/**
 * Tells a FAT32 volume to recount its free space.
 *
 * The FSInfo sector caches a free-cluster count and a hint at where to look
 * next. It sits among the reserved sectors, which a rebuild does not touch, so
 * both would survive as figures describing the filesystem that used to be
 * here. Writing the "unknown" marker into them costs one recount on the next
 * mount and is the only honest value available: the driver's idea of free
 * space would otherwise be wrong from the moment it mounts.
 *
 * @param {Uint8Array} out
 * @param {(sector: number) => number} at
 * @param {Uint8Array} source
 */
function invalidateFsInfo(out, at, source) {
  const sector = u16(source, 48);
  if (sector === 0 || sector === 0xffff) return;
  const base = at(sector);
  if (u32(out, base) !== 0x41615252 || u32(out, base + 484) !== 0x61417272) return;
  for (const offset of [488, 492]) {
    out[base + offset] = 0xff;
    out[base + offset + 1] = 0xff;
    out[base + offset + 2] = 0xff;
    out[base + offset + 3] = 0xff;
  }
}

/** @param {Uint8Array} d @param {number} o */
const u16 = (d, o) => d[o] | (d[o + 1] << 8);

/** @param {Uint8Array} d @param {number} o */
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/**
 * Groups a store's entries by the directory they live in.
 *
 * @param {FsStore} store
 * @returns {Map<string, import('./store.js').FsStoreEntry[]>}
 */
function groupByDirectory(store) {
  /** @type {Map<string, import('./store.js').FsStoreEntry[]>} */
  const tree = new Map([['/', []]]);
  for (const dir of store.directories) if (!tree.has(dir)) tree.set(dir, []);
  for (const entry of store.entries) {
    const parent = parentOf(entry.path);
    const list = tree.get(parent);
    if (list) list.push(entry);
  }
  return tree;
}

/** @param {string} path */
function parentOf(path) {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/**
 * Directory slots a set of children needs, long names included.
 *
 * @param {import('./store.js').FsStoreEntry[]} children
 * @returns {number}
 */
function countSlots(children) {
  let slots = 0;
  for (const child of children) {
    const name = child.path.slice(child.path.lastIndexOf('/') + 1);
    slots += 1 + Math.ceil([...name].length / 13);
  }
  return slots;
}

/** @param {number} bits */
const endOfChain = (bits) => (bits === 12 ? 0xfff : bits === 16 ? 0xffff : 0x0fffffff);

/**
 * @param {Uint8Array} fat
 * @param {number} cluster
 * @param {number} value
 * @param {number} bits
 */
function writeFatEntry(fat, cluster, value, bits) {
  if (bits === 12) {
    // Twelve bits means an entry can start halfway through a byte, and the two
    // halves are assembled differently depending on whether the cluster number
    // is odd. Writing has to preserve the neighbour sharing that byte.
    const at = cluster + (cluster >> 1);
    if (at + 1 >= fat.length) return;
    if (cluster & 1) {
      fat[at] = (fat[at] & 0x0f) | ((value & 0x0f) << 4);
      fat[at + 1] = (value >> 4) & 0xff;
    } else {
      fat[at] = value & 0xff;
      fat[at + 1] = (fat[at + 1] & 0xf0) | ((value >> 8) & 0x0f);
    }
    return;
  }
  if (bits === 16) {
    const at = cluster * 2;
    if (at + 1 >= fat.length) return;
    fat[at] = value & 0xff;
    fat[at + 1] = (value >> 8) & 0xff;
    return;
  }
  const at = cluster * 4;
  if (at + 3 >= fat.length) return;
  // The top four bits of a FAT32 entry are reserved and must be preserved.
  const kept = fat[at + 3] & 0xf0;
  fat[at] = value & 0xff;
  fat[at + 1] = (value >>> 8) & 0xff;
  fat[at + 2] = (value >>> 16) & 0xff;
  fat[at + 3] = kept | ((value >>> 24) & 0x0f);
}

/**
 * @param {string} name '.' or '..'
 * @param {number} cluster
 * @param {number} date
 * @param {number} time
 * @returns {Uint8Array}
 */
function dotEntry(name, cluster, date, time) {
  const entry = new Uint8Array(DIR_ENTRY_SIZE);
  entry.fill(0x20, 0, 11);
  for (let i = 0; i < name.length; i++) entry[i] = name.charCodeAt(i);
  entry[11] = FAT_ATTR.DIRECTORY;
  writeTimes(entry, date, time);
  entry[20] = (cluster >>> 16) & 0xff;
  entry[21] = (cluster >>> 24) & 0xff;
  entry[26] = cluster & 0xff;
  entry[27] = (cluster >>> 8) & 0xff;
  return entry;
}

/**
 * @param {{bytes: Uint8Array, caseFlags: number}} short
 * @param {number} attr
 * @param {number} cluster
 * @param {number} size
 * @param {number} date
 * @param {number} time
 * @returns {Uint8Array}
 */
function shortEntry(short, attr, cluster, size, date, time) {
  const entry = new Uint8Array(DIR_ENTRY_SIZE);
  entry.set(short.bytes, 0);
  entry[11] = attr;
  entry[12] = short.caseFlags;
  writeTimes(entry, date, time);
  entry[20] = (cluster >>> 16) & 0xff;
  entry[21] = (cluster >>> 24) & 0xff;
  entry[26] = cluster & 0xff;
  entry[27] = (cluster >>> 8) & 0xff;
  entry[28] = size & 0xff;
  entry[29] = (size >>> 8) & 0xff;
  entry[30] = (size >>> 16) & 0xff;
  entry[31] = (size >>> 24) & 0xff;
  return entry;
}

/**
 * @param {Uint8Array} entry
 * @param {number} date
 * @param {number} time
 */
function writeTimes(entry, date, time) {
  for (const at of [14, 22]) {
    entry[at] = time & 0xff;
    entry[at + 1] = (time >>> 8) & 0xff;
  }
  for (const at of [16, 18, 24]) {
    entry[at] = date & 0xff;
    entry[at + 1] = (date >>> 8) & 0xff;
  }
}

/**
 * The long-name entries that must precede a short one, in on-disk order.
 *
 * They are stored backwards: the piece holding the *end* of the name comes
 * first and carries the 0x40 flag. Each one repeats a checksum of the short
 * name, which is what ties the two together — an entry whose checksum does not
 * match is treated as an orphan and ignored, so a wrong checksum shows up as
 * the short name appearing instead of the long one.
 *
 * @param {string} name
 * @param {Uint8Array} shortBytes
 * @returns {Uint8Array[]}
 */
export function longNameRecords(name, shortBytes) {
  const units = [];
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const offset = code - 0x10000;
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      units.push(code);
    }
  }

  const checksum = shortNameChecksum(shortBytes);
  const pieces = Math.ceil(units.length / 13);
  const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  /** @type {Uint8Array[]} */
  const out = [];

  for (let piece = pieces; piece >= 1; piece--) {
    const entry = new Uint8Array(DIR_ENTRY_SIZE);
    entry[0] = piece | (piece === pieces ? 0x40 : 0);
    entry[11] = FAT_ATTR_LONG_NAME;
    entry[13] = checksum;
    for (let i = 0; i < 13; i++) {
      const index = (piece - 1) * 13 + i;
      // One NUL terminates the name; every slot after it is 0xFFFF. Padding
      // with NULs instead makes some readers show trailing blanks.
      const value = index < units.length ? units[index] : index === units.length ? 0x0000 : 0xffff;
      entry[positions[i]] = value & 0xff;
      entry[positions[i] + 1] = (value >>> 8) & 0xff;
    }
    out.push(entry);
  }
  return out;
}

/**
 * @param {Uint8Array} shortBytes Eleven bytes, name and extension padded.
 * @returns {number}
 */
export function shortNameChecksum(shortBytes) {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum = (((sum & 1) << 7) + (sum >> 1) + shortBytes[i]) & 0xff;
  }
  return sum;
}

/**
 * Works out the 8.3 name an entry is stored under.
 *
 * A lower-case name that already fits 8.3 does not need long-name entries at
 * all: two bits in the entry say which half was lower case, and that is how
 * `hello.txt` is stored on the reference boards. Anything else — too long, a
 * character 8.3 cannot hold, mixed case — gets a mangled short name plus the
 * real one in long-name entries.
 *
 * @param {string} name
 * @param {Set<string>} taken Short names already used in this directory.
 * @param {string} path       For the error message only.
 * @returns {{bytes: Uint8Array, text: string, caseFlags: number, needsLongName: boolean}}
 */
export function shortNameFor(name, taken, path) {
  if (name.length === 0) throw new FsPathError(path, 'an empty name cannot be stored');

  const dot = name.lastIndexOf('.');
  const rawBase = dot > 0 ? name.slice(0, dot) : name;
  const rawExt = dot > 0 ? name.slice(dot + 1) : '';

  const simple =
    dot !== 0 &&
    !rawBase.includes('.') &&
    rawBase.length > 0 &&
    rawBase.length <= 8 &&
    rawExt.length <= 3 &&
    isShortSafe(rawBase) &&
    isShortSafe(rawExt) &&
    consistentCase(rawBase) &&
    consistentCase(rawExt);

  if (simple) {
    const text = pad(rawBase.toUpperCase(), 8) + pad(rawExt.toUpperCase(), 3);
    if (!taken.has(text)) {
      let caseFlags = 0;
      if (rawBase !== rawBase.toUpperCase()) caseFlags |= 0x08;
      if (rawExt !== rawExt.toUpperCase()) caseFlags |= 0x10;
      return { bytes: asciiBytes(text), text, caseFlags, needsLongName: false };
    }
  }

  const base = sanitize(rawBase) || 'FILE';
  const ext = sanitize(rawExt).slice(0, 3);
  for (let n = 1; n < 1000000; n++) {
    const tail = `~${n}`;
    const stem = base.slice(0, Math.max(1, 8 - tail.length)) + tail;
    const text = pad(stem, 8) + pad(ext, 3);
    if (!taken.has(text)) {
      return { bytes: asciiBytes(text), text, caseFlags: 0, needsLongName: true };
    }
  }
  throw new FsPathError(path, 'no unused short name is available in this directory');
}

/** @param {string} text */
function isShortSafe(text) {
  for (const char of text) {
    const upper = char.toUpperCase();
    const ok =
      (upper >= 'A' && upper <= 'Z') ||
      (upper >= '0' && upper <= '9') ||
      SHORT_NAME_EXTRA.includes(upper);
    if (!ok) return false;
  }
  return true;
}

/**
 * Whether a string is all upper case or all lower case, which is all the two
 * flag bits in a directory entry can say.
 *
 * @param {string} text
 * @returns {boolean}
 */
function consistentCase(text) {
  return text === text.toUpperCase() || text === text.toLowerCase();
}

/** @param {string} text */
function sanitize(text) {
  let out = '';
  for (const char of text.toUpperCase()) {
    out += isShortSafe(char) ? char : '_';
  }
  return out;
}

/** @param {string} text @param {number} width */
const pad = (text, width) => text + ' '.repeat(Math.max(0, width - text.length));

/** @param {string} text */
function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
