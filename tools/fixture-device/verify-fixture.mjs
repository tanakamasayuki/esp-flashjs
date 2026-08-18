// @ts-check
/**
 * Checks that a captured fixture actually came from a provisioned device.
 *
 * Two kinds of check live here, and the difference matters:
 *
 *   - **Byte-level checks** do not use this project's parsers at all. They are
 *     the ones that can fail honestly, because a wrong constant in our code
 *     cannot make them pass.
 *   - **Parser output** is printed for information only, and never decides the
 *     exit code. A fixture is not "bad" because we cannot read it yet — that is
 *     what the fixture is for.
 *
 * Usage: node verify-fixture.mjs <fixture-dir> <partitions.csv>
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, csvPath] = process.argv;
if (!dir) {
  console.error('usage: node verify-fixture.mjs <fixture-dir> [partitions.csv]');
  process.exit(2);
}

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const notes = [];

/**
 * @param {Uint8Array} data
 * @param {number} value
 * @returns {boolean}
 */
const isUniform = (data, value) => data.every((b) => b === value);

/**
 * @param {string} name
 * @returns {Promise<Uint8Array|null>}
 */
async function load(name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  return new Uint8Array(await readFile(path));
}

console.log(`fixture: ${dir}\n`);

const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.bin')) : [];
if (files.length === 0) problems.push('no .bin files were captured');

/* -------------------------------------------------------------------------- */
/* Byte-level checks                                                           */
/* -------------------------------------------------------------------------- */

const table = await load('partition-table.bin');
if (!table) {
  problems.push('partition-table.bin is missing');
} else if (table[0] !== 0xaa || table[1] !== 0x50) {
  problems.push(
    `partition table does not start with the magic bytes AA 50 ` +
      `(found ${table[0].toString(16)} ${table[1].toString(16)})`,
  );
} else {
  console.log('ok    partition table starts with AA 50');

  // Compare the labels on the device against the CSV we asked for. A mismatch
  // means the custom partition scheme did not take, which is easy to miss.
  if (csvPath && existsSync(csvPath)) {
    const wanted = (await readFile(csvPath, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',')[0].trim());

    /** @type {string[]} */
    const found = [];
    for (let off = 0; off + 32 <= table.length; off += 32) {
      if (table[off] !== 0xaa || table[off + 1] !== 0x50) break;
      const label = new TextDecoder()
        .decode(table.subarray(off + 12, off + 28))
        .replace(/\0.*$/, '');
      found.push(label);
    }

    if (found.join(',') === wanted.join(',')) {
      console.log(`ok    layout matches partitions.csv (${found.join(', ')})`);
    } else {
      problems.push(
        `the device layout does not match partitions.csv\n` +
          `        wanted: ${wanted.join(', ')}\n` +
          `        found:  ${found.join(', ')}\n` +
          `        the custom partition scheme probably did not apply`,
      );
    }
  }
}

/** Regions that must contain something for the fixture to be useful. */
const mustHaveData = ['nvs', 'app0', 'bootarea'];
/** Regions that are allowed to be blank, with a note explaining why. */
const mayBeBlank = { app1: 'unwritten second OTA slot, which is the point' };

for (const name of files) {
  const data = await load(name);
  if (!data) continue;
  const stem = name.replace(/\.bin$/, '');
  const blank = isUniform(data, 0xff);
  const zero = isUniform(data, 0x00);
  const state = blank ? 'erased' : zero ? 'all zero' : 'data';

  console.log(`      ${stem.padEnd(16)} ${String(data.length).padStart(8)} bytes  ${state}`);

  if ((blank || zero) && mustHaveData.includes(stem)) {
    problems.push(`${stem}.bin is ${state} — the sketch does not appear to have run`);
  } else if (blank && stem in mayBeBlank) {
    notes.push(`${stem}.bin is erased: ${mayBeBlank[/** @type {keyof typeof mayBeBlank} */ (stem)]}`);
  }
}

/* -------------------------------------------------------------------------- */
/* What our parsers make of it — informational only                            */
/* -------------------------------------------------------------------------- */

console.log('\nparsed by esp-flashjs (informational, does not affect the result):');

try {
  const { parsePartitionTable } = await import('../../src/format/partition.js');
  const { parseOtaData } = await import('../../src/format/otadata.js');
  const { parseNvs } = await import('../../src/format/nvs/parse.js');

  if (table) {
    try {
      const parsed = parsePartitionTable(table);
      console.log(
        `      partition table: ${parsed.partitions.length} entries, md5 ${parsed.md5Valid ? 'valid' : 'MISMATCH'}`,
      );
    } catch (error) {
      console.log(`      partition table: NOT PARSED (${/** @type {Error} */ (error).message})`);
    }
  }

  const otadata = await load('otadata.bin');
  if (otadata) {
    const ota = parseOtaData(otadata);
    console.log(
      `      otadata: active sector ${ota.activeSector ?? 'none'}, ` +
        `seq ${ota.sectors.map((s) => (s.empty ? '-' : s.seq)).join('/')}` +
        (ota.issues.length ? `, issues: ${ota.issues.map((i) => i.code).join(', ')}` : ''),
    );
  }

  const nvs = await load('nvs.bin');
  if (nvs) {
    const store = parseNvs(nvs);
    console.log(
      `      nvs: ${store.entries.length} entries in ${store.namespaces.length} namespaces ` +
        `(${store.namespaces.join(', ')})` +
        (store.issues.length ? `, issues: ${store.issues.map((i) => i.code).join(', ')}` : ''),
    );
  }
} catch (error) {
  console.log(`      (parsers unavailable: ${/** @type {Error} */ (error).message})`);
}

/* -------------------------------------------------------------------------- */
/* Is each filesystem image the filesystem it claims to be?                     */
/* -------------------------------------------------------------------------- */

// Not paranoia. The first run of this fixture produced a spiffs.bin that was
// actually a LittleFS image and a littlefs.bin that was blank, because
// arduino-esp32's LittleFS defaults its partition label to "spiffs" — so it
// formatted over what SPIFFS had just written, and never touched the partition
// named after it. Both files looked entirely plausible: one full of data, one
// erased, sizes correct, layout matching the CSV. Only the bytes gave it away.

/** @param {Uint8Array} data @param {string} text */
function containsText(data, text) {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The 8.3 form FAT stores a short name in: upper case, space-padded, no dot.
 * These names all fit, so no long-name entries are written and searching for
 * "hello.txt" in a FAT image finds nothing.
 *
 * @param {string} name
 * @returns {string}
 */
function shortName(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot === -1 ? name : name.slice(0, dot)).toUpperCase();
  const ext = (dot === -1 ? '' : name.slice(dot + 1)).toUpperCase();
  return base.padEnd(8, ' ') + ext.padEnd(3, ' ');
}

/** The tree the sketch writes to every filesystem. */
const FS_FILES = ['hello.txt', 'big.bin', 'nested.txt', 'empty.txt'];

const LITTLEFS_SUPERBLOCK_AT = 8;

for (const name of ['spiffs', 'littlefs', 'ffat']) {
  const data = await load(`${name}.bin`);
  if (!data) continue;
  if (isUniform(data, 0xff)) {
    problems.push(`${name}.bin is erased — that filesystem was never mounted or written`);
    continue;
  }

  const looksLikeLittlefs = containsText(
    data.subarray(LITTLEFS_SUPERBLOCK_AT, LITTLEFS_SUPERBLOCK_AT + 8),
    'littlefs',
  );

  if (name === 'littlefs' && !looksLikeLittlefs) {
    problems.push('littlefs.bin has no LittleFS superblock');
  }
  if (name === 'spiffs' && looksLikeLittlefs) {
    problems.push(
      'spiffs.bin holds a LittleFS image — a filesystem was mounted without ' +
        'naming its partition, so it formatted over the wrong one',
    );
  }
  if (name === 'ffat' && !(data[510] === 0x55 && data[511] === 0xaa)) {
    problems.push('ffat.bin has no 0x55AA boot-sector signature');
  }

  const missing = FS_FILES.filter(
    (f) => !containsText(data, f) && !containsText(data, shortName(f)),
  );
  if (missing.length > 0) {
    problems.push(`${name}.bin is missing ${missing.join(', ')} — the tree was not written`);
  }
}

/* -------------------------------------------------------------------------- */
/* Does the NVS hold what the sketch writes?                                    */
/* -------------------------------------------------------------------------- */

// Structure is not enough. An ESP32 once passed every check above — valid
// partition table, correct region sizes, no parse issues — while its NVS held
// 95 of 150 keys with two thirds of its entries erased, because esptool reset
// the chip between chunks and the running sketch rewrote NVS underneath the
// capture. Checking the shape missed it entirely. Checking the contents is the
// only thing that catches a device that was busy while being read.
//
// The expected values come from the sketch itself rather than being repeated
// here, so the two cannot drift apart.
try {
  const sketch = await readFile(
    new URL('./fixture_device/fixture_device.ino', import.meta.url),
    'utf8',
  );
  const constant = (name) => {
    const m = sketch.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const manyKeys = constant('MANY_KEYS');
  const bigBlob = constant('BIG_BLOB');
  const smallBlob = constant('SMALL_BLOB');

  const nvs = await load('nvs.bin');
  if (nvs && manyKeys && bigBlob && smallBlob) {
    const { parseNvs } = await import('../../src/format/nvs/parse.js');
    const store = parseNvs(nvs);
    const byNs = {};
    for (const e of store.entries) (byNs[e.namespace] ??= new Map()).set(e.key, e);
    const sizeOf = (v) => (v instanceof Uint8Array ? v.length : undefined);

    for (const ns of ['types', 'blobs', 'many']) {
      if (!byNs[ns]) problems.push(`nvs is missing the "${ns}" namespace`);
    }

    // Every k000..kNNN must be present. A gap means the sketch was interrupted
    // or the partition filled and garbage collection reclaimed entries.
    if (byNs.many) {
      const missing = [];
      for (let i = 0; i < manyKeys; i++) {
        const k = `k${String(i).padStart(3, '0')}`;
        if (!byNs.many.has(k)) missing.push(k);
      }
      if (missing.length > 0) {
        problems.push(
          `nvs "many" is missing ${missing.length} of ${manyKeys} keys ` +
            `(${missing[0]}..${missing[missing.length - 1]}) — the device was ` +
            `rewriting NVS while it was read, or the partition filled up`,
        );
      }
    }

    if (byNs.blobs) {
      const big = sizeOf(byNs.blobs.get('big')?.value);
      const small = sizeOf(byNs.blobs.get('small')?.value);
      if (big !== bigBlob) problems.push(`nvs blobs.big is ${big ?? 'absent'} bytes, expected ${bigBlob}`);
      if (small !== smallBlob) problems.push(`nvs blobs.small is ${small ?? 'absent'} bytes, expected ${smallBlob}`);
      // The overwrite must have taken, and the delete must have removed it.
      if (byNs.blobs.get('rewritten')?.value !== 2) {
        problems.push(`nvs blobs.rewritten is ${byNs.blobs.get('rewritten')?.value ?? 'absent'}, expected 2`);
      }
      if (byNs.blobs.has('deleted')) problems.push('nvs blobs.deleted still exists; it should have been removed');
    }

    // The whole point of writing then overwriting and deleting is that the
    // superseded entries stay behind for the parser to reason about. If they
    // are gone, garbage collection ran and the fixture lost its most
    // interesting case even though everything else still looks right.
    const erased = new Set(store.erasedEntries.map((e) => e.key));
    for (const key of ['rewritten', 'deleted']) {
      if (!erased.has(key)) {
        problems.push(
          `nvs has no erased entry for "${key}" — NVS garbage collection ran, ` +
            `so the overwrite/delete cases this fixture exists to capture are gone`,
        );
      }
    }

    console.log(
      `\ncontent checks: many=${byNs.many?.size ?? 0}/${manyKeys} ` +
        `blobs=${byNs.blobs?.size ?? 0} types=${byNs.types?.size ?? 0} ` +
        `erased=${store.erasedEntries.length}`,
    );
  }
} catch (error) {
  problems.push(`could not check NVS contents: ${/** @type {Error} */ (error).message}`);
}

/* -------------------------------------------------------------------------- */

if (notes.length > 0) {
  console.log('\nnotes:');
  for (const n of notes) console.log(`  - ${n}`);
}

if (problems.length > 0) {
  console.log('\nproblems:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\nThis fixture is not usable as-is. Fix the cause and re-run.');
  process.exit(1);
}

console.log('\nFixture looks good.');
