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

import {
  analyzeBinary,
  classifyEntropy,
  detectFormat,
  HIGH_ENTROPY_THRESHOLD,
  peakEntropy,
} from '../src/core.js';

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

test('a real core dump is named from its subtype, not guessed at', (t) => {
  const data = region('esp32s3', 'coredump.bin');
  if (!data) return t.skip('no captured fixture');

  // There is no core dump analyzer, and this pins what happens in the meantime
  // against bytes a device actually wrote rather than a buffer made up here.
  // The distinction that matters is "we know what this is and cannot read it"
  // versus "no idea": the partition table supplies the first, and throwing it
  // away would be discarding something the device already told us.
  const result = analyzeBinary(data, {
    partition: /** @type {any} */ ({ subtypeName: 'coredump', label: 'coredump' }),
  });
  assert.equal(result.type, 'raw');
  assert.equal(result.metadata.expectedFormat, 'coredump');
  assert.equal(result.metadata.contents, 'data');
  assert.ok(result.issues.some((i) => i.code === 'analyze.notImplemented'));

  // An ELF holding task stacks is structured, not noise. If this ever climbed
  // near the threshold, a core dump would start being reported as possibly
  // encrypted — the accusation the entropy work exists to avoid.
  assert.ok(result.metadata.entropy < 5, `entropy ${result.metadata.entropy}`);
  assert.ok(!result.issues.some((i) => i.code.startsWith('analyze.possiblyEncrypted')));
});

test('an erased partition falls through to raw, whatever its subtype says', () => {
  const erased = new Uint8Array(64 * 1024).fill(0xff);
  for (const subtype of ['nvs', 'spiffs', 'littlefs', 'fat']) {
    const result = analyzeBinary(erased, { partition: /** @type {any} */ ({ subtypeName: subtype }) });
    assert.equal(result.metadata.contents ?? 'parsed', 'erased', `${subtype} on erased flash`);
  }
});

/* -------------------------------------------------------------------------- */
/* Encryption detection                                                        */
/* -------------------------------------------------------------------------- */

/** Bytes with no visible structure, which is what both ciphertext and gzip look like. */
function opaqueBytes(length = 128 * 1024, seed = 1) {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    // xorshift: deterministic, and flat enough to sit above the threshold.
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

test('ordinary data can max out the entropy metric', (t) => {
  const chip = 'esp32s3';
  const base = new URL(`./fixtures/hardware/${chip}/`, import.meta.url);
  if (!existsSync(base)) return t.skip('no captured fixture');

  // This is the limitation the rest of the detection is built around, and it
  // is not hypothetical: /big.bin is filled with a byte counter, so all 256
  // values appear equally often and the window containing it scores a perfect
  // 8.0 — in a plain, unencrypted LittleFS image written by a real device.
  const littlefs = new Uint8Array(readFileSync(new URL('littlefs.bin', base)));
  assert.ok(
    peakEntropy(littlefs) > HIGH_ENTROPY_THRESHOLD,
    'an unencrypted filesystem holding a counter file exceeds the threshold',
  );

  // So entropy on its own must never be what claims encryption. With the chip
  // reporting encryption off, the same bytes are described rather than accused.
  assert.equal(
    classifyEntropy(peakEntropy(littlefs), { flashEncryptionEnabled: false }),
    'high-entropy',
  );
});

test('regions with real structure stay well below the threshold', (t) => {
  const base = new URL('./fixtures/hardware/esp32s3/', import.meta.url);
  if (!existsSync(base)) return t.skip('no captured fixture');

  // Firmware, NVS and a partition table are structured enough that no window
  // of them looks like noise. If one of these crept up, the threshold would be
  // measuring nothing.
  for (const file of ['bootarea', 'app0', 'nvs', 'partition-table', 'otadata']) {
    const data = new Uint8Array(readFileSync(new URL(`${file}.bin`, base)));
    const h = peakEntropy(data);
    assert.ok(h <= HIGH_ENTROPY_THRESHOLD, `${file}: entropy ${h.toFixed(2)}`);
  }
});

test('opaque bytes are called encrypted only when something says encryption is on', () => {
  const data = opaqueBytes();
  const h = peakEntropy(data);
  assert.ok(h > HIGH_ENTROPY_THRESHOLD, 'the fixture must actually be opaque');

  // Nothing known: a guess, and labelled as one.
  assert.equal(classifyEntropy(h, {}), 'possibly-encrypted');

  // The device says encryption is on.
  assert.equal(classifyEntropy(h, { flashEncryptionEnabled: true }), 'encrypted');

  // The partition table says this partition is encrypted, which is as close to
  // authoritative as this gets.
  assert.equal(
    classifyEntropy(h, { partition: /** @type {any} */ ({ encrypted: true }) }),
    'encrypted',
  );
});

test('a chip that says encryption is off is not contradicted', () => {
  const data = opaqueBytes();
  const h = peakEntropy(data);

  // Compressed data is indistinguishable from ciphertext by entropy alone.
  // Calling it "possibly encrypted" when the device has just said encryption
  // is off trains people to dismiss the warning — and the one time it matters
  // is the time they dismiss it.
  assert.equal(classifyEntropy(h, { flashEncryptionEnabled: false }), 'high-entropy');

  const result = analyzeBinary(data, { flashEncryptionEnabled: false });
  assert.equal(result.type, 'raw', 'not flagged as encrypted');
  assert.equal(result.metadata.encryptionState, 'high-entropy');
  assert.ok(result.issues.some((i) => i.code === 'analyze.highEntropy'));
  assert.ok(!result.issues.some((i) => i.code === 'analyze.possiblyEncrypted'));
});

test('"unknown" is not treated as "off"', () => {
  const h = peakEntropy(opaqueBytes());
  // A device that could not report its encryption state leaves us guessing,
  // which is a different answer from being told it is off.
  assert.equal(classifyEntropy(h, { flashEncryptionEnabled: undefined }), 'possibly-encrypted');
});

test('an opaque region is found even when it is not at the start', () => {
  // Sampling only the head reads a mostly-erased partition as empty. Which
  // part the head lands in is an accident of how much has been written, so it
  // cannot be what decides whether anything opaque is present.
  const partition = new Uint8Array(512 * 1024).fill(0xff);
  partition.set(opaqueBytes(64 * 1024, 7), 300 * 1024);

  assert.ok(
    peakEntropy(partition) > HIGH_ENTROPY_THRESHOLD,
    'a window past the head must still be sampled',
  );
  assert.equal(
    peakEntropy(partition.subarray(0, 64 * 1024)),
    0,
    'and the head on its own really does look empty',
  );
});

test('erased and zeroed regions report no entropy at all', () => {
  assert.equal(peakEntropy(new Uint8Array(128 * 1024).fill(0xff)), 0);
  assert.equal(peakEntropy(new Uint8Array(128 * 1024)), 0);
  assert.equal(peakEntropy(new Uint8Array(0)), 0);
});

test('the partition table flag is policy, not a statement about the bytes', () => {
  const h = peakEntropy(opaqueBytes());
  const encryptedPartition = /** @type {any} */ ({ encrypted: true });

  // The flag means "encrypt this partition when flash encryption is enabled".
  // On a chip that has just said encryption is off, it describes an intention
  // that was never carried out.
  assert.equal(
    classifyEntropy(h, { partition: encryptedPartition, flashEncryptionEnabled: false }),
    'high-entropy',
  );

  // With encryption on, or with no word from the device, the flag stands.
  assert.equal(
    classifyEntropy(h, { partition: encryptedPartition, flashEncryptionEnabled: true }),
    'encrypted',
  );
  assert.equal(classifyEntropy(h, { partition: encryptedPartition }), 'encrypted');
});
