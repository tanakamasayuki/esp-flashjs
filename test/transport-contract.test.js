// @ts-check
/**
 * The Transport contract, exercised by a transport built only from what
 * docs/transports.md says is required.
 *
 * The guide tells people they can reach a device with five methods and that the
 * other three merely degrade. That is a promise about this library's shape, and
 * a promise nothing else tests: every transport shipped here implements all
 * eight, so a hidden dependency on an optional one would never show up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EspLoader } from '../src/protocol/loader.js';
import { EspFlash } from '../src/device/esp-flash.js';
import { MockTransport } from '../src/testing/mock-transport.js';
import { canAutoReset } from '../src/transport/transport.js';

/**
 * A transport with the five required methods and nothing else.
 *
 * The bytes come from a MockTransport so there is still a device to talk to,
 * but every optional capability is deliberately absent.
 */
class MinimalTransport {
  /** @param {MockTransport} device */
  constructor(device) {
    this.device = device;
    this.opened = false;
  }

  async open() {
    await this.device.open();
    this.opened = true;
  }

  async close() {
    await this.device.close();
    this.opened = false;
  }

  isOpen() {
    return this.opened;
  }

  /** @param {Uint8Array} data */
  async write(data) {
    await this.device.write(data);
  }

  /** @param {{timeoutMs?: number, signal?: AbortSignal}} [options] */
  async read(options) {
    return this.device.read(options);
  }
}

test('five methods are enough to reach a device', async () => {
  const transport = new MinimalTransport(new MockTransport({ chip: 'ESP32-S3' }));
  const loader = new EspLoader(transport);

  await loader.connect();
  assert.equal(loader.chip?.name, 'ESP32-S3');

  await loader.loadStub();
  assert.ok(loader.isStub, 'the stub loads over a transport with no extras');

  const info = await new EspFlash(loader).getInfo();
  assert.equal(info.chip, 'ESP32-S3');
  assert.ok(info.flashSize && info.flashSize > 0);
});

test('a transport without setSignals reports that it cannot reset', () => {
  const minimal = new MinimalTransport(new MockTransport());
  const full = new MockTransport();

  assert.equal(canAutoReset(/** @type {any} */ (minimal)), false);
  assert.equal(canAutoReset(full), true, 'and one with the method says so');
});

test('reads and writes survive without flushInput', async () => {
  const device = new MockTransport({ chip: 'ESP32-S3' });
  const loader = new EspLoader(new MinimalTransport(device));
  await loader.connect();
  await loader.loadStub();

  for (let i = 0; i < device.flash.length; i++) device.flash[i] = (i * 3 + 1) & 0xff;
  const flash = new EspFlash(loader);

  // resync() calls flushInput optionally; a transport lacking it must not break
  // the operations that use it for recovery.
  await loader.resync();
  const data = await flash.read(0x1000, 0x800);
  assert.equal(data.length, 0x800);
  for (let i = 0; i < data.length; i++) {
    assert.equal(data[i], ((0x1000 + i) * 3 + 1) & 0xff, `byte ${i}`);
  }
});

test('a read returns whatever has arrived, not a requested length', async () => {
  // No length parameter exists, and callers must cope with short reads. This
  // pins the contract the SLIP decoder above depends on.
  const device = new MockTransport({ chip: 'ESP32-S3' });
  const transport = new MinimalTransport(device);
  await transport.open();

  await transport.write(Uint8Array.of(0xc0, 0x00, 0x08, 0x04, 0x00, 0, 0, 0, 0, 0x07, 0x07, 0x12, 0x20, 0x55, 0x55, 0x55, 0x55, 0xc0));
  const first = await transport.read({ timeoutMs: 500 });
  assert.ok(first.length > 0, 'something came back');
  assert.ok(first instanceof Uint8Array);
});
