# Development guide

**English** · [日本語](./development.ja.md)

How to set up, test, and verify changes to ESP FlashJS.

Related: [Specification](./spec.md) / [CI](./ci.md) / [Release](./release.md) / [Publishing](./publishing.md)

---

## 1. Setup

You need **Node.js 20 or newer** (development happens on 22). Nothing else.

```sh
git clone https://github.com/tanakamasayuki/esp-flashjs.git
cd esp-flashjs
npm install
```

`npm install` pulls three devDependencies and nothing more.

| Package | Purpose |
| --- | --- |
| `esbuild` | Bundling and minifying `dist/` |
| `typescript` | Type checking JSDoc and emitting `.d.ts`. **Never transpiling** |
| `@types/w3c-web-serial` | Web Serial type definitions |

**There are zero runtime dependencies.** Before proposing an addition to
`dependencies`, look hard for a way to avoid it.

---

## 2. Running locally

```sh
npm run dev
```

Serves the repository root at `http://localhost:8080`.

| URL | Contents |
| --- | --- |
| `http://localhost:8080/web/` | The web app |
| `http://localhost:8080/examples/` | Example pages |

No build step. Edit anything under `src/` and reload — the browser is resolving
native ESM, with nothing in between.

### 2.1 Why `file://` does not work

ESM `import` and `fetch` both fail under CORS. Always go through an HTTP server.

### 2.2 Web Serial and secure contexts

Web Serial only works in a **secure context**.

| URL | Works |
| --- | --- |
| `http://localhost:8080/web/` | Yes — localhost counts as secure |
| `http://192.168.1.5:8080/web/` | **No** — a LAN address does not. The connect button is disabled |
| `https://…` | Yes |

To test against hardware on another machine, run `npm run dev` there, or use the
deployed Pages site.

### 2.3 The dev server

`scripts/serve.js` is about 80 lines built on `node:http`. It exists so the
project keeps zero dependencies. To change the port or root:

```sh
node scripts/serve.js --port 3000 --root .
```

---

## 3. Testing

### 3.1 Running tests

```sh
npm test                  # everything
npm run test:watch        # re-run on change
npm run test:coverage     # with coverage
```

The runner is Node's built-in `node:test` — no dependency, and `node --test`
works directly.

```sh
# One file
node --test test/protocol.test.js

# Filter by test name (substring or regex)
node --test --test-name-pattern="partition table" "test/*.test.js"

# Terser output
node --test --test-reporter=dot "test/*.test.js"
```

### 3.2 Layout

```text
test/
├── helpers.js          # fixture builders, not a test file
├── binary.test.js      # util/ and binary/
├── format.test.js      # format/ (partition / image / otadata / registry)
├── protocol.test.js    # protocol/ and device/, integrated through MockTransport
└── web.test.js         # the DOM-free parts of web/ (store, i18n)
```

Currently **113 tests, 93.6% line coverage**.

### 3.3 Two kinds of fixture, and when each one lies

**Generated fixtures** live in `test/helpers.js`. Generating beats committing
binaries when what matters is the *intent* of a case, because the intent stays
readable.

```js
import { singleAppPartitions, otaPartitions, partitionTableBytes,
         espImageBytes, otaDataBytes, flashImage, pathologicalInputs } from './helpers.js';

// A conventional single-app 4 MB layout
const bytes = partitionTableBytes();

// Dual-OTA layout
const ota = partitionTableBytes(otaPartitions());

// A firmware image with a deliberately broken checksum
const broken = espImageBytes({ corruptChecksum: true });

// A whole 4 MB flash with bootloader, table and app in place
const flash = flashImage({ size: 1024 * 1024 });
```

**Hardware fixtures** live in `test/fixtures/hardware/<chip>/`, captured by the
tooling in [`tools/fixture-device/`](../tools/fixture-device/README.md).

Use a generated fixture to pin behaviour you have decided on. Use a hardware
fixture to pin behaviour *someone else* has decided — every on-flash format
here belongs to ESP-IDF, not to this project.

The distinction is not academic. A generated fixture is produced by the same
constants the parser reads, so the two agree whether or not either is right.
Every format bug this project has shipped or nearly shipped passed a full test
suite for exactly that reason:

| Bug | Why the suite missed it |
| --- | --- |
| Partition magic byte order reversed | parse and build shared the wrong constant |
| otadata CRC using the standard convention, not the ROM's | the fixture's CRC was generated the same way |
| SPIFFS page flags read as active high | so was the fixture's writer |
| SPIFFS object header read as a packed struct | ditto |
| FAT read without the wear-levelling shift | no generated image had the shift |

Each of those produced output that looked entirely reasonable. Read with the
flags inverted, a SPIFFS image yields the four correct filenames and four empty
files. Read without the wear-levelling shift, a FAT image parses its boot
sector perfectly and reports one file whose name is bytes of the allocation
table. Nothing about either result says "wrong".

So: **when a parser reads a format this project did not invent, at least one
test must run against bytes this project did not produce.** If that is
impossible, say so in the test rather than substituting a generated fixture and
letting the suite look complete.

Two habits make the hardware fixtures worth their size:

- **Check that the fixture exercises the hard part.** `/big.bin` was 4096 bytes
  for a while, which is exactly one FAT cluster and one LittleFS block — so the
  chain-following code, the most error-prone part of all three filesystem
  parsers, was never run. Breaking the FAT12 12-bit unpack failed one unit
  test. At 20000 bytes it fails six.
- **Break it on purpose.** After adding a parser, reintroduce the bug you just
  fixed and confirm the suite goes red. Twice during this work it did not, and
  both times the missing test was for an invariant the parser itself did not
  depend on but a device does.

If you add a fixture captured from real hardware, **anonymize the MAC address,
Wi-Fi credentials, certificates and keys** first. Removing them from git history
afterwards is a chore. The provisioning sketch writes only fixed constants for
this reason, and the MAC lives in eFuse, outside every region captured.

### 3.4 MockTransport: the protocol without hardware

`src/testing/mock-transport.js` is a simulated device that **speaks the real
SLIP protocol** against a `Uint8Array` standing in for flash. It is what makes
the protocol and device layers testable in CI.

```js
import { MockTransport } from '../src/testing/mock-transport.js';
import { EspLoader } from '../src/protocol/loader.js';
import { EspFlash } from '../src/device/esp-flash.js';

const transport = new MockTransport({
  chip: 'ESP32-C6',                 // chip name
  flashSize: 4 * 1024 * 1024,       // or pass flash: Uint8Array with contents
  secureDownloadMode: false,        // true to simulate SDM
  allowStub: true,                  // false to simulate a failed stub load
  supportsSecurityInfo: undefined,  // defaults to the chip definition
});

const loader = new EspLoader(transport);
await loader.connect();
await loader.loadStub();

const flash = new EspFlash(loader);
await flash.getInfo();

// For assertions
transport.flash          // the simulated flash contents
transport.commandLog     // opcodes received, e.g. ['0x08', '0x14', …]
transport.poke(addr, b)  // write directly, bypassing the protocol
```

Scenarios you can reproduce:

| Setting | Situation |
| --- | --- |
| `chip: 'ESP32'` | No `GET_SECURITY_INFO`; exercises the magic-register detection path |
| `allowStub: false` | Stub load failure and the fallback to ROM mode |
| `secureDownloadMode: true` | Register reads and stub loading both refused |
| `registers.set(0x40001000, 0xdead)` | An unknown chip |

**What MockTransport cannot verify:** reset sequence timing, real UART baud rate
changes, and `READ_FLASH` flow control (the mock does not pace, it returns
everything at once). Those need hardware.

### 3.5 How to write tests here

**Feed every parser pathological input.** `pathologicalInputs()` returns empty,
one-byte, all-zero, all-0xFF and random buffers. A parser must either throw or
return a result — never hang or crash.

**Verify parse → build → parse round trips.** This is the only thing that
establishes write-back correctness. For partition tables the assertion goes all
the way to **byte equality**.

```js
const original = partitionTableBytes(otaPartitions());
const rebuilt = buildPartitionTable(parsePartitionTable(original));
assert.deepEqual([...rebuilt], [...original]);
```

**Assert that damaged data does not throw.** Analysis is designed to accumulate
`issues` and return partial results; test that it actually does.

**Assert that boundaries are not silently adjusted.** Misaligned and
out-of-range operations raise; they do not round.

```js
await assert.rejects(() => flash.write(0x1001, data), AlignmentError);
await assert.rejects(() => flash.read(0xfff000, 0x2000), OutOfRangeError);
```

**Doubt your assertions.** During implementation, several test expectations
turned out to be the wrong half (`nvs` spans `0x9000`–`0xf000`, so `0xefff` is
inside it, not past it). When something fails, suspect the implementation
first — then suspect the test.

---

## 4. Type checking

```sh
npm run typecheck
```

Sources are plain JavaScript. TypeScript is used **as a linter only**: files
stay `.js` and no syntax is rewritten.

Every file starts with `// @ts-check`, and types are written in JSDoc.

```js
/**
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.offset]
 * @returns {PartitionTable}
 */
export function parsePartitionTable(data, { offset = 0 } = {}) { … }
```

`tsconfig.json` covers `src/**/*.js` and `web/**/*.js`.

### 4.1 What this actually caught

The decision to run `tsc` has already paid for itself:

- **The `setSignals` argument names.** Web Serial takes
  `dataTerminalReady`/`requestToSend`, not `dtr`/`rts`. Left unnoticed, entering
  the bootloader would have silently done nothing.
- **`warning` vs `warn`.** Issues use one, the log the other; the log's CSS class
  never matched, so warnings rendered as ordinary text.
- **Missing null checks.** `flashSize` is `number|null`.

Binary handling is precisely where this class of mistake does not raise an
exception — it **quietly writes a corrupted image**. For a library that can
brick a board, the check earns its keep.

### 4.2 Exposing a typedef in the public API

`export *` does **not** carry JSDoc typedefs. To publish a new type, add an
explicit alias to the typedef block in `src/core.js` or `src/index.js`.

```js
/**
 * @typedef {import('./format/partition.js').Partition} Partition
 */
```

Start the comment with `/**`. With `/*` it is not JSDoc, and the typedef is
silently ignored — which cost an hour once already.

---

## 5. Layer checking

```sh
npm run lint:layers
```

`scripts/check-layers.js` statically verifies three things.

**Dependency direction.** Imports may only go downward.

| Directory | May import from |
| --- | --- |
| `src/util/` | nothing |
| `src/binary/` | `util/` |
| `src/format/` | `binary/`, `util/` |
| `src/transport/` | `util/` |
| `src/protocol/` | `transport/`, `binary/`, `util/` |
| `src/device/` | `protocol/`, `binary/`, `format/`, `util/` |
| `src/testing/` | all of the above |

The rule that matters most is that `format/` and `binary/` stay pure. The moment
a parser reaches for the transport, the promise that you can analyze a file
without hardware quietly stops being true.

**Extensions on imports.** `./slip.js` yes, `./slip` no. Browsers have no
resolution algorithm, so a missing extension only breaks in production.

**DOM globals.** `document` and `window` are banned outside
`transport/web-serial.js`, otherwise the library stops working in Node and in
workers.

---

## 6. Locale checking

```sh
npm run lint:locales
```

`web/locales/en.json` is canonical. `scripts/check-locales.js` checks each
translation for:

- Missing keys (they fall back to English at runtime, which is exactly why they
  otherwise go unnoticed)
- Unknown keys, usually the residue of a rename applied to only one file
- **Placeholder mismatches.** Dropping `{label}` from a translation means that
  value never reaches the screen

### 6.1 Adding a language

No code changes required.

1. Copy `web/locales/en.json` to `web/locales/<code>.json` and translate the values
2. Add one `{ code, nativeName }` entry to `LOCALES` in `web/i18n.js`
3. Run `npm run lint:locales`

If the language needs a region-to-script mapping (the way `zh-TW` maps to
`zh-Hant`), add it to `TAG_ALIASES` in the same file.

### 6.2 Adding a message

**Never put user-facing text in `src/`.** The library returns a stable `code`
and parameters; translation is `web/locales/`'s job. That separation is what
lets an embedding application use its own wording.

```js
// in src/
issues.push({ level: 'warning', code: 'partition.overlap', params: { a, b, at } });

// in web/locales/en.json
"partition.overlap": "Partitions \"{a}\" and \"{b}\" overlap."
```

---

## 7. Building

```sh
npm run build        # dist/
npm run build:site   # site/ (run build first)
npm run clean        # remove dist, site, types
```

`dist/`, `site/` and `types/` are all gitignored. Build output is never
committed.

### 7.1 What lands in `dist/`

| File | Contents | Size |
| --- | --- | --- |
| `esp-flashjs.js` / `.min.js` | Everything, Web Serial included | 107 KB / 52 KB |
| `esp-flashjs.core.js` / `.min.js` | Analysis only, no serial code | 53 KB / 28 KB |
| `stub/*.json` | Fetched at runtime, **not inlined** | 132 KB |

esbuild is invoked for `bundle` and `minify` only. No `target` is set, so
**nothing is syntactically rewritten**.

### 7.2 How `site/` is assembled

`scripts/build-site.js` places the contents of `web/` at the site root, and
`src/`, `examples/`, `dist/` and `docs/` at the same depth they have in the
repository.

Only `web/` changes depth, so every reference from `web/` into `src/` is funnelled
through **one file, `web/esp-flashjs.js`**. That file's specifier is the only
thing build-site rewrites.

**No file under `web/` may import `../src/` directly.** Always go through
`./esp-flashjs.js` (or `../esp-flashjs.js` from `components/`). Breaking this
produces a page that works locally and 404s on the published site.

build-site finishes by **scanning for absolute paths** and failing if it finds
any. The site is served from `/esp-flashjs/`, so `/src/...` is guaranteed to
break.

---

## 8. Updating the flasher stubs

```sh
npm run fetch-stub                # from the pinned tag
npm run fetch-stub -- --tag v1.3.0
```

Stubs come from [espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub)
releases, licensed **Apache-2.0 OR MIT**.

> **Never use the legacy `esptool-legacy-flasher-stub`.** It is GPL-2.0 and this
> repository is MIT. `scripts/fetch-stub.js` pins the release URL so the correct
> ones are fetched; avoid placing JSON files by hand.

The source tag is recorded automatically in `src/protocol/stub/README.md`.

---

## 9. Manual testing against hardware

This covers what the automated suite structurally cannot. Work through it
whenever you touch the protocol or device layers.

### 9.1 Preparation

- Connect a board over USB
- `npm run dev`, then open `http://localhost:8080/web/` in Chrome or Edge
- Make sure no other tool holds the port (Arduino IDE, esptool, a serial
  monitor). Connection fails if something else has it open

### 9.2 Checklist

**Connecting**

- [ ] Connect opens the port picker
- [ ] The chip name is correct
- [ ] A MAC address appears (not `unknown`)
- [ ] The flash size matches the actual part
- [ ] Mode reads "Stub loader". Still on ROM means the stub failed to load
- [ ] Connecting works without holding BOOT (auto-reset is functioning)

**Reading**

- [ ] The partition table is read automatically and appears in the Flash Map
- [ ] Selecting a partition and reading it fills the Hex tab
- [ ] Analyzing an app partition reports an ESP Firmware Image with a valid checksum
- [ ] Flash Dump completes and its size matches the flash size
- [ ] The progress bar advances, and Cancel interrupts it

**Writing (on a board you can afford to brick)**

- [ ] Write Partition opens a file picker, then a confirmation dialog
- [ ] The confirm button stays disabled until the label is typed correctly
- [ ] Confirming downloads a backup automatically
- [ ] Verification passes after the write
- [ ] Reading the region back matches what was written

**Error handling**

- [ ] Unplugging the cable logs an error and does not freeze the UI
- [ ] The application restarts after Disconnect (reset works)

**Browsers**

- [ ] In Firefox or Safari, the connect UI reports "not supported" and file
      analysis still works

### 9.3 Recording results

Update the "Tested on hardware" column in both READMEs for the chips you have
exercised. **Do not mark anything verified that you have not actually run.**

If something misbehaves, use Export in the log pane. The chip details and library
version are in the header, so the file can go straight onto an issue.

---

## 10. Before committing

```sh
npm run check
```

Runs the same four checks as CI — tests, types, layers, locales. If this passes,
CI almost certainly will too.

To include the build:

```sh
npm run check && npm run build && npm run build:site
```

---

## 11. Common pitfalls

| Symptom | Cause |
| --- | --- |
| `Failed to resolve module specifier` in the browser | An import without a file extension. `npm run lint:layers` catches these |
| 404 only on the deployed site | An absolute path, or a direct `../src/` import from `web/` |
| JSDoc types have no effect | The comment starts with `/*`; it needs `/**` |
| Connects but reads fail | The stub is not loaded. The ROM has no READ_FLASH |
| Connect button disabled on a LAN address | Not a secure context. Use localhost or HTTPS |
| Cannot open the port | Another tool is holding it |
| Translations stay in English | A misspelled key. The browser console warns about it |
