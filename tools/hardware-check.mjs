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
 *   node tools/hardware-check.mjs /dev/ttyUSB0 --rebuild
 *
 * With `--compare`, every region read is checked byte for byte against a
 * fixture esptool produced. Agreement between two independent implementations
 * is the strongest evidence available without a logic analyser.
 *
 * `--rebuild` is the only test that can settle whether a filesystem this
 * library writes is one a device will mount. Everything else — including the
 * build self-check — reads the image back with code from this repository, and
 * a builder and a reader written from the same understanding of a format agree
 * with each other whether or not that understanding is right. So this edits
 * each filesystem, writes it back, resets the board, and reads the chip's own
 * driver reporting what it found. THE BOARD MUST BE RUNNING fixture_verify,
 * not fixture_device: the provisioner reformats everything on boot.
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
import { parseFat } from '../src/format/fs/fat.js';
import { FsStore } from '../src/format/fs/store.js';
import { buildFs } from '../src/format/fs/build.js';
import { crc32 } from '../src/binary/hash.js';
import { parsePartitionTable, PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE } from '../src/format/partition.js';
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
const rebuild = args.includes('--rebuild');

if (!path) {
  console.error(
    'usage: node tools/hardware-check.mjs <port> [--compare <dir>] [--baud <rate>] ' +
      '[--chunk <bytes>] [--rebuild]',
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

/**
 * The filesystems a rebuild is tried on, by partition label.
 *
 * Found in the device's own partition table rather than at fixed offsets: a
 * rebuild writes, and writing to an address worked out from a stale constant
 * is the one mistake in this file that could destroy something.
 */
const REBUILDABLE = {
  spiffs: parseSpiffs,
  littlefs: parseLittlefs,
  ffat: parseFat,
};

/**
 * What the device should report for an image, in the verifier's own format.
 *
 * @param {import('../src/format/fs/store.js').FsStore} store
 * @returns {Map<string, string>} Path to "size crc32".
 */
function expectedListing(store) {
  const out = new Map();
  for (const entry of store.entries) {
    if (entry.directory) continue;
    out.set(entry.path, `${entry.data.length} ${crc32(entry.data).toString(16)}`);
  }
  return out;
}

/**
 * Reads the verifier's output off the serial line after a reset.
 *
 * @param {BridgeTransport} port
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function readVerifierOutput(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let text = '';
  while (Date.now() < deadline) {
    try {
      text += decoder.decode(await port.read({ timeoutMs: 1000 }), { stream: true });
    } catch {
      // A quiet second is normal while the chip boots; only the outer
      // deadline decides that nothing is coming.
      continue;
    }
    if (text.includes('VERIFY END')) break;
  }
  return text;
}

/**
 * Turns the verifier's output into the same shape as {@link expectedListing}.
 *
 * @param {string} text
 * @returns {Map<string, {mounted: boolean, files: Map<string, string>}>}
 */
function parseVerifierOutput(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const fsLine = /^FS (\S+) (mounted|UNMOUNTABLE|end)$/.exec(line.trim());
    if (fsLine) {
      if (fsLine[2] === 'end') current = null;
      else {
        current = { mounted: fsLine[2] === 'mounted', files: new Map() };
        out.set(fsLine[1], current);
      }
      continue;
    }
    const fileLine = /^F (\S+) (\d+) ([0-9a-fA-F]+)$/.exec(line.trim());
    if (fileLine && current) {
      current.files.set(fileLine[1], `${Number(fileLine[2])} ${fileLine[3].toLowerCase()}`);
    }
  }
  return out;
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

  if (rebuild) {
    console.log('\nrebuilding filesystems and writing them back');
    console.log('       the board must be running fixture_verify, not fixture_device');

    const table = parsePartitionTable(
      await flash.read(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE),
    );
    /** @type {Map<string, Map<string, string>>} */
    const expected = new Map();

    for (const [label, parse] of Object.entries(REBUILDABLE)) {
      const partition = table.partitions.find((p) => p.label === label);
      if (!partition) {
        console.log(`       no "${label}" partition on this board; skipping`);
        continue;
      }

      const before = await flash.read(partition.offset, partition.size, chunkSize ? { chunkSize } : {});
      const image = parse(before);
      if (image.files.length === 0) {
        check(false, `${label}: nothing to rebuild — is the filesystem formatted?`);
        continue;
      }

      const store = FsStore.from(image);
      // An edit of each kind, so a rebuild that quietly drops one is visible.
      // The marker also proves the device is reading the new image rather than
      // a cached copy of the old one.
      //
      // Its name is chosen, not arbitrary. Spaces and more than 8.3 characters
      // force FAT to write long-name entries, which nothing the provisioning
      // sketch creates needs — so without this the whole long-name path, read
      // and written, would never meet a real device. It still fits inside the
      // 31 bytes SPIFFS can name.
      store.write('/rebuilt by esp-flashjs.txt', 'written by esp-flashjs\n');
      store.write('/hello.txt', 'replaced by esp-flashjs\n');
      store.delete('/empty.txt');

      /** @type {Uint8Array} */
      let built;
      try {
        built = buildFs(store, { size: partition.size, source: before });
      } catch (error) {
        check(false, `${label}: build failed (${/** @type {Error} */ (error).message})`);
        continue;
      }
      check(true, `${label} rebuilt (${built.length} bytes)`);

      await flash.write(partition.offset, built, { verify: true });
      check(true, `${label} written back and verified against the flash`);
      expected.set(label, expectedListing(store));
    }

    if (expected.size > 0) {
      console.log('\nresetting into the application to see whether it mounts them');
      // The application talks at 115200 whatever rate the stub was raised to.
      if (transport.baudRate !== 115200) await transport.setBaudRate(115200);
      await loader.disconnect({ reset: true });
      await transport.flushInput();

      const text = await readVerifierOutput(transport, 25000);
      if (!text.includes('VERIFY END')) {
        check(false, 'the verifier never reported; is fixture_verify flashed?');
        console.log(`       last output: ${text.trim().split(/\r?\n/).slice(-4).join(' | ')}`);
      } else {
        const reported = parseVerifierOutput(text);
        for (const [label, files] of expected) {
          const got = reported.get(label);
          // This is the claim the whole exercise exists to test. Everything
          // before it was this repository checking its own work.
          check(Boolean(got?.mounted), `${label}: the device mounted the rebuilt image`);
          if (!got?.mounted) continue;

          for (const [path, signature] of files) {
            const found = got.files.get(path);
            check(found === signature, `${label}${path} reads back as ${signature}`);
            if (found !== undefined && found !== signature) {
              console.log(`       device says ${found}`);
            }
          }
          const extra = [...got.files.keys()].filter((path) => !files.has(path));
          check(extra.length === 0, `${label}: nothing the rebuild did not put there`);
          if (extra.length > 0) console.log(`       also found: ${extra.join(', ')}`);
        }
      }
    }
  }
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
