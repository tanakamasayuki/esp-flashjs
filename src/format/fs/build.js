// @ts-check
/**
 * Rebuilding a filesystem image from an edited store.
 *
 * The scope here is deliberately narrow, and the narrowness is the safety
 * feature: a rebuild regenerates an image **at the geometry it came from**.
 * Creating a filesystem from arbitrary parameters is a different job with
 * different failure modes — a partition formatted with a page size the device
 * was not built for mounts and then misbehaves — and this library has no way
 * to check the result against the device that will have to live with it.
 *
 * What each format can actually carry differs, and the differences are not
 * cosmetic. {@link checkFsStore} answers that question up front, before
 * anything is written, so a caller can warn instead of discovering the loss
 * afterwards.
 *
 * @module format/fs/build
 */

import { buildSpiffs, SPIFFS_OBJ_NAME_LEN } from './spiffs-build.js';
import { buildLittlefs } from './littlefs-build.js';
import { buildFat } from './fat-build.js';

/**
 * @typedef {import('./store.js').FsStore} FsStore
 * @typedef {import('../partition.js').Issue} Issue
 */

/**
 * Rebuilds an image from a store, in the store's own format.
 *
 * @param {FsStore} store
 * @param {object} [options] Passed through to the format's builder. FAT needs
 *   `source`: the image the store came from, because the wear-levelling state
 *   at the end of the partition can only be carried over, never regenerated.
 * @returns {Uint8Array}
 */
export function buildFs(store, options = {}) {
  switch (store.type) {
    case 'spiffs':
      return buildSpiffs(store, options);
    case 'littlefs':
      return buildLittlefs(store, options);
    case 'fat':
      return buildFat(store, /** @type {any} */ (options));
    default:
      throw new TypeError(`Cannot rebuild a "${store.type}" image.`);
  }
}

/**
 * What a store would lose or trip over on the way into a given format.
 *
 * Capacity is not reported here. Whether the bytes fit depends on page and
 * block sizes that only the builder knows, and it throws rather than
 * truncating; this is about what the format can *represent* at all, which can
 * be answered without laying anything out.
 *
 * @param {FsStore} store
 * @param {'spiffs'|'littlefs'|'fat'} [type] Defaults to the store's own.
 * @returns {Issue[]}
 */
export function checkFsStore(store, type = store.type) {
  /** @type {Issue[]} */
  const issues = [];

  if (store.incomplete.length > 0) {
    // Worth stating plainly: an incomplete file reads back with zeros where
    // the missing pages were, and rebuilding writes those zeros down as if
    // they were the file. The gap stops being recoverable at that point.
    issues.push({
      level: 'warning',
      code: 'fs.rebuildIncomplete',
      params: { count: store.incomplete.length, paths: store.incomplete.join(', ') },
    });
  }

  if (type === 'spiffs') {
    const empty = store.directories.filter(
      (dir) => !store.paths.some((path) => path.startsWith(`${dir}/`)),
    );
    if (empty.length > 0) {
      // SPIFFS has no directories at all; `/sub/nested.txt` is one 15-byte
      // name. A directory with files in it survives by accident, as a shared
      // prefix. An empty one has nothing to survive as.
      issues.push({
        level: 'warning',
        code: 'fs.spiffsNoDirectories',
        params: { count: empty.length, paths: empty.join(', ') },
      });
    }
    const limit = SPIFFS_OBJ_NAME_LEN - 1;
    const encoder = new TextEncoder();
    const long = store.paths.filter((path) => encoder.encode(path).length > limit);
    if (long.length > 0) {
      issues.push({
        level: 'error',
        code: 'fs.spiffsNameTooLong',
        params: { limit, count: long.length, paths: long.join(', ') },
      });
    }
  }

  if (type === 'fat') {
    // FAT has no way to record these, and Windows refuses them outright.
    const illegal = store.paths
      .concat(store.directories)
      .filter((path) => /[\\:*?"<>|]/.test(path.slice(1)));
    if (illegal.length > 0) {
      issues.push({
        level: 'error',
        code: 'fs.fatIllegalName',
        params: { count: illegal.length, paths: illegal.join(', ') },
      });
    }
  }

  return issues;
}
