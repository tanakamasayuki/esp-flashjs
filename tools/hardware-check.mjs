#!/usr/bin/env node
// @ts-check
/**
 * Drives the library against a real board.
 *
 * Everything verified on hardware so far went through esptool: the fixtures
 * are esptool's output, and the parsers were checked against those bytes. The
 * protocol stack in this repository — reset, sync, chip detection, the stub,
 * chunked reads with retry — had only ever run against MockTransport, which is
 * a mock this project also wrote. That is the same trap the parsers fell into,
 * one layer down.
 *
 * This closes it. Nothing here is part of `npm test`: it needs a board.
 *
 *   node tools/hardware-check.mjs /dev/ttyUSB0
 *   node tools/hardware-check.mjs /dev/ttyACM3 --compare test/fixtures/hardware/esp32s3
 *
 * With `--compare`, every region read is checked byte for byte against a
 * fixture esptool produced. Agreement between two independent implementations
 * is the strongest evidence available without a logic analyser.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EspLoader } from '../src/protocol/loader.js';
import { registerStub } from '../src/protocol/stub-loader.js';
import { EspFlash } from '../src/device/esp-flash.js';
import { md5Hex } from '../src/binary/hash.js';
import { parseNvs } from '../src/format/nvs/parse.js';
import { parseSpiffs } from '../src/format/fs/spiffs.js';
import { parseLittlefs } from '../src/format/fs/littlefs.js';
import { BridgeTransport } from './bridge-transport.mjs';

/**
 * Makes the flasher stubs reachable without a fetch.
 *
 * `fetchStub` asks `fetch()` for a URL next to the module, which is right in a
 * browser and impossible in Node: fetch does not implement the `file:` scheme.
 * `registerStub` is the way in for anything that is not a browser, and every
 * Node consumer needs this — reading flash at all depends on the stub.
 */
function registerStubsFromDisk() {
  // Every JSON in the directory, rather than a list kept in step by hand. The
  // first version of this listed chip names and silently missed
  // esp32p4-rev1 — which is precisely the stub the board on the bench needs.
  const dir = new URL('../dist/stub/', import.meta.url);
  const names = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));

  for (const name of names) {
    registerStub(name, JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')));
  }
  if (names.length === 0) {
    console.error('No stubs in dist/stub/. Run `npm run build` first.');
    process.exit(2);
  }
}

/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const path = args[0];
const compareIndex = args.indexOf('--compare');
const compareDir = compareIndex >= 0 ? args[compareIndex + 1] : null;
const baudIndex = args.indexOf('--baud');
// 115200 is what a chip greets at; anything faster is a decision, and on some
// links a bad one. Measured on a CH340 board here, 115200 loses bytes on long
// reads where 460800 does not.
const baudRate = baudIndex >= 0 ? Number(args[baudIndex + 1]) : 115200;
const chunkIndex = args.indexOf('--chunk');
// A link that drops bytes cannot deliver a large transfer however often it is
// retried, because a READ_FLASH is all-or-nothing. Asking for less at a time
// is the only thing that helps, which is why this is a knob rather than a
// constant.
const chunkSize = chunkIndex >= 0 ? Number(args[chunkIndex + 1]) : undefined;

if (!path) {
  console.error(
    'usage: node tools/hardware-check.mjs <port> [--compare <dir>] [--baud <rate>] [--chunk <bytes>]',
  );
  process.exit(2);
}

/**
 * Regions worth reading, and how each may be compared with its fixture.
 *
 * `bytes` regions are written once and never touched again, so this library
 * and esptool must return identical bytes. `meaning` regions are rewritten by
 * the fixture sketch on every boot: the device has legitimately moved on since
 * the capture — NVS page sequence numbers advance and erased entries pile up —
 * so demanding identical bytes would report a healthy read as a failure.
 * Comparing what the region *means* still catches a misread.
 */
const REGIONS = [
  { name: 'partition-table', offset: 0x8000, size: 0xc00, compare: 'bytes' },
  { name: 'otadata', offset: 0xe000, size: 0x2000, compare: 'bytes' },
  { name: 'nvs', offset: 0x9000, size: 0x5000, compare: 'meaning', parse: summarizeNvs },
  { name: 'spiffs', offset: 0x290000, size: 0x50000, compare: 'meaning', parse: summarizeFs(parseSpiffs) },
  { name: 'littlefs', offset: 0x2e0000, size: 0x50000, compare: 'meaning', parse: summarizeFs(parseLittlefs) },
];

/**
 * The content of an NVS partition, independent of where it physically sits.
 *
 * @param {Uint8Array} data
 * @returns {string}
 */
function summarizeNvs(data) {
  const store = parseNvs(data);
  const entries = store.entries
    .map((e) => `${e.namespace}.${e.key}=${e.value instanceof Uint8Array ? `<${e.value.length}>` : e.value}`)
    .sort();
  return JSON.stringify({ namespaces: store.namespaces, entries });
}

/**
 * @param {(data: Uint8Array) => import('../src/format/fs/types.js').FsImage} parse
 * @returns {(data: Uint8Array) => string}
 */
function summarizeFs(parse) {
  return (data) => {
    const image = parse(data);
    return JSON.stringify(
      image.files.map((f) => ({
        path: f.path,
        size: f.size,
        // The contents, not just the listing: a read that lost a page would
        // still produce the right names and sizes.
        md5: f.directory ? null : md5Hex(f.read()),
      })),
    );
  };
}

let failures = 0;

/** @param {boolean} ok @param {string} message */
function check(ok, message) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures += 1;
}

registerStubsFromDisk();

const transport = new BridgeTransport(path);
const loader = new EspLoader(transport, {
  onLog: (level, code) => {
    if (level === 'error' || level === 'warn') console.log(`       [${level}] ${code}`);
  },
});

try {
  console.log(`\nconnecting to ${path}`);
  await loader.connect();
  check(Boolean(loader.chip), `chip detected: ${loader.chip?.name}`);

  const stubbed = await loader.loadStub();
  check(stubbed && loader.isStub, 'stub loader running');

  // Raised only after the stub is up, which is the only point at which the
  // device can be told to change rate.
  if (baudRate !== 115200 && loader.isStub) {
    await loader.changeBaudRate(baudRate);
    console.log(`       link raised to ${baudRate} baud`);
  }

  const flash = new EspFlash(loader);
  const info = await flash.getInfo();
  console.log(`       ${info.chip}  mac ${info.mac}  flash ${info.flashSize} bytes`);
  check(Boolean(info.flashSize && info.flashSize > 0), 'flash size reported');

  console.log('\nreading regions');
  for (const region of REGIONS) {
    let data;
    try {
      data = await flash.read(region.offset, region.size, chunkSize ? { chunkSize } : {});
    } catch (error) {
      check(false, `${region.name}: ${/** @type {Error} */ (error).message}`);
      continue;
    }
    check(data.length === region.size, `${region.name} read ${data.length} bytes`);

    if (compareDir) {
      const fixture = join(compareDir, `${region.name}.bin`);
      if (!existsSync(fixture)) continue;
      const expected = new Uint8Array(readFileSync(fixture));

      // esptool and this library share no code, so their agreement is evidence
      // rather than self-consistency — which is the whole point of comparing.
      if (region.compare === 'bytes') {
        check(
          md5Hex(data) === md5Hex(expected.subarray(0, data.length)),
          `${region.name} matches the esptool capture byte for byte`,
        );
      } else if (region.parse) {
        let ours;
        let theirs;
        try {
          ours = region.parse(data);
          theirs = region.parse(expected);
        } catch (error) {
          check(false, `${region.name}: parsing failed (${/** @type {Error} */ (error).message})`);
          continue;
        }
        check(ours === theirs, `${region.name} holds the same content as the esptool capture`);
        if (ours !== theirs) {
          console.log(`       device:  ${ours.slice(0, 160)}`);
          console.log(`       fixture: ${theirs.slice(0, 160)}`);
        }
      }
    }
  }

  console.log('\nre-reading to check the link is stable');
  const first = await flash.read(0x9000, 0x5000);
  const second = await flash.read(0x9000, 0x5000);
  check(md5Hex(first) === md5Hex(second), 'two reads of the same region agree');
} catch (error) {
  check(false, `unexpected: ${/** @type {Error} */ (error).message}`);
} finally {
  // Leave the chip running its application rather than sitting in the stub.
  try {
    await loader.disconnect({ reset: true });
  } catch {
    /* the port may already be gone */
  }
  await transport.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
