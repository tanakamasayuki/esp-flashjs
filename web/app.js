// @ts-check
/**
 * Application entry point: wire the shell, register components, start i18n.
 */

import { initI18n, setLocale, getLocale, availableLocales, t, onLocaleChange } from './i18n.js';
import { store } from './store.js';
import { dumpFlash, readPartitionTable } from './actions.js';
import { VERSION, formatByteSize } from './esp-flashjs.js';

import './components/esp-device-panel.js';
import './components/esp-flash-map.js';
import './components/esp-file-list.js';
import './components/esp-inspector.js';
import './components/esp-log.js';
import './components/esp-confirm-dialog.js';

/** Elements whose text content comes from a translation key. */
function applyStaticLabels() {
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const key = element.getAttribute('data-i18n');
    if (key) element.textContent = t(key);
  }
  document.title = `${t('app.title')} — ${t('app.tagline')}`;
}

function buildLanguageSelect() {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById('language'));
  select.replaceChildren(
    ...availableLocales().map(({ code, nativeName }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = nativeName;
      return option;
    }),
  );
  select.value = getLocale();
  select.addEventListener('change', () => void setLocale(select.value));
}

function wireFlashActions() {
  document
    .getElementById('read-table')
    ?.addEventListener('click', () => void readPartitionTable());
  document.getElementById('dump')?.addEventListener('click', () => void dumpFlash());

  // Device-dependent buttons follow the connection and stub state.
  const update = () => {
    const state = store.getState();
    const ready = state.device.status === 'connected' && state.device.usingStub;
    for (const id of ['read-table', 'dump']) {
      const button = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
      if (button) button.disabled = !ready;
    }
  };
  store.subscribe((s) => s.device.status, update);
  store.subscribe((s) => s.device.usingStub, update);
  update();
}

function wireProgress() {
  const bar = /** @type {HTMLElement} */ (document.getElementById('progress'));
  const label = /** @type {HTMLElement} */ (document.getElementById('progress-label'));
  const fill = /** @type {HTMLElement} */ (document.getElementById('progress-fill'));
  const cancel = /** @type {HTMLButtonElement} */ (document.getElementById('progress-cancel'));

  cancel.addEventListener('click', () => store.getState().busy.cancel?.());

  store.subscribe(
    (s) => s.busy,
    (busy) => {
      bar.hidden = !busy.active;
      if (!busy.active) return;
      const percent = busy.total > 0 ? (busy.done / busy.total) * 100 : 0;
      fill.style.width = `${percent.toFixed(1)}%`;
      const phase = busy.phase ? t(`progress.${busy.phase}`) : '';
      label.textContent =
        busy.total > 0
          ? `${phase} ${formatByteSize(busy.done)} / ${formatByteSize(busy.total)}`
          : phase;
      cancel.textContent = t('action.cancel');
    },
  );
}

function wireResponsiveTabs() {
  // Below 900px the two panes stack, so a tab strip decides which one is
  // visible. Above it, both are shown and the strip is hidden by CSS.
  const buttons = document.querySelectorAll('#pane-tabs button');
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const pane = /** @type {HTMLElement} */ (button).dataset.pane;
      document.body.dataset.pane = pane ?? 'left';
      for (const other of buttons) {
        other.setAttribute('aria-selected', String(other === button));
      }
    });
  }
}

/**
 * Fixes up links that point outside the app's own directory.
 *
 * index.html is served from `web/` in the repository and from the root of the
 * published site, so a link to a sibling directory needs a different number of
 * `../` in each case.
 */
function resolveOutsideLinks() {
  const atSiteRoot = !location.pathname.replace(/\/[^/]*$/, '/').endsWith('/web/');
  const link = /** @type {HTMLAnchorElement|null} */ (document.getElementById('examples-link'));
  if (link) link.href = atSiteRoot ? './examples/' : '../examples/';
}

async function main() {
  await initI18n();
  resolveOutsideLinks();
  buildLanguageSelect();
  applyStaticLabels();
  onLocaleChange(applyStaticLabels);

  wireFlashActions();
  wireProgress();
  wireResponsiveTabs();

  const version = document.getElementById('version');
  if (version) version.textContent = `v${VERSION}`;

  document.body.dataset.ready = 'true';
}

void main();
