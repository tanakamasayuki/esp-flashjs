// The single point where the web app reaches into the library.
//
// Keeping it to one file means scripts/build-site.js only has to rewrite the
// specifier below when it moves web/ to the site root; every other file under
// web/ refers to its siblings and works unchanged in both layouts.
export * from '../src/index.js';

/**
 * Type aliases.
 *
 * `export *` does not carry JSDoc typedefs across two levels of re-export, so
 * the types the app uses are pulled in explicitly here. These are comments —
 * they vanish at runtime and exist only so `npm run typecheck` covers web/.
 *
 * @typedef {import('../src/format/partition.js').Partition} Partition
 * @typedef {import('../src/format/partition.js').PartitionTable} PartitionTable
 * @typedef {import('../src/format/partition.js').Issue} Issue
 * @typedef {import('../src/format/image.js').EspImage} EspImage
 * @typedef {import('../src/format/registry.js').AnalysisResult} AnalysisResult
 * @typedef {import('../src/format/registry.js').BinaryRegion} BinaryRegion
 * @typedef {import('../src/device/device-info.js').DeviceInfo} DeviceInfo
 * @typedef {import('../src/format/fs/types.js').FsImage} FsImage
 * @typedef {import('../src/format/fs/types.js').FsFile} FsFile
 * @typedef {import('../src/format/nvs/store.js').NvsStore} NvsStore
 * @typedef {import('../src/format/nvs/parse.js').NvsEntry} NvsEntry
 * @typedef {import('../src/format/nvs/store.js').NvsChange} NvsChange
 * @typedef {import('../src/util/events.js').Progress} Progress
 */
