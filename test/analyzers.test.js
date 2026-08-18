// @ts-check
/**
 * Format detection over every region three real devices produced.
 *
 * The point of these is coverage across formats rather than depth within one:
 * each parser has its own suite. What is checked here is that a region is
 * recognised as what it is, and — just as important — that nothing else claims
 * it. A filesystem misidentified as another filesystem still produces a file
 * list, so a false positive is not obviously wrong when you look at it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { analyzeBinary, detectFormat } from '../src/core.js';

const CHIPS = ['esp32', 'esp32s3', 'esp32p4'];

/** Region file, the subtype its partition declares, and the format expected. */
const REGIONS = [
  { file: 'nvs.bin', subtype: 'nvs', type: 'nvs' },
  { file: 'spiffs.bin', subtype: 'spiffs', type: 'spiffs' },
  { file: 'littlefs.bin', subtype: 'littlefs', type: 'littlefs' },
  { file: 'ffat.bin', subtype: 'fat', type: 'fat' },
  { file: 'partition-table.bin', subtype: null, type: 'partition-table' },
  { file: 'otadata.bin', subtype: 'ota', type: 'otadata' },
  { file: 'bootarea.bin', subtype: null, type: 'esp-image' },
];

/** @param {string} chip @param {string} file */
function region(chip, file) {
  const path = new URL(`./fixtures/hardware/${chip}/${file}`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

for (const chip of CHIPS) {
  test(`${chip}: every region is identified from its bytes alone`, (t) => {
    if (!region(chip, 'nvs.bin')) return t.skip(`no captured fixture for ${chip}`);

    for (const { file, type } of REGIONS) {
      const data = region(chip, file);
      assert.ok(data, `${file} should exist`);
      const candidates = detectFormat(data, {});
      assert.ok(candidates.length > 0, `${file}: nothing recognised it`);
      assert.equal(candidates[0].id, type, `${file}: best match`);
    }
  });

  test(`${chip}: no region is claimed by a second format`, (t) => {
    if (!region(chip, 'nvs.bin')) return t.skip(`no captured fixture for ${chip}`);

    for (const { file, type } of REGIONS) {
      const data = region(chip, file);
      assert.ok(data);
      const others = detectFormat(data, {}).filter((c) => c.id !== type);
      assert.deepEqual(
        others.map((c) => c.id),
        [],
        `${file} was also claimed by ${others.map((c) => c.id).join(', ')}`,
      );
    }
  });

  test(`${chip}: the partition subtype raises confidence without changing the answer`, (t) => {
    if (!region(chip, 'nvs.bin')) return t.skip(`no captured fixture for ${chip}`);

    for (const { file, subtype, type } of REGIONS) {
      if (!subtype) continue;
      const data = region(chip, file);
      assert.ok(data);
      const blind = analyzeBinary(data, {});
      const hinted = analyzeBinary(data, { partition: /** @type {any} */ ({ subtypeName: subtype }) });
      assert.equal(hinted.type, type, `${file} with hint`);
      assert.equal(blind.type, type, `${file} without hint`);
      assert.ok(
        hinted.confidence >= blind.confidence,
        `${file}: a hint should never lower confidence`,
      );
    }
  });
}

test('each filesystem analyzer reports the files it found', (t) => {
  const data = region('esp32s3', 'littlefs.bin');
  if (!data) return t.skip('no captured fixture');

  const result = analyzeBinary(data, {});
  assert.equal(result.type, 'littlefs');
  assert.equal(result.metadata.files, 4, 'four files and one directory');
  assert.equal(result.metadata.directories, 1);
  assert.ok(result.regions.some((r) => r.label === '/big.bin'));
});

test('NVS is analysed rather than reported as unimplemented', (t) => {
  const data = region('esp32p4', 'nvs.bin');
  if (!data) return t.skip('no captured fixture');

  // NVS had a parser long before it had an analyzer, so the inspector kept
  // saying the format was not implemented while the library could read it.
  const result = analyzeBinary(data, { partition: /** @type {any} */ ({ subtypeName: 'nvs' }) });
  assert.equal(result.type, 'nvs');
  assert.equal(result.metadata.namespaces, 3);
  assert.equal(result.metadata.erasedEntries, 2);
  assert.ok(!result.issues.some((i) => i.code === 'analyze.notImplemented'));
});

test('an erased partition falls through to raw, whatever its subtype says', () => {
  const erased = new Uint8Array(64 * 1024).fill(0xff);
  for (const subtype of ['nvs', 'spiffs', 'littlefs', 'fat']) {
    const result = analyzeBinary(erased, { partition: /** @type {any} */ ({ subtypeName: subtype }) });
    assert.equal(result.metadata.contents ?? 'parsed', 'erased', `${subtype} on erased flash`);
  }
});
