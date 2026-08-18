// @ts-check
/**
 * Tests for the parts of the web app that do not need a DOM.
 *
 * The store and the locale resolver hold the logic most likely to go quietly
 * wrong; the rendering components are verified by hand in a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, initialState } from '../web/store.js';

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

test('store notifies only when the selected value changes', () => {
  const store = createStore();
  let calls = 0;
  store.subscribe((s) => s.device.status, () => calls++);

  store.setState({ flash: { size: 4096 } });
  assert.equal(calls, 0, 'an unrelated update must not notify');

  store.setState({ device: { ...store.getState().device, status: 'connecting' } });
  assert.equal(calls, 1);

  // Same value again: the selector result is unchanged, so no notification.
  store.setState({ device: { ...store.getState().device, status: 'connecting' } });
  assert.equal(calls, 1);
});

test('store subscribe can fire immediately and can be cancelled', () => {
  const store = createStore();
  /** @type {unknown[]} */
  const seen = [];
  const off = store.subscribe((s) => s.inspector.tab, (v) => seen.push(v), { immediate: true });
  assert.deepEqual(seen, ['analyze'], 'analysis is the default tab, not metadata');

  store.setState({ inspector: { tab: 'hex' } });
  assert.deepEqual(seen, ['analyze', 'hex']);

  off();
  store.setState({ inspector: { tab: 'analyze' } });
  assert.deepEqual(seen, ['analyze', 'hex'], 'no notifications after unsubscribe');
});

test('store compares by reference so large buffers are never cloned', () => {
  const store = createStore();
  const data = new Uint8Array(1024);
  const buffers = new Map([
    ['a', { id: 'a', name: 'a.bin', data, source: /** @type {const} */ ('file'), address: null, partitionLabel: null, analysis: null }],
  ]);
  store.setState({ buffers });

  // The very same object must come back out; a structural copy of a 16 MB
  // dump on every update would dominate the app's cost.
  assert.equal(store.getState().buffers.get('a')?.data, data);
});

test('store log keeps the newest entries and bounds growth', () => {
  const store = createStore();
  for (let i = 0; i < 600; i++) store.log('info', `code.${i}`);
  const log = store.getState().log;
  assert.equal(log.length, 500);
  assert.equal(log[0].code, 'code.100');
  assert.equal(log.at(-1)?.code, 'code.599');
});

test('initialState is fresh each call', () => {
  const a = initialState();
  const b = initialState();
  a.buffers.set('x', /** @type {any} */ ({}));
  assert.equal(b.buffers.size, 0);
});

/* -------------------------------------------------------------------------- */
/* Locale resolution                                                           */
/* -------------------------------------------------------------------------- */

import { resolveLocale, LOCALES, FALLBACK_LOCALE } from '../web/i18n.js';

/**
 * Runs a function with `localStorage` stubbed.
 *
 * Node has no localStorage, which the module already tolerates; this only
 * matters for the case where a stored preference exists.
 *
 * @template T
 * @param {string|null} stored
 * @param {() => T} body
 * @returns {T}
 */
function withStoredLocale(stored, body) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => stored, setItem: () => {} },
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete (/** @type {any} */ (globalThis).localStorage);
  }
}

test('locale resolution matches an exact tag', () => {
  assert.equal(resolveLocale(['ja']), 'ja');
  assert.equal(resolveLocale(['zh-Hant']), 'zh-Hant');
  // Browsers are inconsistent about case in language tags.
  assert.equal(resolveLocale(['ZH-HANT']), 'zh-Hant');
});

test('locale resolution maps Chinese regions to the right script', () => {
  // Script, not region, is what separates these two: the vocabulary differs,
  // so a glyph conversion would not be enough.
  assert.equal(resolveLocale(['zh-TW']), 'zh-Hant');
  assert.equal(resolveLocale(['zh-HK']), 'zh-Hant');
  assert.equal(resolveLocale(['zh-CN']), 'zh-Hans');
  assert.equal(resolveLocale(['zh']), 'zh-Hans');
});

test('locale resolution falls back to the language subtag', () => {
  assert.equal(resolveLocale(['ja-JP']), 'ja');
  assert.equal(resolveLocale(['en-GB']), 'en');
});

test('locale resolution walks the preference list in order', () => {
  assert.equal(resolveLocale(['ko-KR', 'ja-JP', 'en']), 'ja');
});

test('locale resolution falls back to English for unsupported languages', () => {
  assert.equal(resolveLocale(['ko', 'th', 'vi']), FALLBACK_LOCALE);
  assert.equal(resolveLocale([]), FALLBACK_LOCALE);
});

test('an explicit stored choice wins over the browser preference', () => {
  assert.equal(withStoredLocale('zh-Hans', () => resolveLocale(['ja-JP'])), 'zh-Hans');
  // A stored value that is no longer a supported locale is ignored.
  assert.equal(withStoredLocale('xx', () => resolveLocale(['ja-JP'])), 'ja');
});

test('English is present and is the declared fallback', () => {
  assert.ok(LOCALES.some((l) => l.code === FALLBACK_LOCALE));
  assert.equal(new Set(LOCALES.map((l) => l.code)).size, LOCALES.length);
});
