// @ts-check
/**
 * <esp-confirm-dialog> — gate in front of destructive operations.
 *
 * Requires the partition label to be typed out rather than offering a
 * checkbox. A checkbox is clicked reflexively; typing "app0" makes the user
 * read which partition they are about to destroy.
 */

import { t, onLocaleChange } from '../i18n.js';
import { formatByteSize, toHexAddress } from '../esp-flashjs.js';

const TEMPLATE = `
<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
    color: var(--fg);
    padding: 0;
    max-width: min(460px, 92vw);
    font-family: var(--sans, system-ui, sans-serif);
    font-size: 13px;
  }
  dialog::backdrop { background: rgb(0 0 0 / 0.5); }
  .inner { padding: 18px; }
  h2 { margin: 0 0 10px; font-size: 15px; color: var(--danger); }
  p { margin: 0 0 10px; line-height: 1.55; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 12px;
       font-size: 12px; }
  dt { color: var(--fg-muted); }
  dd { margin: 0; font-family: var(--mono, ui-monospace, monospace); }
  .backup { padding: 8px 10px; border-radius: 5px; font-size: 12px; margin-bottom: 12px; }
  .backup.yes { background: color-mix(in srgb, var(--ok) 14%, transparent);
                border-left: 3px solid var(--ok); }
  .backup.no  { background: color-mix(in srgb, var(--warn) 14%, transparent);
                border-left: 3px solid var(--warn); }
  label { display: block; margin-bottom: 6px; color: var(--fg-muted); font-size: 12px; }
  input {
    width: 100%; box-sizing: border-box; padding: 7px 9px;
    border: 1px solid var(--border); border-radius: 5px;
    background: var(--bg-input); color: var(--fg);
    font-family: var(--mono, ui-monospace, monospace); font-size: 13px;
  }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button { border-radius: 5px; padding: 7px 14px; font: inherit; cursor: pointer;
           border: 1px solid var(--border); background: var(--bg-button); color: var(--fg); }
  button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
<dialog>
  <form method="dialog" class="inner">
    <h2 id="title"></h2>
    <p id="warning"></p>
    <dl id="target"></dl>
    <div id="backup" class="backup"></div>
    <label id="prompt" for="confirm"></label>
    <input id="confirm" type="text" autocomplete="off" spellcheck="false" />
    <div class="buttons">
      <button value="cancel" id="cancel"></button>
      <button value="ok" id="ok" class="danger" disabled></button>
    </div>
  </form>
</dialog>
`;

export class EspConfirmDialog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {(() => void)|null} */
    this._onConfirm = null;
    this._word = '';
  }

  connectedCallback() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const input = /** @type {HTMLInputElement} */ (root.getElementById('confirm'));
    const ok = /** @type {HTMLButtonElement} */ (root.getElementById('ok'));
    const dialog = /** @type {HTMLDialogElement} */ (root.querySelector('dialog'));

    input.addEventListener('input', () => {
      ok.disabled = input.value.trim() !== this._word;
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'ok' && this._onConfirm) this._onConfirm();
      this._onConfirm = null;
      input.value = '';
      ok.disabled = true;
    });
    onLocaleChange(() => this._applyLabels());
    this._applyLabels();
  }

  _applyLabels() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    /** @type {HTMLElement} */ (root.getElementById('title')).textContent = t('confirm.title');
    /** @type {HTMLElement} */ (root.getElementById('cancel')).textContent = t('action.cancel');
    /** @type {HTMLElement} */ (root.getElementById('ok')).textContent = t('action.confirm');
  }

  /**
   * @param {object} options
   * @param {import('../esp-flashjs.js').Partition} options.partition
   * @param {string[]} options.reasons
   * @param {boolean} options.hasBackup
   * @param {() => void} options.onConfirm
   */
  open({ partition, reasons, hasBackup, onConfirm }) {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    this._onConfirm = onConfirm;
    this._word = partition.label || 'WRITE';

    const warning = /** @type {HTMLElement} */ (root.getElementById('warning'));
    warning.textContent = reasons.includes('encrypted')
      ? `${t('confirm.dangerous')} ${t('confirm.encrypted')}`
      : t('confirm.dangerous');

    const target = /** @type {HTMLElement} */ (root.getElementById('target'));
    target.replaceChildren();
    for (const [term, value] of /** @type {Array<[string, string]>} */ ([
      [t('confirm.target'), partition.label],
      [t('partition.offset'), toHexAddress(partition.offset)],
      [t('partition.size'), formatByteSize(partition.size)],
    ])) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      target.append(dt, dd);
    }

    const backup = /** @type {HTMLElement} */ (root.getElementById('backup'));
    backup.className = hasBackup ? 'backup yes' : 'backup no';
    backup.textContent = hasBackup ? t('confirm.backedUp') : t('confirm.notBackedUp');

    /** @type {HTMLElement} */ (root.getElementById('prompt')).textContent = t(
      'confirm.typeToConfirm',
      { word: this._word },
    );

    this._applyLabels();
    /** @type {HTMLDialogElement} */ (root.querySelector('dialog')).showModal();
  }
}

customElements.define('esp-confirm-dialog', EspConfirmDialog);

/**
 * Opens the shared dialog instance, creating it on first use.
 *
 * @param {Parameters<EspConfirmDialog['open']>[0]} options
 */
export function openConfirm(options) {
  let dialog = /** @type {EspConfirmDialog|null} */ (document.querySelector('esp-confirm-dialog'));
  if (!dialog) {
    dialog = /** @type {EspConfirmDialog} */ (document.createElement('esp-confirm-dialog'));
    document.body.append(dialog);
  }
  dialog.open(options);
}
