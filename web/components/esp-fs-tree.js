// @ts-check
/**
 * <esp-fs-tree> — the contents of a SPIFFS, LittleFS or FAT image, editable.
 *
 * All three parsers return the same shape, so this component does not know or
 * care which one produced the image it is showing. What it does care about is
 * that a file can be *incomplete*: a region read from a device can be missing
 * pages, and a file assembled from what survived is still worth extracting —
 * as long as nobody mistakes it for the whole thing.
 *
 * Editing is deliberately staged. Nothing leaves this component until "write
 * back" is pressed, and the rebuild that happens then reads its own output
 * before returning, so a change that cannot be represented fails while the
 * device is still untouched.
 */

import { t, onLocaleChange, tIssue } from '../i18n.js';
import { formatByteSize, FsStore, checkFsStore } from '../esp-flashjs.js';
import { exportBytes } from '../actions.js';
import { downloadName } from '../format-values.js';

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  th { font-weight: 500; color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.size, td.units { font-family: var(--mono, ui-monospace, monospace); text-align: right; white-space: nowrap; }
  td.path { font-family: var(--mono, ui-monospace, monospace); word-break: break-all; }
  td.actions { white-space: nowrap; text-align: right; }
  tr.dir td.path { color: var(--fg-muted); }
  tr.dir td.path::after { content: '/'; }
  tr.partial { background: color-mix(in srgb, var(--warn) 10%, transparent); }
  tr.added { background: color-mix(in srgb, var(--ok, #3fb950) 12%, transparent); }
  tr.modified { background: color-mix(in srgb, var(--accent, #58a6ff) 12%, transparent); }
  tr.deleted td.path { text-decoration: line-through; color: var(--fg-muted); }
  .flag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 6px;
          background: var(--warn); color: var(--bg); }
  button {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--bg-button-hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { border-color: var(--accent, #58a6ff); }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .geometry { color: var(--fg-muted); font-size: 11px; font-family: var(--mono, ui-monospace, monospace); }
  .pending { color: var(--accent, #58a6ff); font-size: 11px; }
  .empty { color: var(--fg-muted); padding: 8px; }
  ul.issues { margin: 8px 0 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
  ul.issues li.error { color: var(--error, #f85149); }
</style>
<div class="toolbar" id="toolbar"></div>
<div id="body"></div>
<ul class="issues" id="issues" hidden></ul>
`;

export class EspFsTree extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {import('../esp-flashjs.js').FsImage|null} */
    this._image = null;
    /** Prefix for extracted filenames, so a download says where it came from. */
    this._name = 'fs';
    /**
     * The edited tree, created on the first change.
     *
     * Taking a copy up front would read every file out of the image just to
     * draw a list of names, which on a 4 MB partition is work nobody asked for.
     * @type {FsStore|null}
     */
    this._store = null;
    /**
     * What changed, tracked as it happens rather than derived by comparing.
     * @type {Map<string, 'added'|'modified'|'deleted'>}
     */
    this._changed = new Map();
    /** @type {((store: FsStore) => void)|undefined} */
    this._onApply = undefined;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    this._cleanup.push(onLocaleChange(() => this._render()));
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  /**
   * @param {import('../esp-flashjs.js').FsImage} image
   * @param {string} name
   * @param {object} [options]
   * @param {(store: FsStore) => void} [options.onApply]
   *   Omitted when there is nowhere to write back to, which turns the editing
   *   controls off rather than letting them build up changes with no exit.
   */
  show(image, name, options = {}) {
    this._image = image;
    this._name = name;
    this._onApply = options.onApply;
    this._store = null;
    this._changed.clear();
    this._render();
  }

  /**
   * The editable tree, taken from the image the first time it is needed.
   *
   * @returns {FsStore}
   */
  _edit() {
    let store = this._store;
    if (!store) {
      store = FsStore.from(/** @type {import('../esp-flashjs.js').FsImage} */ (this._image));
      this._store = store;
    }
    return store;
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const toolbar = /** @type {HTMLElement} */ (root.getElementById('toolbar'));
    const body = /** @type {HTMLElement} */ (root.getElementById('body'));
    const issueList = /** @type {HTMLElement} */ (root.getElementById('issues'));
    toolbar.replaceChildren();
    body.replaceChildren();
    issueList.replaceChildren();
    issueList.hidden = true;

    const image = this._image;
    if (!image) return;

    const rows = this._rows();
    const files = rows.filter((row) => !row.directory && row.state !== 'deleted');

    const saveAll = document.createElement('button');
    saveAll.textContent = t('fs.extractAll', { count: files.length });
    saveAll.disabled = files.length === 0;
    saveAll.addEventListener('click', () => this._extractAll(files));
    toolbar.append(saveAll);

    if (this._onApply) toolbar.append(...this._editControls());

    // The geometry is worth showing for every format, but for SPIFFS it is
    // load-bearing: it was inferred rather than read, and a wrong inference
    // still produces a plausible file list.
    const geometry = document.createElement('span');
    geometry.className = 'geometry';
    geometry.textContent = Object.entries(image.geometry)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    toolbar.append(geometry);

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('fs.noFiles');
      body.append(empty);
    } else {
      body.append(this._table(rows));
    }

    if (this._store) {
      for (const issue of checkFsStore(this._store)) {
        const li = document.createElement('li');
        if (issue.level === 'error') li.className = 'error';
        li.textContent = tIssue(issue);
        issueList.append(li);
        issueList.hidden = false;
      }
    }
  }

  /**
   * One row per entry, merging the image with whatever has been edited.
   *
   * @returns {Array<{path: string, size: number, directory: boolean, complete: boolean,
   *   units: number, state: ''|'added'|'modified'|'deleted',
   *   read: () => Uint8Array}>}
   */
  _rows() {
    const image = /** @type {import('../esp-flashjs.js').FsImage} */ (this._image);
    const original = new Map(image.files.map((f) => [f.path, f]));

    if (!this._store) {
      return image.files.map((file) => ({
        path: file.path,
        size: file.size,
        directory: Boolean(file.directory),
        complete: file.complete,
        units: file.pageIndices.length,
        state: /** @type {const} */ (''),
        read: file.read,
      }));
    }

    const store = this._store;
    const rows = store.entries.map((entry) => {
      const was = original.get(entry.path);
      return {
        path: entry.path,
        size: entry.data.length,
        directory: entry.directory,
        // An edited file is whole by definition; only what came out of the
        // image can be missing pages.
        complete: this._changed.has(entry.path) ? true : (was?.complete ?? true),
        units: was ? was.pageIndices.length : 0,
        state: this._changed.get(entry.path) ?? /** @type {const} */ (''),
        read: () => store.read(entry.path),
      };
    });

    for (const [path, state] of this._changed) {
      if (state !== 'deleted') continue;
      const was = original.get(path);
      rows.push({
        path,
        size: was?.size ?? 0,
        directory: Boolean(was?.directory),
        complete: true,
        units: 0,
        state: 'deleted',
        read: () => new Uint8Array(0),
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    return /** @type {any} */ (rows);
  }

  /** @returns {HTMLElement[]} */
  _editControls() {
    const add = document.createElement('button');
    add.textContent = t('fs.add');
    add.title = t('fs.add.hint');
    add.addEventListener('click', () => this._pickFile(null));

    const pending = this._changed.size;

    const apply = document.createElement('button');
    apply.className = 'primary';
    apply.textContent = t('fs.apply');
    apply.title = t('fs.apply.hint');
    apply.disabled = pending === 0;
    apply.addEventListener('click', () => {
      if (this._store) this._onApply?.(this._store);
    });

    const revert = document.createElement('button');
    revert.textContent = t('fs.revert');
    revert.disabled = pending === 0;
    revert.addEventListener('click', () => {
      this._store = null;
      this._changed.clear();
      this._render();
    });

    /** @type {HTMLElement[]} */
    const out = [add, apply, revert];
    if (pending > 0) {
      const label = document.createElement('span');
      label.className = 'pending';
      label.textContent = t('fs.pending', { count: pending });
      out.push(label);
    }
    return out;
  }

  /**
   * @param {ReturnType<EspFsTree['_rows']>} rows
   * @returns {HTMLElement}
   */
  _table(rows) {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const [key, cls] of [
      ['fs.path', ''],
      ['fs.size', 'size'],
      ['fs.units', 'units'],
      ['', 'actions'],
    ]) {
      const th = document.createElement('th');
      th.textContent = key ? t(key) : '';
      if (cls) th.className = cls;
      head.append(th);
    }
    table.append(head);

    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.directory) tr.className = 'dir';
      else if (row.state) tr.className = row.state;
      else if (!row.complete) tr.className = 'partial';

      const path = document.createElement('td');
      path.className = 'path';
      path.textContent = row.path;
      if (!row.complete && !row.directory) {
        const flag = document.createElement('span');
        flag.className = 'flag';
        flag.textContent = t('fs.partial');
        flag.title = t('fs.partial.hint');
        path.append(flag);
      }
      tr.append(path);

      const size = document.createElement('td');
      size.className = 'size';
      size.textContent = row.directory ? '' : formatByteSize(row.size);
      tr.append(size);

      const units = document.createElement('td');
      units.className = 'units';
      units.textContent = row.directory || row.state ? '' : String(row.units);
      units.title = t('fs.units.hint');
      tr.append(units);

      tr.append(this._rowActions(row));
      table.append(tr);
    }
    return table;
  }

  /**
   * @param {ReturnType<EspFsTree['_rows']>[number]} row
   * @returns {HTMLElement}
   */
  _rowActions(row) {
    const cell = document.createElement('td');
    cell.className = 'actions';
    if (row.state === 'deleted') return cell;

    if (!row.directory) {
      const save = document.createElement('button');
      save.textContent = t('fs.extract');
      save.addEventListener('click', () => exportBytes(row.read(), downloadName(this._name, row.path)));
      cell.append(save);
    }

    if (this._onApply) {
      if (!row.directory) {
        const replace = document.createElement('button');
        replace.textContent = t('fs.replace');
        replace.addEventListener('click', () => this._pickFile(row.path));
        cell.append(replace);
      }
      const remove = document.createElement('button');
      remove.textContent = t('fs.delete');
      remove.addEventListener('click', () => this._delete(row.path));
      cell.append(remove);
    }
    return cell;
  }

  /**
   * @param {string|null} target Path to replace, or null to add a new file.
   */
  _pickFile(target) {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A new file lands at the root under its own name. Anything else would
      // be guessing at a destination the picker never asked about.
      const path = target ?? `/${file.name}`;
      const store = this._edit();
      const existed = store.has(path) || this._changed.get(path) === 'deleted';
      store.write(path, bytes);
      this._changed.set(path, existed ? 'modified' : 'added');
      this._render();
    });
    input.click();
  }

  /** @param {string} path */
  _delete(path) {
    const store = this._edit();
    const removed = [];
    for (const entry of store.entries) {
      if (entry.path === path || entry.path.startsWith(`${path}/`)) removed.push(entry.path);
    }
    store.delete(path);
    for (const gone of removed) {
      // Something added and then removed in the same session leaves no trace
      // rather than showing as a deletion of a file that was never there.
      if (this._changed.get(gone) === 'added') this._changed.delete(gone);
      else this._changed.set(gone, 'deleted');
    }
    this._render();
  }

  /** @param {ReturnType<EspFsTree['_rows']>} rows */
  _extractAll(rows) {
    // One download per file rather than an archive: bundling would mean
    // shipping a zip encoder, and the whole library has no runtime
    // dependencies. Browsers rate-limit bursts of downloads, so this is spaced.
    rows.forEach((row, i) => {
      setTimeout(() => exportBytes(row.read(), downloadName(this._name, row.path)), i * 120);
    });
  }
}

customElements.define('esp-fs-tree', EspFsTree);
