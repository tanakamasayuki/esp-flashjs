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
  } else if (blank) {
    notes.push(`${stem}.bin is erased — that filesystem may be unavailable on this chip`);
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
