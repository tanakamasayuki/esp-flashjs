// @ts-check
/**
 * FAT parsing, checked against images three real devices wrote.
 *
 * The interesting part is not FAT itself but the wear-levelling layer ESP-IDF
 * puts under it. That layer holds one sector spare and skips it, so on a fresh
 * partition the boot sector still lands exactly where a plain FAT reader looks
 * — and nothing else does. Ignoring it parses the BPB perfectly and then reads
 * a file allocation table as if it were the root directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseFat, parseBpb, readFatEntry, wlMapSector } from '../src/format/fs/fat.js';

/** The size the provisioning sketch writes to /big.bin on every filesystem. */
const BIG_FILE = 20000;

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

const EXPECTED = [
  { path: '/big.bin', size: BIG_FILE, directory: false },
  { path: '/empty.txt', size: 0, directory: false },
  { path: '/hello.txt', size: 17, directory: false },
  { path: '/sub', size: 0, directory: true },
  { path: '/sub/nested.txt', size: 7, directory: false },
];

/** @param {string} chip */
function image(chip) {
  const path = new URL(`./fixtures/hardware/${chip}/ffat.bin`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

for (const chip of CHIPS) {
  test(`${chip}: the whole tree is found, directories included`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseFat(data);
    assert.equal(fs.type, 'fat');
    assert.deepEqual(
      fs.files.map((f) => ({ path: f.path, size: f.size, directory: Boolean(f.directory) })),
      EXPECTED,
    );
    assert.deepEqual(fs.issues, []);
  });

  test(`${chip}: the volume is FAT12, by cluster count rather than by guess`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const fs = parseFat(data);
    assert.equal(fs.geometry.bits, 12, 'under 4085 clusters is the definition of FAT12');
    assert.equal(fs.geometry.clusterCount, 197);
    assert.equal(fs.geometry.bytesPerSector, 4096);
  });

  test(`${chip}: contents come back byte for byte`, (t) => {
    const data = image(chip);
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const byPath = new Map(parseFat(data).files.map((f) => [f.path, f]));
    assert.equal(new TextDecoder().decode(byPath.get('/hello.txt')?.read()), 'hello from FatFS\n');
    assert.equal(new TextDecoder().decode(byPath.get('/sub/nested.txt')?.read()), 'nested\n');
    assert.equal(byPath.get('/empty.txt')?.read().length, 0);

    const big = byPath.get('/big.bin');
    assert.ok(big);
    const bytes = big.read();
    assert.equal(bytes.length, BIG_FILE);
    for (let i = 0; i < bytes.length; i++) {
      assert.equal(bytes[i], i & 0xff, `byte ${i}`);
    }
  });
}

test('the wear-levelling spare sector is found rather than assumed absent', (t) => {
  const data = image('esp32s3');
  if (!data) return t.skip('no captured fixture');

  const fs = parseFat(data);
  assert.equal(
    fs.geometry.wlDummySector,
    1,
    'a freshly formatted partition holds physical sector 1 spare',
  );
});

test('ignoring the wear-levelling shift produces confident nonsense', (t) => {
  const data = image('esp32s3');
  if (!data) return t.skip('no captured fixture');

  // This is the failure worth pinning: the BPB is read correctly, no issue is
  // raised, and a single entry appears whose name is bytes of the file
  // allocation table. Nothing about the result says it is wrong.
  const naive = parseFat(data, { wlDummySector: -1 });
  assert.notDeepEqual(
    naive.files.map((f) => f.path),
    EXPECTED.map((f) => f.path),
  );
  assert.ok(
    !naive.files.some((f) => f.path === '/hello.txt'),
    'not one real file survives the wrong mapping',
  );
});

test('the BPB is rejected when it is not one', () => {
  assert.equal(parseBpb(new Uint8Array(4096)), null, 'all zeros has no signature');

  const noise = new Uint8Array(4096).fill(0xab);
  noise[510] = 0x55;
  noise[511] = 0xaa;
  assert.equal(parseBpb(noise), null, 'a stray signature is not enough');
});

test('an erased partition is reported, not parsed', () => {
  const fs = parseFat(new Uint8Array(64 * 1024).fill(0xff));
  assert.deepEqual(fs.files, []);
  assert.ok(fs.issues.some((i) => i.code === 'fat.noBootSector'));
});

test('FAT12 entries are unpacked from their byte and a half', () => {
  // Two entries share three bytes: the even one takes the low twelve bits, the
  // odd one the high twelve. Reading them as whole bytes gives plausible small
  // numbers, so a wrong implementation follows chains that almost work.
  const fat = Uint8Array.from([0xf8, 0xff, 0xff, 0x03, 0x40, 0x00, 0x05, 0xf0, 0xff]);
  assert.equal(readFatEntry(fat, 0, 12), 0xff8);
  assert.equal(readFatEntry(fat, 1, 12), 0xfff);
  assert.equal(readFatEntry(fat, 2, 12), 0x003);
  assert.equal(readFatEntry(fat, 3, 12), 0x004);
  assert.equal(readFatEntry(fat, 4, 12), 0x005);
  assert.equal(readFatEntry(fat, 5, 12), 0xfff);
});

test('the sector map skips the spare and nothing else', () => {
  assert.equal(wlMapSector(0, 1), 0, 'the boot sector stays put, which is what hides the shift');
  assert.equal(wlMapSector(1, 1), 2);
  assert.equal(wlMapSector(3, 1), 4);
  assert.equal(wlMapSector(3, -1), 3, 'no spare, no shift');
});
