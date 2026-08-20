# ESP FlashJS

**JavaScript toolkit for ESP32 flash analysis, editing and programming.**

[日本語 README](./README.ja.md) · [Documentation](./docs/README.md)

[![npm](https://img.shields.io/npm/v/esp-flashjs)](https://www.npmjs.com/package/esp-flashjs)
[![CI](https://github.com/tanakamasayuki/esp-flashjs/actions/workflows/ci.yml/badge.svg)](https://github.com/tanakamasayuki/esp-flashjs/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/esp-flashjs)](./LICENSE)

### ▶ Try it now: **<https://tanakamasayuki.github.io/esp-flashjs/>**

Open it in Chrome or Edge and connect a board — nothing to install. Without a
device, drop a `.bin` file in and analyze it offline.
[Examples](https://tanakamasayuki.github.io/esp-flashjs/examples/)

---

Read, analyze, edit and write back ESP32 flash memory from JavaScript. The
library has no runtime dependencies and no build step: it is plain ESM that
browsers and Node.js run as-is.

```js
import { parsePartitionTable } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@1.1.0/dist/esp-flashjs.core.min.js';

const table = parsePartitionTable(bytes);
console.log(table.partitions);
```

---

## Three ideas

**Library first.** Every parser and builder works without a UI. The web app is
a consumer of the same public API you get from npm — nothing is reachable from
the GUI that is not reachable from code.

**Binary first.** You do not need hardware. Drop a `flash.bin`, `nvs.bin` or
firmware image into the page and analyze it offline. Data read from a device and
data read from a file go through the same code path.

**Buildless.** The sources are ES2022 modules with JSDoc types. `dist/` bundles
exist for convenience, not because anything requires them.

## Status

Released on [npm](https://www.npmjs.com/package/esp-flashjs).

The protocol stack, all the formats and the reference web app are implemented:
chip detection, the flasher stub, read/write/erase/verify/dump, partition
tables, firmware images, otadata, core dumps, and NVS, SPIFFS, LittleFS and
FAT — parsed, edited and rebuilt, from the API and from the web app alike.

Every one of them is tested against flash captured from an ESP32, an ESP32-S3
and an ESP32-P4 rather than against images this project generated. See
[test fixtures](./tools/fixture-device/README.md) for why that distinction
turned out to matter — nine faults survived a complete, passing test suite
until real captures replaced the generated ones — and
[the roadmap](./docs/spec.md#23-roadmap) for what is left.

**0.1.0 was a test release** published before any hardware was available, and
could not complete a session against a device. Do not use it.

## Install

```sh
npm install esp-flashjs
```

```js
// Everything, including Web Serial.
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// Parsers and binary utilities only — no serial code, smaller, runs in Node.
import { parsePartitionTable, analyzeBinary } from 'esp-flashjs/core';
```

On npm: <https://www.npmjs.com/package/esp-flashjs>

Or from a CDN, with no install at all:

```html
<script type="module">
  import { analyzeBinary } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@1.1.0/dist/esp-flashjs.min.js';
</script>
```

Pin the version. Unpinned CDN URLs break other people's pages when a major
release lands.

## Usage

### Analyze a file, no device

```js
import { analyzeBinary, parsePartitionTable } from 'esp-flashjs/core';

const result = analyzeBinary(bytes);
console.log(result.type);        // 'partition-table' | 'esp-image' | 'nvs' | 'spiffs' |
                                 // 'littlefs' | 'fat' | 'otadata' | 'coredump' |
                                 // 'raw' | 'encrypted?'
console.log(result.confidence);  // 0.0 – 1.0
console.log(result.regions);     // byte ranges, for highlighting in a hex view
console.log(result.issues);      // problems found, as stable codes
```

Analysis never throws on damaged input. Problems are reported through `issues`
and the recoverable parts are still returned, because a corrupted image is
usually the one you most want to look at.

### Talk to a device

```js
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// Must be inside a click handler: the browser only opens the port picker
// during a user gesture.
const transport = await WebSerialTransport.request();
const loader = new EspLoader(transport);

await loader.connect();      // reset → sync → identify the chip
await loader.loadStub();     // returns false on failure; the session stays usable

const flash = new EspFlash(loader);
const info = await flash.getInfo();

const table = await flash.read(0x8000, 0xc00, {
  onProgress: ({ done, total }) => console.log(done, '/', total),
});

await loader.disconnect();
```

### Read settings and files out of a device

```js
import { parseNvs, parseSpiffs } from 'esp-flashjs/core';

// NVS: namespaces, keys, values — and the entries a rewrite left behind.
const nvs = parseNvs(await flash.read(0x9000, 0x5000));
console.log(nvs.get('wifi', 'ssid')?.value);
console.log(nvs.erasedEntries.length);

// SPIFFS, LittleFS and FAT all return the same shape.
for (const file of parseSpiffs(await flash.read(0x290000, 0x50000)).files) {
  if (!file.directory) console.log(file.path, file.size, file.read().length);
}
```

Editing NVS and writing it back, extracting files, comparing two images and
everything else is in **[the guide](./docs/guide.md)**, which is the place to
start if you are doing more than looking.

### The stub is not optional for reading

The ESP32 ROM bootloader implements no `READ_FLASH`, `ERASE_FLASH` or
`ERASE_REGION` command. Reading flash, dumping, reading a partition and
everything built on top require the flasher stub to be uploaded into RAM first.

`loadStub()` returns `false` instead of throwing when that fails, so writing
still works and the app can degrade rather than die. `flash.read()` then throws
`UnsupportedOperationError` with `code === 'REQUIRES_STUB'`.

### Errors carry codes, not sentences

```js
try {
  await flash.read(0, 1024);
} catch (error) {
  if (error.code === 'REQUIRES_STUB') { /* … */ }
}
```

Every error has a stable `code` and a `details` object. `message` is English
and meant for developers. The library never produces user-facing prose — that
is the application's job, which is what makes the reference app translatable
without patching the library.

## Chip support

Chip definitions cover the current ESP32 family. Verification on real hardware
is another matter, and the table says which is which rather than implying they
are the same thing.

| Chip | Detection | Tested on hardware |
| --- | --- | --- |
| ESP32 | magic register | yes |
| ESP32-S2 | magic register | not yet |
| ESP32-S3 | chip id | yes |
| ESP32-C2 | chip id | not yet |
| ESP32-C3 | chip id | not yet |
| ESP32-C5 | chip id | not yet |
| ESP32-C6 | chip id | not yet |
| ESP32-C61 | chip id | not yet |
| ESP32-H2 | chip id | not yet |
| ESP32-P4 | chip id | yes |

"Tested" means a board of that chip was erased, provisioned with a known
partition table, NVS contents, three filesystems and a core dump, read back,
and the result committed as a test fixture. The bootloader offset alone differs across those
three (0x1000, 0x0 and 0x2000), which is the kind of thing one board cannot
tell you.

ESP8266 is out of scope: the protocol overlaps, but partition tables and image
formats do not.

## Browser support

Web Serial is required to reach a device, and needs a secure context. That means
Chrome, Edge and other Chromium-based **desktop** browsers, over HTTPS or
`http://localhost`.

Firefox and Safari can still import files and analyze them offline. The app
detects this and disables only the connection controls.

## Safety

Writing flash can leave a board unable to boot, so the library and the app both
take that seriously:

- Reads, exports and analysis are separated from writes and erases in the UI.
- Writes back up the target region first, and abort if the backup fails.
- Destructive operations require typing the partition label, not ticking a box.
- Misaligned or out-of-range operations throw rather than being rounded or
  truncated to something plausible.
- Encrypted regions are labelled as such and never presented as decoded.
  Decryption is out of scope and will not be implemented.

## Development

```sh
npm install
npm run dev            # http://localhost:8080/web/

npm run check          # everything CI runs: tests, types, layers, locales
npm test               # node:test, no hardware needed
npm run test:watch     # re-run on change
npm run test:coverage  # currently 93.6% of lines
npm run typecheck      # tsc over the JSDoc types
npm run lint:layers    # dependency direction and import hygiene
npm run lint:locales   # missing keys and placeholder mismatches

npm run build          # dist/
npm run build:site     # site/, what Pages serves
npm run fetch-stub     # refresh the flasher stubs
```

Publishing to npm is done from a local machine, in three commands — see the
[release procedure](./docs/release.md).

Tests run against `MockTransport`, an in-memory device that speaks the real SLIP
protocol against a `Uint8Array` standing in for flash. That is what makes the
protocol layer testable in CI.

Sources are plain JavaScript. TypeScript is used only as a checker over JSDoc
comments and to emit `.d.ts` at release time; nothing is transpiled.

See [the development guide](./docs/development.md) for how to write tests,
what `MockTransport` can and cannot simulate, and the manual checklist for
testing against real hardware.

## Documentation

Every document exists in English and Japanese. [docs/README.md](./docs/README.md)
is the index.

| Document | Contents |
| --- | --- |
| [CHANGELOG.md](./CHANGELOG.md) | What changed, in English and Japanese in one file |
| [guide.md](./docs/guide.md) | **Start here.** Every task, worked through |
| [api.md](./docs/api.md) | Every export, grouped by purpose |
| [troubleshooting.md](./docs/troubleshooting.md) | Symptoms, and what they usually mean |
| [spec.md](./docs/spec.md) | Specification: design decisions, protocol, formats, safety |
| [development.md](./docs/development.md) | Setup, testing, hardware checklist |
| [analyzers.md](./docs/analyzers.md) | Writing a binary analyzer plugin |
| [transports.md](./docs/transports.md) | Writing a transport (Node.js, WebUSB, …) |
| [ci.md](./docs/ci.md) | The three GitHub Actions workflows and their setup |
| [release.md](./docs/release.md) | Versioning and the release procedure |
| [publishing.md](./docs/publishing.md) | How npm, CDN and Pages are wired up |

## License

MIT. See [LICENSE](./LICENSE).

Bundled flasher stubs come from
[espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub) and
are dual licensed Apache-2.0 OR MIT; see [NOTICE](./NOTICE).

ESP FlashJS is not an official Espressif Systems project.
