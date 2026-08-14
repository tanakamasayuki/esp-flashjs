// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { ByteReader } from '../src/binary/reader.js';
import { ByteWriter } from '../src/binary/writer.js';
import { crc32, md5Hex, espChecksum } from '../src/binary/hash.js';
import { searchBytes, searchText, parseHexPattern, extractStrings } from '../src/binary/search.js';
import { diffBinary, diffSummary, entropy, isUniform } from '../src/binary/diff.js';
import {
  bytesToHex,
  hexToBytes,
  parseAddress,
  formatByteSize,
  decodeCString,
  encodeCString,
} from '../src/util/hex.js';
import { TruncatedDataError } from '../src/util/errors.js';

test('ByteReader reads little-endian integers', () => {
  const data = new Uint8Array([0x50, 0xaa, 0x01, 0x02, 0x00, 0x90, 0x00, 0x00]);
  const r = new ByteReader(data);
  assert.equal(r.u16(), 0xaa50);
  assert.equal(r.u8(), 0x01);
  assert.equal(r.u8(), 0x02);
  assert.equal(r.u32(), 0x9000);
  assert.ok(r.atEnd);
});

test('ByteReader throws on truncated reads instead of returning garbage', () => {
  const r = new ByteReader(new Uint8Array(2), 0, 'test');
  assert.throws(() => r.u32(), TruncatedDataError);
});

test('ByteReader handles signed and 64-bit values', () => {
  const w = new ByteWriter();
  w.i32(-1).u64(0xdeadbeefcafen).i64(-2n);
  const r = new ByteReader(w.toBytes());
  assert.equal(r.i32(), -1);
  assert.equal(r.u64(), 0xdeadbeefcafen);
  assert.equal(r.i64(), -2n);
});

test('ByteWriter.fixed pads with 0xFF to model erased flash', () => {
  const w = ByteWriter.fixed(16, 0xff);
  w.u32(0x12345678);
  // Bytes past the cursor keep the fill value.
  assert.equal(w.buffer[15], 0xff);
});

test('ByteWriter round-trips through ByteReader', () => {
  const w = new ByteWriter();
  w.u8(1).u16(0x0203).u32(0x04050607).cstring('nvs', 16).bytes(new Uint8Array([9, 9]));
  const r = new ByteReader(w.toBytes());
  assert.equal(r.u8(), 1);
  assert.equal(r.u16(), 0x0203);
  assert.equal(r.u32(), 0x04050607);
  assert.equal(r.cstring(16), 'nvs');
  assert.deepEqual([...r.bytes(2)], [9, 9]);
});

test('ByteWriter.align pads to a boundary', () => {
  const w = new ByteWriter();
  w.u8(1).align(16, 0);
  assert.equal(w.length, 16);
});

test('encodeCString rejects values that do not fit', () => {
  assert.deepEqual([...encodeCString('abc', 4)], [97, 98, 99, 0]);
  // 4 characters need 5 bytes with the terminator.
  assert.throws(() => encodeCString('abcd', 4));
  assert.throws(() => encodeCString('ホゲ', 16));
});

test('decodeCString stops at the first NUL', () => {
  assert.equal(decodeCString(new Uint8Array([110, 118, 115, 0, 120, 120])), 'nvs');
  // No terminator at all: use the whole field.
  assert.equal(decodeCString(new Uint8Array([97, 98])), 'ab');
});

test('md5 matches known digests', () => {
  assert.equal(md5Hex(new Uint8Array(0)), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(
    md5Hex(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')),
    '9e107d9d372bb6826bd81d3542a419d6',
  );
});

test('md5 handles inputs that straddle block boundaries', () => {
  // 55, 56 and 64 bytes exercise the padding edge cases.
  for (const length of [55, 56, 57, 63, 64, 65, 1000]) {
    const data = new Uint8Array(length).fill(0x61);
    assert.equal(md5Hex(data).length, 32, `length ${length}`);
  }
  assert.equal(
    md5Hex(new Uint8Array(56).fill(0x61)),
    '3b0c8ac703f828b04c6c197006d17218',
  );
});

test('crc32 matches the known value for "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('espChecksum xors with the 0xEF seed', () => {
  assert.equal(espChecksum(new Uint8Array(0)), 0xef);
  assert.equal(espChecksum(new Uint8Array([0xef])), 0x00);
});

test('hex helpers round-trip', () => {
  assert.equal(bytesToHex(new Uint8Array([0xaa, 0x50])), 'aa50');
  assert.equal(bytesToHex(new Uint8Array([0xaa, 0x50]), ' '), 'aa 50');
  assert.deepEqual([...hexToBytes('AA 50')], [0xaa, 0x50]);
  assert.deepEqual([...hexToBytes('aa:50')], [0xaa, 0x50]);
  assert.throws(() => hexToBytes('AA5'));
  assert.throws(() => hexToBytes('ZZ'));
});

test('parseAddress accepts hex and decimal, rejects nonsense', () => {
  assert.equal(parseAddress('0x9000'), 0x9000);
  assert.equal(parseAddress('9000h'), 0x9000);
  assert.equal(parseAddress('4096'), 4096);
  assert.throws(() => parseAddress('-1'));
  assert.throws(() => parseAddress('0xZZ'));
  assert.throws(() => parseAddress(''));
});

test('formatByteSize avoids a misleading decimal for round sizes', () => {
  assert.equal(formatByteSize(512), '512 B');
  assert.equal(formatByteSize(4096), '4 KB');
  assert.equal(formatByteSize(4 * 1024 * 1024), '4 MB');
  assert.equal(formatByteSize(1536), '1.5 KB');
});

test('searchBytes finds every occurrence', () => {
  const data = new Uint8Array([1, 2, 3, 1, 2, 3, 1, 2]);
  assert.deepEqual(searchBytes(data, new Uint8Array([1, 2, 3])), [0, 3]);
  assert.deepEqual(searchBytes(data, new Uint8Array([1, 2])), [0, 3, 6]);
  assert.deepEqual(searchBytes(data, new Uint8Array([9])), []);
});

test('searchBytes honours from and limit', () => {
  const data = new Uint8Array([1, 1, 1, 1]);
  assert.deepEqual(searchBytes(data, new Uint8Array([1]), { from: 2 }), [2, 3]);
  assert.deepEqual(searchBytes(data, new Uint8Array([1]), { limit: 2 }), [0, 1]);
});

test('parseHexPattern supports wildcards', () => {
  const p = parseHexPattern('AA 50 ?? 02');
  assert.deepEqual([...p.bytes], [0xaa, 0x50, 0x00, 0x02]);
  assert.deepEqual([...p.mask], [0xff, 0xff, 0x00, 0xff]);

  const data = new Uint8Array([0xaa, 0x50, 0x99, 0x02]);
  assert.deepEqual(searchBytes(data, p), [0]);
});

test('parseHexPattern splits unseparated runs and rejects bad input', () => {
  assert.deepEqual([...parseHexPattern('AA50').bytes], [0xaa, 0x50]);
  assert.throws(() => parseHexPattern('AA5'));
  assert.throws(() => parseHexPattern('xyz'));
  assert.throws(() => parseHexPattern(''));
});

test('searchText finds ASCII and is optionally case-insensitive', () => {
  const data = new TextEncoder().encode('hello Hello HELLO');
  assert.deepEqual(searchText(data, 'Hello'), [6]);
  assert.deepEqual(searchText(data, 'hello', { caseInsensitive: true }), [0, 6, 12]);
});

test('extractStrings behaves like strings(1)', () => {
  const data = new Uint8Array([0, 0, 104, 101, 108, 108, 111, 0, 1, 2]);
  assert.deepEqual(extractStrings(data, { minLength: 4 }), [{ offset: 2, text: 'hello' }]);
  assert.deepEqual(extractStrings(data, { minLength: 6 }), []);
});

test('diffBinary reports nothing for identical buffers', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.deepEqual(diffBinary(a, new Uint8Array([1, 2, 3])), []);
});

test('diffBinary groups nearby changes into one chunk', () => {
  const a = new Uint8Array(64);
  const b = new Uint8Array(64);
  b[10] = 1;
  b[12] = 1; // Two bytes apart, well under the default minGap.

  const chunks = diffBinary(a, b);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].offset, 10);
  assert.equal(chunks[0].before.length, 3);
});

test('diffBinary splits when the identical run exceeds minGap', () => {
  const a = new Uint8Array(128);
  const b = new Uint8Array(128);
  b[10] = 1;
  b[100] = 1;

  const chunks = diffBinary(b, a, { minGap: 16 });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.offset), [10, 100]);
});

test('diffBinary includes the final differing byte', () => {
  const a = new Uint8Array([0, 0, 0]);
  const b = new Uint8Array([0, 0, 9]);
  const chunks = diffBinary(a, b);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].offset, 2);
  assert.deepEqual([...chunks[0].after], [9]);
});

test('diffBinary reports length differences', () => {
  const chunks = diffBinary(new Uint8Array([1]), new Uint8Array([1, 2, 3]));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'added');
  assert.deepEqual([...chunks[0].after], [2, 3]);

  const removed = diffBinary(new Uint8Array([1, 2, 3]), new Uint8Array([1]));
  assert.equal(removed[0].kind, 'removed');
});

test('diffSummary counts differences including length', () => {
  assert.deepEqual(diffSummary(new Uint8Array([1, 2]), new Uint8Array([1, 2])), {
    identical: true,
    differingBytes: 0,
    firstDifference: null,
    lengthDelta: 0,
  });
  const s = diffSummary(new Uint8Array([1, 2]), new Uint8Array([1, 3, 4]));
  assert.equal(s.identical, false);
  assert.equal(s.firstDifference, 1);
  assert.equal(s.lengthDelta, 1);
});

test('isUniform detects erased and zeroed regions', () => {
  assert.ok(isUniform(new Uint8Array(16).fill(0xff), 0xff));
  assert.ok(isUniform(new Uint8Array(16), 0x00));
  assert.ok(!isUniform(new Uint8Array([0xff, 0x00]), 0xff));
});

test('entropy separates uniform data from random data', () => {
  assert.equal(entropy(new Uint8Array(1024)), 0);
  const random = Uint8Array.from({ length: 65536 }, (_, i) => (i * 2654435761) >>> 24);
  assert.ok(entropy(random) > 7, `expected high entropy, got ${entropy(random)}`);
});
