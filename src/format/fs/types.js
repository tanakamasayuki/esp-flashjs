// @ts-check
/**
 * Shared shapes for filesystem parsers.
 *
 * SPIFFS, LittleFS and FAT organise their bytes very differently, but callers
 * want the same three things from all of them: what files are in here, how big
 * are they, and give me the contents. Keeping that surface identical means the
 * UI does not have to know which format it is looking at.
 *
 * @module format/fs/types
 */

/**
 * @typedef {object} FsFile
 * @property {string} path        Absolute, with a leading slash.
 * @property {number} size
 * @property {() => Uint8Array} read  Decoded contents. Lazy: reading every
 *   file of a 4 MB image up front costs more than most callers need.
 * @property {number[]} pageIndices  Where the data lives, for a hex view.
 * @property {boolean} complete   False when some of the data is missing.
 * @property {boolean} [directory]
 */

/**
 * @typedef {object} FsImage
 * @property {'spiffs'|'littlefs'|'fat'} type
 * @property {FsFile[]} files
 * @property {Record<string, number>} geometry  Format-specific, for display.
 * @property {import('../partition.js').Issue[]} issues
 */

export {};
