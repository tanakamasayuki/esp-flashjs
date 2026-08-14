// @ts-check
/**
 * Device-independent entry point.
 *
 * Everything exported here is pure computation over byte arrays: parsers,
 * builders, analyzers and binary utilities. Nothing touches a serial port, a
 * DOM node or the network, so this module runs unchanged in Node.js, in a
 * worker, and in the browser.
 *
 * Import this instead of the full package when you only need to analyze files.
 *
 * @module core
 */

/**
 * Type re-exports.
 *
 * `export *` carries values but not JSDoc typedefs, so consumers writing
 * `import('esp-flashjs/core').Partition` would otherwise get nothing. Aliasing
 * them here makes the public types reachable from the package entry point.
 *
 * @typedef {import('./format/partition.js').Partition} Partition
 * @typedef {import('./format/partition.js').PartitionTable} PartitionTable
 * @typedef {import('./format/partition.js').Issue} Issue
 * @typedef {import('./format/image.js').EspImage} EspImage
 * @typedef {import('./format/image.js').Segment} Segment
 * @typedef {import('./format/image.js').AppDescription} AppDescription
 * @typedef {import('./format/otadata.js').OtaData} OtaData
 * @typedef {import('./format/otadata.js').OtaSector} OtaSector
 * @typedef {import('./format/registry.js').AnalysisResult} AnalysisResult
 * @typedef {import('./format/registry.js').AnalyzeContext} AnalyzeContext
 * @typedef {import('./format/registry.js').BinaryAnalyzer} BinaryAnalyzer
 * @typedef {import('./format/registry.js').BinaryRegion} BinaryRegion
 * @typedef {import('./format/registry.js').DetectionResult} DetectionResult
 * @typedef {import('./binary/diff.js').BinaryDiffChunk} BinaryDiffChunk
 * @typedef {import('./binary/search.js').BytePattern} BytePattern
 */

/* Errors ------------------------------------------------------------------ */
export {
  EspFlashError,
  TransportError,
  TransportTimeoutError,
  TransportClosedError,
  ProtocolError,
  SyncFailedError,
  CommandFailedError,
  UnknownChipError,
  DeviceError,
  StubLoadError,
  SecureDownloadModeError,
  UnsupportedOperationError,
  FormatError,
  InvalidMagicError,
  ChecksumError,
  TruncatedDataError,
  AlignmentError,
  OutOfRangeError,
  NvsCapacityError,
  OperationAbortedError,
} from './util/errors.js';

/* Formatting -------------------------------------------------------------- */
export {
  toHexAddress,
  bytesToHex,
  hexToBytes,
  parseAddress,
  hexDump,
  toPrintableAscii,
  formatByteSize,
  decodeCString,
  encodeCString,
} from './util/hex.js';

/* Binary utilities -------------------------------------------------------- */
export { ByteReader } from './binary/reader.js';
export { ByteWriter } from './binary/writer.js';
export { crc32, md5, md5Hex, sha256, espChecksum, ESP_CHECKSUM_MAGIC } from './binary/hash.js';
export { searchBytes, searchText, parseHexPattern, extractStrings } from './binary/search.js';
export { diffBinary, diffBinaryStream, diffSummary, isUniform, entropy } from './binary/diff.js';

/* Partition table --------------------------------------------------------- */
export {
  parsePartitionTable,
  buildPartitionTable,
  validatePartitionTable,
  findUnallocatedRegions,
  findPartitionByLabel,
  findPartitionAt,
  typeName,
  subtypeName,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
  PARTITION_ENTRY_SIZE,
  PARTITION_MAGIC,
  PARTITION_MD5_MAGIC,
  PARTITION_TYPE,
  MAX_PARTITIONS,
} from './format/partition.js';

/* Firmware image ---------------------------------------------------------- */
export {
  parseEspImage,
  parseAppDescription,
  verifyImageHash,
  memoryRegionFor,
  ESP_IMAGE_MAGIC,
  IMAGE_CHIP_IDS,
} from './format/image.js';

/* OTA data ---------------------------------------------------------------- */
export { parseOtaData, OTADATA_SECTOR_SIZE } from './format/otadata.js';

/* Analyzer registry ------------------------------------------------------- */
export {
  registerAnalyzer,
  unregisterAnalyzer,
  listAnalyzers,
  detectFormat,
  analyzeBinary,
  analyzeBinaryAs,
  partitionTableAnalyzer,
  espImageAnalyzer,
  otaDataAnalyzer,
  rawAnalyzer,
  CONFIDENCE_THRESHOLD,
} from './format/registry.js';

/* Chip metadata ----------------------------------------------------------- */
export { CHIPS, chipByName, chipByImageId, chipByMagic } from './protocol/chips.js';
