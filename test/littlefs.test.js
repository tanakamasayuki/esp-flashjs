// @ts-check
/**
 * LittleFS parsing, checked against images three real devices wrote.
 *
 * Every bug found while writing this parser produced the same symptom — a
 * filesystem that mounted as empty — for three unrelated reasons: tags chained
 * against the stored bytes instead of the decoded ones, the forward-CRC tag
 * mistaken for the commit CRC, and a finished checksum fed back in as a
 * running one. None of them looks like a bug from the outside, which is why
 * the fixtures here are bytes this project did not produce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseLittlefs, ctzIndexOf, ctzPointerCount, LFS_TYPE } from '../src/format/fs/littlefs.js';

/** The size the provisioning sketch writes to /big.bin on every filesystem. */
const BIG_FILE = 20000;

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

/** What the provisioning sketch writes. LittleFS keeps the directory itself. */
const EXPECTED = [
  { path: '/big.bin', size: BIG_FILE, directory: false },
  { path: '/empty.txt', size: 0, directory: false },
  { path: '/hello.txt', size: 20, directory: false },
  { path: '/sub', size: 0, directory: true },
  { path: '/sub/nested.txt', size: 7, directory: false },
];

/** @param {string} chip */
function image(chip) {
  const path = new URL(`./fixtures/hardware/${chip}/littlefs.bin`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

for (const chip of CHIPS) {
  test(`${chip}: the whole tree is found, directories included`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseLittlefs(data);
    assert.equal(fs.type, 'littlefs');
    assert.deepEqual(
      fs.files.map((f) => ({ path: f.path, size: f.size, directory: Boolean(f.directory) })),
      EXPECTED,
    );
    assert.deepEqual(fs.issues, []);
  });

  test(`${chip}: geometry comes from the superblock, not from guessing`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseLittlefs(data);
    assert.equal(fs.geometry.blockSize, 4096);
    assert.equal(fs.geometry.blockCount, 80, '80 blocks of 4 KB is the 320 KB partition');
    assert.equal(fs.geometry.blockCount * fs.geometry.blockSize, data.length);
    assert.equal(fs.geometry.nameMax, 255);
  });

  test(`${chip}: contents come back byte for byte`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const byPath = new Map(parseLittlefs(data).files.map((f) => [f.path, f]));

    // Short enough to live inline in the directory metadata.
    assert.equal(
      new TextDecoder().decode(byPath.get('/hello.txt')?.read()),
      'hello from LittleFS\n',
    );
    assert.equal(new TextDecoder().decode(byPath.get('/sub/nested.txt')?.read()), 'nested\n');
    assert.equal(byPath.get('/empty.txt')?.read().length, 0);

    // Too large for inline storage, so it lives in a CTZ skip-list instead.
    const big = byPath.get('/big.bin');
    assert.ok(big);
    const bytes = big.read();
    assert.equal(bytes.length, BIG_FILE);
    for (let i = 0; i < bytes.length; i++) {
      assert.equal(bytes[i], i & 0xff, `byte ${i}`);
    }
    assert.ok(big.complete);
  });
}

test('a nested file is reached through its parent, not by scanning', (t) => {
  const data = image('esp32s3');
  if (!data) return t.skip('no captured fixture');

  // /sub/nested.txt lives in a different metadata pair from the root. Its full
  // path only exists because the walk descended into the directory entry; a
  // parser that scanned for names would report it as "/nested.txt".
  const fs = parseLittlefs(data);
  assert.ok(fs.files.some((f) => f.path === '/sub' && f.directory));
  assert.ok(fs.files.some((f) => f.path === '/sub/nested.txt'));
  assert.ok(!fs.files.some((f) => f.path === '/nested.txt'));
});

test('an erased partition is reported as having no superblock', () => {
  const fs = parseLittlefs(new Uint8Array(64 * 1024).fill(0xff));
  assert.deepEqual(fs.files, []);
  assert.ok(fs.issues.some((i) => i.code === 'littlefs.noSuperblock'));
});

test('a SPIFFS image is not mistaken for LittleFS', (t) => {
  const data = image('esp32s3') && readFileSync(
    new URL('./fixtures/hardware/esp32s3/spiffs.bin', import.meta.url),
  );
  if (!data) return t.skip('no captured fixture');

  const fs = parseLittlefs(new Uint8Array(data));
  assert.deepEqual(fs.files, []);
  assert.ok(fs.issues.some((i) => i.code === 'littlefs.noSuperblock'));
});

test('the CTZ block layout matches LittleFS own arithmetic', () => {
  // The first block of a file carries no skip pointers; later ones carry one
  // per trailing zero in the index, plus one. Getting this wrong shifts the
  // start of every block's data and corrupts long files only.
  assert.equal(ctzPointerCount(0), 0);
  assert.equal(ctzPointerCount(1), 1);
  assert.equal(ctzPointerCount(2), 2);
  assert.equal(ctzPointerCount(3), 1);
  assert.equal(ctzPointerCount(4), 3);

  // A file that fits in one block stays at index 0 however close to the edge.
  assert.equal(ctzIndexOf(0, 4096), 0);
  assert.equal(ctzIndexOf(4095, 4096), 0);
  assert.ok(ctzIndexOf(40960, 4096) > 0);
});

test('tag types are the values LittleFS writes', () => {
  // The forward CRC shares its top three type bits with the commit CRC, and
  // confusing the two ends the log one tag early.
  assert.equal(LFS_TYPE.CCRC, 0x500);
  assert.equal(LFS_TYPE.FCRC, 0x5ff);
  assert.equal(LFS_TYPE.CCRC >>> 8, LFS_TYPE.FCRC >>> 8, 'which is why they are easy to confuse');
});
