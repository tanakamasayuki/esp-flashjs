// @ts-check
/**
 * <esp-hex-viewer> — virtualized hex dump.
 *
 * A 16 MB flash image is 1,048,576 rows. Rendering them all is not an option,
 * so the element keeps a fixed-height spacer for the full scroll range and
 * materializes only the rows currently in view plus a small overscan.
 *
 * Values are set as properties, not attributes: `.data` is a Uint8Array and
 * would be meaningless as a string.
 */

import { t, onLocaleChange } from '../i18n.js';
import { bytesToHex, parseAddress, searchBytes, searchText, parseHexPattern, toPrintableAscii } from '../esp-flashjs.js';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 18;
const OVERSCAN_ROWS = 8;

const TEMPLATE = `
<style>
  :host {
    display: flex;
    flex-direction: column;
    min-height: 0;
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    color: var(--fg);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    font-family: var(--sans, system-ui, sans-serif);
    font-size: 12px;
  }
  input {
    background: var(--bg-input);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
    font: inherit;
    min-width: 0;
    width: 11ch;
  }
  input.wide { width: 18ch; }
  button {
    background: var(--bg-button);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 8px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--bg-button-hover); }
  .status {
    margin-left: auto;
    align-self: center;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    position: relative;
    min-height: 120px;
    contain: strict;
  }
  .spacer { position: relative; width: 100%; }
  .rows {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .row {
    height: ${ROW_HEIGHT}px;
    line-height: ${ROW_HEIGHT}px;
    white-space: pre;
    padding: 0 6px;
  }
  .row:nth-child(even) { background: var(--bg-row-alt); }
  .addr { color: var(--fg-muted); }
  .hex  { color: var(--fg); }
  .ascii { color: var(--fg-dim); }
  mark {
    background: var(--accent-soft);
    color: inherit;
    border-radius: 2px;
  }
  .sel { background: var(--select); color: var(--select-fg); }
  .empty {
    padding: 16px;
    color: var(--fg-muted);
    font-family: var(--sans, system-ui, sans-serif);
  }
  .footer {
    border-top: 1px solid var(--border);
    padding: 4px 6px;
    color: var(--fg-muted);
    white-space: pre-wrap;
    font-size: 11px;
    min-height: 1.4em;
  }
</style>
<div class="toolbar">
  <input id="jump"     type="text" />
  <input id="hex"      type="text" class="wide" />
  <input id="text"     type="text" class="wide" />
  <button id="prev" title="Previous match">&#9650;</button>
  <button id="next" title="Next match">&#9660;</button>
  <span class="status" id="status"></span>
</div>
<div class="scroll" id="scroll" tabindex="0">
  <div class="spacer" id="spacer"><div class="rows" id="rows"></div></div>
</div>
<div class="footer" id="footer"></div>
`;

export class EspHexViewer extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;

    /** @type {Uint8Array} */
    this._data = new Uint8Array(0);
    /** @type {number} */
    this._baseAddress = 0;
    /** @type {import('../esp-flashjs.js').BinaryRegion[]} */
    this._regions = [];
    /** @type {number[]} */
    this._matches = [];
    /** @type {number} */
    this._matchIndex = -1;
    /** @type {number} */
    this._matchLength = 0;
    /** @type {{start: number, end: number}|null} */
    this._selection = null;
    /** @type {number} */
    this._firstRow = -1;

    this._scroll = /** @type {HTMLElement} */ (root.getElementById('scroll'));
    this._spacer = /** @type {HTMLElement} */ (root.getElementById('spacer'));
    this._rows = /** @type {HTMLElement} */ (root.getElementById('rows'));
    this._status = /** @type {HTMLElement} */ (root.getElementById('status'));
    this._footer = /** @type {HTMLElement} */ (root.getElementById('footer'));
    this._jump = /** @type {HTMLInputElement} */ (root.getElementById('jump'));
    this._hexInput = /** @type {HTMLInputElement} */ (root.getElementById('hex'));
    this._textInput = /** @type {HTMLInputElement} */ (root.getElementById('text'));

    this._onScroll = () => this._render();
    this._unsubscribeLocale = () => {};
  }

  connectedCallback() {
    this._scroll.addEventListener('scroll', this._onScroll, { passive: true });
    this._jump.addEventListener('change', () => this._doJump());
    this._hexInput.addEventListener('change', () => this._search('hex'));
    this._textInput.addEventListener('change', () => this._search('text'));
    this.shadowRoot?.getElementById('next')?.addEventListener('click', () => this._step(1));
    this.shadowRoot?.getElementById('prev')?.addEventListener('click', () => this._step(-1));
    this._rows.addEventListener('click', (event) => this._onRowClick(event));

    this._applyLabels();
    this._unsubscribeLocale = onLocaleChange(() => this._applyLabels());
    this._layout();
  }

  disconnectedCallback() {
    this._scroll.removeEventListener('scroll', this._onScroll);
    this._unsubscribeLocale();
  }

  /** @param {Uint8Array} value */
  set data(value) {
    this._data = value ?? new Uint8Array(0);
    this._matches = [];
    this._matchIndex = -1;
    this._selection = null;
    this._firstRow = -1;
    this._scroll.scrollTop = 0;
    this._layout();
  }

  /** @returns {Uint8Array} */
  get data() {
    return this._data;
  }

  /** @param {number} value */
  set baseAddress(value) {
    this._baseAddress = value ?? 0;
    this._firstRow = -1;
    this._render();
  }

  /** @param {import('../esp-flashjs.js').BinaryRegion[]} value */
  set regions(value) {
    this._regions = value ?? [];
    this._firstRow = -1;
    this._render();
  }

  _applyLabels() {
    this._jump.placeholder = t('hex.jumpTo');
    this._hexInput.placeholder = t('hex.searchHex');
    this._textInput.placeholder = t('hex.searchText');
    this._updateFooter();
  }

  _layout() {
    const rowCount = Math.ceil(this._data.length / BYTES_PER_ROW);
    this._spacer.style.height = `${Math.max(rowCount * ROW_HEIGHT, 1)}px`;
    this._firstRow = -1;
    this._render();
  }

  _render() {
    if (this._data.length === 0) {
      this._rows.innerHTML = `<div class="empty">${escapeHtml(t('inspector.notRead'))}</div>`;
      this._rows.style.transform = '';
      return;
    }

    const rowCount = Math.ceil(this._data.length / BYTES_PER_ROW);
    const visibleRows = Math.ceil(this._scroll.clientHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
    const first = Math.max(0, Math.floor(this._scroll.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);

    // Re-rendering identical rows on every scroll event is the difference
    // between smooth and janky on a large buffer.
    if (first === this._firstRow) return;
    this._firstRow = first;

    const last = Math.min(rowCount, first + visibleRows);
    const parts = [];
    for (let row = first; row < last; row++) parts.push(this._renderRow(row));

    this._rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    this._rows.innerHTML = parts.join('');
  }

  /**
   * @param {number} row
   * @returns {string}
   */
  _renderRow(row) {
    const offset = row * BYTES_PER_ROW;
    const bytes = this._data.subarray(offset, offset + BYTES_PER_ROW);
    const address = (this._baseAddress + offset).toString(16).padStart(8, '0');

    let hex = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i === BYTES_PER_ROW / 2) hex += ' ';
      if (i >= bytes.length) {
        hex += '   ';
        continue;
      }
      const at = offset + i;
      const cls = this._classFor(at);
      const pair = bytesToHex(bytes.subarray(i, i + 1));
      hex += ' ' + (cls ? `<span class="${cls}">${pair}</span>` : pair);
    }

    const ascii = escapeHtml(toPrintableAscii(bytes));
    return (
      `<div class="row" data-offset="${offset}">` +
      `<span class="addr">${address}</span> ` +
      `<span class="hex">${hex}</span>  ` +
      `<span class="ascii">|${ascii}|</span>` +
      `</div>`
    );
  }

  /**
   * @param {number} offset
   * @returns {string}
   */
  _classFor(offset) {
    if (this._selection && offset >= this._selection.start && offset < this._selection.end) {
      return 'sel';
    }
    for (const region of this._regions) {
      if (offset >= region.offset && offset < region.offset + region.length) return 'mark';
    }
    return '';
  }

  _doJump() {
    const raw = this._jump.value.trim();
    if (raw === '') return;
    try {
      const absolute = parseAddress(raw);
      const relative = absolute >= this._baseAddress ? absolute - this._baseAddress : absolute;
      this.scrollToOffset(relative);
      this._selection = { start: relative, end: relative + 1 };
      this._firstRow = -1;
      this._render();
      this._updateFooter();
    } catch (error) {
      this._status.textContent = /** @type {Error} */ (error).message;
    }
  }

  /** @param {number} offset */
  scrollToOffset(offset) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    // Put the target a third of the way down rather than at the very top, so
    // the surrounding bytes are visible too.
    const target = row * ROW_HEIGHT - this._scroll.clientHeight / 3;
    this._scroll.scrollTop = Math.max(0, target);
  }

  /** @param {'hex'|'text'} kind */
  _search(kind) {
    const query = (kind === 'hex' ? this._hexInput : this._textInput).value.trim();
    if (query === '') {
      this._matches = [];
      this._matchIndex = -1;
      this._status.textContent = '';
      return;
    }

    try {
      if (kind === 'hex') {
        const pattern = parseHexPattern(query);
        this._matchLength = pattern.bytes.length;
        this._matches = searchBytes(this._data, pattern, { limit: 5000 });
      } else {
        this._matchLength = new TextEncoder().encode(query).length;
        this._matches = searchText(this._data, query, { limit: 5000 });
      }
    } catch (error) {
      this._status.textContent = /** @type {Error} */ (error).message;
      return;
    }

    this._matchIndex = this._matches.length > 0 ? 0 : -1;
    this._status.textContent =
      this._matches.length === 0 ? t('hex.noResults') : t('hex.matches', { count: this._matches.length });
    if (this._matchIndex >= 0) this._goToMatch();
  }

  /** @param {number} delta */
  _step(delta) {
    if (this._matches.length === 0) return;
    this._matchIndex = (this._matchIndex + delta + this._matches.length) % this._matches.length;
    this._goToMatch();
  }

  _goToMatch() {
    const offset = this._matches[this._matchIndex];
    this._selection = { start: offset, end: offset + this._matchLength };
    this.scrollToOffset(offset);
    this._firstRow = -1;
    this._render();
    this._updateFooter();
    this._status.textContent = `${this._matchIndex + 1} / ${this._matches.length}`;
  }

  /** @param {MouseEvent} event */
  _onRowClick(event) {
    const row = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (event.target).closest('.row')
    );
    if (!row) return;
    const rowOffset = Number(row.dataset.offset);

    // Map the click x-position onto a byte column. Doing it by geometry keeps
    // every byte clickable without wrapping each one in its own element.
    const hexSpan = /** @type {HTMLElement} */ (row.querySelector('.hex'));
    const rect = hexSpan.getBoundingClientRect();
    const charWidth = rect.width / (BYTES_PER_ROW * 3 + 1);
    const column = Math.floor((event.clientX - rect.left) / (charWidth * 3));
    const index = Math.max(0, Math.min(BYTES_PER_ROW - 1, column));

    const offset = rowOffset + index;
    if (offset >= this._data.length) return;
    this._selection = { start: offset, end: offset + 1 };
    this._firstRow = -1;
    this._render();
    this._updateFooter();
  }

  _updateFooter() {
    if (!this._selection) {
      this._footer.textContent = '';
      return;
    }
    const { start } = this._selection;
    const length = this._selection.end - start;
    const view = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength);
    /** @type {string[]} */
    const parts = [
      `${t('hex.offset')} 0x${(this._baseAddress + start).toString(16).padStart(8, '0')}`,
      `${t('hex.length')} ${length}`,
    ];

    if (start < this._data.length) parts.push(`u8 ${this._data[start]}`);
    if (start + 2 <= this._data.length) parts.push(`u16 ${view.getUint16(start, true)}`);
    if (start + 4 <= this._data.length) {
      parts.push(`u32 ${view.getUint32(start, true)}`);
      parts.push(`i32 ${view.getInt32(start, true)}`);
      parts.push(`f32 ${formatFloat(view.getFloat32(start, true))}`);
    }
    this._footer.textContent = parts.join('   ');
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatFloat(value) {
  if (!Number.isFinite(value)) return String(value);
  return Math.abs(value) < 1e-4 || Math.abs(value) > 1e10
    ? value.toExponential(4)
    : value.toPrecision(7);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

customElements.define('esp-hex-viewer', EspHexViewer);
