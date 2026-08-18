// @ts-check
/**
 * <esp-device-panel> — connection controls and device identity.
 *
 * Also carries the standing warnings (ROM mode, Secure Download Mode, flash
 * encryption). Those change what the rest of the UI can do, so they belong
 * where the user looks first rather than buried in the log.
 */

import { t, onLocaleChange } from '../i18n.js';
import { WebSerialTransport, formatByteSize, toHexAddress } from '../esp-flashjs.js';
import { store } from '../store.js';
import { connect, disconnect } from '../actions.js';

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  button {
    background: var(--accent);
    color: var(--accent-fg);
    border: 0;
    border-radius: 5px;
    padding: 6px 14px;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  button.secondary { background: var(--bg-button); color: var(--fg); border: 1px solid var(--border); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Vertical space is scarce: flow the facts inline and wrap, rather than
     spending one row per field. */
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.6;
  }
  .fact { white-space: nowrap; }
  .fact > b {
    font-weight: 400;
    color: var(--fg-muted);
    margin-right: 4px;
  }
  .fact > span { font-family: var(--mono, ui-monospace, monospace); }
  .fact.wide { white-space: normal; }
  .status { color: var(--fg-muted); }
  .notice {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 5px;
    border-left: 3px solid var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    font-size: 12px;
    line-height: 1.5;
  }
  .notice.error { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .notice h4 { margin: 0 0 3px; font-size: 12px; }
</style>
<div class="row" id="controls"></div>
<div id="details"></div>
<div id="notices"></div>
`;

export class EspDevicePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    const rerender = () => this._render();
    this._cleanup.push(store.subscribe((s) => s.device, rerender), onLocaleChange(rerender));
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  _render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const { status, info, usingStub } = store.getState().device;
    const supported = WebSerialTransport.isSupported();
    const secure = typeof isSecureContext === 'undefined' || isSecureContext;

    const controls = /** @type {HTMLElement} */ (root.getElementById('controls'));
    controls.replaceChildren();

    const button = document.createElement('button');
    if (status === 'connected') {
      button.textContent = t('device.disconnect');
      button.className = 'secondary';
      button.addEventListener('click', () => void disconnect());
    } else {
      button.textContent = status === 'connecting' ? t('device.connecting') : t('device.connect');
      button.disabled = status === 'connecting' || !supported || !secure;
      button.addEventListener('click', () => void connect());
    }
    controls.append(button);

    const statusText = document.createElement('span');
    statusText.className = 'status';
    statusText.textContent = status === 'connected' ? '' : t('device.disconnected');
    controls.append(statusText);

    /* Details --------------------------------------------------------- */
    const details = /** @type {HTMLElement} */ (root.getElementById('details'));
    if (status !== 'connected' || !info) {
      details.replaceChildren();
    } else {
      const d = /** @type {import('../esp-flashjs.js').DeviceInfo} */ (info);
      /** @type {Array<[string, string, boolean]>} */
      const facts = [
        [t('device.chip'), d.chip, false],
        [t('device.mac'), d.mac, false],
        [t('device.flashSize'), d.flashSize === null ? t('device.unknown') : formatByteSize(d.flashSize), false],
        [t('device.flashId'), d.flashId === null ? t('device.unknown') : toHexAddress(d.flashId, 6), false],
        [t('device.mode'), usingStub ? t('device.mode.stub') : t('device.mode.rom'), false],
      ];
      if (d.features.length > 0) {
        facts.push([t('device.features'), d.features.map((f) => t(`feature.${f}`)).join(', '), true]);
      }

      const wrap = document.createElement('div');
      wrap.className = 'facts';
      for (const [term, value, wide] of facts) {
        const item = document.createElement('span');
        item.className = wide ? 'fact wide' : 'fact';
        const label = document.createElement('b');
        label.textContent = term;
        const text = document.createElement('span');
        text.textContent = value;
        item.append(label, text);
        wrap.append(item);
      }
      details.replaceChildren(wrap);
    }

    /* Notices --------------------------------------------------------- */
    const notices = /** @type {HTMLElement} */ (root.getElementById('notices'));
    notices.replaceChildren();

    if (!supported) {
      notices.append(notice(t('browser.unsupported.title'), t('browser.unsupported.body')));
    } else if (!secure) {
      notices.append(notice(t('browser.unsupported.title'), t('browser.insecureContext'), true));
    }

    if (status === 'connected' && info) {
      const d = /** @type {import('../esp-flashjs.js').DeviceInfo} */ (info);
      if (d.secureDownloadMode) notices.append(notice('', t('device.secureDownloadMode'), true));
      else if (!usingStub) notices.append(notice('', t('device.romModeWarning')));
      if (d.flashEncryptionEnabled) notices.append(notice('', t('device.encryptionEnabled')));
    }
  }
}

/**
 * @param {string} title
 * @param {string} body
 * @param {boolean} [isError]
 * @returns {HTMLElement}
 */
function notice(title, body, isError = false) {
  const div = document.createElement('div');
  div.className = isError ? 'notice error' : 'notice';
  if (title) {
    const h = document.createElement('h4');
    h.textContent = title;
    div.append(h);
  }
  div.append(document.createTextNode(body));
  return div;
}

customElements.define('esp-device-panel', EspDevicePanel);
