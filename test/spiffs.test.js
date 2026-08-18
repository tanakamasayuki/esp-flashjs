// @ts-check
/**
 * SPIFFS parsing, checked against images three real devices wrote.
 *
 * There is no synthetic fixture here on purpose. A SPIFFS image built by this
 * project would encode the same assumptions the parser makes, and both of the
 * bugs found while writing it — a struct laid out as if packed, and page flags
 * read the wrong way round — produced output that looked entirely reasonable:
 * the right four filenames, every file zero bytes long.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseSpiffs, spiffsLookupPages, SPIFFS_FLAG } from '../src/format/fs/spiffs.js';

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

/** What the provisioning sketch writes to every filesystem. */
const EXPECTED = [
  { path: '/big.bin', size: 4096 },
  { path: '/empty.txt', size: 0 },
  { path: '/hello.txt', size: 18 },
  { path: '/sub/nested.txt', size: 7 },
];

/** @param {string} chip */
function image(chip) {
  const path = new URL(`./fixtures/hardware/${chip}/spiffs.bin`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

for (const chip of CHIPS) {
  test(`${chip}: every file the sketch wrote is found, with its real length`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseSpiffs(data);
    assert.equal(fs.type, 'spiffs');
    assert.deepEqual(
      fs.files.map((f) => ({ path: f.path, size: f.size })),
      EXPECTED,
    );
    assert.deepEqual(fs.issues, [], 'a healthy image should raise nothing');
  });

  test(`${chip}: file contents come back byte for byte`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseSpiffs(data);
    const byPath = new Map(fs.files.map((f) => [f.path, f]));

    const hello = byPath.get('/hello.txt');
    assert.ok(hello);
    assert.equal(new TextDecoder().decode(hello.read()), 'hello from SPIFFS\n');

    const nested = byPath.get('/sub/nested.txt');
    assert.ok(nested);
    assert.equal(new TextDecoder().decode(nested.read()), 'nested\n');

    const empty = byPath.get('/empty.txt');
    assert.ok(empty);
    assert.equal(empty.read().length, 0);
  });

  test(`${chip}: a file spanning many pages reassembles in the right order`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const big = parseSpiffs(data).files.find((f) => f.path === '/big.bin');
    assert.ok(big);
    const bytes = big.read();
    assert.equal(bytes.length, 4096);
    assert.ok(
      big.pageIndices.length > 10,
      'a 4 KB file should occupy many 251-byte pages, so ordering matters',
    );
    // The sketch fills it with a position-dependent pattern, so a page landing
    // out of order shows up here rather than passing as plausible data.
    for (let i = 0; i < bytes.length; i++) {
      assert.equal(bytes[i], i & 0xff, `byte ${i}`);
    }
    assert.ok(big.complete);
  });
}

test('a superseded index page does not shadow the current one', (t) => {
  const data = image('esp32s3');
  if (!data) return t.skip('no captured fixture');

  // Every file in these images has two index headers: the one written when it
  // was created, whose size is still undefined, and the one written when it
  // was closed. Preferring the wrong one yields four correctly named files of
  // zero bytes, which is exactly what the first version of this parser did.
  const hello = parseSpiffs(data).files.find((f) => f.path === '/hello.txt');
  assert.ok(hello);
  assert.equal(hello.size, 18, 'the finalised header carries the size');
});

test('a wrong geometry that still finds files is rejected on the evidence', (t) => {
  const data = image('esp32');
  if (!data) return t.skip('no captured fixture');

  // 128-byte pages are wrong for these images, but they are a divisor of the
  // real page size, so the scan still lands on every object index header and
  // reports all four correct filenames. Only the data comes out scrambled.
  // "Did it find any files?" therefore cannot be the detection test.
  const wrong = parseSpiffs(data, { pageSize: 128, blockSize: 4096, detectGeometry: false });
  assert.equal(wrong.files.length, 4, 'the wrong geometry does find the names');
  const wrongBig = wrong.files.find((f) => f.path === '/big.bin');
  assert.ok(wrongBig);
  assert.notDeepEqual(
    Array.from(wrongBig.read().subarray(0, 512)),
    Array.from({ length: 512 }, (_, i) => i & 0xff),
    'but its contents are wrong, which is what makes this dangerous',
  );

  // With detection on, the evidence decides.
  const swept = parseSpiffs(data, { pageSize: 128, blockSize: 4096 });
  assert.equal(swept.geometry.pageSize, 256);
  assert.equal(swept.geometry.blockSize, 4096);
  assert.ok(swept.issues.some((i) => i.code === 'spiffs.geometryDetected'));
  const big = swept.files.find((f) => f.path === '/big.bin');
  assert.ok(big);
  assert.deepEqual(
    Array.from(big.read().subarray(0, 512)),
    Array.from({ length: 512 }, (_, i) => i & 0xff),
  );
});

test('a correct geometry is used as given, without a detection warning', (t) => {
  const data = image('esp32s3');
  if (!data) return t.skip('no captured fixture');
  const fs = parseSpiffs(data, { pageSize: 256, blockSize: 4096 });
  assert.deepEqual(fs.issues, []);
  assert.equal(fs.geometry.pageSize, 256);
});

test('an erased partition parses as empty rather than throwing', () => {
  const fs = parseSpiffs(new Uint8Array(64 * 1024).fill(0xff));
  assert.deepEqual(fs.files, []);
  assert.deepEqual(fs.issues, []);
});

test('an image shorter than one block is reported, not guessed at', () => {
  const fs = parseSpiffs(new Uint8Array(512).fill(0xff), { detectGeometry: false });
  assert.deepEqual(fs.files, []);
  assert.ok(fs.issues.some((i) => i.code === 'spiffs.tooSmall'));
});

test('the lookup table covers only the pages that can hold data', () => {
  // One page of a 4096/256 block is the table itself, so it describes 15
  // pages, and entry i is page i+1. Reading it as page i shifts every entry.
  assert.equal(spiffsLookupPages(256, 4096), 1);
  assert.equal(spiffsLookupPages(256, 8192), 1);
  assert.equal(spiffsLookupPages(128, 4096), 1);
});

test('page flags are active low', () => {
  // 0xf8 is a live index page, 0x78 the same page after deletion, 0xfc a data
  // page. The only difference between the first two is the top bit, so a
  // sign-flipped test silently swaps current data for stale data.
  const live = 0xf8;
  const deleted = 0x78;
  const dataPage = 0xfc;
  assert.equal((live & SPIFFS_FLAG.DELET) !== 0, true, 'live: DELET bit still set');
  assert.equal((deleted & SPIFFS_FLAG.DELET) === 0, true, 'deleted: DELET bit cleared');
  assert.equal((live & SPIFFS_FLAG.INDEX) === 0, true, 'live index page');
  assert.equal((dataPage & SPIFFS_FLAG.INDEX) !== 0, true, 'data page is not an index');
});

test('the lookup page is never mistaken for a data page', () => {
  // Hand-built, because no captured image happens to trigger this: it needs a
  // lookup table whose first bytes read as a plausible page header for a span
  // the file is actually missing. Scanning from page 0 then fills the hole
  // with the lookup table's own bytes and reports the file as complete.
  const PAGE = 256;
  const BLOCK = 4096;
  const HDR = 5;
  const dataPerPage = PAGE - HDR;
  const img = new Uint8Array(BLOCK * 2).fill(0xff);

  /** @param {number} at @param {number} objId @param {number} span @param {number} flags */
  const header = (at, objId, span, flags) => {
    img[at] = objId & 0xff;
    img[at + 1] = objId >> 8;
    img[at + 2] = span & 0xff;
    img[at + 3] = span >> 8;
    img[at + 4] = flags;
  };

  // Page 0 is the lookup table. Its first entries are chosen to read as
  // "object 1, span 1, live data page" if anyone treats it as a page.
  header(0, 0x0001, 1, 0xfc);
  img.fill(0xee, HDR, PAGE); // recognisable filler

  // Page 1: object index header for a two-page file.
  header(PAGE, 0x8001, 0, 0xf8);
  const size = dataPerPage + 10;
  img[PAGE + 8] = size & 0xff;
  img[PAGE + 9] = (size >> 8) & 0xff;
  img[PAGE + 10] = 0;
  img[PAGE + 11] = 0;
  img[PAGE + 12] = 1; // SPIFFS_TYPE_FILE
  img.set(new TextEncoder().encode('/two.bin'), PAGE + 13);
  img[PAGE + 13 + 8] = 0;

  // Page 2: span 0 only. Span 1 is deliberately absent.
  header(2 * PAGE, 0x0001, 0, 0xfc);
  img.fill(0x11, 2 * PAGE + HDR, 3 * PAGE);

  const fs = parseSpiffs(img, { pageSize: PAGE, blockSize: BLOCK, detectGeometry: false });
  const file = fs.files.find((f) => f.path === '/two.bin');
  assert.ok(file, 'the index header should still be found');
  assert.equal(file.complete, false, 'the missing span must stay missing');

  const bytes = file.read();
  assert.equal(bytes.length, size);
  assert.ok(
    bytes.subarray(dataPerPage).every((b) => b === 0),
    'the hole must read as zeros, not as the lookup table',
  );
  assert.ok(
    !bytes.includes(0xee),
    'no byte of the lookup page may end up in a file',
  );
});
