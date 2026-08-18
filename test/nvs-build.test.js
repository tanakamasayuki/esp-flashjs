// @ts-check
/**
 * NVS building, checked against images a real device wrote.
 *
 * A writer that shares its constants with the parser can agree with it while
 * both are wrong — that is how the partition-table magic and the otadata CRC
 * both got past the suite earlier. So the load-bearing test here starts from
 * bytes this project did not produce: flash captured from an ESP32, an
 * ESP32-S3 and an ESP32-P4 that were provisioned with a known set of keys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseNvs, entryState, ENTRY_STATE, NVS_PAGE_SIZE, PAGE_STATE } from '../src/format/nvs/parse.js';
import { NvsStore } from '../src/format/nvs/store.js';
import { buildNvs, NVS_MIN_PAGES } from '../src/format/nvs/build.js';
import { diffNvs, summarizeNvsDiff } from '../src/format/nvs/diff.js';
import { NvsCapacityError } from '../src/util/errors.js';

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

/** @param {string} chip */
const fixturePath = (chip) => new URL(`./fixtures/hardware/${chip}/nvs.bin`, import.meta.url);

/** @param {string} chip */
function hardwareNvs(chip) {
  const path = fixturePath(chip);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

/** A store built from scratch, so tests do not depend on a device being present. */
function syntheticStore() {
  const store = new NvsStore({ pages: [], entries: [], namespaces: [] });
  store.addNamespace('cfg');
  store.set('cfg', 'u8', 0x12, 'U8');
  store.set('cfg', 'i8', -5, 'I8');
  store.set('cfg', 'u16', 0x1234, 'U16');
  store.set('cfg', 'i16', -300, 'I16');
  store.set('cfg', 'u32', 0x12345678, 'U32');
  store.set('cfg', 'i32', -70000, 'I32');
  store.set('cfg', 'u64', 0x1122334455667788n, 'U64');
  store.set('cfg', 'i64', -5000000000n, 'I64');
  store.set('cfg', 'str', 'hello NVS', 'STR');
  store.set('cfg', 'empty', '', 'STR');
  store.set('blobs', 'small', new Uint8Array(64).fill(0xa5), 'BLOB');
  // Over one page, so it has to become several BLOB_DATA chunks and an index.
  store.set('blobs', 'big', Uint8Array.from({ length: 5000 }, (_, i) => i & 0xff), 'BLOB');
  return store;
}

/* -------------------------------------------------------------------------- */
/* Round trip against real devices                                             */
/* -------------------------------------------------------------------------- */

for (const chip of CHIPS) {
  test(`${chip}: an image the device wrote survives parse -> build -> parse`, (t) => {
    const original = hardwareNvs(chip);
    if (!original) return t.skip(`no captured fixture for ${chip}`);

    const before = parseNvs(original);
    assert.equal(
      before.issues.filter((i) => i.level === 'error').length,
      0,
      'the captured image should parse cleanly',
    );

    const rebuilt = buildNvs(before, { size: original.length });
    const after = parseNvs(rebuilt);

    assert.equal(rebuilt.length, original.length);
    assert.deepEqual(
      after.namespaces,
      before.namespaces,
      'namespaces should come back unchanged',
    );
    assert.equal(
      after.entries.length,
      before.entries.length,
      'entry count should come back unchanged',
    );
    assert.deepEqual(
      diffNvs(before, after),
      [],
      'nothing should differ between the device image and the rebuilt one',
    );
  });
}

test('the rebuilt image keeps a page free, the way a device needs', (t) => {
  const original = hardwareNvs('esp32s3');
  if (!original) return t.skip('no captured fixture');

  const rebuilt = buildNvs(parseNvs(original), { size: original.length });
  const pages = parseNvs(rebuilt).pages;

  const free = pages.filter((p) => p.state === PAGE_STATE.UNINITIALIZED);
  assert.ok(
    free.length >= 1,
    'without a free page NVS cannot garbage collect, which is how the first ' +
      'fixture silently lost its erased entries',
  );
  const active = pages.filter((p) => p.state === PAGE_STATE.ACTIVE);
  assert.equal(active.length, 1, 'exactly one page should be open for writing');
});

test('every page in a rebuilt image has a valid header CRC', (t) => {
  const original = hardwareNvs('esp32p4');
  if (!original) return t.skip('no captured fixture');

  const pages = parseNvs(buildNvs(parseNvs(original), { size: original.length })).pages;
  for (const page of pages) {
    assert.ok(page.crcValid, `page ${page.index} header CRC`);
  }
});

/* -------------------------------------------------------------------------- */
/* Round trip without hardware                                                 */
/* -------------------------------------------------------------------------- */

test('every value type survives a round trip', () => {
  const store = syntheticStore();
  const parsed = parseNvs(buildNvs(store, { size: 8 * NVS_PAGE_SIZE }));

  const get = (ns, key) => parsed.get(ns, key);
  assert.equal(get('cfg', 'u8')?.value, 0x12);
  assert.equal(get('cfg', 'i8')?.value, -5);
  assert.equal(get('cfg', 'u16')?.value, 0x1234);
  assert.equal(get('cfg', 'i16')?.value, -300);
  assert.equal(get('cfg', 'u32')?.value, 0x12345678);
  assert.equal(get('cfg', 'i32')?.value, -70000);
  assert.equal(get('cfg', 'u64')?.value, 0x1122334455667788n);
  assert.equal(get('cfg', 'i64')?.value, -5000000000n);
  assert.equal(get('cfg', 'str')?.value, 'hello NVS');
  assert.equal(get('cfg', 'empty')?.value, '');
});

test('a blob too large for one page is split and comes back whole', () => {
  const store = syntheticStore();
  const parsed = parseNvs(buildNvs(store, { size: 8 * NVS_PAGE_SIZE }));

  const big = parsed.get('blobs', 'big');
  assert.ok(big, 'the big blob should be readable');
  assert.equal(big.type, 'BLOB');
  const value = /** @type {Uint8Array} */ (big.value);
  assert.equal(value.length, 5000, 'a split blob must reassemble to its full length');
  assert.ok(!big.partial, 'no chunk should be missing');
  for (let i = 0; i < value.length; i++) {
    assert.equal(value[i], i & 0xff, `blob byte ${i}`);
  }
});

test('an empty namespace still exists after a round trip', () => {
  const store = new NvsStore({ pages: [], entries: [], namespaces: [] });
  store.addNamespace('lonely');
  const parsed = parseNvs(buildNvs(store, { size: NVS_MIN_PAGES * NVS_PAGE_SIZE }));
  assert.deepEqual(parsed.namespaces, ['lonely']);
});

/* -------------------------------------------------------------------------- */
/* Refusing to produce a broken image                                          */
/* -------------------------------------------------------------------------- */

test('data that does not fit is refused rather than truncated', () => {
  const store = new NvsStore({ pages: [], entries: [], namespaces: [] });
  store.addNamespace('big');
  for (let i = 0; i < 500; i++) store.set('big', `k${String(i).padStart(3, '0')}`, i, 'U32');

  assert.throws(
    () => buildNvs(store, { size: NVS_MIN_PAGES * NVS_PAGE_SIZE }),
    (error) => error instanceof NvsCapacityError,
  );
});

test('a partition smaller than three pages is refused', () => {
  const store = syntheticStore();
  assert.throws(() => buildNvs(store, { size: 2 * NVS_PAGE_SIZE }), NvsCapacityError);
});

test('a size that is not a whole number of pages is refused', () => {
  const store = syntheticStore();
  assert.throws(() => buildNvs(store, { size: 5000 }), RangeError);
});

test('a value outside its declared type is refused', () => {
  const store = new NvsStore({ pages: [], entries: [], namespaces: [] });
  store.set('cfg', 'small', 300, 'U8');
  assert.throws(() => buildNvs(store, { size: 4 * NVS_PAGE_SIZE }), RangeError);
});

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

test('diffNvs reports additions, changes and deletions', () => {
  const size = 8 * NVS_PAGE_SIZE;
  const before = parseNvs(buildNvs(syntheticStore(), { size }));

  const edited = syntheticStore();
  edited.set('cfg', 'u8', 0x99, 'U8');
  edited.delete('cfg', 'i8');
  edited.set('cfg', 'fresh', 7, 'U32');
  const after = parseNvs(buildNvs(edited, { size }));

  const changes = diffNvs(before, after);
  assert.deepEqual(summarizeNvsDiff(changes), {
    added: 1,
    modified: 1,
    deleted: 1,
    renamed: 0,
    total: 3,
  });
  assert.deepEqual(
    changes.map((c) => `${c.kind} ${c.namespace}.${c.key}`).sort(),
    ['added cfg.fresh', 'deleted cfg.i8', 'modified cfg.u8'],
  );
});

test('diffNvs pairs a deletion with an identical addition as a rename', () => {
  const size = 8 * NVS_PAGE_SIZE;
  const before = parseNvs(buildNvs(syntheticStore(), { size }));

  const edited = syntheticStore();
  edited.rename('cfg', 'u32', 'renamed');
  const after = parseNvs(buildNvs(edited, { size }));

  const changes = diffNvs(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'renamed');
  assert.equal(changes[0].before, 'u32');
  assert.equal(changes[0].after, 'renamed');
});

test('rename detection can be turned off when a deletion must stay visible', () => {
  const size = 8 * NVS_PAGE_SIZE;
  const before = parseNvs(buildNvs(syntheticStore(), { size }));

  const edited = syntheticStore();
  edited.rename('cfg', 'u32', 'renamed');
  const after = parseNvs(buildNvs(edited, { size }));

  const changes = diffNvs(before, after, { detectRenames: false });
  assert.deepEqual(
    changes.map((c) => c.kind).sort(),
    ['added', 'deleted'],
  );
});

test('an image compared with itself reports no changes', (t) => {
  const original = hardwareNvs('esp32');
  if (!original) return t.skip('no captured fixture');
  const store = parseNvs(original);
  assert.deepEqual(diffNvs(store, parseNvs(original)), []);
});

/* -------------------------------------------------------------------------- */
/* Invariants a device depends on but our own parser does not                  */
/* -------------------------------------------------------------------------- */

/**
 * Counts entry slots marked WRITTEN in a page bitmap.
 *
 * @param {Uint8Array} image
 * @returns {number}
 */
function writtenSlots(image) {
  let count = 0;
  for (let page = 0; page * NVS_PAGE_SIZE < image.length; page++) {
    const base = page * NVS_PAGE_SIZE;
    if (new DataView(image.buffer, base, 4).getUint32(0, true) === PAGE_STATE.UNINITIALIZED) {
      continue;
    }
    for (let i = 0; i < 126; i++) {
      if (entryState(image.subarray(base, base + NVS_PAGE_SIZE), i) === ENTRY_STATE.WRITTEN) {
        count += 1;
      }
    }
  }
  return count;
}

test('every slot a record occupies is marked written, not just its header', () => {
  // Our own parser would not notice: it reads a header, then skips `span`
  // slots without consulting the bitmap again. A device does consult it, and
  // would hand a payload slot out for reuse — quietly destroying the record
  // that already lives there.
  const image = buildNvs(syntheticStore(), { size: 8 * NVS_PAGE_SIZE });
  const parsed = parseNvs(image);

  const occupied = parsed.pages.reduce((sum, page) => sum + page.usedEntries, 0);
  assert.ok(occupied > parsed.entries.length, 'the fixture should include multi-slot records');
  assert.equal(
    writtenSlots(image),
    occupied,
    'written bits should account for payload slots as well as headers',
  );
});

test('a page is always left free, even when the data would fill the partition', () => {
  // NVS needs somewhere to compact into. An image with every page used leaves
  // a device unable to write at all, which is how the first hardware fixture
  // silently lost its erased entries.
  const size = 4 * NVS_PAGE_SIZE; // three usable pages, 126 entries each
  const capacity = 3 * 126 - 1; // one slot goes to the namespace definition

  const fits = new NvsStore({ pages: [], entries: [], namespaces: [] });
  for (let i = 0; i < capacity; i++) fits.set('ns', `k${String(i).padStart(3, '0')}`, i, 'U32');
  const image = buildNvs(fits, { size });
  const free = parseNvs(image).pages.filter((p) => p.state === PAGE_STATE.UNINITIALIZED);
  assert.equal(free.length, 1, 'the spare page must survive a partition packed to capacity');

  const overflows = new NvsStore({ pages: [], entries: [], namespaces: [] });
  for (let i = 0; i <= capacity; i++) {
    overflows.set('ns', `k${String(i).padStart(3, '0')}`, i, 'U32');
  }
  assert.throws(
    () => buildNvs(overflows, { size }),
    (error) => error instanceof NvsCapacityError,
    'one entry beyond capacity must fail rather than eat the spare page',
  );
});
