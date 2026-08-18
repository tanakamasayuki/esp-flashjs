// @ts-check
/**
 * FAT parsing, including the wear-levelling layer ESP-IDF puts underneath it.
 *
 * The wear-levelling part is not optional. ESP-IDF keeps one spare sector and
 * skips over it, so logical sector n sits at physical sector n + 1 for every n
 * at or past the spare. On a freshly formatted partition the spare lands at
 * physical sector 1, which leaves the boot sector exactly where a naive reader
 * expects it — and everything else one sector out. Reading the image as plain
 * FAT therefore parses the BPB perfectly and then finds the file allocation
 * table where the root directory should be.
 *
 * ```text
 * Logical layout, from the BPB
 *   0                       boot sector
 *   reserved                first FAT
 *   reserved + fatSize      second FAT
 *   reserved + fats*fatSize root directory (FAT12/16 only)
 *   ...                     data clusters, numbered from 2
 * ```
 *
 * @module format/fs/fat
 */

/**
 * @typedef {import('../partition.js').Issue} Issue
 * @typedef {import('./types.js').FsFile} FsFile
 * @typedef {import('./types.js').FsImage} FsImage
 */

/** Directory entry attribute bits. */
export const FAT_ATTR = {
  READ_ONLY: 0x01,
  HIDDEN: 0x02,
  SYSTEM: 0x04,
  VOLUME_ID: 0x08,
  DIRECTORY: 0x10,
  ARCHIVE: 0x20,
};

/** An entry with exactly these bits set is one piece of a long file name. */
export const FAT_ATTR_LONG_NAME =
  FAT_ATTR.READ_ONLY | FAT_ATTR.HIDDEN | FAT_ATTR.SYSTEM | FAT_ATTR.VOLUME_ID;

/** Marks the end of the entries in a directory. */
const ENTRY_FREE_AND_LAST = 0x00;
/** Marks a deleted entry; the rest of the directory continues after it. */
const ENTRY_DELETED = 0xe5;

const DIR_ENTRY_SIZE = 32;

/** @param {Uint8Array} d @param {number} o */
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
/** @param {Uint8Array} d @param {number} o */
const u32 = (d, o) => ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0);

/**
 * @typedef {object} FatGeometry
 * @property {number} bytesPerSector
 * @property {number} sectorsPerCluster
 * @property {number} reservedSectors
 * @property {number} numFats
 * @property {number} rootEntries
 * @property {number} totalSectors
 * @property {number} fatSize
 * @property {number} rootDirSectors
 * @property {number} firstDataSector
 * @property {number} clusterCount
 * @property {number} bits          12, 16 or 32.
 * @property {number} rootCluster   FAT32 only.
 * @property {number} wlDummySector -1 when there is no wear-levelling shift.
 */

/**
 * Reads a BIOS parameter block.
 *
 * @param {Uint8Array} sector
 * @returns {FatGeometry|null} Null when the sector is not a BPB.
 */
export function parseBpb(sector) {
  if (sector.length < 512) return null;
  if (sector[510] !== 0x55 || sector[511] !== 0xaa) return null;

  const bytesPerSector = u16(sector, 11);
  const sectorsPerCluster = sector[13];
  const reservedSectors = u16(sector, 14);
  const numFats = sector[16];

  // Every one of these is a power of two in practice, and a stray 0x55AA in
  // unrelated data almost never satisfies all four at once.
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) return null;
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null;
  if (reservedSectors === 0 || numFats === 0 || numFats > 4) return null;

  const rootEntries = u16(sector, 17);
  const totalSectors = u16(sector, 19) || u32(sector, 32);
  const fatSize = u16(sector, 22) || u32(sector, 36);
  if (fatSize === 0 || totalSectors === 0) return null;

  const rootDirSectors = Math.ceil((rootEntries * DIR_ENTRY_SIZE) / bytesPerSector);
  const firstDataSector = reservedSectors + numFats * fatSize + rootDirSectors;
  const dataSectors = totalSectors - firstDataSector;
  if (dataSectors <= 0) return null;
  const clusterCount = Math.floor(dataSectors / sectorsPerCluster);

  // The thresholds are Microsoft's and are the definition of the FAT type, not
  // a heuristic: a volume is FAT12/16/32 purely by how many clusters it has.
  const bits = clusterCount < 4085 ? 12 : clusterCount < 65525 ? 16 : 32;

  return {
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
    rootCluster: bits === 32 ? u32(sector, 44) : 0,
    wlDummySector: -1,
  };
}

/**
 * Maps a logical sector to where it actually sits in the image.
 *
 * @param {number} sector
 * @param {number} dummy Physical sector held spare, or -1 for none.
 * @returns {number}
 */
export function wlMapSector(sector, dummy) {
  if (dummy < 0) return sector;
  return sector >= dummy ? sector + 1 : sector;
}

/**
 * Parses a FAT image.
 *
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.wlDummySector] Skip detection and use this.
 * @returns {FsImage}
 */
export function parseFat(data, { wlDummySector } = {}) {
  /** @type {Issue[]} */
  const issues = [];
  /** @type {Record<string, number>} */
  const emptyGeometry = { bytesPerSector: 0, clusterCount: 0, bits: 0 };

  const boot = parseBpb(data.subarray(0, 4096));
  if (!boot) {
    issues.push({ level: 'error', code: 'fat.noBootSector', params: {} });
    return { type: 'fat', files: [], geometry: emptyGeometry, issues };
  }

  const dummy = wlDummySector ?? detectWlDummy(data, boot);
  if (dummy < 0 && wlDummySector === undefined) {
    issues.push({ level: 'warning', code: 'fat.noValidLayout', params: {} });
  }
  const geometry = { ...boot, wlDummySector: dummy };

  /** @param {number} sector */
  const sectorAt = (sector) => {
    const at = wlMapSector(sector, dummy) * geometry.bytesPerSector;
    return data.subarray(at, at + geometry.bytesPerSector);
  };

  const fat = readFatTable(data, geometry, sectorAt);

  /** @type {FsFile[]} */
  const files = [];
  const rootSectors = [];
  if (geometry.bits === 32) {
    rootSectors.push(...clusterChainSectors(geometry, fat, geometry.rootCluster, issues));
  } else {
    const first = geometry.reservedSectors + geometry.numFats * geometry.fatSize;
    for (let i = 0; i < geometry.rootDirSectors; i++) rootSectors.push(first + i);
  }

  walkDirectory(data, geometry, fat, sectorAt, rootSectors, '', files, issues, new Set(), 0);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { type: 'fat', files, geometry: /** @type {any} */ (geometry), issues };
}

/**
 * Works out which physical sector the wear-levelling layer is holding spare.
 *
 * The BPB says where the root directory should be; whichever spare position
 * puts real directory entries there is the right one. Guessing "no shift"
 * still parses the BPB and then reads a file allocation table as if it were
 * the root directory, which yields a confidently empty filesystem.
 *
 * @param {Uint8Array} data
 * @param {FatGeometry} boot
 * @returns {number}
 */
function detectWlDummy(data, boot) {
  const rootStart = boot.reservedSectors + boot.numFats * boot.fatSize;
  const candidates = [1, -1, ...Array.from({ length: 8 }, (_, i) => i + 2)];

  for (const dummy of candidates) {
    const at = wlMapSector(rootStart, dummy) * boot.bytesPerSector;
    const sector = data.subarray(at, at + boot.bytesPerSector);
    if (sector.length < DIR_ENTRY_SIZE) continue;
    if (looksLikeDirectory(sector)) return dummy;
  }
  return -1;
}

/**
 * @param {Uint8Array} sector
 * @returns {boolean}
 */
function looksLikeDirectory(sector) {
  const first = sector[0];
  if (first === ENTRY_FREE_AND_LAST) return false; // an empty root proves nothing
  if (first === ENTRY_DELETED) return true;
  // A short name is eleven bytes of printable ASCII, and its attribute byte
  // never has the top two bits set.
  for (let i = 0; i < 11; i++) {
    const c = sector[i];
    if (c < 0x20 || c > 0x7e) return false;
  }
  return (sector[11] & 0xc0) === 0;
}

/**
 * @param {Uint8Array} data
 * @param {FatGeometry} geometry
 * @param {(sector: number) => Uint8Array} sectorAt
 * @returns {Uint8Array}
 */
function readFatTable(data, geometry, sectorAt) {
  const out = new Uint8Array(geometry.fatSize * geometry.bytesPerSector);
  for (let i = 0; i < geometry.fatSize; i++) {
    out.set(sectorAt(geometry.reservedSectors + i), i * geometry.bytesPerSector);
  }
  return out;
}

/**
 * Reads one entry from the file allocation table.
 *
 * FAT12 packs entries into a byte and a half, so a cluster's entry can start
 * mid-byte and the two halves are assembled differently depending on whether
 * the cluster number is odd. This is the one place the three FAT widths
 * genuinely differ.
 *
 * @param {Uint8Array} fat
 * @param {number} cluster
 * @param {number} bits
 * @returns {number}
 */
export function readFatEntry(fat, cluster, bits) {
  if (bits === 12) {
    const at = cluster + (cluster >> 1);
    if (at + 1 >= fat.length) return 0;
    const pair = fat[at] | (fat[at + 1] << 8);
    return cluster & 1 ? pair >> 4 : pair & 0x0fff;
  }
  if (bits === 16) {
    const at = cluster * 2;
    return at + 1 < fat.length ? u16(fat, at) : 0;
  }
  const at = cluster * 4;
  return at + 3 < fat.length ? u32(fat, at) & 0x0fffffff : 0;
}

/** @param {number} value @param {number} bits */
function isEndOfChain(value, bits) {
  const limit = bits === 12 ? 0xff8 : bits === 16 ? 0xfff8 : 0x0ffffff8;
  return value >= limit;
}

/**
 * @param {FatGeometry} geometry
 * @param {Uint8Array} fat
 * @param {number} start
 * @param {Issue[]} issues
 * @returns {number[]}
 */
function clusterChainSectors(geometry, fat, start, issues) {
  /** @type {number[]} */
  const sectors = [];
  const seen = new Set();
  let cluster = start;

  while (cluster >= 2 && cluster < geometry.clusterCount + 2) {
    // A corrupted table can point a cluster back at itself or at an earlier
    // one; without this the walk never returns.
    if (seen.has(cluster)) {
      issues.push({ level: 'warning', code: 'fat.clusterLoop', params: { cluster } });
      break;
    }
    seen.add(cluster);

    const first = geometry.firstDataSector + (cluster - 2) * geometry.sectorsPerCluster;
    for (let i = 0; i < geometry.sectorsPerCluster; i++) sectors.push(first + i);

    const next = readFatEntry(fat, cluster, geometry.bits);
    if (isEndOfChain(next, geometry.bits) || next === 0) break;
    cluster = next;
  }
  return sectors;
}

/**
 * @param {Uint8Array} data
 * @param {FatGeometry} geometry
 * @param {Uint8Array} fat
 * @param {(sector: number) => Uint8Array} sectorAt
 * @param {number[]} sectors
 * @param {string} prefix
 * @param {FsFile[]} files
 * @param {Issue[]} issues
 * @param {Set<number>} visited
 * @param {number} depth
 */
function walkDirectory(data, geometry, fat, sectorAt, sectors, prefix, files, issues, visited, depth) {
  if (depth > 32) return;

  /** Long-name pieces are stored before their entry, in reverse order. */
  let longName = '';
  let done = false;

  for (const sector of sectors) {
    if (done) break;
    const bytes = sectorAt(sector);
    for (let off = 0; off + DIR_ENTRY_SIZE <= bytes.length; off += DIR_ENTRY_SIZE) {
      const entry = bytes.subarray(off, off + DIR_ENTRY_SIZE);
      if (entry[0] === ENTRY_FREE_AND_LAST) {
        done = true;
        break;
      }
      if (entry[0] === ENTRY_DELETED) {
        longName = '';
        continue;
      }

      const attr = entry[11];
      if ((attr & 0x3f) === FAT_ATTR_LONG_NAME) {
        longName = decodeLongNamePiece(entry) + longName;
        continue;
      }
      if (attr & FAT_ATTR.VOLUME_ID) {
        longName = '';
        continue;
      }

      const name = longName || decodeShortName(entry);
      longName = '';
      if (name === '.' || name === '..') continue;

      const cluster = (u16(entry, 20) << 16) | u16(entry, 26);
      const size = u32(entry, 28);
      const path = `${prefix}/${name}`;

      if (attr & FAT_ATTR.DIRECTORY) {
        files.push({
          path,
          size: 0,
          read: () => new Uint8Array(0),
          pageIndices: [],
          complete: true,
          directory: true,
        });
        if (cluster >= 2 && !visited.has(cluster)) {
          visited.add(cluster);
          walkDirectory(
            data,
            geometry,
            fat,
            sectorAt,
            clusterChainSectors(geometry, fat, cluster, issues),
            path,
            files,
            issues,
            visited,
            depth + 1,
          );
        }
        continue;
      }

      const chain = size === 0 ? [] : clusterChainSectors(geometry, fat, cluster, issues);
      const capacity = chain.length * geometry.bytesPerSector;
      const complete = capacity >= size;
      if (!complete) {
        issues.push({ level: 'warning', code: 'fat.shortChain', params: { path } });
      }
      files.push({
        path,
        size,
        pageIndices: chain.map((s) => wlMapSector(s, geometry.wlDummySector)),
        complete,
        read: () => {
          const out = new Uint8Array(size);
          let written = 0;
          for (const s of chain) {
            if (written >= size) break;
            const chunk = sectorAt(s).subarray(0, Math.min(geometry.bytesPerSector, size - written));
            out.set(chunk, written);
            written += chunk.length;
          }
          return out;
        },
      });
    }
  }
}

/**
 * @param {Uint8Array} entry
 * @returns {string}
 */
function decodeLongNamePiece(entry) {
  // UTF-16 code units at three disjoint ranges, which is how the pieces fit
  // around the fields a short-name entry needs at fixed offsets.
  const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  let out = '';
  for (const at of positions) {
    const code = u16(entry, at);
    if (code === 0x0000 || code === 0xffff) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * @param {Uint8Array} entry
 * @returns {string}
 */
function decodeShortName(entry) {
  /** @param {number} from @param {number} to */
  const decode = (from, to) => {
    let s = '';
    for (let i = from; i < to; i++) s += String.fromCharCode(entry[i]);
    return s.replace(/ +$/, '');
  };
  const base = decode(0, 8);
  const ext = decode(8, 11);
  // Short names are stored upper case; lower-casing them back is what every
  // other tool shows, and the case bits in byte 12 say which halves were
  // originally lower case.
  const lowerBase = (entry[12] & 0x08) !== 0;
  const lowerExt = (entry[12] & 0x10) !== 0;
  const name = lowerBase ? base.toLowerCase() : base;
  const suffix = lowerExt ? ext.toLowerCase() : ext;
  return suffix ? `${name}.${suffix}` : name;
}
