# ESP FlashJS Specification v1.0

**English** · [日本語](./spec.ja.md)

- Audience: implementers working on this repository
- Status: Phases 1–3 implemented and verified against ESP32, ESP32-S3 and ESP32-P4 hardware; this document has been updated to match the code
- Last updated: 2026-08-18

Related: [development.md](./development.md) (development and testing) / [ci.md](./ci.md) (GitHub Actions) / [release.md](./release.md) (release procedure) / [publishing.md](./publishing.md) (distribution)

---

## 1. Overview

**ESP FlashJS** is a general-purpose library for reading, analyzing, editing and
writing back the flash memory of ESP32-family chips from JavaScript.

At its centre is a UI-independent core library. A web application that uses the
Web Serial API in the browser ships alongside it as the official reference
implementation, published on GitHub Pages.

Tagline:

> JavaScript toolkit for ESP32 flash analysis, editing and programming.

### 1.1 What it is for

- Reading, writing and dumping flash on an ESP32 device
- Parsing the ESP partition table, and extracting or updating individual partitions
- Parsing NVS; viewing and editing keys, namespaces and values; rebuilding and writing back
- Parsing data regions such as SPIFFS and LittleFS
- Parsing ESP firmware images
- Offline analysis of a binary file on its own, and editing based on that analysis

### 1.2 Three pillars

1. **Library first.** Every parse and build function is callable without a UI.
   The GUI is merely a consumer of the API. Anything reachable from the web app
   is, as a rule, reachable from an external application through the same API.
2. **Binary first.** Without a device attached, `flash.bin`, `partition.bin`,
   `nvs.bin` and friends can be loaded as files and analyzed. Data read from a
   device and data read from a file go through the same API wherever possible.
3. **Buildless-friendly.** The sources are plain ESM and can be imported
   directly without a build. Minified bundles exist for distribution
   convenience, not as a prerequisite for using the library.

### 1.3 The end goal

```text
Device → Flash → Partition → Data Structure → Edit → Rebuild → Write Back
```

Offering that whole chain as a UI-independent JavaScript API, with ESP FlashJS
Web as the reference implementation that lets someone inspect and edit an
ESP32's flash structure visually from a browser.

---

## 2. Scope

### 2.1 In scope

| Area | Contents |
| --- | --- |
| Transport | Communication abstraction, with a Web Serial implementation |
| Protocol | The ESP ROM / stub loader serial protocol |
| Flash | read / write / erase / verify / dump |
| Partition | Partition table parsing and generation, per-partition operations |
| Image | ESP firmware image parsing |
| NVS | Parsing, editing, rebuilding, diffing |
| Filesystem | SPIFFS, LittleFS and FAT parsing and extraction |
| Binary | Format detection, data for hex views, binary diff |
| Web | A reference implementation exposing all of the above through a GUI |

### 2.2 Explicitly out of scope

- Decrypting or circumventing Flash Encryption and Secure Boot. Encrypted
  regions are only ever *labelled* as encrypted ([19](#19-encrypted-regions)).
- Building ESP-IDF projects.
- **ESP8266 support.** The protocol overlaps substantially, but the format
  ecosystem is a different thing — there is no partition table, for one. A
  future consideration.
- A Node.js CLI. The core runs under Node, but a CLI is outside this
  specification.

### 2.3 Target chips

All current mainstream chips. Stub JSON for every one of them ships with the
package (132 KB in total; it is fetched at runtime rather than inlined, so it
never reaches consumers who only analyze files).

```text
ESP32  /  ESP32-S2  /  ESP32-S3
ESP32-C2 (ESP8684)  /  ESP32-C3  /  ESP32-C5  /  ESP32-C6  /  ESP32-C61
ESP32-H2  /  ESP32-P4
```

Supporting a chip amounts to one entry in the chip definition table plus a stub
JSON file, so the implementation cost barely scales with the count. Coverage
therefore wins.

That said, **verification is limited to the boards actually available.** Each
chip's status is stated in a table in the README, and anything unverified says
so plainly. Nothing may be written in a way that implies a guarantee.

### 2.4 Target browsers

Browsers implementing Web Serial: desktop Chrome, Edge and other Chromium-based
browsers.

In Firefox and Safari, **only binary mode (offline analysis of loaded files)**
is available. The device-connection UI is disabled and explicitly labelled "this
browser does not support Web Serial". Blocking the whole application is not
acceptable.

---

## 3. Key design decisions

Recorded with their reasons, so that "why is it like this?" does not have to be
re-litigated mid-implementation.

| # | Decision | Reason |
| --- | --- | --- |
| 1 | **Write plain JavaScript (ESM), not TypeScript. Express types in JSDoc** | Project policy. Sources stay `.js`, and `tsc` is used as a type checker, never as a transpiler |
| 2 | **No UI framework. Custom Elements plus a hand-rolled minimal store** | Keeps runtime dependencies at zero and the project runnable without a build |
| 3 | **A single npm package, `esp-flashjs`, split into modules by directory** | Given the build setup, splitting packages gains consumers nothing. Keeping `exports` subpaths stable leaves the door open to splitting later |
| 4 | **Fine-grained sources, bundled into `dist` for distribution** | Maintainability during development and a one-file experience for consumers, at the same time |
| 5 | **Flash read and region erase require the stub loader** | The ESP32 ROM loader has no `READ_FLASH(0xd2)`, `ERASE_FLASH(0xd0)` or `ERASE_REGION(0xd1)`. Dump, partition read and NVS analysis all depend on it, making it a Phase 1 requirement ([6.4](#64-the-flasher-stub)) |
| 6 | **Stub JSON is fetched at runtime, never inlined** | Inlining every chip would add a few hundred KB to the bundle and charge it to people doing offline analysis only. Adding a chip becomes "drop in a JSON file" |
| 7 | **Transport is Reader/Writer-based async I/O with timeouts and `AbortSignal`** | A "read N bytes" interface does not survive contact with real serial I/O: SLIP is delimited, so the length is not known in advance |
| 8 | **Filesystems were read-only until rebuilding was verifiable** | Writing an image carries a compatibility risk reading does not, and reading is what makes a device inspectable. Rebuilding landed in Phase 4 once each format had a check the round trip could not fake ([12.2](#122-rebuilding)) |
| 9 | **The UI is multilingual, detecting from `navigator.languages`** | The ESP32 audience is international, and retrofitting i18n means auditing every string. The catalogue is externalized from the start |

---

## 4. Architecture

### 4.1 Layers

Dependencies flow in one direction only, top to bottom. Reversal is forbidden.

```text
┌─────────────────────────────────────────────┐
│  web/            Reference web app           │  DOM / Web Serial / File API
├─────────────────────────────────────────────┤
│  src/index.js    Public API (barrel)         │
├───────────────┬───────────────┬─────────────┤
│  device/      │  format/      │  binary/    │
│  flash ops    │  parse/build  │  utilities  │
│  ・EspFlash   │  ・partition  │  ・Reader   │
│  ・chip info  │  ・image      │  ・Writer   │
│               │  ・nvs        │  ・diff     │
│               │  ・spiffs     │  ・crc/md5  │
├───────────────┼───────────────┴─────────────┤
│  protocol/    │  SLIP, commands, stub loader │
├───────────────┴─────────────────────────────┤
│  transport/   │  Transport abstraction + impl│
└─────────────────────────────────────────────┘
```

**Rules that must hold:**

- `format/` and `binary/` must not depend on `transport/`, `protocol/` or
  `device/`. They are pure functions taking `Uint8Array` and returning
  `Uint8Array` or plain objects.
- No file under `src/` may reference `document`, `window` or `navigator`. The
  sole exception is `transport/web-serial.js` (which uses `navigator.serial`),
  a deliberately isolated entry point.
- Web app logic never migrates into `src/`.

### 4.2 Repository layout

```text
esp-flashjs/
├── README.md                 # English
├── README.ja.md              # Japanese
├── LICENSE                   # MIT
├── NOTICE                    # Attribution for bundled third-party work (flasher stubs)
├── package.json
├── tsconfig.json             # For type checking and .d.ts emission only
├── .gitignore                # node_modules / dist / types / site
│
├── src/                      # The library, buildless ESM
│   ├── index.js              # Public API barrel, everything including device code
│   ├── core.js               # Device-independent barrel, for Node and offline use
│   │
│   ├── transport/
│   │   ├── transport.js      # Abstraction + JSDoc typedefs
│   │   └── web-serial.js     # WebSerialTransport
│   │
│   ├── testing/
│   │   └── mock-transport.js # Simulated device. A Transport, but it speaks the
│   │                         # protocol, so it lives here, not in transport/ (see 4.3)
│   │
│   ├── protocol/
│   │   ├── slip.js           # SLIP encode / decode
│   │   ├── commands.js       # Command constants, packet codec
│   │   ├── loader.js         # EspLoader
│   │   ├── chips.js          # Chip definition table
│   │   ├── stub-loader.js    # Fetching stub JSON and loading it into RAM
│   │   └── stub/             # Per-chip stub JSON (Apache-2.0 OR MIT)
│   │       ├── esp32.json
│   │       ├── esp32s3.json
│   │       └── …
│   │
│   ├── device/
│   │   ├── esp-flash.js      # EspFlash
│   │   └── device-info.js
│   │
│   ├── format/
│   │   ├── registry.js       # Analyzer plugin registry
│   │   ├── partition.js
│   │   ├── image.js
│   │   ├── otadata.js
│   │   ├── fs/
│   │   │   ├── spiffs.js / littlefs.js / fat.js
│   │   │   └── types.js      # the shape all three return
│   │   └── nvs/
│   │       ├── parse.js / build.js / store.js / diff.js
│   │
│   ├── binary/
│   │   ├── reader.js / writer.js
│   │   └── diff.js / search.js / hash.js
│   │
│   └── util/
│       └── errors.js / events.js / hex.js
│
├── web/                      # Reference web app
│   ├── index.html            # Application entry point
│   ├── esp-flashjs.js        # ★ The only outward reference (see 4.4)
│   ├── app.js                # Startup and wiring
│   ├── store.js              # Minimal state management
│   ├── actions.js            # Use cases; all core API calls funnel through here
│   ├── i18n.js               # Locale detection and catalogue loading
│   ├── locales/
│   │   └── en.json / ja.json / zh-Hans.json / zh-Hant.json
│   ├── components/           # Custom Elements
│   │   ├── esp-device-panel.js
│   │   ├── esp-flash-map.js
│   │   ├── esp-file-list.js
│   │   ├── esp-inspector.js
│   │   ├── esp-hex-viewer.js
│   │   ├── esp-confirm-dialog.js
│   │   └── esp-log.js
│   │                         # esp-nvs-tree / esp-nvs-editor arrive in Phase 2,
│   │                         # esp-diff-view in Phase 3
│   └── styles/
│       └── app.css
│
├── examples/                 # Single-purpose samples, one HTML file each
│   ├── index.html            # Index of samples
│   ├── analyze-binary.html   # No device required
│   ├── partition-parser.html # No device required
│   └── flash-read.html       # Web Serial
│
├── docs/                     # English and Japanese (.ja.md) side by side
│   ├── README.md             # Index
│   ├── spec.md               # This document
│   ├── development.md
│   ├── ci.md
│   ├── release.md
│   └── publishing.md
│
├── test/
│   ├── helpers.js            # Fixture builders
│   ├── binary.test.js        # util/ and binary/
│   ├── format.test.js        # format/
│   ├── protocol.test.js      # protocol/ and device/, through MockTransport
│   └── web.test.js           # The DOM-free parts of web/
│
├── scripts/
│   ├── build.js              # esbuild → dist/
│   ├── build-site.js         # → site/ (for GitHub Pages)
│   ├── fetch-stub.js         # Fetch stub JSON from a pinned release
│   ├── check-layers.js       # Dependency direction and import hygiene (CI)
│   ├── check-locales.js      # Missing keys and placeholder mismatches (CI)
│   ├── sync-version.js       # Propagate npm version into the VERSION constant
│   └── serve.js              # Dev HTTP server (zero dependencies)
│
└── .github/workflows/
    ├── ci.yml                # Checks + build
    ├── pages.yml             # GitHub Pages deployment
    └── release.yml           # npm publish
```

**Generated output (all gitignored):**

```text
dist/                         # npm / CDN artifacts
├── esp-flashjs.js            # full, ESM, unminified
├── esp-flashjs.min.js        # full, ESM, minified
├── esp-flashjs.core.js       # device-independent only
├── esp-flashjs.core.min.js
└── stub/*.json               # fetched at runtime, never inlined

types/                        # .d.ts, emitted at release time only
site/                         # what gets uploaded to GitHub Pages
```

### 4.3 Directory responsibilities

Crossing these boundaries is forbidden.

| Directory | Responsibility | May depend on |
| --- | --- | --- |
| `src/util/` | Generic helpers (errors, hex formatting, events) | nothing |
| `src/binary/` | Byte reading/writing, diffing, searching, hashing | `util/` |
| `src/format/` | parse / build per format. **Pure functions only** | `binary/`, `util/` |
| `src/transport/` | I/O abstraction and implementations | `util/` |
| `src/protocol/` | SLIP, commands, chip definitions, stub | `transport/`, `binary/`, `util/` |
| `src/device/` | Flash operation use cases | `protocol/`, `binary/`, `format/`, `util/` |
| `src/testing/` | Simulated device | `protocol/`, `transport/`, `binary/`, `format/`, `util/` |
| `web/` | UI. A consumer of the core API | `src/`, only through `./esp-flashjs.js` |
| `examples/` | Minimal samples | `../src/`. Never `web/` |

`scripts/check-layers.js` verifies in CI that `format/` and `binary/` do not
import `transport/`, `protocol/` or `device/`. The same script also detects
extension-less imports and DOM globals outside `web-serial.js`.

**Why `testing/` is separate:** `MockTransport` implements `Transport`, but
answering commands means interpreting the protocol. Placed in `transport/` it
would reverse the dependency, so it is its own layer above protocol.

### 4.4 Module resolution and paths

The tree must stay resolvable by a browser's native ESM alone, with no build
tool involved.

- Import specifiers are **always relative and always carry the extension**.
  `./slip.js` (yes), `./slip` (no), `slip.js` (no — that is a bare specifier).
- There is **no implicit resolution** to a directory's `index.js`. Write
  `./format/nvs/parse.js` in full.
- Nothing under `src/` may reference `web/`. The direction is one-way.
- File-relative resources (stub JSON) use
  `new URL('./stub/esp32.json', import.meta.url)`, which resolves whether the
  module was loaded from npm, a CDN, Pages or a local checkout.

**The role of `web/esp-flashjs.js` (important):**

Every reference from `web/` into `src/` is funnelled through this one file.

```js
// web/esp-flashjs.js — its entire contents in the repository
export * from '../src/index.js';
```

Every other file under `web/` reaches the core through `./esp-flashjs.js` (or
`../esp-flashjs.js` from `components/`). **No file inside `web/` may write
`../src/` directly.**

With that in place, when `build-site.js` assembles `site/` and moves the
contents of `web/` to the site root, **this is the only file that needs
rewriting** (see [publishing.md](./publishing.md) §2.2). Everything else inside
`web/` refers to siblings, so relocation cannot break it.

### 4.5 Coding conventions

| Item | Convention |
| --- | --- |
| Language | ECMAScript 2022 or later, ESM only. No CommonJS |
| Transpilation | **None.** Only syntax browsers and Node.js accept natively. `dist` generation is esbuild bundling and minification, with no syntax transform |
| Types | JSDoc. `@typedef` blocks at the top of each module. Every file carries `// @ts-check`, and passing CI's `tsc --noEmit --checkJs` is mandatory |
| Runtime dependencies | **Zero.** devDependencies are esbuild and typescript only |
| Numbers | Flash addresses and sizes are `Number` (16 MB is safely representable). `BigInt` only for NVS U64/I64 |
| Byte arrays | Always `Uint8Array`. Neither `ArrayBuffer` nor `Buffer` appears at an API boundary |
| Endianness | Every ESP format is little-endian. `ByteReader` defaults to LE |
| Naming | PascalCase classes, camelCase functions, SCREAMING_SNAKE_CASE constants |
| Async | Promises. Long operations accept `AbortSignal` and `onProgress` |
| Side effects | No I/O or global registration at module top level (the default analyzer registration in `registry.js` excepted) |
| Messages | No user-facing text in `src/`. Errors carry a stable `code`; translation belongs to `web/locales/` |

---

## 5. Transport layer

### 5.1 Interface

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(opts?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<Uint8Array>} read
 *   Returns one chunk of received bytes. Throws TransportTimeoutError on timeout
 * @property {(baudRate: number) => Promise<void>} [setBaudRate]
 * @property {(signals: {dtr?: boolean, rts?: boolean}) => Promise<void>} [setSignals]
 *   Required to enter the bootloader. Undefined when unsupported
 * @property {() => Promise<void>} [flushInput]
 */
```

`read()` does not take a length because SLIP frames are delimited by `0xC0` and
their length is not known in advance. Frame assembly is `protocol/slip.js`'s job.

A transport without `setSignals` cannot enter the bootloader automatically. In
that case the UI walks the user through holding BOOT and pressing EN.

### 5.2 WebSerialTransport

```js
new WebSerialTransport(port, { baudRate = 115200 })
WebSerialTransport.request(filters?)  // -> Promise<WebSerialTransport>, wraps navigator.serial.requestPort()
WebSerialTransport.list()             // -> Promise<WebSerialTransport[]>, already-permitted ports
```

- `navigator.serial.requestPort()` may only be called **inside a user gesture**.
  It is therefore separate from `open()`.
- Baud rate changes go through `port.close()` then `port.open({baudRate})`. Wait
  roughly 35 ms after sending CHANGE_BAUDRATE before reopening.
- Attempt `port.close()` when the page unloads (`beforeunload`).

Note that Web Serial spells the control lines `dataTerminalReady` and
`requestToSend`. The Transport interface uses `dtr`/`rts` because that is what
the hardware documentation calls them, and `WebSerialTransport` translates. Do
not let the browser's naming leak into the protocol layer.

### 5.3 MockTransport

Given a fixture flash image, it answers SLIP commands the way a real device
would. **Mandatory** — it is what allows CI to run without hardware. See
[development.md §3.4](./development.md#34-mocktransport-the-protocol-without-hardware).

---

## 6. Protocol layer

### 6.1 SLIP framing

- Frames begin and end with `0xC0`.
- Inside a frame, `0xC0` becomes `0xDB 0xDC` and `0xDB` becomes `0xDB 0xDD`.
- Escaping happens **after** the checksum is computed.

```js
slipEncode(payload)  // -> Uint8Array
class SlipDecoder { push(chunk): Uint8Array[] }
```

### 6.2 Packet format

Request (8-byte header + data):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Direction = `0x00` |
| 1 | 1 | Command |
| 2 | 2 | Data length (LE) |
| 4 | 4 | Checksum (LE) — meaningful for data commands only |
| 8 | n | Data |

Response:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Direction = `0x01` |
| 1 | 1 | Command (echoing the request) |
| 2 | 2 | Data length (LE) |
| 4 | 4 | Value (the READ_REG result) |
| 8 | n | Data + status bytes |

**Locating the status bytes (important)**

The response payload is laid out as `[data][status(2)][reserved(2)]`, where
`data` is **however many bytes the issued command is defined to return** and the
trailing reserved pair is only present on ESP32-family ROM loaders.

That means **the status position cannot be inferred from the payload length**.
An implementation that counts from the end lands two bytes off depending on
whether the reserved pair is there. The caller must declare how much data it
expects.

```js
decodeResponse(frame, responseDataLength = 0)
loader.command(op, payload, { responseDataLength })
```

`status[0] !== 0` means failure, with `status[1]` as the error code. When the
payload is shorter than `responseDataLength + 2`, treat it as a device refusing
the command outright and read the status from the first two bytes.

Only two commands have a variable data length: `GET_SECURITY_INFO` (20 or 12)
and `SPI_FLASH_MD5` (32 hex characters from the ROM, 16 raw bytes from the
stub). Both pass a function as `responseDataLength` to decide at runtime.

The checksum applies only to the data commands (`FLASH_DATA`, `MEM_DATA`,
`FLASH_DEFL_DATA`): XOR the payload byte by byte into a `0xEF` seed.

### 6.3 Commands

Common to ROM and stub:

| Opcode | Name | Purpose |
| --- | --- | --- |
| `0x02` | FLASH_BEGIN | Begin a write |
| `0x03` | FLASH_DATA | Write data |
| `0x04` | FLASH_END | End a write |
| `0x05` | MEM_BEGIN | Begin a RAM transfer (for stub loading) |
| `0x06` | MEM_END | End a RAM transfer and jump to the entry point |
| `0x07` | MEM_DATA | RAM transfer data |
| `0x08` | SYNC | Synchronize (`07 07 12 20` + `0x55` × 32) |
| `0x09` | WRITE_REG | Write a 32-bit register |
| `0x0a` | READ_REG | Read a 32-bit register |
| `0x0b` | SPI_SET_PARAMS | Configure flash parameters |
| `0x0d` | SPI_ATTACH | Attach the SPI flash |
| `0x0f` | CHANGE_BAUDRATE | Change the baud rate |
| `0x10` | FLASH_DEFL_BEGIN | Begin a compressed write |
| `0x11` | FLASH_DEFL_DATA | Compressed write data |
| `0x12` | FLASH_DEFL_END | End a compressed write |
| `0x13` | SPI_FLASH_MD5 | MD5 of a flash region |

**Stub loader only:**

| Opcode | Name |
| --- | --- |
| `0xd0` | ERASE_FLASH (whole chip) |
| `0xd1` | ERASE_REGION |
| `0xd2` | READ_FLASH |
| `0xd3` | RUN_USER_CODE |

### 6.4 The flasher stub

**The ROM loader can neither read flash nor erase a region.** Since that
underpins this project's core features — flash dump, partition read, NVS
analysis — loading the stub is a Phase 1 requirement.

**Source and licence:**

- Use the release JSON from Espressif's
  [esp-flasher-stub](https://github.com/espressif/esp-flasher-stub) (the Rust
  implementation). It is **dual licensed Apache-2.0 OR MIT** and can therefore
  ship inside this MIT repository.
- The older [esptool-legacy-flasher-stub](https://github.com/espressif/esptool-legacy-flasher-stub)
  is **GPL-2.0 and must not be used.** To keep it from arriving by accident,
  fetching goes through `scripts/fetch-stub.js` with a pinned release URL, and
  the source tag is recorded in `src/protocol/stub/README.md`.

**Distribution:**

The JSON is not inlined. It ships as individual `src/protocol/stub/<chip>.json`
files, fetched at runtime.

```js
// stub-loader.js
const url = new URL(`./stub/${chip.stub}.json`, import.meta.url);
```

Anchoring on `import.meta.url` makes it resolve from npm, a CDN, Pages or a
local checkout alike. `dist/` ships the same files at the same relative position
as `dist/stub/*.json`.

**Load sequence:** `MEM_BEGIN` → `MEM_DATA`×n → `MEM_END(entry)` for the text
and data segments in turn, then wait for `OHAI` from the stub.

**Fallback:** if the stub fails to load, fall back to ROM mode and disable, in
the UI, flash read, flash dump, partition read, erase region, and every analysis
feature that presumes a read. Writing and whole-chip erase (via the erase
implied by FLASH_BEGIN) remain available.

### 6.5 Chip detection

**There is more than one detection method.** Two, split by generation, and both
must be tried in order.

| Generation | Method |
| --- | --- |
| ESP32, ESP32-S2 | Read `CHIP_DETECT_MAGIC_REG = 0x40001000` via `READ_REG` and match the magic value |
| ESP32-S3 onwards | Match the **chip id** returned by `GET_SECURITY_INFO (0x14)`. These parts carry no unique magic value |

Procedure:

1. Issue `GET_SECURITY_INFO`. A response body of 22 bytes or more is the 20-byte
   form (with a chip id); anything shorter is the 12-byte form (ESP32-S2, which
   omits it).
2. If a chip id comes back and matches a known `IMAGE_CHIP_ID`, use it.
3. Otherwise read the magic register and consult the magic table.
   - The ESP32 does not implement `GET_SECURITY_INFO` at all, so step 1 fails.
     That is a normal path, not an error.
4. If neither identifies the part, raise `UnknownChipError`. The UI states that
   the chip is unrecognized and flash operations are unavailable. **Never guess
   and treat it as a known chip.**

Secure Download Mode also blocks register reads, so step 3 can fail too.

```js
/**
 * @typedef {object} ChipDef
 * @property {string} name             - "ESP32-S3"
 * @property {number} imageChipId      - IMAGE_CHIP_ID, same value as the GET_SECURITY_INFO chip id
 * @property {boolean} usesMagicValue  - false means identifiable only by chip id
 * @property {number|null} magicValue
 * @property {string} stub             - stub JSON file name
 * @property {number} flashWriteSize
 * @property {number} ramBlockSize
 * @property {number} bootloaderOffset
 * @property {number} macEfuseReg
 * @property {number} spiRegBase       - the following are needed for RDID-based flash size detection
 * @property {number} spiUsrOffs
 * @property {number} spiUsr1Offs
 * @property {number} spiUsr2Offs
 * @property {number} spiMosiDlenOffs
 * @property {number} spiMisoDlenOffs
 * @property {number} spiW0Offs
 * @property {boolean} spiAddrRegMsb
 * @property {Array<{start:number,end:number,name:string}>} memoryMap
 * @property {string[]} features       - stable ids, used as translation keys
 */
```

Magic values and register addresses are verified against esptool's target
definitions. A wrong value here is fatal, so always go back to the primary
source when updating.

**Flash size detection** issues RDID (0x9F) through the SPI controller's "user
command" registers and looks up the capacity byte of the returned JEDEC ID. The
SPI register base and offsets differ per chip, which is why they live in
`ChipDef`. When detection fails the result is `null` and **must not be filled in
with a default** — a wrong size silently truncates a dump.

### 6.6 Entering the bootloader (reset strategy)

For transports with `setSignals`, run the classic reset sequence:

```text
DTR=false, RTS=true   → 100ms   (EN low, holding reset)
DTR=true,  RTS=false  → 50ms    (IO0 low, EN high, so it boots into download mode)
DTR=false             → 50ms
```

Parts with USB-Serial/JTAG built in (C3, S3, C6 and others) sometimes ignore
this, so on failure retry once with a different variant. If SYNC still does not
land, fall back to instructing the user.

`SYNC` retries up to seven times with a 100 ms timeout each.

### 6.7 EspLoader API

```js
const loader = new EspLoader(transport, { onLog });
await loader.connect({ signal });         // reset → sync → chip detection
await loader.loadStub();                  // false on failure; stays in ROM mode
loader.chip                               // -> ChipDef
loader.isStub                             // -> boolean
await loader.command(op, data, { timeoutMs, responseDataLength });
await loader.readReg(addr);
await loader.changeBaudRate(921600);
await loader.disconnect({ reset: true });
```

---

## 7. Flash operations

```js
const flash = new EspFlash(loader);

await flash.getInfo();                                      // -> DeviceInfo
await flash.read(address, size, { onProgress, signal, chunkSize, attempts });
//   -> Uint8Array; stub required
//
// A READ_FLASH transfer is all-or-nothing: the stub sends one MD5 for the
// whole range, so a single lost byte discards everything read so far. Reads
// are therefore split into chunkSize pieces (256 KB by default), each retried
// up to `attempts` times (3). A link that drops bytes at all can never deliver
// a multi-megabyte range in one transfer, however often it is retried.
await flash.write(address, data, { compress = true, verify = false, onProgress, signal });
await flash.eraseRegion(address, size);                     // stub required, 4 KB aligned
await flash.eraseAll();
await flash.verify(address, data);                          // -> {ok, expected, actual}, MD5 comparison
await flash.dump({ size, onProgress, signal });             // -> Uint8Array
```

### 7.1 Constraints and validation

| Item | Rule |
| --- | --- |
| Write alignment | `address` on a 4-byte boundary. Otherwise `AlignmentError` |
| eraseRegion | Both `address` and `size` multiples of 4096. Otherwise `AlignmentError` |
| Out of range | `address + size > flashSize` throws. **Never truncate** |
| Write block size | Follows the chip's `flashWriteSize` (usually 0x400) |
| Read | Pass the requested size and block size to the stub's READ_FLASH, receive the stream, and verify with MD5 |
| Verify | Uses `SPI_FLASH_MD5`. Reading back for comparison is the fallback |
| Progress | Call `onProgress({ done, total, phase })` at least once per 64 KB |
| Cancellation | Check `signal.aborted` at each block boundary and throw. The error's message states that flash contents in the target region are now undefined |

### 7.2 Compressed writes

`FLASH_DEFL_*` requires zlib deflate. **To preserve zero runtime dependencies,
use `CompressionStream('deflate')`.** Where unavailable, fall back automatically
to uncompressed `FLASH_*` — `compress: true` means "compress if possible".

### 7.3 DeviceInfo

```js
/**
 * @typedef {object} DeviceInfo
 * @property {string} chip            - "ESP32-S3" | "unknown"
 * @property {string} revision        - "v0.1" | "unknown"
 * @property {string} mac             - "24:0a:c4:xx:xx:xx" | "unknown"
 * @property {number|null} flashSize  - bytes, null when undetectable
 * @property {number|null} flashId
 * @property {string[]} features      - ["wifi", "ble", …], stable ids used as translation keys
 * @property {boolean} secureDownloadMode
 * @property {boolean} secureBootEnabled
 * @property {boolean|null} flashEncryptionEnabled
 * @property {boolean} usingStub
 * @property {number} bootloaderOffset
 */
```

Anything not obtainable is `"unknown"` or `null`, and **never filled in with an
estimate**.

On a chip with Secure Download Mode enabled, flash reads and RAM writes are
prohibited. On detection, show a warning banner at the top of the UI and disable
read operations.

---

## 8. Partition table

### 8.1 Format

- Default offset `0x8000`, region size `0xC00` (3072 bytes = up to 95 entries
  plus the MD5 entry).
- Each entry is 32 bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | Magic. **The bytes `AA 50`** (0x50AA read as a little-endian u16 — see below) |
| 2 | 1 | Type |
| 3 | 1 | Subtype |
| 4 | 4 | Offset |
| 8 | 4 | Size |
| 12 | 16 | Label (NUL-terminated ASCII) |
| 28 | 4 | Flags |

- MD5 checksum entry: magic `0xEBEB`, with the MD5 of everything preceding it in
  the 16 bytes from offset 16.

> **Mind the magic byte order.** Espressif's `gen_esp32part.py` defines it as the
> byte string `b"\xAA\x50"` and compares it raw, so flash carries `AA 50`, which
> read back as a little-endian u16 is **`0x50AA`**, not `0xAA50`.
>
> Getting this backwards produces **a parser that only accepts the tables it
> generated itself**. A parse/build round trip cannot detect it, because both
> sides share the same wrong constant — which is how it shipped in v0.1.0. Keep
> fixtures transcribed from real hardware (`test/real-hardware.test.js`).
- The table ends with `0xFF` padding, or simply with no further entries.

### 8.2 API

```js
parsePartitionTable(data, { offset = 0 })     // -> PartitionTable
buildPartitionTable(table)                    // -> Uint8Array (0xC00, 0xFF padded, with MD5)
validatePartitionTable(table, { flashSize })  // -> Issue[]
```

```js
/**
 * @typedef {object} Partition
 * @property {string} label
 * @property {number} type
 * @property {number} subtype
 * @property {string} typeName      - "app" | "data" | "unknown"
 * @property {string} subtypeName   - "factory" | "ota_0" | "nvs" | "spiffs" | "unknown"
 * @property {number} offset
 * @property {number} size
 * @property {number} flags
 * @property {boolean} encrypted    - flags bit 0
 * @property {number} entryIndex
 */

/**
 * @typedef {object} PartitionTable
 * @property {Partition[]} partitions
 * @property {boolean} hasMd5
 * @property {boolean} md5Valid     - true when there is no MD5 entry to disagree with
 * @property {Issue[]} issues
 */
```

`validatePartitionTable` must detect:

- Overlapping regions
- Extending past the end of flash
- An app partition not on a 64 KB boundary
- Duplicate labels
- A factory partition alongside ota_x slots (warning)
- ota_x slots with no otadata partition (error)

An Issue is `{ level: 'error'|'warning', code, params?, partitionIndex? }`. **It
carries a `code`, not display text** ([16.8](#168-internationalization)). Parsing
does not abort on an Issue; it returns as much as it can.

Note that validation derives type and subtype names from the raw values rather
than trusting the cached `typeName`/`subtypeName` fields. Callers building a
table by hand often leave those blank, and a silently skipped OTA check is worse
than a redundant lookup.

### 8.3 Known types and subtypes

```text
app  (0x00): factory(0x00), ota_0..ota_15(0x10-0x1F), test(0x20)
data (0x01): ota(0x00), phy(0x01), nvs(0x02), coredump(0x03), nvs_keys(0x04),
             efuse(0x05), undefined(0x06), esphttpd(0x80), fat(0x81),
             spiffs(0x82), littlefs(0x83)
```

Unknown values keep the name `unknown` while retaining the raw number, and are
**never discarded**.

### 8.4 Per-partition operations

With a partition selected, the following are offered.

| Operation | Effect | Destructive |
| --- | --- | --- |
| Read Partition | `flash.read(p.offset, p.size)` into a buffer | No |
| Export Partition | Save the buffer as `<label>.bin` | No |
| Analyze | `analyzeBinary(data, { partition: p })` | No |
| Import Partition | Load a file as this partition's buffer | No |
| Replace | Swap the buffer contents, in memory only | No |
| Write Partition | Write the buffer back with `flash.write(p.offset, data)` | **Yes** |
| Erase Partition | `flash.eraseRegion(p.offset, p.size)` | **Yes** |
| Verify | `flash.verify(p.offset, data)` | No |

- If an imported or replaced buffer exceeds the partition size, that is an
  error — **never truncate**. If it is smaller, ask the user before padding the
  remainder with `0xFF`.
- Destructive operations always go through the confirmation flow in
  [17. Safety](#17-safety).

The canonical flow, using NVS as the example:

```text
Select the NVS partition
  → Read Partition
  → Analyze with the NVS analyzer
  → Change a value
  → Rebuild the binary (buildNvs)
  → Preview Diff
  → Back up the original
  → Write Partition
  → Verify
```

### 8.5 Flash map (UI representation)

- Stacked vertically in offset order. Height is proportional to the **square
  root** of the size — linear scaling makes a small region like NVS invisible.
  The real size is printed alongside.
- Undefined space between partitions is labelled "Unallocated", including the
  span from `0x0` to the bootloader.
- Colour by type and subtype. The encrypted flag overlays a hatch pattern.
- Clicking shows the partition in the Inspector.

---

## 9. Binary analyzers and plugins

### 9.1 Interface

```js
/**
 * @typedef {object} DetectionResult
 * @property {number} confidence   - 0.0 to 1.0
 * @property {string} [reasonCode]
 */

/**
 * @typedef {object} BinaryRegion
 * @property {number} offset
 * @property {number} length
 * @property {string} label
 * @property {'header'|'data'|'entry'|'padding'|'unknown'} kind
 * @property {BinaryRegion[]} [children]
 */

/**
 * @typedef {object} AnalysisResult
 * @property {string} type
 * @property {number} confidence
 * @property {Record<string, unknown>} metadata
 * @property {BinaryRegion[]} regions
 * @property {Issue[]} issues
 * @property {unknown} [model]   - the format-specific model (PartitionTable, NvsStore, …)
 */

/**
 * @typedef {object} BinaryAnalyzer
 * @property {string} id
 * @property {string} name
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => DetectionResult} detect
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => AnalysisResult} analyze
 */
```

`AnalyzeContext` is `{ offset, partition?, flashSize? }`. When analyzing the
contents of a partition, the subtype can be passed as a hint.

### 9.2 Registration and dispatch

```js
registerAnalyzer(analyzer);
unregisterAnalyzer(id);
listAnalyzers();

detectFormat(data, ctx)         // -> DetectionResult[], descending by confidence
analyzeBinary(data, ctx)        // -> AnalysisResult, runs the highest-confidence analyzer
analyzeBinaryAs(id, data, ctx)  // -> AnalysisResult, format specified explicitly
```

- If every confidence is below 0.3, the `raw` analyzer answers (hex view only).
- Registered by default: `partition-table`, `esp-image`, `otadata`,
  `spiffs`, `littlefs`, `fat`, `nvs`, `raw`.
- A detector that throws is simply not a match; it must never break the sweep.
  If detection succeeds but parsing then throws, the failure is reported against
  the raw view rather than surfacing as an exception.

### 9.3 Confidence scale

| Value | Meaning |
| --- | --- |
| 1.0 | Magic and checksum/MD5 both match |
| 0.8 | Magic matches and the structure is consistent |
| 0.5 | Magic matches but something is inconsistent (possible corruption) |
| 0.3 | Heuristic only (inferred from a hint) |
| 0.0 | No match |

### 9.4 Detecting encryption

High entropy is the only thing a buffer can say about itself here, and it says
less than it appears to. Encrypted bytes and compressed bytes are both
indistinguishable from noise — that is what both are for — and so is a
perfectly ordinary file that happens to contain a byte counter. A LittleFS
image captured from an unencrypted ESP32-S3 in this repository scores a full
8.0 bits/byte for exactly that reason.

So entropy alone never claims encryption. Two better signals are usually to
hand:

- **The device.** `DeviceInfo.flashEncryptionEnabled` comes from an eFuse. A
  chip that says encryption is off is not to be contradicted; opaque bytes
  there are compressed, hashed or already random.
- **The partition table.** Its `encrypted` flag is a *policy* bit — "encrypt
  this partition when flash encryption is enabled" — not a statement that these
  bytes are ciphertext. It means nothing on a chip with encryption off, so it
  is only consulted once that has been ruled out.

`classifyEntropy(entropy, ctx)` combines them into one of four answers:

| Result | When | Reported as |
| --- | --- | --- |
| `encrypted` | Entropy is high and the chip, or the table, says encryption is on | `type = 'encrypted?'` |
| `possibly-encrypted` | Entropy is high and nothing is known about the device | `type = 'encrypted?'` |
| `high-entropy` | Entropy is high and the chip says encryption is **off** | `type = 'raw'`, stated as a fact rather than an accusation |
| `unknown` | Entropy is normal | `type = 'raw'` |

Entropy is measured as the maximum over every 16 KB window, skipping uniform
ones. Sampling a few windows was the first attempt and missed a 64 KB opaque
region sitting between two of them; which part of a partition has been written
is an accident, so all of it is scanned.

**The contents must never look as though they were understood.**

Note that flash encryption does not cover NVS. The analyzer says so when it
sees an NVS partition on an encrypted device, because the chip reporting
"encryption on" invites the opposite conclusion.

### 9.5 Decryption — deliberately not implemented

Accepting a key and decrypting a region in the browser is feasible. WebCrypto
has no XTS mode, but encrypting a single block with AES-CBC and a zero IV is
AES-ECB for that block, which is enough to build XTS-AES on top of — so it
would cost no runtime dependency.

It is not implemented because of who it would help. Under ESP-IDF's default
flow the key is generated on the chip, burned into eFuse and read-protected: it
never leaves the device, and nobody — including this tool — can decrypt that
flash. Decryption only helps someone who generated the key themselves and still
holds the file, and that person already has `espsecure.py`.

Enabling flash encryption is also a one-way door in hardware, so a board
prepared for testing this cannot be used for anything else afterwards.

If it is ever built, what is needed is not an encrypted board but **a key
file**: a device in Development mode whose key was generated externally, plus
the `.bin` that was burned into it. Without that pairing there is nothing to
verify against.

---

## 10. ESP firmware image

### 10.1 Format

Common header (8 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Magic `0xE9` |
| 1 | 1 | Segment count |
| 2 | 1 | SPI mode |
| 3 | 1 | High nibble = flash size, low nibble = flash frequency |
| 4 | 4 | Entry point |

Extended header (ESP32 family, 16 bytes): WP pin, SPI pin drive (3), chip id
(2), min chip rev, min/max chip rev full (2+2), reserved (4), hash appended (1).

Each segment: load address (4) + length (4) + data.
Trailer: padding to a 16-byte boundary, then a one-byte checksum (XOR seeded
with `0xEF`). If hash-appended is 1, a further 32 bytes of SHA-256.

App description (for an app partition, at `0x20` into the first segment): magic
`0xABCD5432`, version[32], project_name[32], time[16], date[16], idf_ver[32],
app_elf_sha256[32].

### 10.2 API

```js
parseEspImage(data)  // -> EspImage
verifyImageHash(data, image)  // -> Promise<boolean|null>, async because it needs WebCrypto
```

```js
/**
 * @typedef {object} EspImage
 * @property {number} entryPoint
 * @property {string} spiMode           - "qio"|"qout"|"dio"|"dout"|"unknown"
 * @property {string} flashSize
 * @property {string} flashFreq
 * @property {number|null} chipId
 * @property {string} chipName
 * @property {Segment[]} segments
 * @property {number} checksum
 * @property {boolean} checksumValid
 * @property {boolean} hashAppended
 * @property {string|null} sha256
 * @property {AppDescription|null} app
 * @property {number} imageLength       - bytes actually used
 * @property {Issue[]} issues
 */
```

`Segment` is `{ index, loadAddress, length, fileOffset }`. `memoryRegionFor()`
classifies a load address against the chip's `memoryMap` into
`"IRAM"|"DRAM"|"IROM"|"DROM"|"RTC"|"unknown"`.

When analyzing an app partition, the UI shows "image `imageLength` bytes /
partition N bytes / M bytes free (X%)".

---

## 11. NVS

> Implemented and verified against NVS partitions captured from three chips.

### 11.1 Format

An NVS partition is a run of 4096-byte pages.

**Page (4096 bytes):**

| Offset | Size | Contents |
| --- | --- | --- |
| 0 | 32 | Page header |
| 32 | 32 | Entry state bitmap (2 bits × 126 entries) |
| 64 | 4032 | Entry area (32 bytes × 126) |

Page header: state(4), seqNo(4), version(1), unused(19), crc32(4)

Page state:

| Value | Meaning |
| --- | --- |
| `0xFFFFFFFF` | UNINITIALIZED |
| `0xFFFFFFFE` | ACTIVE |
| `0xFFFFFFFC` | FULL |
| `0xFFFFFFF8` | FREEING |
| `0xFFFFFFF0` | CORRUPT |

version: `0xFF` = v1, `0xFE` = v2 (v2 is current; v1 is read-only here)

Entry state (bitmap, two bits at a time from the LSB): `0b11` EMPTY,
`0b10` WRITTEN, `0b00` ERASED

**Entry (32 bytes):**

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Namespace index (0 = the namespace definition entry itself) |
| 1 | 1 | Type |
| 2 | 1 | Span (how many 32-byte units this entry occupies) |
| 3 | 1 | Chunk index (`0xFF` for anything but a blob) |
| 4 | 4 | CRC32 |
| 8 | 16 | Key (NUL-terminated ASCII, max 15 characters) |
| 24 | 8 | Data (primitives) or the variable-length header |

For variable-length values (string or blob), offset 24 onwards is size(2),
reserved(2), crc32 of data(4), and the payload occupies the following span-1
entry slots.

**Types:**

| Value | Type | | Value | Type |
| --- | --- | --- | --- | --- |
| `0x01` | U8 | | `0x08` | U64 |
| `0x11` | I8 | | `0x18` | I64 |
| `0x02` | U16 | | `0x21` | STR |
| `0x12` | I16 | | `0x41` | BLOB (v1) |
| `0x04` | U32 | | `0x42` | BLOB_DATA |
| `0x14` | I32 | | `0x48` | BLOB_IDX |

A namespace is declared by an entry with `namespaceIndex = 0`, where the key is
the namespace name and the U8 data is its assigned index.

### 11.2 Parsing

```js
parseNvs(data, { strict = false })  // -> NvsStore
```

- Walk pages in seqNo order and take only entries in the WRITTEN state.
- When the same (namespace, key) appears on several pages, **the one on the page
  with the higher seqNo wins** — that is NVS update semantics.
- A blob is reassembled from as many BLOB_DATA chunks as its BLOB_IDX declares.
  On a missing chunk, raise an Issue and keep the partial data as
  `partial: true`.
- An entry with a CRC mismatch raises an Issue and is **kept** with
  `crcValid: false`, not discarded. Only `strict: true` turns it into an
  exception.
- ERASED entries are not returned by default but are reachable through
  `store.erasedEntries` (for forensic work).

### 11.3 The editing model

```js
/**
 * @typedef {object} NvsEntry
 * @property {string} namespace
 * @property {string} key
 * @property {string} type          - "U8" | "STR" | "BLOB" | …
 * @property {number|bigint|string|Uint8Array} value
 * @property {Uint8Array} raw
 * @property {number} pageIndex
 * @property {number} entryIndex
 * @property {number} span
 * @property {boolean} crcValid
 */
```

```js
const store = parseNvs(binary);

store.namespaces              // -> string[]
store.entries                 // -> NvsEntry[] (a read-only snapshot)
store.list(namespace)         // -> NvsEntry[]
store.get(namespace, key)     // -> NvsEntry | undefined
store.set(namespace, key, value, type?)
store.delete(namespace, key)
store.rename(namespace, key, newKey)
store.addNamespace(name)
store.deleteNamespace(name)   // also removes its entries

store.isDirty                 // -> boolean
store.changes()               // -> NvsChange[], the diff against the original
store.reset()                 // revert to the original
store.original                // -> NvsStore, an immutable snapshot

buildNvs(store, { size, version = 2 })  // -> Uint8Array
```

- The store **never destroys the original**. `parseNvs` keeps an immutable
  snapshot internally and applies changes as an overlay.
- Type inference in `set`: `number` → U32 (I32 if negative), `bigint` → U64/I64,
  `string` → STR, `Uint8Array` → BLOB. To avoid ambiguity the UI always requires
  an explicit type.

### 11.4 Building

Rules for `buildNvs(store, { size })`:

- `size` is the partition size (a multiple of 4096, minimum 3 pages = 12288
  bytes). NVS needs at least one page kept free for garbage collection.
- Pack the namespace definitions first, then the entries, into ACTIVE pages.
  When a page fills, mark it FULL and move on.
- Unused pages are UNINITIALIZED (all `0xFF`).
- seqNo counts up from 0. Recompute the page CRC32 and every entry CRC32.
- If it does not fit, throw `NvsCapacityError`. **Never truncate.**
- **A self-check that re-parses the output and compares it against the source
  store is enabled by default** (disable with `{ selfCheck: false }`).

### 11.5 Diff

```js
diffNvs(before, after)  // -> NvsChange[]
```

```js
/**
 * @typedef {object} NvsChange
 * @property {'added'|'modified'|'deleted'|'renamed'} kind
 * @property {string} namespace
 * @property {string} key
 * @property {unknown} [before]
 * @property {unknown} [after]
 * @property {string} [beforeType]
 * @property {string} [afterType]
 */
```

A type-only change is still `modified`, expressed through
`beforeType !== afterType`.

---

## 12. Filesystems

> Implemented and verified against images captured from three chips.

All three formats parse and rebuild. Each returns the same shape, so the UI
does not have to know which one it is looking at.

```js
parseSpiffs(data, { pageSize = 256, blockSize = 4096, objNameLen = 32, detectGeometry = true })
parseLittlefs(data, { blockSize })     // blockSize comes from the superblock
parseFat(data, { wlDummySector })      // detected when not given
// all -> FsImage
```

```js
/**
 * @typedef {object} FsFile
 * @property {string} path            Absolute, with a leading slash.
 * @property {number} size
 * @property {() => Uint8Array} read  Lazy: reading every file up front costs
 *                                    more than most callers need.
 * @property {number[]} pageIndices   Where the data lives, for a hex view.
 * @property {boolean} complete       False when some of the data is missing.
 * @property {boolean} [directory]
 */
/**
 * @typedef {object} FsImage
 * @property {'spiffs'|'littlefs'|'fat'} type
 * @property {FsFile[]} files
 * @property {Record<string, number>} geometry
 * @property {Issue[]} issues
 */
```

### 12.1 What each format needs that the others do not

**SPIFFS** records nothing about its own geometry, so page and block size have
to be inferred. Candidates are scored on whether the files they find hold
together — not on how many they find. A wrong geometry is not obviously wrong:
read with 128-byte pages, a real image yields all four correct filenames and
scrambled contents, because a divisor of the true page size still lands on
every object index header.

Its page flags are **active low**: a cleared bit is what asserts the flag. Read
the usual way round, every decision inverts at once and the image parses as a
set of correctly named, empty files.

**LittleFS** is a log. A directory is a pair of blocks holding append-only
commits, and its current state is the sum of them; entries are addressed by a
position that earlier commits can shift, so a create or delete moves every
later entry. Geometry is not guessed — the superblock states it.

**FAT** on ESP-IDF sits under a wear-levelling layer that holds one sector
spare and skips it. On a freshly formatted partition that spare lands at
physical sector 1, which leaves the boot sector exactly where a plain FAT
reader looks and everything else one sector out. Ignoring the layer therefore
parses the BPB perfectly and then reads the file allocation table as if it were
the root directory. The spare is located by testing which position puts real
directory entries where the BPB says the root directory is.

The FAT width is decided by cluster count, which is the definition rather than
a heuristic; the `fsType` string in the BPB is documentation and is allowed to
lie.

### 12.2 Rebuilding

```js
FsStore.from(image)                    // -> FsStore, a full copy
store.write(path, bytes)               // add or replace
store.delete(path)                     // a directory takes its subtree
store.rename(from, to)
checkFsStore(store, type)              // -> Issue[], before anything is built
buildFs(store, { size, source })       // -> Uint8Array
```

**Rebuild is restricted to regenerating at the original image's geometry.**
Creating a filesystem from arbitrary parameters is a different job: a partition
formatted with a page size the device was not built for mounts and then
misbehaves, and there is no way to check that from here.

The hard part is not writing the bytes; it is knowing they are right. A builder
and a parser written from the same reading of a format agree with each other
whether or not that reading was correct, and this project has already been
caught by exactly that — SPIFFS page flags were read the wrong way round and
every test passed. So each format is pinned by a check the round trip cannot
satisfy on its own:

| Format | What the round trip cannot see | What is checked instead |
| --- | --- | --- |
| SPIFFS | The parser sweeps every page and never reads an object index; a device only reads the index | `readSpiffsViaIndex` reaches the data the way the device does. It agrees with the parser on the captured images, so agreement on a built one means the index tables are right |
| LittleFS | A metadata pair that is off the tail chain reads back perfectly and is handed out as free space on the device's next write | `littlefsTraverse` walks the chain the block allocator walks, and the build fails if any pair it wrote is unreachable |
| FAT | The wear-levelling state at the end of the partition is not part of any published format | It is never regenerated. `buildFat` requires the source image and carries the boot sector, the spare sector and the tail over untouched, writing through the same mapping the parse used |

Three consequences worth stating plainly:

- **A rebuild compacts.** Deleted pages, superseded entries and the history in
  a LittleFS log all go away. The result holds the same files and is not the
  same bytes.
- **Free space is zeroed in FAT.** A real filesystem only unlinks a deleted
  file, but an image someone is about to publish should not carry the contents
  of one.
- **Modification times are not preserved.** SPIFFS stores an mtime beside each
  name and ESP-IDF's LittleFS stores one as a user attribute; neither survives,
  because the store does not carry them.

What none of this establishes is that a device mounts the result. That needs
hardware, and `tools/hardware-check.mjs --rebuild` is where it happens.

---

## 13. Binary utilities

### 13.1 Diff

```js
diffBinary(a, b, { minGap = 16 })       // -> BinaryDiffChunk[]
diffBinaryStream(a, b, opts)            // -> AsyncGenerator<BinaryDiffChunk>
```

- Compare byte by byte, grouping runs of differences into one chunk.
- A run of identical bytes shorter than `minGap` stays inside the chunk, which
  keeps one changed string from becoming twenty chunks.
- When lengths differ, the excess becomes a trailing chunk marked
  `kind: 'added'|'removed'`.

```js
/**
 * @typedef {object} BinaryDiffChunk
 * @property {number} offset
 * @property {Uint8Array} before
 * @property {Uint8Array} after
 * @property {'modified'|'added'|'removed'} kind
 */
```

Comparing two 16 MB images synchronously on the UI thread freezes the page, so
`diffBinaryStream()` yields control every 1 MB. The UI always uses that form.

### 13.2 Search

```js
searchBytes(data, pattern, { from = 0, limit = 1000 })                   // -> number[]
searchText(data, text, { encoding = 'utf-8', caseInsensitive = false })  // -> number[]
parseHexPattern("AA 50 ?? 02")  // -> {bytes: Uint8Array, mask: Uint8Array}
```

`??` acts as a wildcard.

### 13.3 Hashes

`crc32(data)` and `md5(data)` are implemented here, because `crypto.subtle` has
no MD5 and it is needed to compare against `SPI_FLASH_MD5`. SHA-256 goes through
`crypto.subtle.digest` and returns `null` where unavailable rather than falling
back — a caller that cannot verify a hash must know that.

---

## 14. Error model

```text
EspFlashError (base)
├── TransportError
│   ├── TransportTimeoutError
│   └── TransportClosedError
├── ProtocolError
│   ├── SyncFailedError
│   ├── CommandFailedError      (status, errorCode)
│   └── UnknownChipError
├── DeviceError
│   ├── StubLoadError
│   ├── SecureDownloadModeError
│   └── UnsupportedOperationError   (code: 'REQUIRES_STUB', …)
├── FormatError
│   ├── InvalidMagicError
│   ├── ChecksumError
│   └── TruncatedDataError
├── AlignmentError
├── OutOfRangeError
├── NvsCapacityError
└── OperationAbortedError
```

Every error carries a `code` (a stable string such as `'SYNC_FAILED'`) and a
`details` object. **The UI branches on `code`, never on the message text, and
translates the code into display text**
([16.8](#168-internationalization)). `message` is an English developer-facing
string.

**Policy:** analysis code (`format/`) prefers accumulating `issues` and
returning partial results over throwing. It throws only when the data is not the
target format at all, or when `strict: true`. Device operations throw.

---

## 15. Progress and cancellation

Long-running operations (read, write, dump, diff) share a signature:

```js
{ onProgress?: (p: Progress) => void, signal?: AbortSignal }

/**
 * @typedef {object} Progress
 * @property {string} phase    - "erasing" | "writing" | "reading" | "verifying" | "analyzing"
 * @property {number} done
 * @property {number} total
 * @property {number} [bytesPerSecond]
 */
```

`phase` is a stable id used as a translation key. The library throttles
`onProgress` to at most 20 Hz: a 16 MB dump at 4 KB blocks is 4096 callbacks,
which unthrottled is enough DOM work to visibly slow the transfer it reports on.

---

## 16. The web application

### 16.1 Principles

- **No framework, no build.** `web/index.html` loads `./app.js` as
  `type="module"`.
- UI parts are Custom Elements (`esp-*`) using Shadow DOM to avoid style
  collisions, themed through CSS custom properties injected from outside.
- State lives in a single store; components subscribe and re-render.
  **Components must never call the core API directly** — everything goes through
  `actions.js`.
- References to the core are funnelled through `web/esp-flashjs.js`
  ([4.4](#44-module-resolution-and-paths)).

### 16.2 The store

```js
// web/store.js
export const store = createStore(initialState);
store.getState()
store.setState(patch)          // shallow merge, notifies on change
store.subscribe(selector, fn)  // fn runs only when the selector's result changes
```

Shape of the state:

```js
{
  device: { status: 'disconnected'|'connecting'|'connected', info: DeviceInfo|null, usingStub: false, error: null },
  flash:  { size: null },
  partitions: { table: PartitionTable|null, source: 'device'|'file'|null },
  selection: { kind: 'partition'|'buffer'|'gap'|null, id: null },
  buffers: Map<string, {id, name, data: Uint8Array, source, address, partitionLabel, analysis}>,
  inspector: { tab: 'info'|'hex'|'analyze'|'edit'|'diff' },
  busy: { active: false, phase: '', done: 0, total: 0, cancel: null },
  log: LogEntry[],
}
```

`Uint8Array`s live in the state, but **change notification is by reference
comparison** — nothing is deep-copied. Buffers reach 16 MB, so copying happens
only as an explicit operation.

### 16.3 Screen layout

```text
┌───────────────────────────────────────────────────┐
│ ESP FlashJS                    [Device: ESP32-S3] │
├───────────────────────────────────────────────────┤
│ Device                                            │
│ [Connect] [Disconnect]  Chip / Rev / MAC / Flash  │
├─────────────────┬─────────────────────────────────┤
│ Flash Map       │ Inspector                       │
│                 │ ┌─────────────────────────────┐ │
│  Bootloader     │ │ Info │ Hex │ Analyze │ Edit │ │
│  Partition Tbl  │ ├─────────────────────────────┤ │
│  NVS            │ │                             │ │
│  OTA Data       │ │                             │ │
│  App0           │ │                             │ │
│  App1           │ │                             │ │
│  SPIFFS         │ │                             │ │
│  (Unallocated)  │ │                             │ │
│                 │ └─────────────────────────────┘ │
├─────────────────┴─────────────────────────────────┤
│ Log                                        [Clear]│
└───────────────────────────────────────────────────┘
```

- Besides the flash map, the left pane lists buffers loaded from files (the
  "Files" section). Device-sourced and file-sourced data share one Inspector.
- Below 900px the layout collapses to one column, with a tab strip switching
  between the flash map and the Inspector.

### 16.4 Inspector tabs

| Tab | Contents |
| --- | --- |
| Info | Metadata for the selection (offset / size / type / subtype / label / end address / encrypted) |
| Hex | The hex viewer, highlighting analyzed regions |
| Analyze | The `analyzeBinary` result, with a per-format view (partition table, image segment list, NVS tree, SPIFFS file tree) and a selector to override the format |
| Edit | Format-specific editing UI, such as the NVS editor |
| Diff | Pick two buffers and compare them |

### 16.5 Hex viewer (`esp-hex-viewer`)

- **Virtual scrolling is mandatory** — 16 MB is 1,048,576 rows. Only the
  viewport plus a small overscan exists in the DOM.
- 16 bytes per row, rendered as `offset (8 digits) | 16 hex bytes (split after
  the 8th) | ASCII`.
- Features: byte-range selection, jump to address (accepting `0x`-prefixed and
  decimal), hex search with wildcards, text search, and highlighting from
  `BinaryRegion[]`.
- The status line shows offset, length, and the selection interpreted as
  u8/u16/u32/i32/float and as text.
- Values arrive as **properties, not attributes**: `.data` (Uint8Array),
  `.baseAddress`, `.regions`.

### 16.6 UI terminology

"Upload" and "Download" are **forbidden** — the direction is ambiguous.

| Context | Wording |
| --- | --- |
| Device → PC | Read from Device |
| PC → Device | Write to Device |
| File → app | Import Binary |
| App → file | Export Binary |
| Partition | Read Partition / Write Partition / Import Partition / Export Partition |
| Whole chip | Flash Dump (read) / Flash Erase |

The principle carries into every translation. To keep direction unambiguous when
translating, the `locales/` keys themselves encode it, as in
`action.readFromDevice`.

Destructive buttons use a danger colour and sit in a group visually separated
from the non-destructive ones (Read / Analyze / Export).

### 16.7 Log

Every device operation and analysis run is logged.

```js
{ time, level: 'info'|'warn'|'error', code, params }
```

The `code` is translated at render time, so switching language retranslates the
history rather than leaving a mixed transcript. The log can be exported as text,
with chip details and the library version in the header so it can be attached to
a bug report. **The exported log is in English**, so whoever receives it can
read it.

### 16.8 Internationalization

**Requirement:** detect from the browser's language settings, falling back to
English. Ship Japanese, English and Chinese from the start, structured so other
major languages can be added later.

**Initial set:**

```text
en        English      (the fallback; must always have every key)
ja        日本語
zh-Hans   简体中文
zh-Hant   繁體中文
```

Simplified and Traditional Chinese are separate locales. A glyph conversion does
not produce matching vocabulary.

**Resolution:**

1. An explicit user choice stored in `localStorage`, if present
2. Otherwise walk `navigator.languages` from the front, matching in this order:
   - Exact (`zh-Hant`)
   - Region implying a script (`zh-TW` → `zh-Hant`, `zh-CN` → `zh-Hans`)
   - Language subtag only (`ja-JP` → `ja`)
3. Otherwise `en`

**Catalogue format:** flat key-value JSON at `web/locales/<locale>.json`. Not
nested, so a key can be found by full-text search.

```json
{
  "action.readFromDevice": "Read from Device",
  "partition.label": "Label",
  "error.SYNC_FAILED": "Could not synchronize with the device.",
  "partition.overlap": "Partitions \"{a}\" and \"{b}\" overlap."
}
```

**API:**

```js
// web/i18n.js
await initI18n();                      // resolve the locale, fetch it and en
t('action.readFromDevice')             // -> string
t('partition.overlap', { a, b })       // -> interpolated string
setLocale('zh-Hans')                   // explicit switch; persists and re-renders
availableLocales()                     // -> [{code, nativeName}]
```

**Rules:**

- `en.json` is the sole canon. Keys missing from another locale fall back to
  English and warn on the console.
- An unknown key returns the key itself, so a screen never goes blank.
- **No user-facing text in `src`, ever.** The library returns only `code` and
  `params`; translation belongs to `web/`. This is what lets a third-party
  application embed the library and use its own wording.
- Adding a translation is one `locales/xx.json` file plus one entry in
  `availableLocales()`. No code change.
- Switching language takes effect immediately, with no reload.
- `<html lang>` follows the selected locale.
- Numbers and dates are formatted with `Intl.NumberFormat` and
  `Intl.DateTimeFormat`. But **byte counts and addresses are not localized** —
  `0x00009000` and `4096` are technical notation that reads the same everywhere.

**Languages wanted later:** ko, de, fr, es, pt-BR, ru. The translation procedure
is documented so community PRs can add them.

---

## 17. Safety

Writing flash can leave a device unable to boot, so the following are mandatory.

### 17.1 Defining dangerous regions

A write or erase touching any of these counts as a dangerous operation:

- The bootloader region (from `0x1000` on ESP32, from `0x0` on S3, C3 and
  others, up to the partition table)
- The partition table region (`0x8000` + `0xC00`)
- The otadata partition
- Any app partition (type 0)
- Any partition with the `encrypted` flag
- The efuse and nvs_keys partitions

### 17.2 Confirmation flow

A dangerous operation shows a confirmation dialog first, containing:

1. The target region (offset, size, partition name)
2. What could happen ("the device may stop booting")
3. **Whether a backup exists.** With none, "Back Up First" is offered as the
   primary button
4. A text field requiring the partition label (or `WRITE`) to be typed. A
   checkbox is not sufficient — a checkbox gets clicked reflexively, whereas
   typing `app0` makes the user read which partition they are about to destroy

Writing plaintext to an encrypted partition adds a second warning on top.

### 17.3 Backup first

The UI steers the user through:

```text
Read Original → Store Backup → Modify → Preview Diff → Write → Verify
```

- The write dialog always offers a "Backup Original" checkbox, **on by
  default**. When set, the target region is read and stored in `buffers` before
  the write, and exported as a `.bin` at the same time.
- **If the backup fails, the write does not proceed.** The whole point is having
  a way back; continuing without one silently removes it.
- Preview Diff compares the region's current contents against the new data.

### 17.4 Verify

Verification runs by default after a write (MD5 comparison). A mismatch is
reported as a clear error in both the log and a dialog.

---

## 18. Handling unsupported regions

- A region or partition that cannot be parsed is **never removed** from the
  list. It is shown as `Unknown / Raw`.
- Hex view, export, replace and diff all remain available for raw data.
- Flash space not covered by the partition table appears in the flash map as
  `Unallocated` and can be read and exported.

---

## 19. Encrypted regions

- Where Flash Encryption or similar makes the contents unreadable, they are
  never presented as though they had been parsed.
- The state is stated explicitly, as one of three values:
  - `Encrypted` — the partition's `encrypted` flag is set, or eFuse confirms
    Flash Encryption is enabled
  - `Possibly Encrypted` — high entropy with no known magic
    ([9.4](#94-detecting-encryption))
  - `Unknown` — nothing to judge by
- **Decryption is not performed, and will not be implemented.**

---

## 20. Testing

### 20.1 Approach

Fixture-based, with no dependency on hardware. The runner is Node's built-in
`node:test` — no added dependency, and `node --test` runs it. Browser-specific
behaviour is covered by manual testing.

### 20.2 Fixtures

**Fixtures are generated in code.** Readable intent beats a committed binary.
The builders live in `test/helpers.js`.

| Function | Produces |
| --- | --- |
| `singleAppPartitions()` / `otaPartitions()` | Partition layouts (4 MB single-app / dual OTA) |
| `partitionTableBytes(partitions?)` | The bytes of a partition table |
| `espImageBytes(options)` | A firmware image; supports `corruptChecksum`, `appendHash`, `appDesc` |
| `otaDataBytes(sequences)` | otadata; `null` leaves that sector unwritten |
| `flashImage(options)` | A whole flash with bootloader, table and app in place |
| `pathologicalInputs()` | Empty / one byte / all 0x00 / all 0xFF / random |

Binaries captured from real hardware go under `test/fixtures/` only, and
**MAC addresses, Wi-Fi credentials, certificates and keys must be anonymized.**

### 20.3 Required test cases

| Subject | Cases |
| --- | --- |
| Every parser | Valid data / corrupted data / boundaries / empty (length 0) / unknown format |
| SLIP | Escaping round trip, a frame split across reads, malformed frames |
| Protocol | Through MockTransport: SYNC, chip detection, read, write, timeout, retry |
| Partition | parse → build → parse round trip, byte for byte |
| NVS | parse → build → parse with every entry preserved; round trip after editing; capacity overflow raises |
| Image | Checksum and SHA-256 verification |
| Diff | No differences / all different / differing lengths / the minGap boundary |
| Flash | Out-of-range and misaligned input raise |
| i18n | Missing keys against `en.json`; every `navigator.languages` resolution pattern |

**Round-trip tests are mandatory for NVS and the partition table.** Nothing else
establishes that write-back is correct.

### 20.4 CI

GitHub Actions runs the following. Locally, `npm run check` runs the same four.

| Check | Command |
| --- | --- |
| Unit tests | `npm test` (`node --test`) |
| JSDoc type check | `npm run typecheck` (`tsc --noEmit`) |
| Layer boundaries and import hygiene | `npm run lint:layers` |
| Locale keys and placeholders | `npm run lint:locales` |

`npm run build` and `npm run build:site` follow, confirming the build works.

Workflow details and the one-time repository setup are in [ci.md](./ci.md). How
to write tests, and the manual hardware checklist, are in
[development.md](./development.md).

---

## 21. Distribution

See [publishing.md](./publishing.md) for the full account. In brief:

| Channel | Mechanism |
| --- | --- |
| GitHub Pages | GitHub Actions assembles `site/` with `scripts/build-site.js` and deploys it |
| npm | A single package, `esp-flashjs`, with `dist` split into full and core. **Published from a local machine**, keeping tokens out of the repository |
| CDN | `dist/esp-flashjs.min.js` loadable straight from jsDelivr |

---

## 22. Roadmap

### Phase 1 — MVP (implemented)

- [x] Transport (WebSerial / Mock)
- [x] Protocol (SLIP / commands / chip detection / stub loader)
- [x] Device info
- [x] Flash read / write / erase / verify / dump
- [x] Partition table parsing, validation and generation
- [x] ESP firmware image parsing (pulled forward from Phase 3; needed to prove out the analyzer)
- [x] otadata parsing (likewise)
- [x] Binary diff and search (likewise)
- [x] Binary import / export
- [x] Hex viewer (virtual scrolling, search, highlighting)
- [x] Flash map
- [x] Web app skeleton (store / Inspector / log / safety / i18n)
- [x] Build scripts and site assembly for GitHub Pages
- [x] CI (tests / types / layers / locales)
- [x] npm publication ([v0.1.0](https://www.npmjs.com/package/esp-flashjs), 2026-08-16)
- [x] Verification on real hardware (ESP32, ESP32-S3, ESP32-P4)

### Phase 2 — NVS (implemented)

- [x] NVS parsing
- [x] NVS build, with a self-check that re-parses its own output
- [x] NVS diff
- [x] Analyzer registration
- [x] Namespace and key tree in the UI, erased entries included
- [x] Value editing in the UI, rejected at the field rather than at build time
- [x] Writing back to a partition, through the existing backup-and-confirm path

### Phase 3 — Filesystems and deeper analysis (implemented)

- [x] SPIFFS parsing and file extraction
- [x] LittleFS parsing and file extraction (pulled forward: the same hardware
      capture yields all three filesystems, so parsing them together costs far
      less than parsing them one phase apart)
- [x] FAT parsing, including ESP-IDF's wear-levelling layer
- [x] Filesystem tree with per-file extraction in the UI
- [x] A dedicated diff view in the UI
- [x] Refining encryption detection — entropy no longer claims encryption on its own; the chip's eFuse and the partition table decide ([9.4](#94-detecting-encryption))
- [ ] ~~Decrypting with a supplied key~~ — feasible, deliberately deferred; the reasoning is in [9.5](#95-decryption-deliberately-not-implemented)

### Phase 4 — Extensions

- [x] SPIFFS / LittleFS / FAT rebuilding ([12.2](#122-rebuilding))
- [x] Publishing and documenting the analyzer plugin API ([analyzers.md](./analyzers.md); its example is executed by `test/analyzer-plugin.test.js`, so it cannot drift)
- [x] NodeSerialTransport / WebUSBTransport — decided against shipping either; the `Transport` interface is the extension point and [transports.md](./transports.md) documents it with a working Node example. A Node transport would mean a native dependency, which costs every consumer the zero-dependency guarantee
- [ ] Reconsidering ESP8266 support
- [x] Deciding on package splitting (`@esp-flashjs/*`) — decided against

---

## 23. Open questions

| # | Question | Notes |
| --- | --- | --- |
| 1 | **Hardware verification** | Resolved for ESP32, ESP32-S3 and ESP32-P4: each was erased, provisioned and captured, and those captures are the fixtures the parsers are tested against. It settled reset timing, READ_FLASH flow control and five parser bugs that MockTransport could not have caught. The other chips remain unverified and the README says so |
| 2 | ~~Whether and when to split packages~~ | **No.** The `esp-flashjs/core` subpath already gives an analysis-only consumer the smaller bundle — 80 KB against 108 KB minified — without a second package to version, publish and keep in step. Splitting would buy nothing a subpath export and `sideEffects: false` do not already buy, and would cost every release a coordination step. The directory boundaries, enforced by `lint:layers`, are what actually keeps the layering honest |
| 3 | How to implement LittleFS | Write it, or port an existing JS implementation |
| 4 | Additional languages | ko / de / fr / es / pt-BR / ru. Each is one JSON file |

**Settled:**

- ~~Which stubs to bundle~~ → all ten chips. 132 KB in total, and since it is
  fetched at runtime rather than inlined, it costs analysis-only consumers
  nothing.
- ~~UI language~~ → detected from `navigator.languages`, shipping en / ja /
  zh-Hans / zh-Hant.
- ~~What the landing page shows~~ → the web app itself, with a description and
  links pinned along the top.
