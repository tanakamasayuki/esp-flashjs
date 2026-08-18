// @ts-check
/**
 * Fixtures transcribed from real hardware.
 *
 * Every other partition fixture in this suite is produced by
 * `buildPartitionTable`, so a parser and a builder that share a wrong constant
 * agree with each other and the round-trip test passes. That is precisely what
 * happened with the entry magic in 0.1.0: it was written and read as a
 * little-endian 0xAA50, while flash actually carries the bytes AA 50, which
 * read back as 0x50AA. Only bytes that came off a device can catch that.
 *
 * These are byte-for-byte literals. Do not regenerate them from our own code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePartitionTable, buildPartitionTable } from '../src/format/partition.js';
import { analyzeBinary } from '../src/format/registry.js';
import { hexToBytes } from '../src/util/hex.js';

/**
 * The first entry as reported by an ESP32 over Web Serial at 0x8000:
 *
 *   aa 50 01 02 00 90 00 00 00 50 00 00 6e 76 73 00
 *   │     │  │  └ offset 0x9000  └ size 0x5000  └ "nvs"
 *   │     │  └ subtype 0x02 (nvs)
 *   │     └ type 0x01 (data)
 *   └ magic bytes AA 50
 */
const REAL_FIRST_ENTRY = 'aa50 0102 00900000 00500000 6e76730000000000000000000000000000000000';

/**
 * A default ESP-IDF layout written out by hand in the on-flash byte order.
 * @returns {Uint8Array}
 */
function realWorldTable() {
  const entries = [
    REAL_FIRST_ENTRY,
    // otadata, data/ota, 0xe000, 0x2000
    'aa50 0100 00e00000 00200000 6f746164617461000000000000000000 00000000',
    // app0, app/ota_0, 0x10000, 0x140000
    'aa50 0010 00000100 00001400 6170703000000000000000000000000000000000',
    // app1, app/ota_1, 0x150000, 0x140000
    'aa50 0011 00001500 00001400 6170703100000000000000000000000000000000',
    // spiffs, data/spiffs, 0x290000, 0x160000
    'aa50 0182 00002900 00001600 7370696666730000000000000000000000000000',
  ].map((hex) => hexToBytes(hex));

  for (const [i, e] of entries.entries()) {
    assert.equal(e.length, 32, `entry ${i} must be 32 bytes`);
  }

  const table = new Uint8Array(0xc00).fill(0xff);
  let offset = 0;
  for (const e of entries) {
    table.set(e, offset);
    offset += e.length;
  }
  return table;
}

test('the magic on flash is the byte sequence AA 50', () => {
  const table = realWorldTable();
  assert.equal(table[0], 0xaa);
  assert.equal(table[1], 0x50);

  // Read as a little-endian u16 that is 0x50AA. Asserting the value spells out
  // the trap rather than leaving it implicit.
  assert.equal(table[0] | (table[1] << 8), 0x50aa);
});

test('a table read from real hardware parses', () => {
  const table = parsePartitionTable(realWorldTable());

  assert.equal(table.partitions.length, 5);
  assert.deepEqual(
    table.partitions.map((p) => [p.label, p.typeName, p.subtypeName, p.offset, p.size]),
    [
      ['nvs', 'data', 'nvs', 0x9000, 0x5000],
      ['otadata', 'data', 'ota', 0xe000, 0x2000],
      ['app0', 'app', 'ota_0', 0x10000, 0x140000],
      ['app1', 'app', 'ota_1', 0x150000, 0x140000],
      ['spiffs', 'data', 'spiffs', 0x290000, 0x160000],
    ],
  );
});

test('rebuilding a real table reproduces the original bytes', () => {
  const original = realWorldTable();
  const rebuilt = buildPartitionTable(parsePartitionTable(original), { md5: false });

  // Compare only the entry area; the original has no MD5 entry.
  const entryBytes = 5 * 32;
  assert.deepEqual(
    [...rebuilt.subarray(0, entryBytes)],
    [...original.subarray(0, entryBytes)],
    'the bytes we emit must match what the device holds',
  );
});

test('the analyzer recognizes a real table', () => {
  const result = analyzeBinary(realWorldTable());
  assert.equal(result.type, 'partition-table');
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.metadata.partitionCount, 5);
});

test('a table with the magic bytes swapped is rejected', () => {
  // 50 AA is what 0.1.0 produced. It must not be accepted, or the bug could
  // come back unnoticed through our own generated files.
  const wrong = realWorldTable();
  wrong[0] = 0x50;
  wrong[1] = 0xaa;
  assert.throws(() => parsePartitionTable(wrong), /magic/i);
});
