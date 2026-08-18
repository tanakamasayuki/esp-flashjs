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
import { entropy, isUniform } from '../binary/diff.js';

/**
 * @typedef {import('./partition.js').Issue} Issue
 */

/**
 * @typedef {object} AnalyzeContext
 * @property {number} [offset]      Absolute flash offset the buffer came from.
 * @property {import('./partition.js').Partition} [partition] Owning partition, if known.
 * @property {number|null} [flashSize]
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

/** @type {BinaryAnalyzer} */
export const espImageAnalyzer = {
  id: 'esp-image',
  name: 'ESP Firmware Image',
  detect(data) {
    if (data.length < 24 || data[0] !== ESP_IMAGE_MAGIC) return { confidence: 0 };
    try {
      const image = parseEspImage(data);
      if (image.segments.length === 0) return { confidence: 0.3, reasonCode: 'noSegments' };
      return image.checksumValid
        ? { confidence: 1.0, reasonCode: 'magicAndChecksum' }
        : { confidence: 0.5, reasonCode: 'checksumMismatch' };
    } catch {
      return { confidence: 0 };
    }
  },
  analyze(data) {
    const image = parseEspImage(data);
    /** @type {BinaryRegion[]} */
    const regions = [{ offset: 0, length: 24, label: 'Image header', kind: 'header' }];
    for (const seg of image.segments) {
      regions.push({
        offset: seg.fileOffset - 8,
        length: 8,
        label: `Segment ${seg.index} header`,
        kind: 'header',
      });
      regions.push({
        offset: seg.fileOffset,
        length: seg.length,
        label: `Segment ${seg.index} @ 0x${seg.loadAddress.toString(16)}`,
        kind: 'data',
      });
    }
    if (image.hashAppended && image.sha256) {
      regions.push({
        offset: image.imageLength - 32,
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
  nvs: { format: 'nvs', phase: 2 },
  nvs_keys: { format: 'nvs-keys', phase: 2 },
  spiffs: { format: 'spiffs', phase: 3 },
  littlefs: { format: 'littlefs', phase: 4 },
  fat: { format: 'fat', phase: 4 },
  coredump: { format: 'coredump', phase: 4 },
  phy: { format: 'phy-init', phase: 4 },
};

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
    // Sampling keeps this cheap on multi-megabyte buffers; entropy is stable
    // enough over a 64 KB window to answer "does this look encrypted".
    const sample = data.length > 65536 ? data.subarray(0, 65536) : data;
    const h = allErased || allZero ? 0 : entropy(sample);
    const likelyEncrypted = h > 7.5;

    if (likelyEncrypted) {
      issues.push({ level: 'warning', code: 'analyze.possiblyEncrypted', params: { entropy: h } });
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
      type: likelyEncrypted ? 'encrypted?' : 'raw',
      confidence: 0,
      metadata: {
        length: data.length,
        entropy: h,
        allErased,
        allZero,
        encryptionState: likelyEncrypted ? 'possibly-encrypted' : 'unknown',
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
registerAnalyzer(rawAnalyzer);
