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
  writeNvs,
  writeFilesystem,
  erasePartition,
  exportBytes,
  readFlashRegion,
  readPartition,
  select,
  setInspectorTab,
  writePartition,
} from '../actions.js';
import { writeBackBlocker } from '../write-back.js';
import './esp-hex-viewer.js';
import './esp-nvs-tree.js';
import { openConfirm } from './esp-confirm-dialog.js';

/**
 * The inspector's tabs.
 *
 * Both answer the same question about the same thing — what is this region I
 * selected? — one in prose and one in bytes. A byte-comparison tab used to sit
 * beside them and did not: it took two subjects rather than one, so nothing on
 * screen explained why it was there or what it was showing.
 *
 * @type {Array<'analyze'|'hex'>}
 */
const TABS = ['analyze', 'hex'];

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
  .summary { margin: 0 0 10px; font-weight: 500; }
  .note { margin: 10px 0 0; color: var(--fg-muted); font-size: 12px; width: 100%; }
  .freshness { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: -4px 0 12px; }
  .freshness .note { margin: 0; width: auto; }
  .actions.danger-group { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 14px; }
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
    /**
     * The filesystem tree, kept alive while it is showing the same image.
     *
     * Unlike the NVS tree, whose edits live in the `NvsStore` the analysis
     * holds, this one keeps them in the element. Rebuilding it on every render
     * would throw away a set of pending file edits whenever anything else in
     * the app changed.
     *
     * @type {{model: unknown, element: import('./esp-fs-tree.js').EspFsTree}|null}
     */
    this._fs = null;
  }

  connectedCallback() {
    const rerender = () => this._render();
    this._cleanup.push(
      store.subscribe((s) => s.selection.id, rerender),
      store.subscribe((s) => s.selection.kind, rerender),
      store.subscribe((s) => s.inspector.tab, rerender),
      store.subscribe((s) => s.buffers, rerender),
      store.subscribe((s) => s.device.usingStub, rerender),
      // Every action here talks to the device, and none of them may start
      // while another is running.
      store.subscribe((s) => s.busy.active, rerender),
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
   *
   * @returns {{
   *   title: string,
   *   data: Uint8Array|null,
   *   address: number,
   *   size: number,
   *   analysis: import('../esp-flashjs.js').AnalysisResult|null,
   *   partition: import('../esp-flashjs.js').Partition|null,
   *   readAt: number|null,
   * }|null}
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
        size: buffer.data.length,
        analysis: buffer.analysis,
        readAt: buffer.source === 'device' ? buffer.readAt : null,
        // A buffer read from a partition still belongs to it. Reading one
        // selects the buffer rather than the partition, so forgetting this
        // made every editor go read-only the moment its data arrived — and
        // come back if you clicked the partition in the list again.
        partition: buffer.partitionLabel
          ? (state.partitions.table?.partitions.find((p) => p.label === buffer.partitionLabel) ??
            null)
          : null,
      };
    }

    if (kind === 'region') {
      // Encoded by the flash map as `<kind>@<offset>+<size>`.
      const match = /^(.+)@(\d+)\+(\d+)$/.exec(id);
      if (!match) return null;
      const [, regionKind, offsetText, sizeText] = match;
      const address = Number(offsetText);
      const size = Number(sizeText);
      const buffer = [...state.buffers.values()].find(
        (b) => b.source === 'device' && b.address === address && b.data.length === size,
      );
      return {
        title:
          regionKind === 'unallocated'
            ? t('flash.unallocated')
            : t(`flash.region.${regionKind}`),
        data: buffer?.data ?? null,
        address,
        size,
        analysis: buffer?.analysis ?? null,
        readAt: buffer?.readAt ?? null,
        partition: null,
      };
    }

    const table = state.partitions.table;
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
      size: partition.size,
      analysis: buffer?.analysis ?? null,
      readAt: buffer?.readAt ?? null,
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

    if (state.inspector.tab === 'hex') {
      this._renderHex(bodyEl, target);
    } else {
      this._hex = null;
      this._renderAnalysis(bodyEl, target);
    }
  }

  /**
   * @param {HTMLElement} body
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   */
  _renderHex(body, target) {
    if (!target.data) {
      this._hex = null;
      body.replaceChildren(this._notReadYet(target));
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
   * A region that has not been read is a dead end without a way to read it.
   *
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   * @returns {HTMLElement}
   */
  _notReadYet(target) {
    const wrap = document.createElement('div');
    wrap.className = 'pad';

    const heading = document.createElement('h3');
    heading.textContent = target.title;
    // The read control goes here too, and this is the path that needs it most:
    // anything too large to be read on selection arrives here, so leaving it to
    // the branch that only runs once there is data took the button away from
    // exactly the regions that still had to be fetched by hand.
    wrap.append(heading, this._freshness(target), this._detailList(target));
    wrap.append(this._readActions(target));
    return wrap;
  }

  /**
   * Read and export, available for anything with an address — partition or not.
   *
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   * @returns {HTMLElement}
   */
  _readActions(target) {
    const state = store.getState();
    const canRead =
      state.device.status === 'connected' && state.device.usingStub && !state.busy.active;

    const wrap = document.createElement('div');
    wrap.className = 'actions';
    // Reading lives at the top now, beside the heading and the timestamp.
    wrap.append(
      action(t('action.exportBinary'), target.data === null, () =>
        exportBytes(/** @type {Uint8Array} */ (target.data), `${regionFileName(target)}.bin`),
      ),
    );
    if (!canRead) {
      const why = document.createElement('p');
      why.className = 'note';
      why.textContent =
        state.device.status === 'connected' ? t('device.romModeWarning') : t('device.disconnected');
      wrap.append(why);
    }
    return wrap;
  }

  /**
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   * @returns {HTMLElement}
   */
  _detailList(target) {
    /** @type {Array<[string, string]>} */
    const rows = [
      [t('partition.offset'), toHexAddress(target.address)],
      [t('partition.size'), `${formatByteSize(target.size)} (${toHexAddress(target.size)})`],
      [t('partition.end'), toHexAddress(target.address + target.size)],
    ];
    const p = target.partition;
    if (p) {
      rows.push(
        [t('partition.type'), `${p.typeName} (${p.type})`],
        [t('partition.subtype'), `${p.subtypeName} (${toHexAddress(p.subtype, 2)})`],
        [t('partition.flags'), toHexAddress(p.flags, 2)],
      );
      if (p.encrypted) rows.push([t('partition.encrypted'), 'yes']);
    }
    return definitionList(rows);
  }

  /**
   * How old what is on screen is, and how to replace it.
   *
   * The read control used to sit at the bottom, below however long the
   * analysis happened to be — past a hundred-file directory listing, in
   * practice. It belongs next to the thing it refreshes. The timestamp belongs
   * beside it for the same reason the whole session is discarded on connect:
   * the device keeps running while someone reads a copy of its flash, and
   * nothing else distinguishes a copy taken a moment ago from one taken before
   * the application rewrote it.
   *
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   * @returns {HTMLElement}
   */
  _freshness(target) {
    const state = store.getState();
    const canRead =
      state.device.status === 'connected' && state.device.usingStub && !state.busy.active;

    const bar = document.createElement('div');
    bar.className = 'freshness';

    const button = document.createElement('button');
    button.className = 'act';
    button.textContent = target.data ? t('action.reread') : t('action.readFromDevice');
    button.disabled = !canRead;
    button.addEventListener('click', () => {
      if (target.partition) void readPartition(target.partition);
      else void readFlashRegion(target.address, target.size, `${regionFileName(target)}.bin`);
    });
    bar.append(button);

    const when = document.createElement('span');
    when.className = 'note';
    when.textContent = target.readAt
      ? t('inspector.readAt', { time: new Date(target.readAt).toLocaleTimeString() })
      : target.data
        ? t('inspector.fromFile')
        : t('inspector.notRead');
    bar.append(when);
    return bar;
  }

  /**
   * @param {HTMLElement} body
   * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
   */
  _renderAnalysis(body, target) {
    if (!target.data) {
      body.replaceChildren(this._notReadYet(target));
      return;
    }

    const container = document.createElement('div');
    container.className = 'pad';

    const heading = document.createElement('h3');
    heading.textContent = target.title;
    container.append(heading, this._freshness(target));

    const analysis = target.analysis;

    // Analysis first — it is what the inspector is for. The offsets and sizes
    // follow underneath.
    if (analysis) {
      const summary = document.createElement('p');
      summary.className = 'summary';
      const expected = /** @type {string|null} */ (analysis.metadata.expectedFormat ?? null);
      summary.textContent = expected
        ? // The partition table says what this is; saying "raw binary, 0%" when
          // we already know it is NVS throws that away.
          `${t(`analyze.format.${expected}`)} — ${t('analyze.unsupportedShort')}`
        : `${t(`analyze.type.${analysis.type}`)} · ${t('inspector.confidence')} ${Math.round(analysis.confidence * 100)}%`;
      container.append(summary);

      if (analysis.type === 'partition-table') {
        container.append(
          partitionTable(
            /** @type {{partitions: import('../esp-flashjs.js').Partition[]}} */ (analysis.model)
              .partitions,
          ),
        );
      } else if (analysis.type === 'esp-image') {
        container.append(imageDetails(analysis, target.partition));
      } else if (analysis.type === 'nvs') {
        container.append(this._nvsTree(analysis, target));
      } else if (
        analysis.type === 'spiffs' ||
        analysis.type === 'littlefs' ||
        analysis.type === 'fat'
      ) {
        container.append(this._fsTree(analysis, target));
      } else if (analysis.type === 'raw' || analysis.type === 'encrypted?') {
        container.append(rawSummary(analysis));
      } else {
        const entries = Object.entries(analysis.metadata).map(
          ([key, value]) => /** @type {[string, string]} */ ([key, formatValue(value)]),
        );
        if (entries.length > 0) container.append(definitionList(entries));
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
    }

    container.append(heading2(t('inspector.details')), this._detailList(target));
    container.append(this._readActions(target));
    if (target.partition) container.append(this._destructiveActions(target.partition, target.data));

    body.replaceChildren(container);
  }

  /**
   * @param {import('../esp-flashjs.js').AnalysisResult} analysis
   * @param {any} target
   * @returns {HTMLElement}
   */
  _fsTree(analysis, target) {
    if (!this._fs || this._fs.model !== analysis.model) {
      this._fs = {
        model: analysis.model,
        element: /** @type {import('./esp-fs-tree.js').EspFsTree} */ (
          document.createElement('esp-fs-tree')
        ),
      };
    }
    const tree = this._fs.element;
    const partition = target.partition;
    const state = store.getState();
    const blocker = writeBackBlocker({
      partition: target.partition,
      status: state.device.status,
      usingStub: state.device.usingStub,
    });

    // The element reads its data through a method rather than an attribute: an
    // FsImage carries lazy `read()` closures over the buffer, and those do not
    // survive being stringified into the DOM.
    tree.show(
      /** @type {import('../esp-flashjs.js').FsImage} */ (analysis.model),
      partition?.label ?? 'fs',
      {
        blocker,
        onApply: !blocker
          ? (edited) => {
              openConfirm({
                partition,
                reasons: assessRisk(partition.offset, partition.size).reasons,
                detail: t('confirm.fsChanges'),
                hasBackup: [...store.getState().buffers.values()].some(
                  (b) => b.partitionLabel === partition.label,
                ),
                onConfirm: () => void writeFilesystem(partition, edited, target.data),
              });
            }
          : undefined,
      },
    );
    return tree;
  }

  /**
   * @param {import('../esp-flashjs.js').AnalysisResult} analysis
   * @param {any} target
   * @returns {HTMLElement}
   */
  _nvsTree(analysis, target) {
    const tree = /** @type {import('./esp-nvs-tree.js').EspNvsTree} */ (
      document.createElement('esp-nvs-tree')
    );
    const nvs = /** @type {import('../esp-flashjs.js').NvsStore} */ (analysis.model);
    const partition = target.partition;
    const state = store.getState();
    const blocker = writeBackBlocker({
      partition: target.partition,
      status: state.device.status,
      usingStub: state.device.usingStub,
    });

    tree.show(nvs, {
      blocker,
      onApply: !blocker
        ? (edited) => {
            const changes = edited.changes();
            openConfirm({
              partition,
              reasons: assessRisk(partition.offset, partition.size).reasons,
              detail: t('confirm.nvsChanges', { count: changes.length }),
              hasBackup: [...store.getState().buffers.values()].some(
                (b) => b.partitionLabel === partition.label,
              ),
              onConfirm: () => void writeNvs(partition, edited),
            });
          }
        : undefined,
    });
    return tree;
  }

  /**
   * @param {import('../esp-flashjs.js').Partition} partition
   * @param {Uint8Array|null} data
   * @returns {HTMLElement}
   */
  _destructiveActions(partition, data) {
    const state = store.getState();
    const busy = state.busy.active;
    const canRead = state.device.status === 'connected' && state.device.usingStub && !busy;
    const connected = state.device.status === 'connected' && !busy;

    const wrap = document.createElement('div');
    wrap.className = 'actions danger-group';

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
            const bytes = new Uint8Array(buffer);
            confirmThen(() => void writePartition(partition, bytes));
          }),
        );
      }, true),
      action(t('action.erase'), !canRead, () => confirmThen(() => void erasePartition(partition)), true),
    );
    void data;
    return wrap;
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

/**
 * @param {NonNullable<ReturnType<EspInspector['_target']>>} target
 * @returns {string}
 */
function regionFileName(target) {
  if (target.partition) return target.partition.label;
  return `flash-${toHexAddress(target.address)}`;
}

/** @param {string} text @returns {HTMLElement} */
function heading2(text) {
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
 * Presents an unparsed buffer in terms someone can act on.
 *
 * The internal metadata keys (`allErased`, `encryptionState`, …) answer the
 * analyzer's questions, not the user's. What they want to know is whether
 * there is anything in there and why it is not being read.
 *
 * @param {import('../esp-flashjs.js').AnalysisResult} analysis
 * @returns {HTMLElement}
 */
function rawSummary(analysis) {
  const m = analysis.metadata;
  const contents = /** @type {string} */ (m.contents ?? 'data');
  const entropyValue = typeof m.entropy === 'number' ? m.entropy : 0;

  /** @type {Array<[string, string]>} */
  const rows = [
    [t('raw.contents'), t(`raw.contents.${contents}`)],
    [t('partition.size'), formatByteSize(Number(m.length ?? 0))],
  ];
  // Entropy only means something when there is data to measure.
  if (contents === 'data') {
    rows.push([
      t('raw.entropy'),
      `${entropyValue.toFixed(2)} bits/byte — ${t(
        entropyValue > 7.5 ? 'raw.entropy.high' : 'raw.entropy.normal',
      )}`,
    ]);
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
