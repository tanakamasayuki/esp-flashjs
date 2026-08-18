// @ts-check
/**
 * Binary analyzer plugin registry.
 *
 * Analyzers declare how confident they are that a buffer is theirs, and the
 * highest bidder gets to describe it. Unrecognized data falls through to the
 * `raw` analyzer rather than being rejected — an unparseable region is still
 * worth showing in a hex view.
 *
 * @module format/registry
 */

import { parsePartitionTable, validatePartitionTable, PARTITION_MAGIC } from './partition.js';
import { parseEspImage, ESP_IMAGE_MAGIC } from './image.js';
import { parseOtaData } from './otadata.js';
import { parseNvs } from './nvs/parse.js';
import { parseSpiffs } from './fs/spiffs.js';
import { parseLittlefs, LITTLEFS_MAGIC } from './fs/littlefs.js';
import { parseFat, parseBpb } from './fs/fat.js';
import { entropy, isUniform } from '../binary/diff.js';

/**
 * @typedef {import('./partition.js').Issue} Issue
 */

/**
 * @typedef {object} AnalyzeContext
 * @property {number} [offset]      Absolute flash offset the buffer came from.
 * @property {import('./partition.js').Partition} [partition] Owning partition, if known.
 * @property {number|null} [flashSize]
 * @property {boolean} [flashEncryptionEnabled] What the device reports about
 *   itself. Entropy alone cannot tell encryption from compression; this can.
 */

/**
 * @typedef {object} DetectionResult
 * @property {number} confidence  0.0 to 1.0.
 * @property {string} [reasonCode]
 */

/**
 * @typedef {object} BinaryRegion
 * @property {number} offset
 * @property {number} length
 * @property {string} label
 * @property {'header'|'data'|'entry'|'padding'|'unknown'} kind
 * @property {BinaryRegion[]} [children]
 */

/**
 * @typedef {object} AnalysisResult
 * @property {string} type
 * @property {number} confidence
 * @property {Record<string, unknown>} metadata
 * @property {BinaryRegion[]} regions
 * @property {Issue[]} issues
 * @property {unknown} [model]
 */

/**
 * @typedef {object} BinaryAnalyzer
 * @property {string} id
 * @property {string} name
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => DetectionResult} detect
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => AnalysisResult} analyze
 */

/** Below this, no analyzer is considered to have recognized the data. */
export const CONFIDENCE_THRESHOLD = 0.3;

/** @type {Map<string, BinaryAnalyzer>} */
const analyzers = new Map();

/** @param {BinaryAnalyzer} analyzer */
export function registerAnalyzer(analyzer) {
  analyzers.set(analyzer.id, analyzer);
}

/** @param {string} id @returns {boolean} */
export function unregisterAnalyzer(id) {
  return analyzers.delete(id);
}

/** @returns {BinaryAnalyzer[]} */
export function listAnalyzers() {
  return [...analyzers.values()];
}

/**
 * Runs every analyzer's cheap detection pass.
 *
 * @param {Uint8Array} data
 * @param {AnalyzeContext} [ctx]
 * @returns {Array<DetectionResult & {id: string, name: string}>} Descending by confidence.
 */
export function detectFormat(data, ctx = {}) {
  const results = [];
  for (const analyzer of analyzers.values()) {
    if (analyzer.id === 'raw') continue;
    let detection;
    try {
      detection = analyzer.detect(data, ctx);
    } catch {
      // A detector that throws is simply not a match; never let it break the
      // whole detection sweep.
      continue;
    }
    if (detection.confidence > 0) {
      results.push({ ...detection, id: analyzer.id, name: analyzer.name });
    }
  }
  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Analyzes a buffer using the best-matching analyzer.
 *
 * @param {Uint8Array} data
 * @param {AnalyzeContext} [ctx]
 * @returns {AnalysisResult}
 */
export function analyzeBinary(data, ctx = {}) {
  const candidates = detectFormat(data, ctx);
  const best = candidates[0];
  const analyzer = best ? analyzers.get(best.id) : undefined;
  if (best && analyzer && best.confidence >= CONFIDENCE_THRESHOLD) {
    try {
      return analyzer.analyze(data, ctx);
    } catch (error) {
      // Detection said yes but parsing blew up: report it against the raw view
      // rather than surfacing an exception to the caller.
      const raw = rawAnalyzer.analyze(data, ctx);
      raw.issues.push({
        level: 'error',
        code: 'analyze.failed',
        params: { analyzer: best.id, message: /** @type {Error} */ (error).message },
      });
      return raw;
    }
  }
  return rawAnalyzer.analyze(data, ctx);
}

/**
 * Analyzes a buffer as a specific format, bypassing detection.
 *
 * @param {string} id
 * @param {Uint8Array} data
 * @param {AnalyzeContext} [ctx]
 * @returns {AnalysisResult}
 * @throws {Error} If no analyzer with that id is registered.
 */
export function analyzeBinaryAs(id, data, ctx = {}) {
  const analyzer = analyzers.get(id);
  if (!analyzer) throw new Error(`No analyzer registered with id "${id}".`);
  return analyzer.analyze(data, ctx);
}

/* -------------------------------------------------------------------------- */
/* Built-in analyzers                                                          */
/* -------------------------------------------------------------------------- */

/** @type {BinaryAnalyzer} */
export const partitionTableAnalyzer = {
  id: 'partition-table',
  name: 'Partition Table',
  detect(data, ctx) {
    if (data.length < 32) return { confidence: 0 };
    const magic = readU16(data, 0);
    if (magic !== PARTITION_MAGIC) return { confidence: 0 };
    try {
      const table = parsePartitionTable(data);
      if (table.hasMd5) {
        return table.md5Valid
          ? { confidence: 1.0, reasonCode: 'magicAndMd5' }
          : { confidence: 0.5, reasonCode: 'md5Mismatch' };
      }
      return { confidence: 0.8, reasonCode: 'magicOnly' };
    } catch {
      return { confidence: 0 };
    }
  },
  analyze(data, ctx) {
    const table = parsePartitionTable(data);
    const issues = [
      ...table.issues,
      ...validatePartitionTable(table, { flashSize: ctx.flashSize ?? null }),
    ];

    /** @type {BinaryRegion[]} */
    const regions = table.partitions.map((p) => ({
      offset: p.entryIndex * 32,
      length: 32,
      label: p.label || `entry ${p.entryIndex}`,
      kind: /** @type {const} */ ('entry'),
    }));
    if (table.hasMd5) {
      regions.push({
        offset: table.partitions.length * 32,
        length: 32,
        label: 'MD5 checksum',
        kind: 'header',
      });
    }

    return {
      type: 'partition-table',
      confidence: table.hasMd5 && table.md5Valid ? 1.0 : 0.8,
      metadata: {
        partitionCount: table.partitions.length,
        hasMd5: table.hasMd5,
        md5Valid: table.md5Valid,
      },
      regions,
      issues,
      model: table,
    };
  },
};

/**
 * Offsets a bootloader can start at, by chip family.
 *
 * A dump of the boot area starts at flash 0, but the bootloader itself does
 * not: it sits at 0x0 on the ESP32-S3 and C3, 0x1000 on the ESP32 and S2, and
 * 0x2000 on the P4. Looking only at offset 0 therefore recognises the boot
 * area of one chip family in three and calls the rest raw data — which is what
 * captures from three different boards made obvious.
 */
export const BOOTLOADER_OFFSETS = Object.freeze([0x0, 0x1000, 0x2000]);

/**
 * @param {Uint8Array} data
 * @returns {number} Offset of an image header, or -1.
 */
function findImageStart(data) {
  for (const at of BOOTLOADER_OFFSETS) {
    if (at + 24 > data.length) break;
    if (data[at] !== ESP_IMAGE_MAGIC) continue;
    // Everything before a bootloader is erased flash. Anything else means the
    // magic byte is a coincidence rather than the start of an image.
    if (at > 0 && !isUniform(data.subarray(0, at), 0xff)) continue;
    return at;
  }
  return -1;
}

/** @type {BinaryAnalyzer} */
export const espImageAnalyzer = {
  id: 'esp-image',
  name: 'ESP Firmware Image',
  detect(data) {
    const start = findImageStart(data);
    if (start < 0) return { confidence: 0 };
    try {
      const image = parseEspImage(data.subarray(start));
      if (image.segments.length === 0) return { confidence: 0.3, reasonCode: 'noSegments' };
      return image.checksumValid
        ? { confidence: 1.0, reasonCode: 'magicAndChecksum' }
        : { confidence: 0.5, reasonCode: 'checksumMismatch' };
    } catch {
      return { confidence: 0 };
    }
  },
  analyze(data) {
    const start = Math.max(0, findImageStart(data));
    const image = parseEspImage(data.subarray(start));
    /** @type {BinaryRegion[]} */
    const regions = [{ offset: start, length: 24, label: 'Image header', kind: 'header' }];
    for (const seg of image.segments) {
      regions.push({
        offset: start + seg.fileOffset - 8,
        length: 8,
        label: `Segment ${seg.index} header`,
        kind: 'header',
      });
      regions.push({
        offset: start + seg.fileOffset,
        length: seg.length,
        label: `Segment ${seg.index} @ 0x${seg.loadAddress.toString(16)}`,
        kind: 'data',
      });
    }
    if (image.hashAppended && image.sha256) {
      regions.push({
        offset: start + image.imageLength - 32,
        length: 32,
        label: 'SHA-256',
        kind: 'header',
      });
    }

    return {
      type: 'esp-image',
      confidence: image.checksumValid ? 1.0 : 0.5,
      metadata: {
        chip: image.chipName,
        imageOffset: start,
        entryPoint: image.entryPoint,
        segments: image.segments.length,
        imageLength: image.imageLength,
        spiMode: image.spiMode,
        flashSize: image.flashSize,
        flashFreq: image.flashFreq,
        appVersion: image.app?.version ?? null,
        projectName: image.app?.projectName ?? null,
        idfVersion: image.app?.idfVersion ?? null,
      },
      regions,
      issues: image.issues,
      model: image,
    };
  },
};

/** @type {BinaryAnalyzer} */
export const otaDataAnalyzer = {
  id: 'otadata',
  name: 'OTA Data',
  detect(data, ctx) {
    // otadata has no magic; it is identified by size and by the partition
    // subtype it came from. Without that hint, stay at heuristic confidence.
    if (data.length !== 0x2000) return { confidence: 0 };
    const bySubtype = ctx.partition?.subtypeName === 'ota';
    const parsed = parseOtaData(data);
    if (bySubtype) return { confidence: 0.8, reasonCode: 'subtypeHint' };
    return parsed.sectors.some((s) => s.valid) ? { confidence: 0.3, reasonCode: 'validCrc' } : { confidence: 0 };
  },
  analyze(data, ctx) {
    const ota = parseOtaData(data);
    return {
      type: 'otadata',
      confidence: ctx.partition?.subtypeName === 'ota' ? 0.8 : 0.3,
      metadata: {
        activeSector: ota.activeSector,
        bootSlot: ota.bootSlot,
        sequences: ota.sectors.map((s) => s.seq),
      },
      regions: ota.sectors.map((s) => ({
        offset: s.index * 0x1000,
        length: 32,
        label: `Sector ${s.index} (seq ${s.empty ? 'empty' : s.seq})`,
        kind: /** @type {const} */ ('header'),
      })),
      issues: ota.issues,
      model: ota,
    };
  },
};

/**
 * Formats we can name from a partition subtype but cannot yet parse.
 *
 * Knowing "this is NVS, we just do not read NVS yet" is a different answer from
 * "we have no idea what this is", and the partition table already tells us
 * which one applies. Reporting them the same way wastes information the device
 * handed us.
 *
 * @type {Record<string, {format: string, phase: number}>}
 */
export const UNIMPLEMENTED_SUBTYPE_FORMATS = {
  // Encrypted key material; there is nothing readable to show even in principle.
  nvs_keys: { format: 'nvs-keys', phase: 2 },
  coredump: { format: 'coredump', phase: 4 },
  phy: { format: 'phy-init', phase: 4 },
};


/**
 * Whether a buffer holds nothing at all.
 *
 * Analyzers that lean on the partition subtype must check this first. A blank
 * `nvs` partition is still an `nvs` partition as far as the table is
 * concerned, so the subtype hint alone would have them claim erased flash with
 * high confidence and report it as a filesystem containing no files — which
 * reads as "empty" rather than as "never formatted".
 *
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function isBlank(data) {
  return isUniform(data, 0xff) || isUniform(data, 0x00);
}

/**
 * Turns a parsed filesystem into the shape the inspector wants.
 *
 * @param {import('./fs/types.js').FsImage} image
 * @param {number} confidence
 * @returns {any}
 */
function filesystemResult(image, confidence) {
  const files = image.files.filter((f) => !f.directory);
  return {
    type: image.type,
    confidence,
    metadata: {
      files: files.length,
      directories: image.files.length - files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      ...image.geometry,
    },
    // One region per file, so a hex view can show where each one lives. Files
    // are scattered across the image rather than laid out in order, which is
    // precisely what makes them hard to find by eye.
    regions: files.slice(0, 512).map((f) => ({
      offset: (f.pageIndices[0] ?? 0) * (image.geometry.pageSize ?? image.geometry.blockSize ?? image.geometry.bytesPerSector ?? 1),
      length: f.size,
      label: f.path,
      kind: /** @type {const} */ ('data'),
    })),
    issues: image.issues,
    model: image,
  };
}

/**
 * NVS.
 *
 * There is no magic to look for, so a partition subtype of `nvs` is the strong
 * signal and a page header that parses is the weak one.
 *
 * @type {BinaryAnalyzer}
 */
export const nvsAnalyzer = {
  id: 'nvs',
  name: 'NVS',
  detect(data, ctx) {
    if (data.length < 4096 || data.length % 4096 !== 0) return { confidence: 0 };
    if (isBlank(data)) return { confidence: 0 };
    if (ctx.partition?.subtypeName === 'nvs') return { confidence: 0.9, reasonCode: 'subtypeHint' };
    const store = parseNvs(data);
    if (store.entries.length === 0) return { confidence: 0 };
    return { confidence: 0.4, reasonCode: 'entriesFound' };
  },
  analyze(data, ctx) {
    const store = parseNvs(data);
    const issues = [...store.issues];

    // Flash encryption does not cover NVS, and this catches people out: the
    // chip reports encryption on, so the partition is assumed protected. It is
    // not. NVS has its own scheme, keyed from a separate `nvs_keys` partition,
    // and it has to be turned on separately.
    if (ctx.flashEncryptionEnabled === true) {
      issues.push({ level: 'warning', code: 'nvs.notFlashEncrypted', params: {} });
    }

    // An NVS partition with no readable pages and no structure is not an empty
    // one. NVS encryption turns the whole partition into ciphertext, and the
    // difference between "nothing stored here" and "cannot read what is stored
    // here" is the difference between a working device and a broken one.
    const usable = store.pages.filter((page) => page.stateName !== 'uninitialized').length;
    if (usable === 0 && store.entries.length === 0 && peakEntropy(data) > HIGH_ENTROPY_THRESHOLD) {
      issues.push({ level: 'warning', code: 'nvs.likelyEncrypted', params: {} });
    }

    return {
      type: 'nvs',
      confidence: ctx.partition?.subtypeName === 'nvs' ? 0.9 : 0.4,
      metadata: {
        entries: store.entries.length,
        erasedEntries: store.erasedEntries.length,
        namespaces: store.namespaces.length,
        pages: store.pages.length,
      },
      regions: store.pages
        .filter((page) => page.stateName !== 'uninitialized')
        .map((page) => ({
          offset: page.index * 4096,
          length: 4096,
          label: `Page ${page.index} (${page.stateName}, seq ${page.seqNo}, ${page.usedEntries} entries)`,
          kind: /** @type {const} */ ('entry'),
        })),
      issues,
      model: store,
    };
  },
};

/**
 * LittleFS. The only one of the three filesystems with a real magic string.
 *
 * @type {BinaryAnalyzer}
 */
export const littlefsAnalyzer = {
  id: 'littlefs',
  name: 'LittleFS',
  detect(data) {
    if (isBlank(data)) return { confidence: 0 };
    // The superblock name sits at offset 8 of whichever block of the first
    // metadata pair is current, and both blocks carry it after a format.
    for (const blockSize of [4096, 8192, 512, 256]) {
      for (const block of [0, 1]) {
        const at = block * blockSize + 8;
        if (at + LITTLEFS_MAGIC.length > data.length) continue;
        let match = true;
        for (let i = 0; i < LITTLEFS_MAGIC.length; i++) {
          if (data[at + i] !== LITTLEFS_MAGIC.charCodeAt(i)) { match = false; break; }
        }
        if (match) return { confidence: 0.95, reasonCode: 'superblockMagic' };
      }
    }
    return { confidence: 0 };
  },
  analyze(data) {
    return filesystemResult(parseLittlefs(data), 0.95);
  },
};

/**
 * FAT, as ESP-IDF writes it: behind a wear-levelling layer.
 *
 * @type {BinaryAnalyzer}
 */
export const fatAnalyzer = {
  id: 'fat',
  name: 'FAT',
  detect(data) {
    if (isBlank(data)) return { confidence: 0 };
    // parseBpb checks far more than the 0x55AA signature, which on its own
    // turns up in plenty of unrelated data.
    return parseBpb(data.subarray(0, 4096))
      ? { confidence: 0.9, reasonCode: 'bootSector' }
      : { confidence: 0 };
  },
  analyze(data) {
    return filesystemResult(parseFat(data), 0.9);
  },
};

/**
 * SPIFFS.
 *
 * Nothing in a SPIFFS image identifies it, and its page and block sizes are
 * not recorded either — so detection leans on the partition subtype, and
 * falls back to whether a plausible geometry finds intact files.
 *
 * @type {BinaryAnalyzer}
 */
export const spiffsAnalyzer = {
  id: 'spiffs',
  name: 'SPIFFS',
  detect(data, ctx) {
    if (isBlank(data)) return { confidence: 0 };
    if (ctx.partition?.subtypeName === 'spiffs') {
      return { confidence: 0.85, reasonCode: 'subtypeHint' };
    }
    // Only the default geometry here: sweeping five of them is too much work
    // for a detection pass that runs for every analyzer.
    const image = parseSpiffs(data, { detectGeometry: false });
    const intact = image.files.filter((f) => f.complete).length;
    return intact > 0 ? { confidence: 0.5, reasonCode: 'filesFound' } : { confidence: 0 };
  },
  analyze(data, ctx) {
    return filesystemResult(
      parseSpiffs(data),
      ctx.partition?.subtypeName === 'spiffs' ? 0.85 : 0.5,
    );
  },
};

/** Above this, a region's bytes carry no visible structure. */
export const HIGH_ENTROPY_THRESHOLD = 7.5;

/** Window size for the entropy scan. Small enough to notice one opaque file. */
const ENTROPY_WINDOW_SIZE = 16384;

/**
 * The highest entropy found in any window of the buffer.
 *
 * Every window is examined rather than a sample of them. Sampling was the
 * first attempt and it is wrong twice over: which part the head lands in is an
 * accident of how much has been written, and spreading a handful of windows
 * across a partition leaves gaps a whole file can hide in — a 64 KB opaque
 * region in a 512 KB partition fell between two of eight windows and read as
 * empty. Scanning is one pass over bytes that were just read off a device at
 * 10 KB/s; the cost is not worth an incomplete answer.
 *
 * Uniform windows are skipped, not counted as zero: erased flash between two
 * written regions says nothing about either.
 *
 * @param {Uint8Array} data
 * @returns {number}
 */
export function peakEntropy(data) {
  if (data.length === 0) return 0;
  let peak = 0;
  for (let at = 0; at < data.length; at += ENTROPY_WINDOW_SIZE) {
    // Not named `window`: that shadows a DOM global, and this module has to
    // stay usable outside a browser.
    const slice = data.subarray(at, Math.min(at + ENTROPY_WINDOW_SIZE, data.length));
    // A short trailing slice is too small for the measure to mean much.
    if (slice.length < 256) break;
    if (isUniform(slice, 0xff) || isUniform(slice, 0x00)) continue;
    const h = entropy(slice);
    if (h > peak) peak = h;
  }
  return peak;
}

/**
 * What high entropy means, given what else is known.
 *
 * Entropy on its own cannot separate encrypted bytes from compressed ones —
 * both are indistinguishable from noise, which is the point of both. Reporting
 * every compressed blob as "possibly encrypted" trains people to dismiss the
 * warning, and the one time it matters is the time they dismiss it.
 *
 * Two better signals are usually to hand and were previously unused: the
 * partition table marks partitions as encrypted, and the device says whether
 * flash encryption is switched on at all.
 *
 * @param {number} entropyValue
 * @param {import('./registry.js').AnalyzeContext} ctx
 * @returns {'encrypted'|'possibly-encrypted'|'high-entropy'|'unknown'}
 */
export function classifyEntropy(entropyValue, ctx) {
  if (entropyValue <= HIGH_ENTROPY_THRESHOLD) return 'unknown';

  // The chip is the authority. A device that says encryption is off is not to
  // be contradicted: opaque bytes there are compressed, hashed or already
  // random. Calling those "possibly encrypted" trains people to dismiss the
  // warning, and the one time it matters is the time they dismiss it.
  if (ctx.flashEncryptionEnabled === false) return 'high-entropy';
  if (ctx.flashEncryptionEnabled === true) return 'encrypted';

  // The partition table's flag is a *policy* bit — "encrypt this partition if
  // flash encryption is enabled" — not a statement that these bytes are
  // ciphertext. On a chip with encryption off it means nothing, which is why
  // it is only consulted once that has been ruled out above.
  if (ctx.partition?.encrypted) return 'encrypted';

  return 'possibly-encrypted';
}

/**
 * Fallback analyzer. Always succeeds, never claims to understand the data.
 * @type {BinaryAnalyzer}
 */
export const rawAnalyzer = {
  id: 'raw',
  name: 'Raw Binary',
  detect() {
    return { confidence: CONFIDENCE_THRESHOLD - 0.01 };
  },
  analyze(data, ctx = {}) {
    /** @type {Issue[]} */
    const issues = [];
    const allErased = isUniform(data, 0xff);
    const allZero = isUniform(data, 0x00);
    const h = allErased || allZero ? 0 : peakEntropy(data);
    const encryptionState = classifyEntropy(h, ctx);

    if (encryptionState === 'encrypted') {
      issues.push({ level: 'warning', code: 'analyze.encrypted', params: { entropy: h } });
    } else if (encryptionState === 'possibly-encrypted') {
      issues.push({ level: 'warning', code: 'analyze.possiblyEncrypted', params: { entropy: h } });
    } else if (encryptionState === 'high-entropy') {
      // Worth saying, but as a fact rather than an alarm: it explains why no
      // analyzer recognised the region without asserting a cause.
      issues.push({ level: 'warning', code: 'analyze.highEntropy', params: { entropy: h } });
    }

    // The partition table often tells us what this was meant to be, even when
    // no analyzer can read it yet.
    const expected = ctx.partition
      ? UNIMPLEMENTED_SUBTYPE_FORMATS[ctx.partition.subtypeName]
      : undefined;
    if (expected && !allErased && !allZero) {
      issues.push({
        level: 'warning',
        code: 'analyze.notImplemented',
        params: { format: expected.format, phase: expected.phase },
      });
    }

    return {
      type: encryptionState === 'unknown' || encryptionState === 'high-entropy' ? 'raw' : 'encrypted?',
      confidence: 0,
      metadata: {
        length: data.length,
        entropy: h,
        allErased,
        allZero,
        encryptionState,
        expectedFormat: expected?.format ?? null,
        expectedPhase: expected?.phase ?? null,
        contents: allErased ? 'erased' : allZero ? 'zeroed' : 'data',
      },
      regions: [],
      issues,
    };
  },
};

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @returns {number}
 */
function readU16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

registerAnalyzer(partitionTableAnalyzer);
registerAnalyzer(espImageAnalyzer);
registerAnalyzer(otaDataAnalyzer);
registerAnalyzer(nvsAnalyzer);
registerAnalyzer(littlefsAnalyzer);
registerAnalyzer(fatAnalyzer);
registerAnalyzer(spiffsAnalyzer);
registerAnalyzer(rawAnalyzer);
