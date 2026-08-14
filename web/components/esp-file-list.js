// @ts-check
/**
 * <esp-file-list> — buffers loaded from disk or read from the device.
 *
 * This is the entry point for the offline workflow: with no board attached,
 * dropping a .bin here reaches exactly the same inspector as a partition read.
 */

import { t, onLocaleChange } from '../i18n.js';
import { formatByteSize } from '../esp-flashjs.js';
import { store } from '../store.js';
import { importFile, removeBuffer, select } from '../actions.js';

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .drop {
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 10px;
    text-align: center;
    color: var(--fg-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .drop.over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer; }
  li:hover { background: var(--bg-button-hover); }
  li[aria-selected="true"] { outline: 2px solid var(--accent); outline-offset: -2px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .size { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; color: var(--fg-muted); }
  .tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--bg-button);
         color: var(--fg-muted); }
  .remove { border: 0; background: none; color: var(--fg-muted); cursor: pointer; font-size: 14px;
            line-height: 1; padding: 2px 4px; }
  .remove:hover { color: var(--danger); }
</style>
<div class="drop" id="drop"></div>
<input type="file" id="picker" accept=".bin,application/octet-stream" multiple hidden />
<ul id="list"></ul>
`;

export class EspFileList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const drop = /** @type {HTMLElement} */ (root.getElementById('drop'));
    const picker = /** @type {HTMLInputElement} */ (root.getElementById('picker'));

    drop.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      for (const file of picker.files ?? []) void importFile(file);
      picker.value = '';
    });

    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      for (const file of event.dataTransfer?.files ?? []) void importFile(file);
    });

    const rerender = () => this._render();
    this._cleanup.push(
      store.subscribe((s) => s.buffers, rerender),
      store.subscribe((s) => s.selection.id, rerender),
      onLocaleChange(rerender),
    );
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    /** @type {HTMLElement} */ (root.getElementById('drop')).textContent = t('files.import');

    const list = /** @type {HTMLElement} */ (root.getElementById('list'));
    const state = store.getState();
    const buffers = [...state.buffers.values()];

    if (buffers.length === 0) {
      list.replaceChildren();
      return;
    }

    list.replaceChildren(
      ...buffers.map((buffer) => {
        const li = document.createElement('li');
        li.setAttribute(
          'aria-selected',
          String(state.selection.kind === 'buffer' && state.selection.id === buffer.id),
        );
        li.addEventListener('click', () => select('buffer', buffer.id));

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = buffer.name;
        name.title = buffer.name;

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = buffer.analysis ? t(`analyze.type.${buffer.analysis.type}`) : '—';

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatByteSize(buffer.data.length);

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '×';
        remove.title = t('files.remove');
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          removeBuffer(buffer.id);
        });

        li.append(name, tag, size, remove);
        return li;
      }),
    );
  }
}

customElements.define('esp-file-list', EspFileList);
