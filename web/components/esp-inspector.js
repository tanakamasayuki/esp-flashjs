// @ts-check
/**
 * <esp-inspector> — tabbed view of whatever is selected.
 *
 * Device partitions and imported files land in the same place deliberately:
 * the analysis path must not depend on where the bytes came from.
 */

import { t, tIssue, onLocaleChange } from '../i18n.js';
import { formatByteSize, toHexAddress } from '../esp-flashjs.js';
import { store } from '../store.js';
import {
  assessRisk,
  erasePartition,
  exportBytes,
  readPartition,
  select,
  setInspectorTab,
  writePartition,
} from '../actions.js';
import './esp-hex-viewer.js';
import { openConfirm } from './esp-confirm-dialog.js';

/** @type {Array<'info'|'hex'|'analyze'>} */
const TABS = ['info', 'hex', 'analyze'];

const TEMPLATE = `
<style>
  :host { display: flex; flex-direction: column; min-height: 0; height: 100%;
          font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); padding: 0 6px; }
  .tabs button {
    background: none; border: 0; border-bottom: 2px solid transparent;
    padding: 8px 12px; font: inherit; color: var(--fg-muted); cursor: pointer;
  }
  .tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
  .body { flex: 1; overflow: auto; min-height: 0; display: flex; flex-direction: column; }
  .pad { padding: 12px; }
  .empty { padding: 24px 12px; color: var(--fg-muted); text-align: center; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0; }
  dt { color: var(--fg-muted); }
  dd { margin: 0; font-family: var(--mono, ui-monospace, monospace); word-break: break-all; }
  h3 { margin: 0 0 8px; font-size: 13px; }
  h4 { margin: 16px 0 6px; font-size: 12px; color: var(--fg-muted);
       text-transform: uppercase; letter-spacing: 0.04em; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  button.act {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 5px 11px; font: inherit; cursor: pointer;
  }
  button.act:hover:not(:disabled) { background: var(--bg-button-hover); }
  button.act:disabled { opacity: 0.45; cursor: not-allowed; }
  button.act.danger { border-color: var(--danger); color: var(--danger); }
  button.act.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .sep { width: 1px; background: var(--border); margin: 0 4px; }
  ul.issues { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  ul.issues li { padding: 6px 8px; border-radius: 4px; border-left: 3px solid var(--warn);
                 background: color-mix(in srgb, var(--warn) 10%, transparent); font-size: 12px; line-height: 1.45; }
  ul.issues li.error { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-muted); font-weight: 500; }
  td.num { font-family: var(--mono, ui-monospace, monospace); }
  esp-hex-viewer { flex: 1; min-height: 0; }
</style>
<div class="tabs" id="tabs" role="tablist"></div>
<div class="body" id="body"></div>
`;

export class EspInspector extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {Array<() => void>} */
    this._cleanup = [];
    /** @type {import('./esp-hex-viewer.js').EspHexViewer|null} */
    this._hex = null;
  }

  connectedCallback() {
    const rerender = () => this._render();
    this._cleanup.push(
      store.subscribe((s) => s.selection.id, rerender),
      store.subscribe((s) => s.selection.kind, rerender),
      store.subscribe((s) => s.inspector.tab, rerender),
      store.subscribe((s) => s.buffers, rerender),
      store.subscribe((s) => s.device.usingStub, rerender),
      onLocaleChange(rerender),
    );
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  /**
   * Resolves the selection into the bytes and metadata to display.
   * @returns {{title: string, data: Uint8Array|null, address: number, analysis: import('../esp-flashjs.js').AnalysisResult|null, partition: import('../esp-flashjs.js').Partition|null}|null}
   */
  _target() {
    const state = store.getState();
    const { kind, id } = state.selection;
    if (!kind || !id) return null;

    if (kind === 'buffer') {
      const buffer = state.buffers.get(id);
      if (!buffer) return null;
      return {
        title: buffer.name,
        data: buffer.data,
        address: buffer.address ?? 0,
        analysis: buffer.analysis,
        partition: null,
      };
    }

    const table = /** @type {{partitions: import('../esp-flashjs.js').Partition[]}|null} */ (
      state.partitions.table
    );
    const partition = table?.partitions.find((p) => p.label === id) ?? null;
    if (!partition) return null;

    // Prefer an already-read buffer for this partition so switching tabs does
    // not require another read.
    const buffer = [...state.buffers.values()].find(
      (b) => b.partitionLabel === partition.label && b.source === 'device',
    );
    return {
      title: partition.label,
      data: buffer?.data ?? null,
      address: partition.offset,
      analysis: buffer?.analysis ?? null,
      partition,
    };
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const tabsEl = /** @type {HTMLElement} */ (root.getElementById('tabs'));
    const bodyEl = /** @type {HTMLElement} */ (root.getElementById('body'));
    const state = store.getState();
    const target = this._target();

    tabsEl.replaceChildren();
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.inspector.tab === tab));
      button.textContent = t(`inspector.tab.${tab}`);
      button.addEventListener('click', () => setInspectorTab(tab));
      tabsEl.append(button);
    }

    if (!target) {
      this._hex = null;
      bodyEl.innerHTML = `<p class="empty">${escapeHtml(t('inspector.empty'))}</p>`;
      return;
    }

    switch (state.inspector.tab) {
      case 'hex':
        this._renderHex(bodyEl, target);
        break;
      case 'analyze':
        this._hex = null;
        this._renderAnalysis(bodyEl, target);
        break;
      default:
        this._hex = null;
        this._renderInfo(bodyEl, target);
    }
  }

  /**
   * @param {HTMLElement} body
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   */
  _renderHex(body, target) {
    if (!target.data) {
      body.innerHTML = `<p class="empty">${escapeHtml(t('inspector.notRead'))}</p>`;
      return;
    }
    // Reuse the element across renders: rebuilding it would throw away scroll
    // position and search state on every unrelated store update.
    if (!this._hex || this._hex.parentElement !== body) {
      this._hex = /** @type {import('./esp-hex-viewer.js').EspHexViewer} */ (
        document.createElement('esp-hex-viewer')
      );
      body.replaceChildren(this._hex);
    }
    if (this._hex.data !== target.data) this._hex.data = target.data;
    this._hex.baseAddress = target.address;
    this._hex.regions = target.analysis?.regions ?? [];
  }

  /**
   * @param {HTMLElement} body
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   */
  _renderInfo(body, target) {
    const container = document.createElement('div');
    container.className = 'pad';

    const heading = document.createElement('h3');
    heading.textContent = target.title;
    container.append(heading);

    /** @type {Array<[string, string]>} */
    const rows = [];
    const p = target.partition;
    if (p) {
      rows.push(
        [t('partition.offset'), toHexAddress(p.offset)],
        [t('partition.size'), `${formatByteSize(p.size)} (${toHexAddress(p.size)})`],
        [t('partition.end'), toHexAddress(p.offset + p.size)],
        [t('partition.type'), `${p.typeName} (${p.type})`],
        [t('partition.subtype'), `${p.subtypeName} (${toHexAddress(p.subtype, 2)})`],
        [t('partition.flags'), toHexAddress(p.flags, 2)],
        [t('partition.encrypted'), p.encrypted ? 'yes' : 'no'],
      );
    } else if (target.data) {
      rows.push([t('partition.size'), formatByteSize(target.data.length)]);
      if (target.address) rows.push([t('partition.offset'), toHexAddress(target.address)]);
    }
    container.append(definitionList(rows));

    if (p) container.append(this._partitionActions(p, target.data));
    body.replaceChildren(container);
  }

  /**
   * @param {import('../esp-flashjs.js').Partition} partition
   * @param {Uint8Array|null} data
   * @returns {HTMLElement}
   */
  _partitionActions(partition, data) {
    const state = store.getState();
    const connected = state.device.status === 'connected';
    const canRead = connected && state.device.usingStub;

    const wrap = document.createElement('div');
    wrap.className = 'actions';

    // Non-destructive actions first, then a visual break, then the ones that
    // can brick the board.
    wrap.append(
      action(t('action.readPartition'), !canRead, () => void readPartition(partition)),
      action(t('action.exportPartition'), data === null, () =>
        exportBytes(/** @type {Uint8Array} */ (data), `${partition.label}.bin`),
      ),
    );

    const separator = document.createElement('div');
    separator.className = 'sep';
    wrap.append(separator);

    /** @param {() => void} run */
    const confirmThen = (run) => {
      const risk = assessRisk(partition.offset, partition.size);
      openConfirm({
        partition,
        reasons: risk.reasons,
        hasBackup: [...store.getState().buffers.values()].some(
          (b) => b.partitionLabel === partition.label,
        ),
        onConfirm: run,
      });
    };

    wrap.append(
      // Import and write in one step. Splitting them would let a user pick a
      // file, forget which one, and confirm a write against the wrong bytes.
      action(t('action.writePartition'), !connected, () => {
        pickFile((file) =>
          file.arrayBuffer().then((buffer) => {
            const data = new Uint8Array(buffer);
            confirmThen(() => void writePartition(partition, data));
          }),
        );
      }, true),
      action(t('action.erase'), !canRead, () => confirmThen(() => void erasePartition(partition)), true),
    );
    return wrap;
  }

  /**
   * @param {HTMLElement} body
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   */
  _renderAnalysis(body, target) {
    const container = document.createElement('div');
    container.className = 'pad';

    if (!target.data) {
      body.innerHTML = `<p class="empty">${escapeHtml(t('inspector.notRead'))}</p>`;
      return;
    }

    const analysis = target.analysis;
    if (!analysis) {
      body.innerHTML = `<p class="empty">${escapeHtml(t('inspector.empty'))}</p>`;
      return;
    }

    container.append(
      definitionList([
        [t('inspector.format'), t(`analyze.type.${analysis.type}`)],
        [t('inspector.confidence'), `${Math.round(analysis.confidence * 100)}%`],
      ]),
    );

    if (analysis.type === 'partition-table') {
      container.append(
        heading(t('partition.section')),
        partitionTable(
          /** @type {{partitions: import('../esp-flashjs.js').Partition[]}} */ (analysis.model)
            .partitions,
        ),
      );
    } else if (analysis.type === 'esp-image') {
      container.append(heading(t('analyze.type.esp-image')), imageDetails(analysis, target.partition));
    } else {
      const entries = Object.entries(analysis.metadata).map(
        ([key, value]) => /** @type {[string, string]} */ ([key, formatValue(value)]),
      );
      if (entries.length > 0) container.append(heading(t('inspector.tab.analyze')), definitionList(entries));
    }

    if (analysis.issues.length > 0) {
      const list = document.createElement('ul');
      list.className = 'issues';
      for (const issue of analysis.issues) {
        const li = document.createElement('li');
        if (issue.level === 'error') li.className = 'error';
        li.textContent = tIssue(issue);
        list.append(li);
      }
      container.append(list);
    }

    body.replaceChildren(container);
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @param {Array<[string, string]>} rows
 * @returns {HTMLElement}
 */
function definitionList(rows) {
  const dl = document.createElement('dl');
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
}

/** @param {string} text @returns {HTMLElement} */
function heading(text) {
  const h = document.createElement('h4');
  h.textContent = text;
  return h;
}

/**
 * @param {string} label
 * @param {boolean} disabled
 * @param {() => void} onClick
 * @param {boolean} [danger]
 * @returns {HTMLElement}
 */
function action(label, disabled, onClick, danger = false) {
  const button = document.createElement('button');
  button.className = danger ? 'act danger' : 'act';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * @param {import('../esp-flashjs.js').Partition[]} partitions
 * @returns {HTMLElement}
 */
function partitionTable(partitions) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of [
    t('partition.label'),
    t('partition.type'),
    t('partition.subtype'),
    t('partition.offset'),
    t('partition.size'),
    t('partition.end'),
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  table.append(head);

  for (const p of partitions) {
    const tr = document.createElement('tr');
    for (const [text, mono] of /** @type {Array<[string, boolean]>} */ ([
      [p.label, false],
      [p.typeName, false],
      [p.subtypeName, false],
      [toHexAddress(p.offset), true],
      [formatByteSize(p.size), true],
      [toHexAddress(p.offset + p.size), true],
    ])) {
      const td = document.createElement('td');
      if (mono) td.className = 'num';
      td.textContent = text;
      tr.append(td);
    }
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => select('partition', p.label));
    table.append(tr);
  }
  return table;
}

/**
 * @param {import('../esp-flashjs.js').AnalysisResult} analysis
 * @param {import('../esp-flashjs.js').Partition|null} partition
 * @returns {HTMLElement}
 */
function imageDetails(analysis, partition) {
  const image = /** @type {import('../esp-flashjs.js').EspImage} */ (analysis.model);
  /** @type {Array<[string, string]>} */
  const rows = [
    [t('device.chip'), image.chipName],
    [t('image.entryPoint'), toHexAddress(image.entryPoint)],
    [t('image.segments'), String(image.segments.length)],
    [t('image.imageLength'), formatByteSize(image.imageLength)],
    [t('image.checksum'), image.checksumValid ? t('image.valid') : t('image.invalid')],
  ];
  if (image.sha256) rows.push([t('image.sha256'), image.sha256]);
  if (image.app) {
    rows.push(
      [t('image.projectName'), image.app.projectName],
      [t('image.appVersion'), image.app.version],
      [t('image.idfVersion'), image.app.idfVersion],
    );
  }
  if (partition) {
    const free = partition.size - image.imageLength;
    const percent = Math.round((free / partition.size) * 100);
    rows.push([t('image.freeSpace'), `${formatByteSize(free)} (${percent}%)`]);
  }
  return definitionList(rows);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * Opens a one-shot file picker.
 *
 * @param {(file: File) => void} onPick
 */
function pickFile(onPick) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.bin,application/octet-stream';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  });
  input.click();
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

customElements.define('esp-inspector', EspInspector);
