// @ts-check
/**
 * <esp-diff-view> — what changed between two buffers.
 *
 * The comparison people actually need is "the device versus my backup", which
 * is why the picker defaults to buffers rather than to files: after a write,
 * both halves are already loaded.
 *
 * A whole-flash diff can produce tens of thousands of chunks, and rendering
 * them all would freeze the page for no benefit — nobody reads the
 * ten-thousandth. The list is capped and says so, because a silently truncated
 * diff reads as "that is everything that changed".
 */

import { t, onLocaleChange } from '../i18n.js';
import { bytesToHex, diffBinary, diffSummary, formatByteSize, toHexAddress } from '../esp-flashjs.js';
import { store } from '../store.js';

/** Beyond this the list stops being read and starts being scrolled past. */
const MAX_CHUNKS = 500;

/** Bytes of a chunk to print before saying how much more there is. */
const PREVIEW_BYTES = 16;

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .picker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  select {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; font: inherit; max-width: 240px;
  }
  .arrow { color: var(--fg-muted); }
  .summary { margin: 0 0 8px; font-size: 12px; }
  .summary.same { color: var(--ok, var(--fg-muted)); }
  .summary.differs { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
  th, td { text-align: left; padding: 2px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-family: var(--sans, system-ui, sans-serif); font-weight: 500; color: var(--fg-muted);
       font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.offset { white-space: nowrap; color: var(--fg-muted); }
  td.before { color: var(--danger); }
  td.after { color: var(--ok, var(--accent)); }
  td.bytes { word-break: break-all; }
  .kind { font-family: var(--sans, system-ui, sans-serif); font-size: 10px; padding: 1px 5px;
          border-radius: 3px; background: var(--bg-button); color: var(--fg-muted); }
  .note { color: var(--fg-muted); font-size: 11px; margin: 8px 0 0; }
  .empty { color: var(--fg-muted); padding: 8px 0; }
</style>
<div class="picker" id="picker"></div>
<div id="body"></div>
`;

export class EspDiffView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {string|null} */
    this._leftKey = null;
    /** @type {string|null} */
    this._rightKey = null;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    const rerender = () => this._render();
    this._cleanup.push(store.subscribe((s) => s.buffers, rerender), onLocaleChange(rerender));
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const picker = /** @type {HTMLElement} */ (root.getElementById('picker'));
    const body = /** @type {HTMLElement} */ (root.getElementById('body'));
    picker.replaceChildren();
    body.replaceChildren();

    const buffers = [...store.getState().buffers.values()];
    if (buffers.length < 2) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = t('diff.needTwo');
      body.append(note);
      return;
    }

    // Default to the two most recent, which after a write are the backup and
    // the re-read — the comparison that answers "did that do what I meant?".
    this._leftKey ??= buffers[buffers.length - 2].key;
    this._rightKey ??= buffers[buffers.length - 1].key;

    const left = this._select(buffers, this._leftKey, (key) => {
      this._leftKey = key;
      this._render();
    });
    const right = this._select(buffers, this._rightKey, (key) => {
      this._rightKey = key;
      this._render();
    });
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    picker.append(left, arrow, right);

    const a = buffers.find((b) => b.key === this._leftKey);
    const b = buffers.find((buf) => buf.key === this._rightKey);
    if (!a || !b) return;

    body.append(this._result(a.data, b.data));
  }

  /**
   * @param {import('../store.js').Buffer[]} buffers
   * @param {string|null} selected
   * @param {(key: string) => void} onChange
   * @returns {HTMLSelectElement}
   */
  _select(buffers, selected, onChange) {
    const select = document.createElement('select');
    for (const buffer of buffers) {
      const option = document.createElement('option');
      option.value = buffer.key;
      option.textContent = `${buffer.name} (${formatByteSize(buffer.data.length)})`;
      option.selected = buffer.key === selected;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  /**
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {DocumentFragment}
   */
  _result(a, b) {
    const fragment = document.createDocumentFragment();
    const summary = diffSummary(a, b);

    const line = document.createElement('p');
    line.className = `summary ${summary.identical ? 'same' : 'differs'}`;
    line.textContent = summary.identical
      ? t('diff.identical')
      : t('diff.summary', {
          bytes: summary.differingBytes,
          first: toHexAddress(summary.firstDifference ?? 0),
          delta: summary.lengthDelta,
        });
    fragment.append(line);
    if (summary.identical) return fragment;

    const chunks = diffBinary(a, b);
    const shown = chunks.slice(0, MAX_CHUNKS);

    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const key of ['diff.offset', 'diff.kind', 'diff.before', 'diff.after']) {
      const th = document.createElement('th');
      th.textContent = t(key);
      head.append(th);
    }
    table.append(head);

    for (const chunk of shown) {
      const row = document.createElement('tr');

      const offset = document.createElement('td');
      offset.className = 'offset';
      offset.textContent = toHexAddress(chunk.offset);
      row.append(offset);

      const kind = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'kind';
      badge.textContent = t(`diff.kind.${chunk.kind}`);
      kind.append(badge);
      row.append(kind);

      const before = document.createElement('td');
      before.className = 'bytes before';
      before.textContent = preview(chunk.before);
      row.append(before);

      const after = document.createElement('td');
      after.className = 'bytes after';
      after.textContent = preview(chunk.after);
      row.append(after);

      table.append(row);
    }
    fragment.append(table);

    if (chunks.length > shown.length) {
      const note = document.createElement('p');
      note.className = 'note';
      // Saying how many were dropped matters more than showing them: a list
      // that just stops looks like the end of the differences.
      note.textContent = t('diff.truncated', {
        shown: shown.length,
        total: chunks.length,
      });
      fragment.append(note);
    }
    return fragment;
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function preview(bytes) {
  if (bytes.length === 0) return '—';
  const head = bytesToHex(bytes.subarray(0, PREVIEW_BYTES), ' ');
  return bytes.length > PREVIEW_BYTES ? `${head} … (${bytes.length})` : head;
}

customElements.define('esp-diff-view', EspDiffView);
