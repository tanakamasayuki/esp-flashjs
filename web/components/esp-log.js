// @ts-check
/**
 * <esp-log> — running record of operations.
 *
 * Entries are stored as `code` plus parameters and translated at render time,
 * so switching language retranslates the history rather than leaving a mixed
 * transcript behind.
 */

import { t, tIssue, onLocaleChange } from '../i18n.js';
import { store } from '../store.js';
import { exportLog } from '../actions.js';

const TEMPLATE = `
<style>
  :host { display: flex; flex-direction: column; min-height: 0; height: 100%;
          font-family: var(--sans, system-ui, sans-serif); font-size: 12px; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
           border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 12px; text-transform: uppercase;
       letter-spacing: 0.04em; color: var(--fg-muted); }
  .spacer { flex: 1; }
  button { background: none; border: 1px solid var(--border); border-radius: 4px;
           color: var(--fg-muted); padding: 2px 8px; font: inherit; cursor: pointer; }
  button:hover { color: var(--fg); }
  ol { flex: 1; overflow: auto; list-style: none; margin: 0; padding: 4px 0;
       font-family: var(--mono, ui-monospace, monospace); }
  li { display: flex; gap: 8px; padding: 2px 10px; line-height: 1.5; }
  li.warn { color: var(--warn); }
  li.error { color: var(--danger); }
  time { color: var(--fg-muted); flex-shrink: 0; }
  .empty { padding: 10px; color: var(--fg-muted); font-family: var(--sans, system-ui, sans-serif); }
</style>
<header>
  <h2 id="title"></h2>
  <span class="spacer"></span>
  <button id="export"></button>
  <button id="clear"></button>
</header>
<ol id="list"></ol>
`;

export class EspLog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.getElementById('clear')?.addEventListener('click', () => store.setState({ log: [] }));
    root.getElementById('export')?.addEventListener('click', () => exportLog());

    const rerender = () => this._render();
    this._cleanup.push(store.subscribe((s) => s.log, rerender), onLocaleChange(rerender));
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    /** @type {HTMLElement} */ (root.getElementById('title')).textContent = t('log.section');
    /** @type {HTMLElement} */ (root.getElementById('clear')).textContent = t('log.clear');
    /** @type {HTMLElement} */ (root.getElementById('export')).textContent = t('log.export');

    const list = /** @type {HTMLElement} */ (root.getElementById('list'));
    const entries = store.getState().log;

    if (entries.length === 0) {
      list.innerHTML = `<li class="empty">${t('log.empty')}</li>`;
      return;
    }

    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    list.replaceChildren(
      ...entries.map((entry) => {
        const li = document.createElement('li');
        li.className = entry.level;
        const time = document.createElement('time');
        time.textContent = new Date(entry.time).toLocaleTimeString();
        const text = document.createElement('span');
        text.textContent = tIssue({ code: entry.code, params: entry.params });
        li.append(time, text);
        return li;
      }),
    );
    // Only auto-scroll if the user was already following the tail; yanking the
    // view away while they are reading history is worse than a stale scroll.
    if (wasAtBottom) list.scrollTop = list.scrollHeight;
  }
}

customElements.define('esp-log', EspLog);
