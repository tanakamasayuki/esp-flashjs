// @ts-check
/**
 * <esp-fs-tree> — the contents of a SPIFFS, LittleFS or FAT image.
 *
 * All three parsers return the same shape, so this component does not know or
 * care which one produced the image it is showing. What it does care about is
 * that a file can be *incomplete*: a region read from a device can be missing
 * pages, and a file assembled from what survived is still worth extracting —
 * as long as nobody mistakes it for the whole thing.
 */

import { t, onLocaleChange } from '../i18n.js';
import { formatByteSize } from '../esp-flashjs.js';
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
  tr.dir td.path { color: var(--fg-muted); }
  tr.dir td.path::after { content: '/'; }
  tr.partial { background: color-mix(in srgb, var(--warn) 10%, transparent); }
  .flag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 6px;
          background: var(--warn); color: var(--bg); }
  button {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer;
  }
  button:hover { background: var(--bg-button-hover); }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .geometry { color: var(--fg-muted); font-size: 11px; font-family: var(--mono, ui-monospace, monospace); }
  .empty { color: var(--fg-muted); padding: 8px; }
</style>
<div class="toolbar" id="toolbar"></div>
<div id="body"></div>
`;

export class EspFsTree extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {import('../esp-flashjs.js').FsImage|null} */
    this._image = null;
    /** Prefix for extracted filenames, so a download says where it came from. */
    this._name = 'fs';
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
   */
  show(image, name) {
    this._image = image;
    this._name = name;
    this._render();
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const toolbar = /** @type {HTMLElement} */ (root.getElementById('toolbar'));
    const body = /** @type {HTMLElement} */ (root.getElementById('body'));
    toolbar.replaceChildren();
    body.replaceChildren();

    const image = this._image;
    if (!image) return;

    const files = image.files.filter((f) => !f.directory);

    const saveAll = document.createElement('button');
    saveAll.textContent = t('fs.extractAll', { count: files.length });
    saveAll.disabled = files.length === 0;
    saveAll.addEventListener('click', () => this._extractAll(files));
    toolbar.append(saveAll);

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

    if (image.files.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('fs.noFiles');
      body.append(empty);
      return;
    }

    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const [key, cls] of [
      ['fs.path', ''],
      ['fs.size', 'size'],
      ['fs.units', 'units'],
      ['', ''],
    ]) {
      const th = document.createElement('th');
      th.textContent = key ? t(key) : '';
      if (cls) th.className = cls;
      head.append(th);
    }
    table.append(head);

    for (const file of image.files) {
      const row = document.createElement('tr');
      if (file.directory) row.className = 'dir';
      else if (!file.complete) row.className = 'partial';

      const path = document.createElement('td');
      path.className = 'path';
      path.textContent = file.path;
      if (!file.complete && !file.directory) {
        const flag = document.createElement('span');
        flag.className = 'flag';
        flag.textContent = t('fs.partial');
        flag.title = t('fs.partial.hint');
        path.append(flag);
      }
      row.append(path);

      const size = document.createElement('td');
      size.className = 'size';
      size.textContent = file.directory ? '' : formatByteSize(file.size);
      row.append(size);

      const units = document.createElement('td');
      units.className = 'units';
      units.textContent = file.directory ? '' : String(file.pageIndices.length);
      units.title = t('fs.units.hint');
      row.append(units);

      const actions = document.createElement('td');
      if (!file.directory) {
        const save = document.createElement('button');
        save.textContent = t('fs.extract');
        save.addEventListener('click', () => this._extract(file));
        actions.append(save);
      }
      row.append(actions);

      table.append(row);
    }
    body.append(table);
  }

  /** @param {import('../esp-flashjs.js').FsFile} file */
  _extract(file) {
    // Reading is deferred until now: a 320 KB image can hold a file per page,
    // and decoding all of them to draw a list would be work nobody asked for.
    exportBytes(file.read(), this._downloadName(file));
  }

  /** @param {import('../esp-flashjs.js').FsFile[]} files */
  _extractAll(files) {
    // One download per file rather than an archive: bundling would mean
    // shipping a zip encoder, and the whole library has no runtime
    // dependencies. Browsers rate-limit bursts of downloads, so this is spaced.
    files.forEach((file, i) => {
      setTimeout(() => this._extract(file), i * 120);
    });
  }

  /** @param {import('../esp-flashjs.js').FsFile} file */
  _downloadName(file) {
    return downloadName(this._name, file.path);
  }
}

customElements.define('esp-fs-tree', EspFsTree);
