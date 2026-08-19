// @ts-check
/**
 * <esp-diff-view> — what changed between two sets of bytes.
 *
 * The comparison people actually need is "the device versus my backup", which
 * is why the sides default to the current selection and the most recent other
 * copy of the same region: after a write, both halves are already loaded.
 *
 * The selection is offered as a side of its own rather than only as whichever
 * buffer happens to hold it. Without that, changing what is selected on the
 * left has no visible effect here, which reads as the tab being broken — and
 * leaves the question "what am I looking at?" unanswered, since two dropdowns
 * of filenames say what is being compared but never why those two.
 *
 * A whole-flash diff can produce tens of thousands of chunks, and rendering
 * them all would freeze the page for no benefit — nobody reads the
 * ten-thousandth. The list is capped and says so, because a silently truncated
 * diff reads as "that is everything that changed".
 */

import { t, onLocaleChange } from '../i18n.js';
import { bytesToHex, diffBinary, diffSummary, formatByteSize, toHexAddress } from '../esp-flashjs.js';
import { store } from '../store.js';
import { chooseDiffSides, SELECTION } from '../diff-sides.js';

/** Beyond this the list stops being read and starts being scrolled past. */
const MAX_CHUNKS = 500;

/** Bytes of a chunk to print before saying how much more there is. */
const PREVIEW_BYTES = 16;

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .hint { color: var(--fg-muted); font-size: 12px; margin: 0 0 10px; }
  .picker { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .side { display: flex; align-items: center; gap: 6px; }
  .side > label { color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  select {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; font: inherit; max-width: 240px;
  }
  .arrow { color: var(--fg-muted); padding: 0 2px; }
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
<p class="hint" id="hint"></p>
<div class="picker" id="picker"></div>
<div id="body"></div>
`;

export class EspDiffView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /**
     * What the inspector has selected, or null.
     * @type {{title: string, data: Uint8Array|null, address: number, size: number}|null}
     */
    this._target = null;
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

  /**
   * @param {{title: string, data: Uint8Array|null, address: number, size: number}|null} target
   */
  show(target) {
    this._target = target;
    this._render();
  }

  /**
   * The two sides on offer.
   *
   * The selection comes first and keeps its own identity even when it is also
   * one of the buffers, so that a side pointing at it follows what the user
   * selects instead of freezing on the buffer it happened to resolve to.
   *
   * @returns {Array<{key: string, label: string, data: Uint8Array}>}
   */
  _options() {
    /** @type {Array<{key: string, label: string, data: Uint8Array}>} */
    const options = [];
    const target = this._target;
    if (target?.data) {
      options.push({
        key: SELECTION,
        label: t('diff.selection', {
          name: target.title,
          size: formatByteSize(target.data.length),
        }),
        data: target.data,
      });
    }
    for (const buffer of store.getState().buffers.values()) {
      options.push({
        key: buffer.key,
        label: `${buffer.name} (${formatByteSize(buffer.data.length)})`,
        data: buffer.data,
      });
    }
    return options;
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const hint = /** @type {HTMLElement} */ (root.getElementById('hint'));
    const picker = /** @type {HTMLElement} */ (root.getElementById('picker'));
    const body = /** @type {HTMLElement} */ (root.getElementById('body'));
    picker.replaceChildren();
    body.replaceChildren();
    hint.textContent = t('diff.hint');

    const options = this._options();
    if (options.length < 2) {
      const note = document.createElement('p');
      note.className = 'empty';
      // Naming the shortfall beats a generic "nothing to show": with one side
      // already available, what is missing is the other one.
      note.textContent =
        options.length === 1 ? t('diff.needOneMore', { have: options[0].label }) : t('diff.needTwo');
      body.append(note);
      return;
    }

    const sides = chooseDiffSides(options, this._target, {
      left: this._leftKey,
      right: this._rightKey,
    });
    this._leftKey = sides.left;
    this._rightKey = sides.right;

    picker.append(
      this._side('diff.before', options, this._leftKey, (key) => {
        this._leftKey = key;
        this._render();
      }),
    );
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    picker.append(arrow);
    picker.append(
      this._side('diff.after', options, this._rightKey, (key) => {
        this._rightKey = key;
        this._render();
      }),
    );

    const a = options.find((o) => o.key === this._leftKey);
    const b = options.find((o) => o.key === this._rightKey);
    if (!a || !b) return;

    if (a.data === b.data) {
      // "Identical" would be true and useless here. Saying why avoids the
      // reading that the two really are separate copies that happen to match.
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = t('diff.sameSide');
      body.append(note);
      return;
    }

    body.append(this._result(a.data, b.data));
  }

  /**
   * @param {string} labelKey
   * @param {Array<{key: string, label: string}>} options
   * @param {string|null} selected
   * @param {(key: string) => void} onChange
   * @returns {HTMLElement}
   */
  _side(labelKey, options, selected, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'side';

    const label = document.createElement('label');
    label.textContent = t(labelKey);
    wrap.append(label);

    const select = document.createElement('select');
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.key;
      element.textContent = option.label;
      element.selected = option.key === selected;
      select.append(element);
    }
    select.addEventListener('change', () => onChange(select.value));
    label.setAttribute('for', labelKey);
    select.id = labelKey;
    wrap.append(select);
    return wrap;
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
