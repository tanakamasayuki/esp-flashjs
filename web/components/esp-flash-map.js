// @ts-check
/**
 * <esp-flash-map> — visual layout of the flash.
 *
 * Heights follow the square root of the partition size rather than the size
 * itself. On a 4 MB device a 24 KB NVS partition is 0.6% of the flash and
 * would be a sub-pixel sliver under linear scaling; the exact size is printed
 * on the row, so the bar only has to convey proportion.
 */

import { t, onLocaleChange } from '../i18n.js';
import { describeFlashLayout, formatByteSize, toHexAddress } from '../esp-flashjs.js';
import { store } from '../store.js';
import { select } from '../actions.js';

/** Colour per partition kind, resolved against CSS variables. */
const PALETTE = {
  app: 'var(--map-app)',
  nvs: 'var(--map-nvs)',
  ota: 'var(--map-ota)',
  fs: 'var(--map-fs)',
  data: 'var(--map-data)',
  gap: 'var(--map-gap)',
  system: 'var(--map-system)',
};

const TEMPLATE = `
<style>
  :host { display: block; font-family: var(--sans, system-ui, sans-serif); font-size: 13px; }
  .empty { padding: 12px; color: var(--fg-muted); }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    border-left: 4px solid var(--kind-color);
    background: color-mix(in srgb, var(--kind-color) 12%, transparent);
    cursor: pointer;
    min-height: var(--row-height);
  }
  li:hover { background: color-mix(in srgb, var(--kind-color) 22%, transparent); }
  li[aria-selected="true"] {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  li.gap {
    border-left-style: dashed;
    cursor: default;
    color: var(--fg-muted);
  }
  /* Reserved by the boot process, not free space. */
  li.system {
    cursor: default;
    border-left-style: double;
    border-left-width: 5px;
  }
  .name { font-weight: 500; }
  .sub { color: var(--fg-muted); font-size: 11px; }
  .size {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--fg-muted);
    text-align: right;
    white-space: nowrap;
  }
  .locked { font-size: 11px; }
  .tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--border);
    color: var(--fg-muted);
    vertical-align: 1px;
  }
  /* Nothing written yet: mute it so the used partitions stand out. */
  li.empty-partition .name { color: var(--fg-muted); font-weight: 400; }
</style>
<div id="root"></div>
`;

export class EspFlashMap extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    /** @type {Array<() => void>} */
    this._cleanup = [];
  }

  connectedCallback() {
    const rerender = () => this._render();
    this._cleanup.push(
      store.subscribe((s) => s.partitions.table, rerender),
      store.subscribe((s) => s.flash.size, rerender),
      store.subscribe((s) => s.selection.id, rerender),
      store.subscribe((s) => s.partitionStates, rerender),
      onLocaleChange(rerender),
    );
    this._render();
  }

  disconnectedCallback() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  }

  _render() {
    const root = /** @type {HTMLElement} */ (this.shadowRoot?.getElementById('root'));
    const state = store.getState();
    const table = /** @type {{partitions: import('../esp-flashjs.js').Partition[]}|null} */ (
      state.partitions.table
    );

    if (!table || table.partitions.length === 0) {
      root.innerHTML = `<p class="empty">${escapeHtml(t('partition.none'))}</p>`;
      return;
    }

    const flashSize = state.flash.size;
    const bootloaderOffset = state.device.info?.bootloaderOffset ?? 0x1000;
    const entries = describeFlashLayout(table.partitions, { flashSize, bootloaderOffset });

    const maxRoot = Math.sqrt(Math.max(...entries.map((e) => e.size), 1));

    const list = document.createElement('ol');
    for (const entry of entries) {
      const li = document.createElement('li');
      // Square-root scaling: proportional enough to read, never invisible.
      const height = 22 + (Math.sqrt(entry.size) / maxRoot) * 46;
      li.style.setProperty('--row-height', `${height.toFixed(0)}px`);

      if (entry.kind !== 'partition') {
        // The bootloader and the partition table are not free space, even
        // though no entry describes them. Showing them as "unallocated" is how
        // someone talks themselves into erasing the bootloader.
        const isSystem = entry.kind !== 'unallocated';
        li.className = isSystem ? 'system' : 'gap';
        li.style.setProperty('--kind-color', isSystem ? PALETTE.system : PALETTE.gap);
        const label = isSystem ? t(`flash.region.${entry.kind}`) : t('flash.unallocated');
        li.innerHTML =
          `<span><span class="name">${escapeHtml(label)}</span>` +
          (isSystem ? ' <span class="locked" title="' + escapeHtml(t('flash.systemRegion')) + '">&#9888;</span>' : '') +
          `<br><span class="sub">${toHexAddress(entry.offset)}</span></span>` +
          `<span class="size">${formatByteSize(entry.size)}</span>`;
        list.append(li);
        continue;
      }

      const partition = /** @type {import('../esp-flashjs.js').Partition} */ (entry.partition);
      li.style.setProperty('--kind-color', colorFor(partition));
      li.dataset.label = partition.label;
      li.setAttribute('role', 'option');
      li.setAttribute(
        'aria-selected',
        String(state.selection.kind === 'partition' && state.selection.id === partition.label),
      );
      const probed = state.partitionStates.get(partition.label);
      // An empty partition looks identical to a full one on a size-based map,
      // so say it outright rather than making someone read a hex dump.
      const stateTag =
        probed && probed !== 'data'
          ? ` <span class="tag">${escapeHtml(t(`partition.state.${probed}`))}</span>`
          : '';
      if (probed && probed !== 'data') li.classList.add('empty-partition');

      li.innerHTML =
        `<span><span class="name">${escapeHtml(partition.label)}</span>` +
        (partition.encrypted ? ` <span class="locked" title="${escapeHtml(t('partition.encrypted'))}">&#128274;</span>` : '') +
        stateTag +
        `<br><span class="sub">${partition.typeName} / ${partition.subtypeName} &middot; ` +
        `${toHexAddress(partition.offset)}</span></span>` +
        `<span class="size">${formatByteSize(partition.size)}</span>`;
      li.addEventListener('click', () => select('partition', partition.label));
      list.append(li);
    }

    root.replaceChildren(list);
  }
}

/**
 * @param {import('../esp-flashjs.js').Partition} partition
 * @returns {string}
 */
function colorFor(partition) {
  if (partition.type === 0) return PALETTE.app;
  switch (partition.subtypeName) {
    case 'nvs':
    case 'nvs_keys':
      return PALETTE.nvs;
    case 'ota':
      return PALETTE.ota;
    case 'spiffs':
    case 'littlefs':
    case 'fat':
      return PALETTE.fs;
    default:
      return PALETTE.data;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

customElements.define('esp-flash-map', EspFlashMap);
