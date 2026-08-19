// @ts-check
/**
 * An editable filesystem tree.
 *
 * The three parsers hand back an `FsImage` whose files are read lazily out of
 * the bytes they came from. That is right for inspection and wrong for
 * editing: as soon as one file changes, every offset in the image moves, so
 * there is nothing left to be lazy about. `FsStore` therefore takes a full
 * copy up front and holds paths and bytes only. Rebuilding starts from that,
 * not from the original image.
 *
 * Directories are tracked separately from files. SPIFFS has no directories —
 * `/sub/nested.txt` is a single 15-character name — while LittleFS and FAT do,
 * and an empty directory exists in one and cannot exist in the other. Keeping
 * the set explicit means the store can say what was asked for and each builder
 * can do the representable thing with it.
 *
 * @module format/fs/store
 */

import { FsPathError } from '../../util/errors.js';

/**
 * @typedef {import('./types.js').FsImage} FsImage
 * @typedef {import('./types.js').FsFile} FsFile
 */

/**
 * One entry held by a store.
 *
 * @typedef {object} FsStoreEntry
 * @property {string} path
 * @property {boolean} directory
 * @property {Uint8Array} data  Empty for a directory.
 */

/**
 * Normalises a path and rejects the ones no filesystem here can hold.
 *
 * `..` is rejected rather than resolved. A store is not a mounted filesystem
 * with a working directory, so there is no context in which resolving it would
 * mean anything, and silently turning `/a/../b` into `/b` would hide a caller
 * bug rather than fix it.
 *
 * @param {string} path
 * @returns {string} Absolute, no trailing slash, no repeated separators.
 */
export function normalizeFsPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new FsPathError(String(path), 'a path must be a non-empty string');
  }
  const parts = path.split('/').filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new FsPathError(path, `"${part}" is not resolved; give an absolute path`);
    }
    if (part.includes('\0')) {
      throw new FsPathError(path, 'a NUL byte cannot be stored in a filename');
    }
  }
  return `/${parts.join('/')}`;
}

/**
 * Every ancestor of a path, outermost first, excluding the path itself.
 *
 * @param {string} path Already normalised.
 * @returns {string[]}
 */
function ancestorsOf(path) {
  const parts = path.split('/').filter(Boolean);
  /** @type {string[]} */
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join('/')}`);
  return out;
}

/**
 * A mutable set of files, ready to be built back into an image.
 *
 * Nothing here knows about pages, blocks or clusters. Capacity is a property
 * of the format being built into, and is enforced there — a store that fits
 * LittleFS may not fit the SPIFFS partition beside it.
 */
export class FsStore {
  /**
   * @param {'spiffs'|'littlefs'|'fat'} type
   * @param {Record<string, number>} [geometry] Carried through to the builder.
   */
  constructor(type, geometry = {}) {
    /** @type {'spiffs'|'littlefs'|'fat'} */
    this.type = type;
    /** Format-specific; the builder decides which parts it can honour. */
    this.geometry = { ...geometry };
    /** @type {Map<string, Uint8Array>} */
    this._files = new Map();
    /** @type {Set<string>} */
    this._dirs = new Set();
    /**
     * Paths whose contents were only partly recoverable from the source image.
     *
     * Reading an incomplete file yields zeros where pages were missing, which
     * is the right thing for extraction and a trap for editing: writing the
     * store back would turn a recoverable gap into a permanent one. The list
     * travels with the store so a caller can refuse, warn, or drop them.
     *
     * @type {string[]}
     */
    this.incomplete = [];
  }

  /**
   * Takes a full copy of a parsed image.
   *
   * @param {FsImage} image
   * @returns {FsStore}
   */
  static from(image) {
    const store = new FsStore(image.type, image.geometry);
    for (const file of image.files) {
      const path = normalizeFsPath(file.path);
      if (file.directory) {
        store._dirs.add(path);
        continue;
      }
      store._files.set(path, new Uint8Array(file.read()));
      if (!file.complete) store.incomplete.push(path);
      for (const dir of ancestorsOf(path)) store._dirs.add(dir);
    }
    for (const dir of [...store._dirs]) {
      for (const parent of ancestorsOf(dir)) store._dirs.add(parent);
    }
    return store;
  }

  /** @returns {number} Files, not counting directories. */
  get size() {
    return this._files.size;
  }

  /**
   * Every entry, directories included, in path order.
   *
   * Sorted so that a parent always precedes its children, which is the order
   * every builder wants and the order a tree view expects.
   *
   * @returns {FsStoreEntry[]}
   */
  get entries() {
    /** @type {FsStoreEntry[]} */
    const out = [];
    for (const path of this._dirs) out.push({ path, directory: true, data: new Uint8Array(0) });
    for (const [path, data] of this._files) out.push({ path, directory: false, data });
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /** @returns {string[]} File paths, sorted. */
  get paths() {
    return [...this._files.keys()].sort();
  }

  /** @returns {string[]} Directory paths, sorted. */
  get directories() {
    return [...this._dirs].sort();
  }

  /** @returns {number} Total bytes of file data, before any per-format overhead. */
  get byteLength() {
    let total = 0;
    for (const data of this._files.values()) total += data.length;
    return total;
  }

  /**
   * @param {string} path
   * @returns {boolean}
   */
  has(path) {
    return this._files.has(normalizeFsPath(path));
  }

  /**
   * @param {string} path
   * @returns {Uint8Array} A copy; mutating it does not change the store.
   */
  read(path) {
    const key = normalizeFsPath(path);
    const data = this._files.get(key);
    if (!data) throw new FsPathError(key, 'no such file in this store');
    return new Uint8Array(data);
  }

  /**
   * Adds a file, or replaces one that is already there.
   *
   * @param {string} path
   * @param {Uint8Array|ArrayBuffer|string} contents Strings are encoded UTF-8.
   * @returns {this}
   */
  write(path, contents) {
    const key = normalizeFsPath(path);
    if (key === '/') throw new FsPathError(path, 'the root is a directory, not a file');
    if (this._dirs.has(key)) throw new FsPathError(key, 'a directory of that name already exists');

    const data =
      typeof contents === 'string'
        ? new TextEncoder().encode(contents)
        : contents instanceof ArrayBuffer
          ? new Uint8Array(contents)
          : new Uint8Array(contents);

    this._files.set(key, data);
    this.incomplete = this.incomplete.filter((p) => p !== key);
    for (const dir of ancestorsOf(key)) this._dirs.add(dir);
    return this;
  }

  /**
   * @param {string} path
   * @returns {this}
   */
  mkdir(path) {
    const key = normalizeFsPath(path);
    if (key === '/') return this;
    if (this._files.has(key)) throw new FsPathError(key, 'a file of that name already exists');
    this._dirs.add(key);
    for (const dir of ancestorsOf(key)) this._dirs.add(dir);
    return this;
  }

  /**
   * Removes a file, or a directory and everything under it.
   *
   * @param {string} path
   * @returns {number} How many entries went away. Zero means nothing matched.
   */
  delete(path) {
    const key = normalizeFsPath(path);
    let removed = 0;

    if (this._files.delete(key)) removed++;
    if (this._dirs.delete(key)) removed++;

    const prefix = `${key}/`;
    for (const child of [...this._files.keys()]) {
      if (child.startsWith(prefix)) {
        this._files.delete(child);
        removed++;
      }
    }
    for (const child of [...this._dirs]) {
      if (child.startsWith(prefix)) {
        this._dirs.delete(child);
        removed++;
      }
    }

    this.incomplete = this.incomplete.filter((p) => p !== key && !p.startsWith(prefix));
    return removed;
  }

  /**
   * Moves a file or a whole subtree.
   *
   * @param {string} from
   * @param {string} to
   * @returns {this}
   */
  rename(from, to) {
    const source = normalizeFsPath(from);
    const target = normalizeFsPath(to);
    if (source === target) return this;
    if (target.startsWith(`${source}/`)) {
      throw new FsPathError(target, 'a directory cannot be moved inside itself');
    }

    const moves = /** @type {Array<[string, string]>} */ ([]);
    for (const path of this._files.keys()) {
      if (path === source) moves.push([path, target]);
      else if (path.startsWith(`${source}/`)) moves.push([path, target + path.slice(source.length)]);
    }
    const dirMoves = /** @type {Array<[string, string]>} */ ([]);
    for (const path of this._dirs) {
      if (path === source) dirMoves.push([path, target]);
      else if (path.startsWith(`${source}/`)) dirMoves.push([path, target + path.slice(source.length)]);
    }
    if (moves.length === 0 && dirMoves.length === 0) {
      throw new FsPathError(source, 'no such file or directory in this store');
    }

    for (const [was, now] of moves) {
      const data = /** @type {Uint8Array} */ (this._files.get(was));
      this._files.delete(was);
      this._files.set(now, data);
      for (const dir of ancestorsOf(now)) this._dirs.add(dir);
    }
    for (const [was, now] of dirMoves) {
      this._dirs.delete(was);
      this._dirs.add(now);
      for (const dir of ancestorsOf(now)) this._dirs.add(dir);
    }
    this.incomplete = this.incomplete.map((p) =>
      p === source ? target : p.startsWith(`${source}/`) ? target + p.slice(source.length) : p,
    );
    return this;
  }

  /**
   * An independent copy, so a rebuild can be tried without losing the original.
   *
   * @returns {FsStore}
   */
  clone() {
    const copy = new FsStore(this.type, this.geometry);
    for (const [path, data] of this._files) copy._files.set(path, new Uint8Array(data));
    for (const dir of this._dirs) copy._dirs.add(dir);
    copy.incomplete = [...this.incomplete];
    return copy;
  }
}
