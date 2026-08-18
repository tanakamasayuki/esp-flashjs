// @ts-check
/**
 * WebSerialTransport against a fake SerialPort.
 *
 * These cover the stream handling that MockTransport cannot: it answers
 * synchronously, so it never exercises what happens when a read outlives its
 * timeout. That gap hid a bug where a timed-out read was abandoned while still
 * in flight, and silently swallowed the next chunk to arrive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSerialTransport } from '../src/transport/web-serial.js';
import { TransportTimeoutError } from '../src/util/errors.js';

/**
 * A SerialPort stand-in whose incoming data we control.
 */
function fakePort() {
  /** @type {ReadableStreamDefaultController<Uint8Array>} */
  let controller;
  /** @type {Uint8Array[]} */
  const written = [];
  /** @type {Array<{dtr?: boolean, rts?: boolean}>} */
  const signals = [];

  const port = {
    readable: new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        written.push(chunk);
      },
    }),
    async open() {},
    async close() {},
    async setSignals(s) {
      signals.push(s);
    },
    getInfo: () => ({}),
  };

  return {
    port: /** @type {any} */ (port),
    written,
    signals,
    /** @param {number[]} bytes */
    deliver(bytes) {
      controller.enqueue(Uint8Array.from(bytes));
    },
  };
}

test('a chunk arriving after a timeout is still delivered to the next read', async () => {
  const fake = fakePort();
  const transport = new WebSerialTransport(fake.port);
  await transport.open();

  // Nothing has arrived yet, so this read must time out.
  await assert.rejects(() => transport.read({ timeoutMs: 30 }), TransportTimeoutError);

  // The device answers late — exactly the case a 100 ms SYNC timeout creates.
  fake.deliver([0xc0, 0x01, 0x08, 0xc0]);

  const received = await transport.read({ timeoutMs: 500 });
  assert.deepEqual([...received], [0xc0, 0x01, 0x08, 0xc0], 'the late chunk must not be lost');

  await transport.close();
});

test('repeated timeouts do not consume queued data', async () => {
  const fake = fakePort();
  const transport = new WebSerialTransport(fake.port);
  await transport.open();

  // Several timeouts in a row, as the sync retry loop produces.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => transport.read({ timeoutMs: 15 }), TransportTimeoutError);
  }

  fake.deliver([1, 2, 3]);
  fake.deliver([4, 5, 6]);

  /** @type {number[]} */
  const all = [];
  while (all.length < 6) {
    all.push(...(await transport.read({ timeoutMs: 500 })));
  }
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6]);

  await transport.close();
});

test('data delivered before any read is buffered, not dropped', async () => {
  const fake = fakePort();
  const transport = new WebSerialTransport(fake.port);
  await transport.open();

  fake.deliver([0xaa, 0x55]);
  // Give the pump a turn to pick it up.
  await new Promise((r) => setTimeout(r, 10));

  const received = await transport.read({ timeoutMs: 200 });
  assert.deepEqual([...received], [0xaa, 0x55]);

  await transport.close();
});

test('flushInput discards buffered data without breaking later reads', async () => {
  const fake = fakePort();
  const transport = new WebSerialTransport(fake.port);
  await transport.open();

  fake.deliver([9, 9, 9]);
  await new Promise((r) => setTimeout(r, 10));
  await transport.flushInput();

  await assert.rejects(() => transport.read({ timeoutMs: 20 }), TransportTimeoutError);

  fake.deliver([7]);
  assert.deepEqual([...(await transport.read({ timeoutMs: 200 }))], [7]);

  await transport.close();
});

test('setSignals translates to the Web Serial spelling', async () => {
  const fake = fakePort();
  const transport = new WebSerialTransport(fake.port);
  await transport.open();

  await transport.setSignals({ dtr: false, rts: true });
  assert.deepEqual(fake.signals.at(-1), { dataTerminalReady: false, requestToSend: true });

  // Only the named line is touched.
  await transport.setSignals({ dtr: true });
  assert.deepEqual(fake.signals.at(-1), { dataTerminalReady: true });

  await transport.close();
});
