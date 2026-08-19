// @ts-check
/**
 * <esp-nvs-tree> — namespaces, keys and values, with editing.
 *
 * Edits are held as an overlay on the parsed image and nothing is written
 * until the user says so, which is what makes the diff below the table
 * meaningful: it is the exact list of what a write would change. `NvsStore`
 * keeps the original bytes untouched, so reverting is a discard rather than a
 * re-read.
 *
 * Erased entries are shown too. They are the residue of overwrites and
 * deletes, they are what tells you a device has actually been in service, and
 * a tool that hides them makes a used partition look freshly provisioned.
 */

import { t, onLocaleChange } from '../i18n.js';
import { displayValue, isEditableType, parseValue, shortValue } from '../format-values.js';

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .stats { color: var(--fg-muted); font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); }
  th { font-weight: 500; color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr.ns > td { background: var(--bg-button); font-weight: 500; }
  td.key, td.value, td.type { font-family: var(--mono, ui-monospace, monospace); }
  td.value { word-break: break-all; }
  td.key { padding-left: 22px; }
  tr.erased { opacity: 0.7; }
  /* The strike goes on the name alone, never on the cell. A decoration set on
     an ancestor is drawn across every descendant and cannot be switched off
     further down, so styling the cell struck through the "erased" badge too
     and made the one word explaining the row the hardest part to read. */
  tr.erased td.key .name { text-decoration: line-through; }
  /* A tint alone was too quiet to read as "not written yet", and says nothing
     to anyone who cannot separate the two colours. Stripe, word and tint. */
  tr.changed { background: color-mix(in srgb, var(--warn) 14%, transparent); }
  tr.changed td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
  .unsaved {
    display: flex; align-items: center; gap: 8px; margin: 0 0 8px;
    padding: 7px 10px; border-radius: 4px; font-size: 12px; line-height: 1.5;
    border: 1px solid var(--warn);
    background: color-mix(in srgb, var(--warn) 16%, transparent);
  }
  .unsaved strong { font-weight: 600; }
  button.primary.urgent {
    border-color: var(--warn); background: color-mix(in srgb, var(--warn) 22%, transparent);
    font-weight: 600;
  }
  .tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 6px;
         background: var(--bg-button); color: var(--fg-muted); }
  button {
    background: var(--bg-button); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--bg-button-hover); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  input.edit {
    font: inherit; font-family: var(--mono, ui-monospace, monospace); font-size: 12px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--accent);
    border-radius: 3px; padding: 1px 4px; width: 100%; box-sizing: border-box;
  }
  .changes { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
  .changes h4 { margin: 0 0 4px; font-size: 12px; }
  .changes ul { list-style: none; margin: 0; padding: 0; font-size: 12px;
                font-family: var(--mono, ui-monospace, monospace); }
  .changes li { padding: 1px 0; }
  .kind { display: inline-block; width: 68px; color: var(--fg-muted); }
  .note { color: var(--fg-muted); font-size: 11px; margin: 6px 0 0; }
</style>
<p class="unsaved" id="unsaved" hidden></p>
<div class="toolbar" id="toolbar"></div>
<div id="body"></div>
<div id="changes"></div>
`;

export class EspNvsTree extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {import('../esp-flashjs.js').NvsStore|null} */
    this._store = null;
    /** @type {string|null} Which cell is open for editing, as "namespace + key". */
    this._editing = null;
    /** @type {((store: import('../esp-flashjs.js').NvsStore) => void)|null} */
    this._onApply = null;
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
   * @param {import('../esp-flashjs.js').NvsStore} store
   * @param {object} [options]
   * @param {(store: import('../esp-flashjs.js').NvsStore) => void} [options.onApply]
   * @param {string|null} [options.blocker] Translation key for why write-back
   *   is unavailable, when it is.
   *   Called when the user asks to write the edits back. Absent means read-only.
   */
  show(store, { onApply, blocker } = {}) {
    this._store = store;
    this._onApply = onApply ?? null;
    /**
     * Why write-back is unavailable, if it is.
     *
     * Three different reasons need three different answers, and the one it
     * used to give — "this came from a file" — was wrong two times out of
     * three.
     * @type {string|null}
     */
    this._blocker = blocker ?? null;
    this._editing = null;
    this._render();
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const toolbar = /** @type {HTMLElement} */ (root.getElementById('toolbar'));
    const body = /** @type {HTMLElement} */ (root.getElementById('body'));
    const changes = /** @type {HTMLElement} */ (root.getElementById('changes'));
    const unsaved = /** @type {HTMLElement} */ (root.getElementById('unsaved'));
    toolbar.replaceChildren();
    body.replaceChildren();
    changes.replaceChildren();
    unsaved.replaceChildren();

    const store = this._store;
    if (!store) {
      unsaved.hidden = true;
      return;
    }

    const pending = store.changes();
    unsaved.hidden = pending.length === 0;
    if (pending.length > 0) {
      // At the top, in the colour used for "something needs attention". Edits
      // live only in this page until they are written, and a tab closed here
      // loses them with nothing to undo.
      const strong = document.createElement('strong');
      strong.textContent = t('nvs.unsaved', { count: pending.length });
      unsaved.append(strong, document.createTextNode(` ${t('nvs.unsaved.hint')}`));
    }

    const apply = document.createElement('button');
    apply.className = this._onApply && pending.length > 0 ? 'primary urgent' : 'primary';
    apply.textContent =
      pending.length > 0 ? t('nvs.apply.count', { count: pending.length }) : t('nvs.apply');
    apply.disabled = !this._onApply || pending.length === 0;
    apply.title = this._onApply ? t('nvs.apply.hint') : t(this._blocker ?? 'writeback.readonly');
    apply.addEventListener('click', () => this._onApply?.(store));
    toolbar.append(apply);

    const revert = document.createElement('button');
    revert.textContent = t('nvs.revert');
    revert.disabled = pending.length === 0;
    revert.addEventListener('click', () => {
      store.reset();
      this._editing = null;
      this._render();
    });
    toolbar.append(revert);

    const stats = document.createElement('span');
    stats.className = 'stats';
    stats.textContent = t('nvs.stats', {
      entries: store.entries.length,
      namespaces: store.namespaces.length,
      erased: store.erasedEntries.length,
    });
    toolbar.append(stats);

    /** @type {Map<string, import('../esp-flashjs.js').NvsEntry[]>} */
    const byNamespace = new Map();
    for (const name of store.namespaces) byNamespace.set(name, []);
    for (const entry of store.entries) {
      if (!byNamespace.has(entry.namespace)) byNamespace.set(entry.namespace, []);
      /** @type {import('../esp-flashjs.js').NvsEntry[]} */ (byNamespace.get(entry.namespace)).push(entry);
    }

    /** Erased entries, indexed the same way, so they sit with their namespace. */
    const erasedByNamespace = new Map();
    for (const entry of store.erasedEntries) {
      if (!erasedByNamespace.has(entry.namespace)) erasedByNamespace.set(entry.namespace, []);
      erasedByNamespace.get(entry.namespace).push(entry);
    }

    const changed = new Set(pending.map((c) => `${c.namespace}\0${c.key}`));

    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const key of ['nvs.key', 'nvs.type', 'nvs.value', '']) {
      const th = document.createElement('th');
      th.textContent = key ? t(key) : '';
      head.append(th);
    }
    table.append(head);

    for (const [namespace, entries] of byNamespace) {
      const nsRow = document.createElement('tr');
      nsRow.className = 'ns';
      const nsCell = document.createElement('td');
      nsCell.colSpan = 4;
      nsCell.textContent = namespace;
      const count = document.createElement('span');
      count.className = 'tag';
      count.textContent = String(entries.length);
      nsCell.append(count);
      nsRow.append(nsCell);
      table.append(nsRow);

      for (const entry of entries) {
        table.append(this._entryRow(store, entry, changed, false));
      }
      for (const entry of erasedByNamespace.get(namespace) ?? []) {
        table.append(this._entryRow(store, entry, changed, true));
      }
    }
    body.append(table);

    if (pending.length > 0) changes.append(this._changeList(pending));
  }

  /**
   * @param {import('../esp-flashjs.js').NvsStore} store
   * @param {import('../esp-flashjs.js').NvsEntry} entry
   * @param {Set<string>} changed
   * @param {boolean} erased
   * @returns {HTMLElement}
   */
  _entryRow(store, entry, changed, erased) {
    const id = `${entry.namespace}\0${entry.key}`;
    const row = document.createElement('tr');
    if (erased) row.className = 'erased';
    else if (changed.has(id)) row.className = 'changed';

    const key = document.createElement('td');
    key.className = 'key';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.key;
    key.append(name);
    if (erased) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t('nvs.erased');
      tag.title = t('nvs.erased.hint');
      key.append(tag);
    }
    row.append(key);

    const type = document.createElement('td');
    type.className = 'type';
    type.textContent = entry.type;
    row.append(type);

    const value = document.createElement('td');
    value.className = 'value';
    if (!erased && this._editing === id) {
      value.append(this._editor(store, entry));
    } else {
      value.textContent = displayValue(entry);
    }
    row.append(value);

    const actions = document.createElement('td');
    if (!erased && this._onApply) {
      const edit = document.createElement('button');
      edit.textContent = t('nvs.edit');
      edit.disabled = !isEditableType(entry.type);
      edit.title = isEditableType(entry.type) ? '' : t('nvs.edit.unsupported');
      edit.addEventListener('click', () => {
        this._editing = id;
        this._render();
      });
      actions.append(edit);
    }
    row.append(actions);
    return row;
  }

  /**
   * @param {import('../esp-flashjs.js').NvsStore} store
   * @param {import('../esp-flashjs.js').NvsEntry} entry
   * @returns {HTMLElement}
   */
  _editor(store, entry) {
    const input = document.createElement('input');
    input.className = 'edit';
    input.value = displayValue(entry);
    input.setAttribute('aria-label', `${entry.namespace}.${entry.key}`);

    const commit = () => {
      try {
        store.set(entry.namespace, entry.key, parseValue(entry.type, input.value), entry.type);
        this._editing = null;
        this._render();
      } catch (error) {
        // Rejecting the edit in place beats writing a value the type cannot
        // hold and discovering it at build time, when a partition is at stake.
        input.setCustomValidity(String(/** @type {Error} */ (error).message));
        input.reportValidity();
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') {
        this._editing = null;
        this._render();
      }
    });
    input.addEventListener('blur', commit);
    queueMicrotask(() => input.focus());
    return input;
  }

  /**
   * @param {import('../esp-flashjs.js').NvsChange[]} changes
   * @returns {HTMLElement}
   */
  _changeList(changes) {
    const wrap = document.createElement('div');
    wrap.className = 'changes';

    const title = document.createElement('h4');
    title.textContent = t('nvs.pending', { count: changes.length });
    wrap.append(title);

    const list = document.createElement('ul');
    for (const change of changes) {
      const li = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = t(`nvs.change.${change.kind}`);
      li.append(kind);
      li.append(
        document.createTextNode(
          `${change.namespace}.${change.key}` +
            (change.kind === 'modified'
              ? `  ${shortValue(change.before)} → ${shortValue(change.after)}`
              : change.kind === 'renamed'
                ? `  → ${String(change.after)}`
                : change.kind === 'added'
                  ? `  = ${shortValue(change.after)}`
                  : ''),
        ),
      );
      list.append(li);
    }
    wrap.append(list);

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = t('nvs.pending.hint');
    wrap.append(note);
    return wrap;
  }
}

customElements.define('esp-nvs-tree', EspNvsTree);
