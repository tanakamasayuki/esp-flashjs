// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePartitionTable,
  buildPartitionTable,
  validatePartitionTable,
  findUnallocatedRegions,
  describeFlashLayout,
  findPartitionAt,
  PARTITION_TABLE_SIZE,
  PARTITION_TYPE,
  MAX_PARTITIONS,
} from '../src/format/partition.js';
import { parseEspImage, verifyImageHash } from '../src/format/image.js';
import { parseOtaData } from '../src/format/otadata.js';
import { analyzeBinary, detectFormat, analyzeBinaryAs } from '../src/format/registry.js';
import { InvalidMagicError } from '../src/util/errors.js';
import {
  espImageBytes,
  otaDataBytes,
  otaPartitions,
  part,
  partitionTableBytes,
  pathologicalInputs,
  singleAppPartitions,
} from './helpers.js';

/* -------------------------------------------------------------------------- */
/* Partition table                                                             */
/* -------------------------------------------------------------------------- */

test('partition table parses a conventional layout', () => {
  const table = parsePartitionTable(partitionTableBytes());
  assert.equal(table.partitions.length, 4);
  assert.equal(table.hasMd5, true);
  assert.equal(table.md5Valid, true);

  const nvs = table.partitions[0];
  assert.equal(nvs.label, 'nvs');
  assert.equal(nvs.offset, 0x9000);
  assert.equal(nvs.size, 0x6000);
  assert.equal(nvs.typeName, 'data');
  assert.equal(nvs.subtypeName, 'nvs');
  assert.equal(nvs.encrypted, false);
});

test('partition table round-trips byte for byte', () => {
  const original = partitionTableBytes(otaPartitions());
  const parsed = parsePartitionTable(original);
  const rebuilt = buildPartitionTable(parsed);
  assert.equal(rebuilt.length, PARTITION_TABLE_SIZE);
  assert.deepEqual([...rebuilt], [...original]);
});

test('partition table round-trips through repeated parse and build', () => {
  let bytes = partitionTableBytes();
  for (let i = 0; i < 3; i++) {
    bytes = buildPartitionTable(parsePartitionTable(bytes));
  }
  assert.deepEqual([...bytes], [...partitionTableBytes()]);
});

test('partition table detects a corrupted MD5', () => {
  const bytes = partitionTableBytes();
  const md5EntryStart = 4 * 32;
  bytes[md5EntryStart + 16] ^= 0xff;

  const table = parsePartitionTable(bytes);
  assert.equal(table.hasMd5, true);
  assert.equal(table.md5Valid, false);
  assert.ok(table.issues.some((i) => i.code === 'partition.md5Mismatch'));
});

test('partition table tolerates a missing MD5 entry', () => {
  const bytes = buildPartitionTable(singleAppPartitions(), { md5: false });
  const table = parsePartitionTable(bytes);
  assert.equal(table.hasMd5, false);
  assert.equal(table.md5Valid, true);
  assert.equal(table.partitions.length, 4);
});

test('partition table rejects data that is not a partition table', () => {
  for (const [name, data] of Object.entries(pathologicalInputs())) {
    assert.throws(() => parsePartitionTable(data), InvalidMagicError, name);
  }
});

test('partition table holds the maximum number of entries', () => {
  const many = Array.from({ length: MAX_PARTITIONS }, (_, i) =>
    part(`p${i}`, PARTITION_TYPE.DATA, 0x02, 0x10000 + i * 0x1000, 0x1000),
  );
  const bytes = buildPartitionTable(many, { md5: false });
  assert.equal(parsePartitionTable(bytes).partitions.length, MAX_PARTITIONS);
  assert.throws(() => buildPartitionTable([...many, part('x', 1, 2, 0, 0x1000)]));
});

test('validation finds overlapping partitions', () => {
  const issues = validatePartitionTable([
    part('a', PARTITION_TYPE.DATA, 0x02, 0x9000, 0x6000),
    part('b', PARTITION_TYPE.DATA, 0x02, 0xa000, 0x1000),
  ]);
  assert.ok(issues.some((i) => i.code === 'partition.overlap' && i.level === 'error'));
});

test('validation finds partitions past the end of flash', () => {
  const issues = validatePartitionTable(singleAppPartitions(), { flashSize: 0x100000 });
  assert.ok(issues.some((i) => i.code === 'partition.exceedsFlash'));
});

test('validation enforces 64 KB alignment for app partitions', () => {
  const issues = validatePartitionTable([part('app', PARTITION_TYPE.APP, 0x00, 0x11000, 0x10000)]);
  assert.ok(issues.some((i) => i.code === 'partition.appAlignment'));

  const ok = validatePartitionTable([part('app', PARTITION_TYPE.APP, 0x00, 0x10000, 0x10000)]);
  assert.ok(!ok.some((i) => i.code === 'partition.appAlignment'));
});

test('validation finds duplicate labels', () => {
  const issues = validatePartitionTable([
    part('same', PARTITION_TYPE.DATA, 0x02, 0x9000, 0x1000),
    part('same', PARTITION_TYPE.DATA, 0x02, 0xa000, 0x1000),
  ]);
  assert.ok(issues.some((i) => i.code === 'partition.duplicateLabel'));
});

test('validation requires otadata when OTA slots exist', () => {
  const withoutOtaData = otaPartitions().filter((p) => p.label !== 'otadata');
  const issues = validatePartitionTable(withoutOtaData);
  assert.ok(issues.some((i) => i.code === 'partition.missingOtaData' && i.level === 'error'));

  assert.ok(
    !validatePartitionTable(otaPartitions()).some((i) => i.code === 'partition.missingOtaData'),
  );
});

test('validation rejects partitions that collide with the table itself', () => {
  const issues = validatePartitionTable([part('bad', PARTITION_TYPE.DATA, 0x02, 0x8000, 0x1000)]);
  assert.ok(issues.some((i) => i.code === 'partition.overlapsTable'));
});

test('unknown type and subtype values are preserved, not discarded', () => {
  const bytes = buildPartitionTable([part('mystery', 0x40, 0x77, 0x10000, 0x1000)]);
  const table = parsePartitionTable(bytes);
  assert.equal(table.partitions[0].type, 0x40);
  assert.equal(table.partitions[0].subtype, 0x77);
  assert.equal(table.partitions[0].typeName, 'unknown');
  assert.equal(table.partitions[0].subtypeName, 'unknown');
});

test('unallocated regions cover the bootloader gap and any tail', () => {
  // This layout fills the 4 MB device exactly, leaving only the leading gap
  // that holds the bootloader and the partition table itself.
  const exact = findUnallocatedRegions(singleAppPartitions(), 4 * 1024 * 1024);
  assert.equal(exact.length, 1);
  assert.deepEqual(exact[0], { offset: 0, size: 0x9000 });

  // Shrinking the last partition must surface a trailing gap.
  const short = singleAppPartitions();
  short[3] = { ...short[3], size: 0x10000 };
  const gaps = findUnallocatedRegions(short, 4 * 1024 * 1024);
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps[1], { offset: 0x120000, size: 4 * 1024 * 1024 - 0x120000 });
});

test('findPartitionAt locates the owner of an address', () => {
  const ps = singleAppPartitions();
  assert.equal(findPartitionAt(ps, 0x9000)?.label, 'nvs'); // first byte
  assert.equal(findPartitionAt(ps, 0xefff)?.label, 'nvs'); // last byte
  assert.equal(findPartitionAt(ps, 0xf000)?.label, 'phy_init'); // just past the end
  assert.equal(findPartitionAt(ps, 0x8fff), undefined); // in the leading gap
  assert.equal(findPartitionAt(ps, 0x10000)?.label, 'factory');
});

/* -------------------------------------------------------------------------- */
/* Firmware image                                                              */
/* -------------------------------------------------------------------------- */

test('ESP image parses header, segments and checksum', () => {
  const image = parseEspImage(espImageBytes());
  assert.equal(image.entryPoint, 0x40080000);
  assert.equal(image.segments.length, 1);
  assert.equal(image.chipName, 'ESP32-S3');
  assert.equal(image.spiMode, 'dio');
  assert.equal(image.flashSize, '4MB');
  assert.equal(image.flashFreq, '80m');
  assert.equal(image.checksumValid, true);
  assert.deepEqual(image.issues, []);
});

test('ESP image reports a bad checksum instead of throwing', () => {
  const image = parseEspImage(espImageBytes({ corruptChecksum: true }));
  assert.equal(image.checksumValid, false);
  assert.ok(image.issues.some((i) => i.code === 'image.checksumMismatch'));
});

test('ESP image parses the app description', () => {
  const image = parseEspImage(
    espImageBytes({ appDesc: { version: '2.1.0', projectName: 'sensor', idfVersion: 'v5.3' } }),
  );
  assert.equal(image.app?.version, '2.1.0');
  assert.equal(image.app?.projectName, 'sensor');
  assert.equal(image.app?.idfVersion, 'v5.3');
});

test('ESP image handles multiple segments and an appended hash', () => {
  const image = parseEspImage(
    espImageBytes({
      appendHash: true,
      segments: [
        { loadAddress: 0x3fc80000, data: new Uint8Array(100).fill(1) },
        { loadAddress: 0x40380000, data: new Uint8Array(200).fill(2) },
      ],
    }),
  );
  assert.equal(image.segments.length, 2);
  assert.equal(image.segments[1].length, 200);
  assert.equal(image.hashAppended, true);
  assert.equal(image.sha256?.length, 64);
  assert.equal(image.checksumValid, true);
});

test('verifyImageHash rejects a wrong appended hash', async () => {
  const bytes = espImageBytes({ appendHash: true });
  const image = parseEspImage(bytes);
  // The helper fills the hash with 0xAA, which will not match.
  assert.equal(await verifyImageHash(bytes, image), false);
});

test('ESP image rejects data without the magic byte', () => {
  assert.throws(() => parseEspImage(new Uint8Array([0x00, 0x01])), InvalidMagicError);
  assert.throws(() => parseEspImage(new Uint8Array(0)), InvalidMagicError);
});

test('ESP image reports truncation rather than inventing segments', () => {
  const full = espImageBytes({ segments: [{ loadAddress: 0, data: new Uint8Array(256) }] });
  const image = parseEspImage(full.subarray(0, 40));
  assert.ok(image.issues.some((i) => i.code.startsWith('image.truncated')));
});

/* -------------------------------------------------------------------------- */
/* OTA data                                                                    */
/* -------------------------------------------------------------------------- */

test('otadata picks the sector with the higher sequence number', () => {
  const ota = parseOtaData(otaDataBytes([1, 2]));
  assert.equal(ota.activeSector, 1);
  assert.equal(ota.bootSlot, 1); // (2 - 1) % 2
});

test('otadata handles a never-written partition', () => {
  const ota = parseOtaData(otaDataBytes([null, null]));
  assert.equal(ota.activeSector, null);
  assert.ok(ota.issues.some((i) => i.code === 'otadata.neverWritten'));
});

test('otadata ignores a sector with a bad CRC', () => {
  const bytes = otaDataBytes([5, 9]);
  bytes[0x1000 + 28] ^= 0xff; // Corrupt the second sector's CRC.
  const ota = parseOtaData(bytes);
  assert.equal(ota.activeSector, 0);
  assert.equal(ota.sectors[1].valid, false);
});

/* -------------------------------------------------------------------------- */
/* Analyzer registry                                                           */
/* -------------------------------------------------------------------------- */

test('analyzeBinary identifies a partition table with full confidence', () => {
  const result = analyzeBinary(partitionTableBytes());
  assert.equal(result.type, 'partition-table');
  assert.equal(result.confidence, 1.0);
  assert.equal(result.metadata.partitionCount, 4);
  assert.equal(result.regions.length, 5); // 4 entries plus the MD5 entry
});

test('analyzeBinary identifies a firmware image', () => {
  const result = analyzeBinary(espImageBytes());
  assert.equal(result.type, 'esp-image');
  assert.equal(result.confidence, 1.0);
  assert.equal(result.metadata.chip, 'ESP32-S3');
});

test('analyzeBinary falls back to raw for unrecognized data', () => {
  const result = analyzeBinary(pathologicalInputs().random);
  assert.ok(result.type === 'raw' || result.type === 'encrypted?');
  assert.equal(result.confidence, 0);
});

test('analyzeBinary never throws on pathological input', () => {
  for (const [name, data] of Object.entries(pathologicalInputs())) {
    const result = analyzeBinary(data);
    assert.ok(typeof result.type === 'string', name);
  }
});

test('raw analyzer flags erased and zeroed regions', () => {
  const erased = analyzeBinary(new Uint8Array(4096).fill(0xff));
  assert.equal(erased.metadata.allErased, true);
  assert.equal(erased.metadata.encryptionState, 'unknown');

  const zeroed = analyzeBinary(new Uint8Array(4096));
  assert.equal(zeroed.metadata.allZero, true);
});

test('raw analyzer marks high-entropy data as possibly encrypted', () => {
  // Crypto-quality randomness, standing in for an encrypted partition.
  const data = new Uint8Array(65536);
  let state = 12345;
  for (let i = 0; i < data.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (state >> 16) & 0xff;
  }
  const result = analyzeBinary(data);
  assert.equal(result.type, 'encrypted?');
  assert.equal(result.metadata.encryptionState, 'possibly-encrypted');
  assert.ok(result.issues.some((i) => i.code === 'analyze.possiblyEncrypted'));
});

test('detectFormat ranks candidates by confidence', () => {
  const candidates = detectFormat(partitionTableBytes());
  assert.equal(candidates[0].id, 'partition-table');
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].confidence >= candidates[i].confidence);
  }
});

test('analyzeBinaryAs bypasses detection', () => {
  const result = analyzeBinaryAs('raw', partitionTableBytes());
  assert.equal(result.type, 'raw');
  assert.throws(() => analyzeBinaryAs('nope', new Uint8Array(4)));
});

test('otadata analyzer uses the partition subtype as a hint', () => {
  const bytes = otaDataBytes([1, null]);
  const otadata = part('otadata', PARTITION_TYPE.DATA, 0x00, 0xe000, 0x2000);
  assert.equal(otadata.subtypeName, 'ota');

  const withHint = analyzeBinary(bytes, { partition: otadata });
  assert.equal(withHint.type, 'otadata');
  assert.equal(withHint.metadata.activeSector, 0);
});

/* -------------------------------------------------------------------------- */
/* Flash layout                                                                */
/* -------------------------------------------------------------------------- */

test('the flash layout names the bootloader and the table, not "unallocated"', () => {
  // The partition table describes neither itself nor the bootloader, so a
  // naive gap calculation reports the two most dangerous regions on the chip
  // as free space.
  const layout = describeFlashLayout(singleAppPartitions(), {
    flashSize: 4 * 1024 * 1024,
    bootloaderOffset: 0x1000,
  });

  assert.deepEqual(
    layout.slice(0, 4).map((r) => [r.kind, r.offset, r.size]),
    [
      ['unallocated', 0x0, 0x1000], // genuinely unused on the original ESP32
      ['bootloader', 0x1000, 0x7000],
      ['partition-table', 0x8000, 0xc00],
      ['unallocated', 0x8c00, 0x400],
    ],
  );

  // Nothing in the boot area may be described as free.
  for (const region of layout) {
    if (region.offset < 0x8c00 && region.kind === 'unallocated') {
      assert.equal(region.offset, 0, `0x${region.offset.toString(16)} must not read as unallocated`);
    }
  }
});

test('a chip that boots from 0x0 has no leading gap', () => {
  const layout = describeFlashLayout(singleAppPartitions(), {
    flashSize: 4 * 1024 * 1024,
    bootloaderOffset: 0,
  });
  assert.equal(layout[0].kind, 'bootloader');
  assert.equal(layout[0].offset, 0);
  assert.equal(layout[0].size, 0x8000);
});

test('the flash layout covers the device with no gaps or overlaps', () => {
  const flashSize = 4 * 1024 * 1024;
  const layout = describeFlashLayout(singleAppPartitions(), { flashSize, bootloaderOffset: 0x1000 });

  let cursor = 0;
  for (const region of layout) {
    assert.equal(region.offset, cursor, `gap or overlap before 0x${region.offset.toString(16)}`);
    cursor += region.size;
  }
  assert.equal(cursor, flashSize, 'the layout must reach the end of flash');
});

test('every partition still appears in the layout', () => {
  const partitions = otaPartitions();
  const layout = describeFlashLayout(partitions, { flashSize: 4 * 1024 * 1024 });
  const named = layout.filter((r) => r.kind === 'partition').map((r) => r.partition?.label);
  assert.deepEqual(named, partitions.map((p) => p.label));
});
