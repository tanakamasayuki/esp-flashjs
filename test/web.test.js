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
  archiveName,
  displayValue,
  downloadName,
  isEditableType,
  parseValue,
} from '../web/format-values.js';
import { zip, toDosTimestamp } from '../web/zip.js';
import { decodeTextFile } from '../web/format-values.js';

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

test('an extracted file keeps its own name', () => {
  // It used to arrive as "spiffs_sub_nested.txt", which nobody asked for. The
  // collision that was guarding against is one browsers already solve by
  // appending a number, and extracting everything now produces a ZIP that
  // keeps the real paths.
  assert.equal(downloadName('/sub/nested.txt'), 'nested.txt');
  assert.equal(downloadName('/hello.txt'), 'hello.txt');
  assert.equal(downloadName('/'), 'file', 'a path with no name still gets one');
});

test('a download name cannot carry a separator or a reserved character', () => {
  // A filesystem image can hold names a host will not accept.
  assert.ok(!downloadName('/a/b/c.bin').includes('/'));
  assert.equal(downloadName('/what?.txt'), 'what_.txt');
  assert.equal(archiveName('spiffs'), 'spiffs-files.zip');
});

/* -------------------------------------------------------------------------- */
/* ZIP                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reads an archive back the way an extractor does: from the central directory
 * at the end, not by scanning for local headers. Written here rather than
 * reusing anything from the writer, so the two cannot agree on a mistake.
 *
 * @param {Uint8Array} archive
 * @returns {Array<{name: string, size: number, method: number, crc: number, directory: boolean}>}
 */
function readCentralDirectory(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'the archive must end with an end-of-central-directory record');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory entry');
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    out.push({
      name,
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      size: view.getUint32(at + 24, true),
      directory: (view.getUint32(at + 38, true) & 0x10) !== 0,
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

test('an archive keeps the real paths, which is the point of making one', async () => {
  // Extracting file by file flattened /sub/nested.txt into a filename. A ZIP
  // is the reason that compromise is no longer needed.
  const archive = await zip(
    [
      { path: '/hello.txt', data: new TextEncoder().encode('hello\n') },
      { path: '/sub', directory: true },
      { path: '/sub/nested.txt', data: new TextEncoder().encode('nested\n') },
      { path: '/empty', directory: true },
    ],
    { compress: false, date: new Date(2026, 0, 2, 3, 4, 6) },
  );

  const entries = readCentralDirectory(archive);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['hello.txt', 'sub/', 'sub/nested.txt', 'empty/'],
    'no leading slash, and directories keep their trailing one',
  );
  assert.deepEqual(
    entries.filter((e) => e.directory).map((e) => e.name),
    ['sub/', 'empty/'],
    'an empty directory has to survive: it is the difference between two formats',
  );
  assert.equal(entries[0].size, 6);
});

test('a stored entry carries the checksum an extractor will verify', async () => {
  const data = new TextEncoder().encode('the quick brown fox');
  const archive = await zip([{ path: 'a.txt', data }], { compress: false });
  const [entry] = readCentralDirectory(archive);

  // CRC-32 longhand, so a mistake in the library cannot agree with itself.
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  assert.equal(entry.crc, (~crc) >>> 0);
  assert.equal(entry.method, 0);
});

test('a compressed entry is only used when it is actually smaller', async () => {
  const compressible = new Uint8Array(4096); // all zeros
  const random = Uint8Array.from({ length: 512 }, (_, i) => (i * 2654435761) & 0xff);
  const archive = await zip([
    { path: 'zeros.bin', data: compressible },
    { path: 'random.bin', data: random },
  ]);
  const entries = readCentralDirectory(archive);

  assert.equal(entries[0].size, 4096);
  assert.equal(entries[1].size, 512);
  if (typeof globalThis.CompressionStream === 'function') {
    assert.equal(entries[0].method, 8, 'four kilobytes of zeros compress');
  }
});

test('an empty archive is still a valid one', async () => {
  const archive = await zip([]);
  assert.deepEqual(readCentralDirectory(archive), []);
  assert.equal(archive.length, 22, 'nothing but the end record');
});

test('the DOS timestamp loses the odd second, as the format requires', () => {
  const stamp = toDosTimestamp(new Date(2026, 7, 19, 14, 30, 45));
  assert.equal((stamp.date >> 9) + 1980, 2026);
  assert.equal((stamp.date >> 5) & 0x0f, 8);
  assert.equal(stamp.date & 0x1f, 19);
  assert.equal(stamp.time >> 11, 14);
  assert.equal((stamp.time >> 5) & 0x3f, 30);
  assert.equal((stamp.time & 0x1f) * 2, 44, 'two-second resolution, rounded down');
});

test('a date before 1980 is clamped rather than wrapping', () => {
  // The field has nowhere to put it, and a negative year would wrap into a
  // plausible-looking future date.
  assert.equal((toDosTimestamp(new Date(1970, 0, 1)).date >> 9) + 1980, 1980);
});

/* -------------------------------------------------------------------------- */
/* Text detection                                                              */
/* -------------------------------------------------------------------------- */

test('only real text is offered for editing', () => {
  assert.equal(decodeTextFile(new TextEncoder().encode('hello\n')), 'hello\n');
  assert.equal(decodeTextFile(new TextEncoder().encode('日本語のテキスト')), '日本語のテキスト');

  // A lenient decoder would "decode" this into replacement characters, and
  // saving the result back would replace every byte it could not read.
  assert.equal(decodeTextFile(Uint8Array.of(0xff, 0xfe, 0x00, 0x01)), null);
  assert.equal(decodeTextFile(Uint8Array.of(0x68, 0x00, 0x69)), null, 'a NUL means not text');
  assert.equal(decodeTextFile(new Uint8Array(300), 256), null, 'and a huge file is not a textarea');
});
