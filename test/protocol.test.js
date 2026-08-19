// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { SlipDecoder, slipEncode, slipUnescape, SLIP_END, SLIP_ESC } from '../src/protocol/slip.js';
import {
  CMD,
  decodeResponse,
  encodeRequest,
  payloadChecksum,
  flashDataPayload,
} from '../src/protocol/commands.js';
import { chipByName, chipByImageId, chipByMagic, CHIPS } from '../src/protocol/chips.js';
import { EspLoader } from '../src/protocol/loader.js';
import { EspFlash } from '../src/device/esp-flash.js';
import { ChecksumError } from '../src/util/errors.js';
import { MockTransport } from '../src/testing/mock-transport.js';
import {
  AlignmentError,
  OutOfRangeError,
  UnknownChipError,
  UnsupportedOperationError,
} from '../src/util/errors.js';
import { flashImage, partitionTableBytes } from './helpers.js';
import { parsePartitionTable } from '../src/format/partition.js';

/* -------------------------------------------------------------------------- */
/* SLIP                                                                        */
/* -------------------------------------------------------------------------- */

test('SLIP escapes the delimiter and the escape byte', () => {
  const encoded = slipEncode(new Uint8Array([0x01, SLIP_END, SLIP_ESC, 0x02]));
  assert.deepEqual([...encoded], [0xc0, 0x01, 0xdb, 0xdc, 0xdb, 0xdd, 0x02, 0xc0]);
});

test('SLIP round-trips arbitrary payloads', () => {
  for (const payload of [
    new Uint8Array(0),
    new Uint8Array([0xc0]),
    new Uint8Array([0xdb]),
    new Uint8Array([0xc0, 0xdb, 0xc0, 0xdb]),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ]) {
    const frame = slipEncode(payload);
    assert.deepEqual([...slipUnescape(frame.subarray(1, -1))], [...payload]);
  }
});

test('SlipDecoder reassembles a frame split across reads', () => {
  const frame = slipEncode(new Uint8Array([1, 2, 0xc0, 3]));
  const decoder = new SlipDecoder();

  /** @type {Uint8Array[]} */
  let frames = [];
  for (let i = 0; i < frame.length; i++) {
    frames = frames.concat(decoder.push(frame.subarray(i, i + 1)));
  }
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2, 0xc0, 3]);
});

test('SlipDecoder returns several frames from one read', () => {
  const a = slipEncode(new Uint8Array([1]));
  const b = slipEncode(new Uint8Array([2]));
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);

  const frames = new SlipDecoder().push(merged);
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]], [1]);
  assert.deepEqual([...frames[1]], [2]);
});

test('SlipDecoder discards boot log noise outside frames', () => {
  const decoder = new SlipDecoder();
  const noise = new TextEncoder().encode('rst:0x1 (POWERON_RESET)\r\n');
  assert.deepEqual(decoder.push(noise), []);
  assert.ok(decoder.discarded > 0);

  const frames = decoder.push(slipEncode(new Uint8Array([7])));
  assert.deepEqual([...frames[0]], [7]);
});

test('SlipDecoder drops an oversized frame instead of growing forever', () => {
  const decoder = new SlipDecoder({ maxFrameSize: 8 });
  decoder.push(new Uint8Array([SLIP_END]));
  assert.deepEqual(decoder.push(new Uint8Array(32)), []);
  // Recovers on the next well-formed frame.
  assert.equal(decoder.push(slipEncode(new Uint8Array([1]))).length, 1);
});

/* -------------------------------------------------------------------------- */
/* Command codec                                                               */
/* -------------------------------------------------------------------------- */

test('request header carries direction, opcode, size and checksum', () => {
  const packet = encodeRequest(CMD.READ_REG, new Uint8Array([1, 2, 3, 4]));
  assert.equal(packet[0], 0x00);
  assert.equal(packet[1], CMD.READ_REG);
  assert.equal(packet[2] | (packet[3] << 8), 4);
  // READ_REG is not a data command, so the checksum field stays zero.
  assert.equal(packet[4], 0);
});

test('a data command checksums the data block, not the whole payload', () => {
  const data = new Uint8Array([0xaa, 0x55]);
  const payload = flashDataPayload(data, 0); // 16-byte header + data
  const packet = encodeRequest(CMD.FLASH_DATA, payload);

  assert.equal(packet[4], payloadChecksum(data), 'must cover only the data block');

  // The two are genuinely different values here, so this asserts something.
  // Getting it wrong makes the ROM answer "Invalid CRC in message" (0x07).
  assert.notEqual(
    payloadChecksum(data),
    payloadChecksum(payload),
    'the header must change the result, otherwise the test proves nothing',
  );
  assert.notEqual(packet[4], payloadChecksum(payload));
});

test('a non-data command leaves the checksum field zero', () => {
  const packet = encodeRequest(CMD.READ_REG, new Uint8Array([1, 2, 3, 4]));
  assert.equal(packet[4], 0);
});

test('the simulated ROM rejects a wrong checksum the way hardware does', async () => {
  const transport = new MockTransport();
  await transport.open();

  // A FLASH_DATA packet whose checksum covers the header too — the mistake
  // that shipped in 0.1.0.
  const data = new Uint8Array([1, 2, 3, 4]);
  const payload = flashDataPayload(data, 0);
  const wrong = encodeRequest(CMD.FLASH_DATA, payload, payloadChecksum(payload));
  await transport.write(slipEncode(wrong));

  const response = decodeResponse(new SlipDecoder().push(await transport.read())[0]);
  assert.ok(response);
  assert.equal(response.status, 1);
  assert.equal(response.errorCode, 0x07, 'Invalid CRC in message');
  assert.equal(transport.badChecksums, 1);

  await transport.close();
});

test('payloadChecksum starts from the 0xEF seed', () => {
  assert.equal(payloadChecksum(new Uint8Array(0)), 0xef);
  assert.equal(payloadChecksum(new Uint8Array([0xef])), 0x00);
});

test('decodeResponse rejects frames that are not responses', () => {
  assert.equal(decodeResponse(new Uint8Array(4)), null);
  assert.equal(decodeResponse(encodeRequest(CMD.SYNC)), null); // direction 0x00
});

/**
 * @param {number} op
 * @param {Uint8Array} body
 * @param {number} [value]
 * @returns {Uint8Array}
 */
function responseFrame(op, body, value = 0) {
  const frame = new Uint8Array(8 + body.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x01;
  frame[1] = op;
  view.setUint16(2, body.length, true);
  view.setUint32(4, value, true);
  frame.set(body, 8);
  return frame;
}

test('decodeResponse locates the status after the declared data length', () => {
  // [data(2)][status(2)][reserved(2)] — the layout an ESP32 ROM sends.
  const frame = responseFrame(CMD.READ_REG, new Uint8Array([0xde, 0xad, 0, 0, 0, 0]), 0x1234);

  const withData = decodeResponse(frame, 2);
  assert.ok(withData);
  assert.equal(withData.value, 0x1234);
  assert.equal(withData.status, 0);
  assert.deepEqual([...withData.data], [0xde, 0xad]);

  // Reading the same frame as if it returned no data finds the status in the
  // wrong place, which is exactly why the length must be declared.
  assert.equal(decodeResponse(frame, 0)?.status, 0xde);
});

test('decodeResponse reads the status from the front of a short response', () => {
  // A device refusing a command answers with status bytes and nothing else.
  const frame = responseFrame(CMD.GET_SECURITY_INFO, new Uint8Array([0x01, 0x05]));
  const response = decodeResponse(frame, 20);
  assert.ok(response);
  assert.equal(response.status, 0x01);
  assert.equal(response.errorCode, 0x05);
  assert.equal(response.data.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Chip table                                                                  */
/* -------------------------------------------------------------------------- */

test('chip lookups work by name, image id and magic', () => {
  assert.equal(chipByName('esp32-s3')?.name, 'ESP32-S3');
  assert.equal(chipByName('ESP32S3')?.name, 'ESP32-S3');
  assert.equal(chipByImageId(9)?.name, 'ESP32-S3');
  assert.equal(chipByMagic(0x00f01d83)?.name, 'ESP32');
  assert.equal(chipByName('nonesuch'), undefined);
});

test('chip image ids are unique', () => {
  const ids = CHIPS.map((c) => c.imageChipId);
  assert.equal(new Set(ids).size, ids.length);
});

test('only pre-S3 chips are identified by a magic value', () => {
  for (const chip of CHIPS) {
    if (chip.usesMagicValue) assert.ok(chip.magicValue !== null, chip.name);
    else assert.equal(chip.magicValue, null, chip.name);
  }
  assert.deepEqual(
    CHIPS.filter((c) => c.usesMagicValue).map((c) => c.name),
    ['ESP32', 'ESP32-S2'],
  );
});

/* -------------------------------------------------------------------------- */
/* Loader against the simulated device                                         */
/* -------------------------------------------------------------------------- */

/**
 * @param {ConstructorParameters<typeof MockTransport>[0]} [options]
 */
async function connected(options) {
  const transport = new MockTransport(options);
  const loader = new EspLoader(transport);
  await loader.connect();
  return { transport, loader };
}

test('connect detects a modern chip through GET_SECURITY_INFO', async () => {
  const { loader, transport } = await connected({ chip: 'ESP32-C6' });
  assert.equal(loader.chip?.name, 'ESP32-C6');
  assert.ok(transport.commandLog.includes('0x14'));
});

test('connect falls back to the magic register for the original ESP32', async () => {
  const { loader, transport } = await connected({ chip: 'ESP32' });
  assert.equal(loader.chip?.name, 'ESP32');
  // GET_SECURITY_INFO is attempted and refused, then READ_REG succeeds.
  assert.ok(transport.commandLog.includes('0x14'));
  assert.ok(transport.commandLog.includes('0x0a'));
});

test('connect reports an unknown chip rather than guessing', async () => {
  const transport = new MockTransport({ chip: 'ESP32' });
  transport.registers.set(0x40001000, 0xdeadbeef);
  const loader = new EspLoader(transport);
  await assert.rejects(() => loader.connect(), UnknownChipError);
});

test('readReg and writeReg reach the register file', async () => {
  const { loader, transport } = await connected();
  await loader.writeReg(0x1000, 0x12345678);
  assert.equal(transport.registers.get(0x1000), 0x12345678);
  assert.equal(await loader.readReg(0x1000), 0x12345678);
});

test('MAC address is read from eFuse', async () => {
  const { loader } = await connected();
  const flash = new EspFlash(loader);
  const info = await flash.getInfo();
  assert.match(info.mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  // The two eFuse words are reassembled in a specific order; a swap here would
  // still look like a MAC, so pin the exact value the mock encodes.
  assert.equal(info.mac, '24:0a:c4:11:22:33');
});

test('flash size is detected from the SPI flash JEDEC id', async () => {
  for (const size of [1, 4, 16]) {
    const { loader } = await connected({ flashSize: size * 1024 * 1024 });
    const info = await new EspFlash(loader).getInfo();
    assert.equal(info.flashSize, size * 1024 * 1024, `${size} MB`);
  }
});

test('stub loading succeeds and unlocks the read commands', async () => {
  const { loader } = await connected();
  assert.equal(loader.isStub, false);
  assert.equal(await loader.loadStub(), true);
  assert.equal(loader.isStub, true);
});

test('a failed stub load leaves the session usable in ROM mode', async () => {
  const { loader } = await connected({ allowStub: false });
  assert.equal(await loader.loadStub(), false);
  assert.equal(loader.isStub, false);
  assert.equal(loader.chip?.name, 'ESP32-S3');
});

test('Secure Download Mode is reported and blocks the stub', async () => {
  const { loader } = await connected({ chip: 'ESP32-C3', secureDownloadMode: true });
  assert.equal(loader.secureDownloadMode, true);
  assert.equal(await loader.loadStub(), false);

  const info = await new EspFlash(loader).getInfo();
  assert.equal(info.secureDownloadMode, true);
  assert.equal(info.mac, 'unknown');
  assert.equal(info.flashSize, null);
});

/* -------------------------------------------------------------------------- */
/* Flash operations                                                            */
/* -------------------------------------------------------------------------- */

test('read requires the stub and says so', async () => {
  const { loader } = await connected();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  await assert.rejects(() => flash.read(0, 16), (error) => {
    assert.ok(error instanceof UnsupportedOperationError);
    assert.equal(error.code, 'REQUIRES_STUB');
    return true;
  });
});

test('erase region requires the stub', async () => {
  const { loader } = await connected();
  const flash = new EspFlash(loader);
  await flash.getInfo();
  await assert.rejects(() => flash.eraseRegion(0x9000, 0x1000), UnsupportedOperationError);
});

test('read returns exactly what is in flash', async () => {
  const image = flashImage();
  const { loader } = await connected({ flash: image });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  const table = await flash.read(0x8000, 0xc00);
  assert.deepEqual([...table], [...image.subarray(0x8000, 0x8c00)]);

  const parsed = parsePartitionTable(table);
  assert.equal(parsed.partitions.length, 4);
  assert.equal(parsed.md5Valid, true);
});

test('read reports progress and finishes at 100%', async () => {
  const { loader } = await connected({ flash: flashImage() });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  /** @type {import('../src/util/events.js').Progress[]} */
  const events = [];
  await flash.read(0, 0x8000, { onProgress: (p) => events.push(p) });

  assert.ok(events.length > 0);
  assert.equal(events.at(-1)?.done, 0x8000);
  assert.equal(events.at(-1)?.total, 0x8000);
  assert.ok(events.every((e) => e.phase === 'reading'));
});

test('read of zero bytes is a no-op', async () => {
  const { loader } = await connected();
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();
  assert.equal((await flash.read(0x1000, 0)).length, 0);
});

test('write lands in flash and verifies', async () => {
  const { loader, transport } = await connected();
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  const payload = partitionTableBytes();
  await flash.write(0x8000, payload, { compress: false });
  assert.deepEqual([...transport.flash.subarray(0x8000, 0x8c00)], [...payload]);

  const result = await flash.verify(0x8000, payload);
  assert.equal(result.ok, true);
  assert.equal(result.expected, result.actual);
});

test('verify fails when the contents differ', async () => {
  const { loader } = await connected();
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  const result = await flash.verify(0x8000, new Uint8Array(16).fill(0x42));
  assert.equal(result.ok, false);
  assert.notEqual(result.expected, result.actual);
});

test('erase region restores 0xFF', async () => {
  const { loader, transport } = await connected({ flash: flashImage() });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  // The sector at 0x8000 holds the partition table.
  assert.ok(transport.flash.subarray(0x8000, 0x8c00).some((b) => b !== 0xff));
  await flash.eraseRegion(0x8000, 0x1000);
  assert.ok(transport.flash.subarray(0x8000, 0x9000).every((b) => b === 0xff));

  // Sectors on either side keep their contents.
  assert.ok(transport.flash.subarray(0x1000, 0x2000).some((b) => b !== 0xff));
  assert.ok(transport.flash.subarray(0x10000, 0x11000).some((b) => b !== 0xff));
});

test('misaligned addresses are rejected, not silently rounded', async () => {
  const { loader } = await connected();
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  await assert.rejects(() => flash.write(0x1001, new Uint8Array(4)), AlignmentError);
  await assert.rejects(() => flash.eraseRegion(0x1001, 0x1000), AlignmentError);
  await assert.rejects(() => flash.eraseRegion(0x1000, 0x1001), AlignmentError);
});

test('out-of-range access is rejected, not truncated', async () => {
  const { loader } = await connected({ flashSize: 0x100000 });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  await assert.rejects(() => flash.read(0xfff000, 0x2000), OutOfRangeError);
  await assert.rejects(() => flash.write(0xfff000, new Uint8Array(0x2000)), OutOfRangeError);
  await assert.rejects(() => flash.read(-1, 4), OutOfRangeError);
});

test('dump reads the whole device', async () => {
  const image = flashImage({ size: 1024 * 1024 });
  const { loader } = await connected({ flash: image });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  const dump = await flash.dump();
  assert.equal(dump.length, 1024 * 1024);
  assert.deepEqual([...dump.subarray(0x8000, 0x8100)], [...image.subarray(0x8000, 0x8100)]);
});

test('an aborted read rejects instead of returning a partial buffer', async () => {
  const { loader } = await connected({ flash: flashImage() });
  await loader.loadStub();
  const flash = new EspFlash(loader);
  await flash.getInfo();

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => flash.read(0, 0x10000, { signal: controller.signal }),
    (error) => /** @type {Error & {code: string}} */ (error).code === 'ABORTED',
  );
});

test('disconnect leaves the transport closed', async () => {
  const { loader, transport } = await connected();
  await loader.loadStub();
  await loader.disconnect();
  assert.equal(transport.isOpen(), false);
  assert.equal(loader.isStub, false);
  assert.equal(loader.chip, null);
});

/* -------------------------------------------------------------------------- */
/* Reading over a link that drops bytes                                        */
/* -------------------------------------------------------------------------- */

/**
 * The stub verifies each transfer with its own MD5, so a dropped byte is a
 * rejected read rather than silent corruption. That makes retrying safe — and
 * necessary, because a link that drops bytes at all will never deliver a large
 * range in one go.
 */
async function flakyFlash(options) {
  const transport = new MockTransport({ chip: 'ESP32-S3', ...options });
  const loader = new EspLoader(transport);
  await loader.connect();
  await loader.loadStub();
  for (let i = 0; i < transport.flash.length; i++) transport.flash[i] = (i * 7 + 3) & 0xff;
  return { transport, loader, flash: new EspFlash(loader) };
}

test('a read that loses bytes is retried and returns the right data', async () => {
  const { transport, flash } = await flakyFlash({ flakyReads: 1 });

  const data = await flash.read(0x1000, 0x2000);

  assert.equal(transport.droppedReads, 1, 'the mock should have spoiled one transfer');
  assert.equal(data.length, 0x2000);
  for (let i = 0; i < data.length; i++) {
    assert.equal(data[i], ((0x1000 + i) * 7 + 3) & 0xff, `byte ${i} survived the retry`);
  }
});

test('a read gives up once its attempts are exhausted', async () => {
  const { flash } = await flakyFlash({ flakyReads: 5 });

  await assert.rejects(
    () => flash.read(0x1000, 0x2000, { attempts: 2 }),
    (error) => error instanceof ChecksumError,
  );
});

test('progress never goes backwards across a retry', async () => {
  const { flash } = await flakyFlash({ flakyReads: 1 });

  const seen = [];
  await flash.read(0, 0x3000, { onProgress: (p) => seen.push(p.done) });

  assert.ok(seen.length > 0, 'progress should be reported');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `progress went ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert.equal(seen.at(-1), 0x3000, 'progress should finish at the total');
});

test('a range larger than one chunk is split, and each chunk is verified', async () => {
  const { transport, flash } = await flakyFlash({});
  transport.commandLog.length = 0;

  const data = await flash.read(0, 0x60000, { chunkSize: 0x20000 });

  const reads = transport.commandLog.filter((c) => c === '0xd2').length;
  assert.equal(reads, 3, 'three chunks for three times the chunk size');
  assert.equal(data.length, 0x60000);
  for (let i = 0; i < data.length; i += 4093) {
    assert.equal(data[i], (i * 7 + 3) & 0xff, `byte ${i}`);
  }
});

/* -------------------------------------------------------------------------- */
/* One conversation at a time                                                  */
/* -------------------------------------------------------------------------- */

test('two reads started at once do not read each other frames', async () => {
  // A serial port carries one conversation. Two operations in flight together
  // each consume the other's frames, and the failure does not look like a
  // programming mistake — it looks like a bad cable: a checksum mismatch, then
  // a run of timeouts, then a device that appears to have stopped responding.
  // That is exactly what was reported from the web app when a write's backup
  // read started while another read was still going.
  const { loader, transport } = await connected({ chip: 'ESP32', flash: flashImage() });
  await loader.loadStub();
  const flash = new EspFlash(loader);

  // Large enough to need many blocks and acknowledgements each: the damage is
  // done by the two transfers taking turns, so a read short enough to finish
  // in one block would not show it.
  const [app, table] = await Promise.all([
    flash.read(0x10000, 0x20000),
    flash.read(0x8000, 0x20000),
  ]);

  // The device has one transfer session, not one per caller. This is the
  // invariant; that the bytes also came out right is luck, and the kind of
  // luck that holds in a test and not on a real link.
  assert.equal(transport.overlappedReads, 0, 'the second read must wait for the first');

  const expected = flashImage();
  assert.deepEqual(Buffer.from(app), Buffer.from(expected.subarray(0x10000, 0x10000 + 0x20000)));
  assert.deepEqual(Buffer.from(table), Buffer.from(expected.subarray(0x8000, 0x8000 + 0x20000)));
});

test('queued operations run in the order they were asked for', async () => {
  const { loader } = await connected();
  /** @type {string[]} */
  const order = [];

  await Promise.all(
    ['first', 'second', 'third'].map((name) =>
      loader.exclusive(async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
      }),
    ),
  );

  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
    'third:start',
    'third:end',
  ]);
});

test('an operation that throws still releases the link', async () => {
  const { loader } = await connected();
  await assert.rejects(() =>
    loader.exclusive(async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(loader.busy, false);
  assert.equal(await loader.exclusive(async () => 'through'), 'through');
});

test('giving up while queued does not run the operation anyway', async () => {
  // The whole point of queuing is that the wait can be long. Someone who
  // cancels during it has cancelled.
  const { loader } = await connected();
  const controller = new AbortController();
  let ran = false;

  const ahead = loader.exclusive(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const queued = loader.exclusive(
    async () => {
      ran = true;
    },
    { signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(queued, /aborted/i);
  await ahead;
  assert.equal(ran, false);
  assert.equal(loader.busy, false);
});

test('busy reports whether the link is in use', async () => {
  const { loader } = await connected();
  assert.equal(loader.busy, false);

  let observed = false;
  await loader.exclusive(async () => {
    observed = loader.busy;
  });
  assert.equal(observed, true);
  assert.equal(loader.busy, false);
});
