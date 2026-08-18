// @ts-check
/**
 * The examples from docs/guide.md, executed.
 *
 * A guide whose snippets do not run is worse than no guide: it reads as
 * authoritative while teaching an API that has moved. Everything here is
 * copied from the guide, so the guide cannot drift without a test failing.
 *
 * Device-dependent sections are unavoidably absent — tools/hardware-check.mjs
 * covers those against a real board.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  analyzeBinary,
  analyzeBinaryAs,
  buildNvs,
  describeFlashLayout,
  diffNvs,
  findPartitionByLabel,
  listAnalyzers,
  parseFat,
  parseLittlefs,
  parseNvs,
  parsePartitionTable,
  parseSpiffs,
  summarizeNvsDiff,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
} from '../src/core.js';

const BASE = new URL('./fixtures/hardware/esp32s3/', import.meta.url);

/** @param {string} name */
function region(name) {
  const path = new URL(`${name}.bin`, BASE);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

test('guide §2: analyzing a file returns a described result, never a throw', (t) => {
  const bytes = region('partition-table');
  if (!bytes) return t.skip('no captured fixture');

  const result = analyzeBinary(bytes);
  assert.equal(result.type, 'partition-table');
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.ok(Array.isArray(result.regions));
  assert.ok(Array.isArray(result.issues));
  assert.ok(result.model, 'a recognised format comes with its parsed model');

  // Damaged input is described rather than rejected: a corrupted image is the
  // one you most want to look at.
  const damaged = new Uint8Array(4096).fill(0x5a);
  assert.doesNotThrow(() => analyzeBinary(damaged));
});

test('guide §2: a format can be listed and forced', (t) => {
  const bytes = region('nvs');
  if (!bytes) return t.skip('no captured fixture');

  const ids = listAnalyzers().map((a) => a.id);
  for (const expected of ['partition-table', 'esp-image', 'otadata', 'nvs', 'spiffs', 'littlefs', 'fat', 'raw']) {
    assert.ok(ids.includes(expected), `${expected} should be registered`);
  }
  assert.equal(analyzeBinaryAs('nvs', bytes, {}).type, 'nvs');
});

test('guide §5: the partition table and the fields the guide names', (t) => {
  const bytes = region('partition-table');
  if (!bytes) return t.skip('no captured fixture');

  assert.equal(PARTITION_TABLE_OFFSET, 0x8000);
  assert.equal(PARTITION_TABLE_SIZE, 0xc00);

  const table = parsePartitionTable(bytes);
  assert.ok(table.partitions.length > 0);
  assert.equal(table.md5Valid, true);
  assert.deepEqual(table.issues, []);

  for (const field of ['label', 'typeName', 'subtypeName', 'offset', 'size', 'encrypted']) {
    assert.ok(field in table.partitions[0], `partitions carry ${field}`);
  }

  assert.ok(findPartitionByLabel(table.partitions, 'nvs'));

  const kinds = new Set(
    describeFlashLayout(table.partitions, { flashSize: 8 * 1024 * 1024, bootloaderOffset: 0 })
      .map((r) => r.kind),
  );
  // The bootloader and the table are named rather than lumped in with free
  // space, because a mistaken write there stops the chip booting.
  assert.ok(kinds.has('bootloader'));
  assert.ok(kinds.has('partition-table'));
  assert.ok(kinds.has('unallocated'));
});

test('guide §6: reading, editing and rebuilding NVS', (t) => {
  const bytes = region('nvs');
  if (!bytes) return t.skip('no captured fixture');

  const store = parseNvs(bytes);
  assert.ok(store.namespaces.length > 0);
  assert.ok(store.entries.length > 0);
  assert.ok(store.get('types', 'u8'));
  assert.equal(store.list('types').length, 10);

  assert.equal(store.isDirty, false);
  store.set('types', 'u8', 0x99, 'U8');
  store.delete('types', 'i8');
  assert.equal(store.isDirty, true);
  assert.equal(store.changes().length, 2);

  const image = buildNvs(store, { size: bytes.length });
  assert.equal(image.length, bytes.length);

  assert.deepEqual(summarizeNvsDiff(diffNvs(parseNvs(bytes), parseNvs(image))), {
    added: 0,
    modified: 1,
    deleted: 1,
    renamed: 0,
    total: 2,
  });

  store.reset();
  assert.equal(store.isDirty, false, 'reverting is a discard, not a re-read');
});

test('guide §7: all three filesystems answer the same questions', (t) => {
  if (!region('spiffs')) return t.skip('no captured fixture');

  for (const [name, parse] of /** @type {const} */ ([
    ['spiffs', parseSpiffs],
    ['littlefs', parseLittlefs],
    ['ffat', parseFat],
  ])) {
    const bytes = region(name);
    assert.ok(bytes);
    const image = parse(bytes);

    assert.ok(['spiffs', 'littlefs', 'fat'].includes(image.type));
    assert.ok(image.geometry && typeof image.geometry === 'object');
    assert.ok(Array.isArray(image.issues));

    const file = image.files.find((f) => !f.directory && f.size > 0);
    assert.ok(file, `${name} should hold a file`);
    assert.equal(typeof file.complete, 'boolean');
    // read() is deferred, and returns exactly what the entry says it holds.
    assert.equal(file.read().length, file.size);
  }
});

test('guide §7: a wrong SPIFFS geometry can be forced, and is not silently used', (t) => {
  const bytes = region('spiffs');
  if (!bytes) return t.skip('no captured fixture');

  const forced = parseSpiffs(bytes, { pageSize: 256, blockSize: 4096, detectGeometry: false });
  assert.equal(forced.geometry.pageSize, 256);
  assert.ok(forced.files.length > 0);
});
