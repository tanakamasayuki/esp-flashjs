// @ts-check
/**
 * Checks the documentation against the code it documents.
 *
 * Reference documentation rots in two directions, and both are worse than
 * having none: an export nobody wrote down is undiscoverable, and a documented
 * name that no longer exists sends readers looking for something that was
 * removed. Neither shows up in a test suite that only exercises the library.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as full from '../src/index.js';
import * as core from '../src/core.js';
import * as errors from '../src/util/errors.js';

const API = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');

test('every export appears in the API reference', () => {
  const undocumented = Object.keys(full).filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(API),
  );
  assert.deepEqual(
    undocumented,
    [],
    `add these to docs/api.md: ${undocumented.join(', ')}`,
  );
});

test('the API reference names nothing that was removed', () => {
  // Capitalised identifiers only: lower-case words in prose are not claims
  // about the API, and the noise would make the check useless.
  const known = new Set(Object.keys(full));
  const prose = new Set([
    'Uint8Array', 'Promise', 'Map', 'JSDoc', 'TypeScript', 'WebCrypto', 'Node',
    'ESP32', 'IRAM', 'DRAM', 'IROM', 'DROM', 'RTC', 'MD5', 'SPI', 'RAM', 'SHA',
    'URL', 'DTR', 'RTS', 'NVS', 'FAT',
    // Type names, which are JSDoc typedefs rather than runtime exports.
    'Transport', 'ChipDef', 'NvsStore', 'NvsChange', 'FsImage', 'Issue',
  ]);
  const codes = new Set(
    Object.values(errors)
      .filter((v) => typeof v === 'function')
      .flatMap((cls) => {
        try {
          // @ts-expect-error - probing constructors of varying arity
          return [new cls('CODE', 'message', {}).code];
        } catch {
          return [];
        }
      }),
  );

  const claimed = [...API.matchAll(/`([A-Z][A-Za-z0-9_]*)(?:\(|`|#)/g)].map((m) => m[1]);
  const bogus = [...new Set(claimed)].filter(
    (name) => !known.has(name) && !prose.has(name) && !codes.has(name) && !/^[A-Z_]+$/.test(name),
  );
  assert.deepEqual(bogus, [], `docs/api.md names things that do not exist: ${bogus.join(', ')}`);
});

test('the error codes in the reference are the codes the classes carry', () => {
  /** @type {Array<[string, () => Error & {code?: string}]>} */
  const cases = [
    ['AlignmentError', () => new errors.AlignmentError('erase', 1, 4096)],
    ['ChecksumError', () => new errors.ChecksumError('read', 'a', 'b')],
    ['InvalidMagicError', () => new errors.InvalidMagicError('table', 0xaa50, 0)],
    ['NvsCapacityError', () => new errors.NvsCapacityError(1, 2)],
    ['OperationAbortedError', () => new errors.OperationAbortedError('reading')],
    ['OutOfRangeError', () => new errors.OutOfRangeError(0, 1, 2)],
    ['StubLoadError', () => new errors.StubLoadError('x')],
    ['SyncFailedError', () => new errors.SyncFailedError(7)],
    ['TransportClosedError', () => new errors.TransportClosedError()],
    ['TransportTimeoutError', () => new errors.TransportTimeoutError(3000)],
    ['TruncatedDataError', () => new errors.TruncatedDataError('x', 4, 2)],
    ['UnsupportedOperationError', () => errors.UnsupportedOperationError.requiresStub('Flash read')],
  ];

  for (const [name, make] of cases) {
    const code = make().code;
    assert.ok(code, `${name} should carry a code`);
    // A reader copying a code out of the table has to get a working comparison.
    assert.match(
      API,
      new RegExp(`\`${name}\`[^|]*\\|[^|]*\`${code}\``),
      `docs/api.md should list ${name} with code ${code}`,
    );
  }
});

test('core exports nothing that reaches for a browser', () => {
  // The reference promises core runs anywhere. It is imported at the top of
  // this file under Node, so loading it at all is most of the proof; this
  // pins the promise that the two entry points differ only by the device layer.
  const deviceOnly = Object.keys(full).filter((name) => !(name in core));
  for (const name of ['EspFlash', 'EspLoader', 'WebSerialTransport', 'registerStub']) {
    assert.ok(deviceOnly.includes(name), `${name} belongs to the full entry point`);
  }
  for (const name of ['parseNvs', 'parseSpiffs', 'analyzeBinary', 'diffBinary']) {
    assert.ok(name in core, `${name} belongs to core`);
  }
});

test('every relative link in the documentation resolves', () => {
  const docs = readdirSync(new URL('../docs/', import.meta.url))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`);
  const files = [
    ...docs,
    'README.md',
    'README.ja.md',
    'CHANGELOG.md',
    'CHANGELOG.ja.md',
    'tools/fixture-device/README.md',
    'tools/fixture-device/README.ja.md',
  ];

  /** @type {string[]} */
  const broken = [];
  for (const file of files) {
    const path = new URL(`../${file}`, import.meta.url);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\]\((\.[^)#]*?)(#[^)]*)?\)/g)) {
      const target = resolve(dirname(path.pathname), match[1]);
      if (!existsSync(target)) broken.push(`${file} -> ${match[1]}`);
    }
  }
  assert.deepEqual(broken, [], `broken links: ${broken.join(', ')}`);
});

test('every English document has a Japanese counterpart, and they link to each other', () => {
  const dir = new URL('../docs/', import.meta.url);
  const english = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.endsWith('.ja.md'));

  for (const file of english) {
    const japanese = file.replace(/\.md$/, '.ja.md');
    assert.ok(
      existsSync(new URL(japanese, dir)),
      `docs/${file} has no Japanese counterpart`,
    );
    assert.match(
      readFileSync(new URL(file, dir), 'utf8'),
      new RegExp(`\\(\\./${japanese.replace('.', '\\.')}\\)`),
      `docs/${file} should link to its translation`,
    );
    assert.match(
      readFileSync(new URL(japanese, dir), 'utf8'),
      new RegExp(`\\(\\./${file.replace('.', '\\.')}\\)`),
      `docs/${japanese} should link back`,
    );
  }
});

test('every in-document anchor resolves to a heading', () => {
  // Anchors rot silently: the link still renders, it just lands at the top of
  // the page. Four in this repository were broken by an em-dash, which GitHub
  // drops entirely while a naive slug turns it into a second hyphen.
  const slug = (heading) =>
    heading
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');

  const root = new URL('../', import.meta.url);
  const files = [
    ...readdirSync(new URL('docs/', root))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
    'README.md',
    'README.ja.md',
    'CHANGELOG.md',
    'CHANGELOG.ja.md',
  ];

  /** @type {Map<string, Set<string>>} */
  const headings = new Map();
  for (const file of files) {
    const text = readFileSync(new URL(file, root), 'utf8');
    headings.set(
      file,
      new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))),
    );
  }

  /** @type {string[]} */
  const broken = [];
  for (const file of files) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const match of text.matchAll(/\]\((\.\/[^)#]+)?#([^)]+)\)/g)) {
      const target = match[1] ? `${dir ? `${dir}/` : ''}${match[1].slice(2)}` : file;
      if (!headings.has(target)) continue; // a file outside this set
      if (!headings.get(target)?.has(match[2])) {
        broken.push(`${file} -> ${match[1] ?? ''}#${match[2]}`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken anchors: ${broken.join(', ')}`);
});

test('no Japanese document has stray Hangul', () => {
  // A guide once opened with 작업 where 作業 was meant. It survived review
  // because at a glance it is the same word, and nothing else would catch it.
  const root = new URL('../', import.meta.url);
  const files = [
    ...readdirSync(new URL('docs/', root))
      .filter((f) => f.endsWith('.ja.md'))
      .map((f) => `docs/${f}`),
    'README.ja.md',
    'CHANGELOG.ja.md',
  ];

  /** @type {string[]} */
  const found = [];
  for (const file of files) {
    const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/[가-힯ᄀ-ᇿ]/.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(found, [], `Hangul in a Japanese document: ${found.join(', ')}`);
});
