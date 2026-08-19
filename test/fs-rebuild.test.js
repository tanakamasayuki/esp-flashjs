// @ts-check
/**
 * Rebuilding SPIFFS, LittleFS and FAT images.
 *
 * A builder is harder to test honestly than a parser. The obvious test —
 * build, parse, compare — is satisfied by any pair of implementations that are
 * wrong in the same way, and for a filesystem "wrong in the same way" is the
 * normal case, because both halves were written from the same reading of the
 * format. This project has already been caught by exactly that: SPIFFS page
 * flags were read the wrong way round and every test agreed, because the
 * fixtures came from the parser.
 *
 * So each format is pinned by something the round trip cannot fake:
 *
 *   - **SPIFFS** is read back through the *object index*, the way a device
 *     does, rather than by the page sweep the parser uses. The two readers
 *     agree on the captured hardware images, so when they also agree on a
 *     built one, the index tables are right. A test below breaks an index
 *     entry to show the parser cannot see the difference and the index reader
 *     can.
 *   - **LittleFS** is walked the way the block allocator walks it. A metadata
 *     pair that is off the tail chain reads back perfectly and is handed out
 *     as free space by the device on its next write.
 *   - **FAT** is checked to have left the wear-levelling frame byte for byte
 *     as it found it, since that part cannot be regenerated at all.
 *
 * What none of this can establish is that a device mounts the result. That
 * needs hardware, and `tools/hardware-check.mjs` is where it happens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseSpiffs } from '../src/format/fs/spiffs.js';
import { parseLittlefs } from '../src/format/fs/littlefs.js';
import { parseFat } from '../src/format/fs/fat.js';
import { FsStore } from '../src/format/fs/store.js';
import { buildFs, checkFsStore } from '../src/format/fs/build.js';
import { buildSpiffs, readSpiffsViaIndex, spiffsMagic } from '../src/format/fs/spiffs-build.js';
import { buildLittlefs, littlefsTraverse } from '../src/format/fs/littlefs-build.js';
import { buildFat, shortNameChecksum } from '../src/format/fs/fat-build.js';
import { FsCapacityError, FsPathError } from '../src/util/errors.js';

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

/**
 * @param {string} chip
 * @param {string} name
 * @returns {Uint8Array|null}
 */
function fixture(chip, name) {
  const path = new URL(`./fixtures/hardware/${chip}/${name}`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

/**
 * Deterministic filler, so a failure is reproducible and a diff is meaningful.
 *
 * @param {number} length
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
function filler(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/**
 * @param {import('../src/format/fs/types.js').FsImage} image
 * @returns {Array<{path: string, bytes: string}>}
 */
function contents(image) {
  return image.files
    .filter((f) => !f.directory)
    .map((f) => ({ path: f.path, bytes: Buffer.from(f.read()).toString('hex') }));
}

/* SPIFFS ------------------------------------------------------------------ */

for (const chip of CHIPS) {
  test(`${chip}: the two SPIFFS readers agree on bytes the device wrote`, (t) => {
    const data = fixture(chip, 'spiffs.bin');
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    // This is what makes the index reader usable as a check on the builder. It
    // reaches the data by a completely different route — lookup table to index
    // header to page numbers, instead of a sweep — so agreement here is
    // agreement about the format, not about our reading of it.
    const scanned = parseSpiffs(data);
    const indexed = readSpiffsViaIndex(data);

    assert.deepEqual(indexed.issues, [], 'a healthy image should raise nothing');
    assert.deepEqual(contents(indexed), contents(scanned));
  });

  test(`${chip}: a SPIFFS image rebuilds to the same contents`, (t) => {
    const data = fixture(chip, 'spiffs.bin');
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const original = parseSpiffs(data);
    const store = FsStore.from(original);
    const rebuilt = buildSpiffs(store, { size: data.length });

    assert.notDeepEqual(rebuilt, data, 'a rebuild compacts; it is not a copy');
    assert.deepEqual(contents(parseSpiffs(rebuilt)), contents(original));
    assert.deepEqual(contents(readSpiffsViaIndex(rebuilt)), contents(original));
  });
}

test('every block of a rebuilt SPIFFS image carries the magic a device checks', () => {
  const store = new FsStore('spiffs');
  store.write('/a.txt', 'a');
  const size = 64 * 4096;
  const image = buildSpiffs(store, { size, pageSize: 256, blockSize: 4096 });

  // Without this a device does not read the image and get it wrong; it
  // declines to mount and offers to format, which loses everything.
  for (let block = 0; block < 64; block++) {
    const at = block * 4096 + 256 - 4;
    assert.equal(
      image[at] | (image[at + 1] << 8),
      spiffsMagic(256, 64, block),
      `block ${block} must be recognisable`,
    );
    assert.equal(image[at + 2] | (image[at + 3] << 8), 0, 'and carry a zero erase count');
  }
});

test('a SPIFFS file too big for one index page continues into another', () => {
  // 103 page numbers fit after a 32-byte name and its metadata, so anything
  // past about 25 KB needs continuation index pages. Nothing in the captured
  // fixtures is that large, which is why this case is built here.
  const store = new FsStore('spiffs');
  const big = filler(60000, 7);
  store.write('/huge.bin', big);

  const image = buildSpiffs(store, { size: 320 * 1024, pageSize: 256, blockSize: 4096 });
  const viaIndex = readSpiffsViaIndex(image);

  assert.deepEqual(viaIndex.issues, []);
  const file = viaIndex.files.find((f) => f.path === '/huge.bin');
  assert.ok(file);
  assert.equal(file.size, big.length);
  assert.deepEqual(Buffer.from(file.read()), Buffer.from(big));
});

test('a broken index entry is invisible to the parser and fatal to the index reader', () => {
  // The whole reason the self-check does not go through parseSpiffs. An image
  // like this one extracts perfectly in this library and hands a device the
  // wrong page for part of the file.
  const store = new FsStore('spiffs');
  store.write('/x.bin', filler(3000, 3));
  const good = buildSpiffs(store, { size: 64 * 1024, pageSize: 256, blockSize: 4096 });

  const broken = new Uint8Array(good);
  const entry = 1 * 256 + 49 + 3 * 2; // page 1 is the index header; span 3
  broken[entry] = 0x7f;
  broken[entry + 1] = 0x00;

  assert.deepEqual(parseSpiffs(broken).issues, [], 'the sweep never looks at the index');
  const indexed = readSpiffsViaIndex(broken);
  assert.ok(
    indexed.issues.some((issue) => issue.code === 'spiffs.indexMismatch'),
    'and this is what catches it',
  );
});

test('SPIFFS refuses a path it cannot name rather than truncating it', () => {
  const store = new FsStore('spiffs');
  store.write('/a-directory-with-a-long-name/and-a-file.txt', 'x');
  assert.throws(() => buildSpiffs(store, { size: 64 * 1024 }), FsPathError);
});

test('SPIFFS reports how many pages it needed, not where it gave up', () => {
  const store = new FsStore('spiffs');
  store.write('/x.bin', filler(60000, 5));

  assert.throws(
    () => buildSpiffs(store, { size: 16 * 1024, pageSize: 256, blockSize: 4096 }),
    (error) => {
      assert.ok(error instanceof FsCapacityError);
      assert.equal(error.details.unit, 'page');
      assert.ok(error.details.required > 239, 'the whole file, not the part that fitted');
      return true;
    },
  );
});

/* LittleFS ---------------------------------------------------------------- */

for (const chip of CHIPS) {
  test(`${chip}: the tail chain of a captured LittleFS image is walkable`, (t) => {
    const data = fixture(chip, 'littlefs.bin');
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const image = parseLittlefs(data);
    const walk = littlefsTraverse(data, { blockSize: image.geometry.blockSize });

    assert.deepEqual(walk.issues, []);
    assert.ok(walk.pairs.length >= 2, 'the root and the /sub directory at least');
    assert.deepEqual(walk.pairs[0], [0, 1], 'the chain starts where the device starts');
  });

  test(`${chip}: a LittleFS image rebuilds to the same contents`, (t) => {
    const data = fixture(chip, 'littlefs.bin');
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const original = parseLittlefs(data);
    const store = FsStore.from(original);
    const rebuilt = buildLittlefs(store, { size: data.length });
    const back = parseLittlefs(rebuilt);

    assert.deepEqual(contents(back), contents(original));
    assert.deepEqual(
      back.files.filter((f) => f.directory).map((f) => f.path),
      original.files.filter((f) => f.directory).map((f) => f.path),
    );
    assert.equal(back.geometry.blockSize, original.geometry.blockSize);
    assert.equal(back.geometry.blockCount, original.geometry.blockCount);
    assert.equal(back.geometry.version, original.geometry.version);
  });
}

test('a directory too big for one metadata pair continues in the next', () => {
  const store = new FsStore('littlefs');
  const expected = new Map();
  for (let i = 0; i < 120; i++) {
    const path = `/f${String(i).padStart(3, '0')}.txt`;
    const body = `content number ${i}\n`;
    expected.set(path, body);
    store.write(path, body);
  }

  const image = buildLittlefs(store, { size: 80 * 4096, blockSize: 4096 });
  const back = parseLittlefs(image);

  assert.deepEqual(back.issues, []);
  assert.equal(back.files.length, 120);
  for (const file of back.files) {
    assert.equal(new TextDecoder().decode(file.read()), expected.get(file.path));
  }

  const walk = littlefsTraverse(image, { blockSize: 4096 });
  assert.ok(walk.pairs.length > 1, 'which means the directory really did split');
});

test('every metadata pair of a rebuilt image is on the tail chain', () => {
  // A pair that is not on the chain reads back perfectly here and is treated
  // as free space by the device, which overwrites it on the next write. The
  // parser cannot see this, because it follows hard tails and ignores soft
  // ones.
  const store = new FsStore('littlefs');
  store.write('/a/b/c/deep.bin', filler(30000, 11));
  store.write('/a/b/c/small.txt', 'hi');
  store.mkdir('/a/empty');

  const image = buildLittlefs(store, { size: 80 * 4096, blockSize: 4096 });
  const walk = littlefsTraverse(image, { blockSize: 4096 });

  assert.deepEqual(walk.issues, []);
  // Root, /a, /a/b, /a/b/c and /a/empty.
  assert.equal(walk.pairs.length, 5);

  const back = parseLittlefs(image);
  assert.deepEqual(
    back.files.map((f) => f.path),
    ['/a', '/a/b', '/a/b/c', '/a/b/c/deep.bin', '/a/b/c/small.txt', '/a/empty'],
  );
  assert.deepEqual(
    Buffer.from(/** @type {any} */ (back.files.find((f) => f.path === '/a/b/c/deep.bin')).read()),
    Buffer.from(filler(30000, 11)),
  );
});

test('LittleFS reports a shortfall in blocks, which is the unit that ran out', () => {
  const store = new FsStore('littlefs');
  for (let i = 0; i < 50; i++) store.write(`/big${i}.bin`, filler(9000, i + 1));

  assert.throws(
    () => buildLittlefs(store, { size: 16 * 4096, blockSize: 4096 }),
    (error) => {
      assert.ok(error instanceof FsCapacityError);
      assert.equal(error.details.unit, 'block');
      assert.equal(error.details.available, 16);
      return true;
    },
  );
});

/* FAT --------------------------------------------------------------------- */

for (const chip of CHIPS) {
  test(`${chip}: a FAT image rebuilds without disturbing the wear-levelling frame`, (t) => {
    const data = fixture(chip, 'ffat.bin');
    if (!data) return t.skip(`no captured fixture for ${chip}`);

    const original = parseFat(data);
    const store = FsStore.from(original);
    const rebuilt = buildFat(store, { source: data });

    assert.deepEqual(contents(parseFat(rebuilt)), contents(original));

    // The last three sectors hold the layer's state, its configuration and a
    // device id it chose at random. None of that can be recomputed; carrying
    // it over is the only correct thing to do with it.
    const sector = original.geometry.bytesPerSector;
    const tail = data.length - 3 * sector;
    assert.deepEqual(Buffer.from(rebuilt.subarray(tail)), Buffer.from(data.subarray(tail)));
    assert.deepEqual(Buffer.from(rebuilt.subarray(0, sector)), Buffer.from(data.subarray(0, sector)));
  });
}

test('FAT stores a name that does not fit 8.3 as long-name entries', (t) => {
  const source = fixture('esp32', 'ffat.bin');
  if (!source) return t.skip('no captured fixture');

  const store = FsStore.from(parseFat(source));
  store.write('/a very long file name with spaces.txt', 'long\n');
  store.write('/日本語のファイル.txt', 'japanese\n');

  const image = buildFat(store, { source });
  const back = parseFat(image);

  assert.deepEqual(back.issues, []);
  const paths = back.files.map((f) => f.path);
  assert.ok(paths.includes('/a very long file name with spaces.txt'));
  assert.ok(paths.includes('/日本語のファイル.txt'));
});

test('a lower-case 8.3 name needs no long-name entries at all', () => {
  // Two bits in the entry say which half of the name was lower case. That is
  // how the reference boards store `hello.txt`, and matching it keeps a
  // rebuilt directory the same size as the one it replaces.
  const source = fixture('esp32', 'ffat.bin');
  if (!source) return;

  const store = new FsStore('fat');
  store.write('/hello.txt', 'hi\n');
  const image = buildFat(store, { source });

  const rootStart = 4 * 4096; // logical sector 3 through the spare at 1
  assert.equal(image[rootStart + 11] & 0x3f, 0x20, 'a plain archive entry, not a name piece');
  assert.equal(image[rootStart + 12], 0x08 | 0x10, 'both halves were lower case');
  assert.equal(
    Buffer.from(image.subarray(rootStart, rootStart + 11)).toString('latin1'),
    'HELLO   TXT',
  );
});

test('the long-name checksum is the one the specification defines', () => {
  // Written out longhand so the test cannot agree with a mistake in the
  // implementation. An entry whose checksum does not match its short name is
  // an orphan, and the short name shows up instead of the long one.
  /** @param {string} text */
  const longhand = (text) => {
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      sum = (((sum & 1) << 7) + (sum >> 1) + text.charCodeAt(i)) & 0xff;
    }
    return sum;
  };
  for (const name of ['HELLO   TXT', 'A~1     BIN', '日本語     ~1 ']) {
    const bytes = Uint8Array.from({ length: 11 }, (_, i) => name.charCodeAt(i) & 0xff);
    assert.equal(shortNameChecksum(bytes), longhand(name));
  }
});

test('FAT reports a shortfall in clusters', (t) => {
  const source = fixture('esp32', 'ffat.bin');
  if (!source) return t.skip('no captured fixture');

  const store = FsStore.from(parseFat(source));
  for (let i = 0; i < 80; i++) store.write(`/fill${i}.bin`, filler(20000, i + 1));

  assert.throws(
    () => buildFat(store, { source }),
    (error) => {
      assert.ok(error instanceof FsCapacityError);
      assert.equal(error.details.unit, 'cluster');
      return true;
    },
  );
});

/**
 * An empty FAT32 volume, built from the specification rather than captured.
 *
 * There is no FAT32 fixture and there cannot easily be one: the format begins
 * at 65525 clusters, which is 32 MB at the smallest sector size, and no ESP
 * partition here is that large. So the whole 32-bit path — four-byte table
 * entries, a root directory that lives in a cluster instead of a fixed run of
 * sectors, and the FSInfo cache — would otherwise never run at all.
 *
 * @returns {Uint8Array}
 */
function emptyFat32() {
  const bytesPerSector = 512;
  const sectorsPerCluster = 1;
  const reserved = 32;
  const numFats = 2;
  const clusterCount = 65600; // just past the threshold that defines FAT32
  const fatSize = Math.ceil(((clusterCount + 2) * 4) / bytesPerSector);
  const total = reserved + numFats * fatSize + clusterCount * sectorsPerCluster;

  const out = new Uint8Array(total * bytesPerSector);
  /** @param {number} at @param {number} value */
  const w16 = (at, value) => {
    out[at] = value & 0xff;
    out[at + 1] = (value >> 8) & 0xff;
  };
  /** @param {number} at @param {number} value */
  const w32 = (at, value) => {
    out[at] = value & 0xff;
    out[at + 1] = (value >>> 8) & 0xff;
    out[at + 2] = (value >>> 16) & 0xff;
    out[at + 3] = (value >>> 24) & 0xff;
  };

  w16(11, bytesPerSector);
  out[13] = sectorsPerCluster;
  w16(14, reserved);
  out[16] = numFats;
  w32(32, total);
  w32(36, fatSize);
  w32(44, 2); // root cluster
  w16(48, 1); // FSInfo sector
  out[510] = 0x55;
  out[511] = 0xaa;

  const fsInfo = bytesPerSector;
  w32(fsInfo, 0x41615252);
  w32(fsInfo + 484, 0x61417272);
  w32(fsInfo + 488, 12345); // a free-cluster count about to become a lie
  w32(fsInfo + 492, 7);
  w32(fsInfo + 508, 0xaa550000);
  return out;
}

test('FAT32 is written with four-byte table entries and a clustered root', () => {
  const source = emptyFat32();
  const store = new FsStore('fat');
  store.write('/hello.txt', 'hi from fat32\n');
  store.write('/dir/nested.bin', filler(5000, 31));
  store.write('/a long fat32 name.dat', 'lfn\n');

  const image = buildFat(store, { source });
  const back = parseFat(image, { wlDummySector: -1 });

  assert.equal(back.geometry.bits, 32);
  assert.deepEqual(back.issues, []);
  assert.deepEqual(
    back.files.map((f) => f.path),
    ['/a long fat32 name.dat', '/dir', '/dir/nested.bin', '/hello.txt'],
  );
  assert.deepEqual(
    Buffer.from(/** @type {any} */ (back.files.find((f) => f.path === '/dir/nested.bin')).read()),
    Buffer.from(filler(5000, 31)),
  );

  // The boot sector is carried over, so the root has to go where it already
  // says the root is rather than wherever the allocator would have put it.
  const rootCluster = image[44] | (image[45] << 8) | (image[46] << 16) | (image[47] << 24);
  assert.equal(rootCluster, 2);

  // FSInfo caches a free-cluster count and sits among the reserved sectors a
  // rebuild does not touch, so it would otherwise survive describing the
  // filesystem that used to be here.
  const fsInfo = 512;
  assert.equal(
    Buffer.from(image.subarray(fsInfo + 488, fsInfo + 496)).toString('hex'),
    'ffffffffffffffff',
    'both counts must read as unknown, which forces a recount on mount',
  );
});

test('buildFat says what it needs instead of inventing it', () => {
  const store = new FsStore('fat');
  store.write('/a.txt', 'a');
  assert.throws(() => buildFat(store, /** @type {any} */ ({})), /wear-levelling state/);
});

/* Editing and dispatch ---------------------------------------------------- */

for (const [format, file, parse] of /** @type {const} */ ([
  ['spiffs', 'spiffs.bin', parseSpiffs],
  ['littlefs', 'littlefs.bin', parseLittlefs],
  ['fat', 'ffat.bin', parseFat],
])) {
  test(`${format}: add, replace and delete survive a rebuild`, (t) => {
    const source = fixture('esp32', file);
    if (!source) return t.skip('no captured fixture');

    const store = FsStore.from(parse(source));
    store.write('/hello.txt', 'replaced\n');
    store.write('/added.bin', filler(5000, 21));
    store.delete('/big.bin');

    const rebuilt = buildFs(store, { size: source.length, source });
    const back = parse(rebuilt);
    const byPath = new Map(back.files.map((f) => [f.path, f]));

    assert.equal(new TextDecoder().decode(/** @type {any} */ (byPath.get('/hello.txt')).read()), 'replaced\n');
    assert.deepEqual(
      Buffer.from(/** @type {any} */ (byPath.get('/added.bin')).read()),
      Buffer.from(filler(5000, 21)),
    );
    assert.equal(byPath.has('/big.bin'), false);
  });
}

test('a rebuild of an untouched store changes nothing that can be read back', (t) => {
  const source = fixture('esp32', 'spiffs.bin');
  if (!source) return t.skip('no captured fixture');

  const original = parseSpiffs(source);
  let image = source;
  // Twice, because a builder that loses something on each pass would still
  // look right after one.
  for (let round = 0; round < 2; round++) {
    image = buildSpiffs(FsStore.from(parseSpiffs(image)), { size: source.length });
  }
  assert.deepEqual(contents(parseSpiffs(image)), contents(original));
});

/* Representability -------------------------------------------------------- */

test('checkFsStore names what a format cannot hold, before anything is written', () => {
  const store = new FsStore('spiffs');
  store.write('/logs/a.txt', 'a');
  store.mkdir('/empty-one');

  const issues = checkFsStore(store, 'spiffs');
  const codes = issues.map((i) => i.code);
  assert.ok(
    codes.includes('fs.spiffsNoDirectories'),
    'an empty directory has nothing to survive as in a flat namespace',
  );
  assert.equal(
    issues.find((i) => i.code === 'fs.spiffsNoDirectories')?.params.paths,
    '/empty-one',
    'and /logs is not listed, because its file keeps the prefix alive',
  );
});

test('checkFsStore warns that rebuilding freezes a partly recovered file', () => {
  const store = FsStore.from({
    type: 'littlefs',
    geometry: {},
    issues: [],
    files: [
      { path: '/torn.bin', size: 8, read: () => new Uint8Array(8), pageIndices: [], complete: false },
    ],
  });

  const issues = checkFsStore(store);
  assert.ok(issues.some((i) => i.code === 'fs.rebuildIncomplete'));
});

test('checkFsStore rejects names FAT has no way to record', () => {
  const store = new FsStore('fat');
  store.write('/what?.txt', 'x');
  assert.ok(checkFsStore(store).some((i) => i.code === 'fs.fatIllegalName' && i.level === 'error'));
});
