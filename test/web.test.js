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
import {
  displayValue,
  downloadName,
  isEditableType,
  parseValue,
} from '../web/format-values.js';

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

/* -------------------------------------------------------------------------- */
/* Value conversion for the NVS editor                                         */
/* -------------------------------------------------------------------------- */

test('an edit that cannot be the declared type is rejected at the field', () => {
  // buildNvs would refuse too, but only after the user has read a confirmation
  // dialog and typed a partition name to get past it. Failing here costs a red
  // outline; failing there costs their attention on a device that is about to
  // be written.
  assert.throws(() => parseValue('U32', '12.5'), TypeError);
  assert.throws(() => parseValue('U32', 'abc'), TypeError);
  assert.throws(() => parseValue('U32', ''), TypeError);
  assert.throws(() => parseValue('U32', '   '), TypeError);
  assert.throws(() => parseValue('U64', '1.5'), TypeError);
  assert.throws(() => parseValue('I64', 'nope'), TypeError);
});

test('the notations someone might reasonably type are accepted', () => {
  assert.equal(parseValue('U32', '42'), 42);
  assert.equal(parseValue('U32', ' 42 '), 42, 'surrounding space is not an error');
  assert.equal(parseValue('U32', '0x10'), 16);
  assert.equal(parseValue('U32', '1e3'), 1000);
  assert.equal(parseValue('I32', '-7'), -7);
  assert.equal(parseValue('U64', '1122334455667788'), 1122334455667788n);
  assert.equal(parseValue('I64', '-5000000000'), -5000000000n);
});

test('a string keeps exactly what was typed', () => {
  // Trimming a string value would silently change data. Only the numeric
  // parsers trim, and only because " 42 " is unambiguous.
  assert.equal(parseValue('STR', '  padded  '), '  padded  ');
  assert.equal(parseValue('STR', ''), '', 'an empty string is a legal NVS value');
});

test('a blob is shown as a preview, never as a value to edit', () => {
  const short = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  assert.equal(displayValue({ type: 'BLOB', value: short }), 'de ad be ef');

  const long = new Uint8Array(100).fill(0xa5);
  const shown = displayValue({ type: 'BLOB', value: long });
  assert.ok(shown.endsWith('(100 bytes)'), 'the full length is stated rather than implied');
  assert.ok(shown.length < 120, 'and the preview stays one line');

  assert.equal(isEditableType('BLOB'), false);
  assert.equal(isEditableType('STR'), true);
  assert.equal(isEditableType('U32'), true);
});

test('a download name survives a nested path', () => {
  // A slash here is not a directory: browsers either strip it or refuse the
  // download outright, so a file at /sub/nested.txt must not produce one.
  assert.equal(downloadName('spiffs', '/sub/nested.txt'), 'spiffs_sub_nested.txt');
  assert.equal(downloadName('ffat', '/hello.txt'), 'ffat_hello.txt');
  assert.equal(downloadName('fs', '/'), 'fs_file', 'a path with no name still gets one');
  assert.ok(!downloadName('fs', '/a/b/c.bin').includes('/'));
});
