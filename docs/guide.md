# Using esp-flashjs

[日本語](./guide.ja.md) · **English**

A task-by-task guide, from opening a `.bin` file to editing NVS on a live
board. Each section starts with the short version and then says what is going
on underneath, so it should be readable whether this is your first ESP32 tool
or your fifth.

For the reasoning behind the design, see [spec.md](./spec.md). For a list of
every export, see [api.md](./api.md). When something does not work, see
[troubleshooting.md](./troubleshooting.md).

---

## Contents

1. [Which import to use](#1-which-import-to-use)
2. [Start without a device](#2-start-without-a-device)
3. [Connecting to a board](#3-connecting-to-a-board)
4. [Reading flash](#4-reading-flash)
5. [The partition table](#5-the-partition-table)
6. [NVS: reading, editing, writing back](#6-nvs-reading-editing-writing-back)
7. [Filesystems: SPIFFS, LittleFS, FAT](#7-filesystems-spiffs-littlefs-fat)
8. [Writing safely](#8-writing-safely)
9. [Progress and cancellation](#9-progress-and-cancellation)
10. [Errors](#10-errors)
11. [Going faster](#11-going-faster)
12. [Outside a browser](#12-outside-a-browser)

---

## 1. Which import to use

There are two entry points, and picking the right one matters more than it
looks.

```js
// Everything, including Web Serial. Needs a browser.
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// Parsers and byte utilities only. No serial code. Runs anywhere.
import { analyzeBinary, parseNvs, parseSpiffs } from 'esp-flashjs/core';
```

`esp-flashjs/core` is pure computation over `Uint8Array`. It has no idea a
device exists, which is why it works in Node, in a worker, or on a server. If
you are analysing files, this is the one you want — it is smaller and it cannot
accidentally reach for a browser API.

The full entry point adds the transport, the bootloader protocol and the flash
operations built on them. Everything in `core` is re-exported from it, so you
never need both.

> **Neither has any runtime dependencies.** That is deliberate, and it is why
> this works straight from a `<script type="module">` with no build step.

---

## 2. Start without a device

The fastest way to understand what the library does is to hand it a file. Drop
a flash dump, a partition table, an NVS partition or a firmware image into
`analyzeBinary` and it will work out what it is.

```js
import { analyzeBinary } from 'esp-flashjs/core';

const bytes = new Uint8Array(await file.arrayBuffer());
const result = analyzeBinary(bytes);

console.log(result.type);        // 'partition-table' | 'esp-image' | 'nvs' |
                                 // 'spiffs' | 'littlefs' | 'fat' | 'otadata' |
                                 // 'raw' | 'encrypted?'
console.log(result.confidence);  // 0.0 – 1.0
console.log(result.metadata);    // format-specific summary
console.log(result.regions);     // byte ranges, for highlighting in a hex view
console.log(result.issues);      // problems found, as stable codes
console.log(result.model);       // the parsed model, if the format has one
```

**Analysis never throws on damaged input.** Problems come back through `issues`
and whatever could be parsed is still returned, because a corrupted image is
usually the one you most want to look at.

### Give it context if you have it

If you know which partition the bytes came from, say so. Several formats have
no magic number of their own — NVS and SPIFFS among them — and the partition
subtype is the difference between recognising them and guessing.

```js
const table = parsePartitionTable(tableBytes);
const nvsPartition = findPartitionByLabel(table.partitions, 'nvs');

const result = analyzeBinary(nvsBytes, {
  partition: nvsPartition,
  offset: nvsPartition.offset,
  flashEncryptionEnabled: false,   // if you know; see §10 of spec.md
});
```

### Forcing a format

When detection picks something you disagree with — or you want to see what a
particular analyzer makes of a region it did not win:

```js
import { analyzeBinaryAs, listAnalyzers } from 'esp-flashjs/core';

console.log(listAnalyzers());                     // [{ id, name }, …]
const forced = analyzeBinaryAs('nvs', bytes, {});
```

---

## 3. Connecting to a board

In a browser, a device is reached through Web Serial. Three things are true of
it and all three catch people out:

- It only exists in a **secure context** — HTTPS, or `localhost`. Not `file://`.
- The port picker only opens **inside a user gesture**, so the call has to
  happen in a click handler.
- It is Chromium-only on the desktop. Firefox and Safari do not implement it,
  and mobile Chrome does not either.

```js
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

button.addEventListener('click', async () => {
  if (!WebSerialTransport.isSupported()) {
    // Say so plainly rather than failing later for a reason that looks unrelated.
    return showMessage('This browser cannot reach serial devices.');
  }

  const transport = await WebSerialTransport.request();   // opens the picker
  const loader = new EspLoader(transport);

  await loader.connect();        // reset → sync → identify the chip
  console.log(loader.chip?.name); // 'ESP32-S3'

  const ok = await loader.loadStub();
  if (!ok) console.warn('Running without the stub: reads will not work.');

  const flash = new EspFlash(loader);
  const info = await flash.getInfo();
  console.log(info.chip, info.mac, info.flashSize);

  await loader.disconnect();     // resets the chip so it boots the application
});
```

### The stub is not optional for reading

This is the single most important thing to know about the protocol.

**The ESP32 ROM bootloader implements no `READ_FLASH` command.** Nor
`ERASE_FLASH`, nor `ERASE_REGION`. Reading flash, dumping, reading a partition,
analysing NVS — everything on the reading side requires a small program called
the *flasher stub* to be uploaded into the chip's RAM first, which is what
`loadStub()` does.

`loadStub()` returns `false` rather than throwing when it fails, because
writing still works without it and a reduced session beats no session. Reads
then throw `UnsupportedOperationError` with `code === 'REQUIRES_STUB'`.

> **Outside a browser**, `loadStub()` needs help: it fetches the stub image
> from a URL beside the module, and Node's `fetch` does not implement `file:`.
> See [§12](#12-outside-a-browser).

### If the board does not respond

`connect()` resets the chip into its bootloader by toggling DTR and RTS, which
is how the auto-reset circuit on most boards is wired. Boards without that
circuit, and transports that cannot drive those lines, need the user to hold
BOOT and tap EN by hand.

```js
import { canAutoReset } from 'esp-flashjs';

if (!canAutoReset(transport)) {
  showMessage('Hold BOOT, tap EN, then release BOOT.');
}
await loader.connect({ autoReset: false });   // skip the reset attempt
```

---

## 4. Reading flash

```js
const data = await flash.read(0x8000, 0xc00);   // address, length
```

That is all most uses need. What happens underneath is worth knowing for the
cases where it does not just work.

A `READ_FLASH` transfer is **all-or-nothing**: the stub sends one MD5 over the
whole range, and one dropped byte anywhere discards everything. On a link that
loses bytes — a long cable, a marginal USB bridge, a virtual-machine
passthrough — a multi-megabyte read therefore never completes, however many
times you retry it.

So `read()` splits the range into chunks and retries each one:

```js
const data = await flash.read(0x290000, 0x50000, {
  chunkSize: 0x40000,   // bytes per transfer; default 256 KB
  attempts: 3,          // tries per chunk before giving up
  onProgress: ({ done, total }) => console.log(done, '/', total),
  signal: controller.signal,
});
```

If a read keeps failing, **make the chunks smaller before you change anything
else**. Retrying a size the link cannot carry does not help; asking for less at
a time does. See [troubleshooting.md](./troubleshooting.md#reads-fail-or-return-short).

### Dumping the whole chip

```js
const image = await flash.dump({ onProgress: (p) => console.log(p.done, p.total) });
```

`dump()` reads the whole flash, sized from the chip when you do not say
otherwise.

### Verifying without transferring

`verify()` compares by hash, computed on the device, so it costs one command
rather than a whole read:

```js
const same = await flash.verify(0x10000, expectedBytes);
```

---

## 5. The partition table

The partition table lives at `0x8000` and is 3 KB. Everything else in flash is
found through it.

```js
import {
  parsePartitionTable,
  findPartitionByLabel,
  describeFlashLayout,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
} from 'esp-flashjs/core';

const raw = await flash.read(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
const table = parsePartitionTable(raw);

for (const p of table.partitions) {
  console.log(p.label, p.typeName, p.subtypeName, p.offset, p.size, p.encrypted);
}
console.log(table.md5Valid);   // the table carries its own checksum
console.log(table.issues);     // overlaps, bad magic, unaligned offsets…
```

### Seeing the whole chip, gaps included

`describeFlashLayout` returns every region in address order — including the
bootloader, the table itself, and unallocated space:

```js
const regions = describeFlashLayout(table.partitions, {
  flashSize: info.flashSize,
  bootloaderOffset: info.bootloaderOffset,
});
// [{ kind: 'bootloader' | 'partition-table' | 'partition' | 'unallocated', … }]
```

The bootloader and the table are the two regions where a mistaken write stops
the device booting, so they are named rather than lumped in with free space.

### Finding out what is actually in each partition

The table says what a partition is *for*. It does not say whether anything has
been written to it. `probePartitions` reads the first sector of each and
classifies it:

```js
const states = await flash.probePartitions(table.partitions);
// Map<label, 'erased' | 'zeroed' | 'data' | 'unreadable'>
```

A few KB per partition answers "is this device provisioned?" without reading
megabytes.

---

## 6. NVS: reading, editing, writing back

NVS is where ESP-IDF applications keep their settings: Wi-Fi credentials,
calibration, counters. It is a key–value store organised into namespaces.

### Reading

```js
import { parseNvs } from 'esp-flashjs/core';

const store = parseNvs(await flash.read(0x9000, 0x5000));

console.log(store.namespaces);            // ['blobs', 'many', 'types']
for (const entry of store.entries) {
  console.log(entry.namespace, entry.key, entry.type, entry.value);
}
console.log(store.get('wifi', 'ssid')?.value);
console.log(store.list('wifi'));
```

Values come back as the type they were stored as: `number` for the 8/16/32-bit
integers, `bigint` for the 64-bit ones, `string` for `STR`, and `Uint8Array`
for `BLOB`.

### Erased entries are not noise

```js
console.log(store.erasedEntries);   // overwritten or deleted, still on flash
```

NVS never overwrites in place. Changing a value writes a new entry and marks
the old one erased; deleting just marks. Those remnants stay until garbage
collection reclaims the page, and they are the evidence that a device has
actually been in service. A tool that hides them makes a used partition look
freshly provisioned.

### Editing

Edits are held as an overlay. The parsed image is never modified, so reverting
is a discard rather than a re-read, and you can always ask what a write *would*
change:

```js
store.set('wifi', 'ssid', 'lab-network', 'STR');
store.set('wifi', 'retries', 3, 'U32');
store.delete('wifi', 'old_key');
store.rename('wifi', 'psk', 'password');
store.addNamespace('calibration');

console.log(store.isDirty);     // true
console.log(store.changes());   // [{ kind, namespace, key, before, after, … }]

store.reset();                  // discard everything
```

Always pass the type explicitly. Inference exists so scripted edits are
possible, but the mapping from a JavaScript value to an NVS type is ambiguous
and a UI should never guess on the user's behalf.

### Writing back

```js
import { buildNvs } from 'esp-flashjs/core';

const image = buildNvs(store, { size: partition.size });
await flash.write(partition.offset, image);
```

`buildNvs` **re-parses its own output and compares it against the store before
returning**. A value that cannot be represented, or an image that would not
read back, fails while the device is still untouched — rather than half way
through a write, which is the state nobody recovers from without a cable.

It also refuses rather than truncating. If the data does not fit it throws
`NvsCapacityError`, whose `details` say how much space would have been needed.

> **One page is always left free.** NVS needs somewhere to compact into; an
> image with every page used leaves a device unable to write at all. This is
> not a detail you can economise on — a fixture built without it silently lost
> its erased entries to garbage collection on the first boot.

### Comparing two images

```js
import { diffNvs, summarizeNvsDiff } from 'esp-flashjs/core';

const changes = diffNvs(parseNvs(backup), parseNvs(current));
console.log(summarizeNvsDiff(changes));  // { added, modified, deleted, renamed, total }
```

`diffNvs` pairs a deletion with an identical addition and reports it as a
rename. Pass `{ detectRenames: false }` when you would rather see both halves.

---

## 7. Filesystems: SPIFFS, LittleFS, FAT

All three return the same shape, so code that lists or extracts files does not
need to know which one it is looking at.

```js
import { parseSpiffs, parseLittlefs, parseFat } from 'esp-flashjs/core';

const image = parseSpiffs(bytes);     // or parseLittlefs / parseFat

console.log(image.type);      // 'spiffs' | 'littlefs' | 'fat'
console.log(image.geometry);  // format-specific, worth showing to the user
console.log(image.issues);

for (const file of image.files) {
  if (file.directory) continue;
  console.log(file.path, file.size, file.complete);
  const contents = file.read();       // decoded lazily
}
```

`read()` is deferred on purpose: a 320 KB image can hold a file per page, and
decoding all of them just to draw a list is work nobody asked for.

### `complete: false` matters

A region read from a device can be missing pages. A file assembled from what
survived is still worth extracting — gaps read as zeros — but it must not be
mistaken for the whole thing. Show it differently.

### Which parser, and the one trap in each

Use the partition subtype to choose, or let `analyzeBinary` do it. Then:

**SPIFFS** records nothing about its own geometry, so page and block size are
inferred. `parseSpiffs` scores candidate geometries on whether the files they
find hold together, not on how many they find — a wrong geometry that is a
divisor of the right one still produces all the correct filenames and scrambled
contents. Show `image.geometry` and let the user override it:

```js
parseSpiffs(bytes, { pageSize: 256, blockSize: 4096, detectGeometry: false });
```

**LittleFS** states its geometry in its own superblock, so there is nothing to
guess.

**FAT** on ESP-IDF sits under a wear-levelling layer that holds one sector
spare and skips it. `parseFat` finds that spare automatically. Ignoring it
parses the boot sector perfectly and then reads the file allocation table as if
it were the root directory — which yields one file whose name is bytes of the
FAT.

---

## 8. Writing safely

Writing to flash is the one operation that can leave a device unable to boot.
The library gives you the pieces; the order is up to you, and the order matters.

```js
// 1. Back up first, and abort if the backup fails.
const original = await flash.read(partition.offset, partition.size);
saveToDisk(original);

// 2. Build and validate the new image before erasing anything.
const image = buildNvs(store, { size: partition.size });

// 3. Confirm with the user — see below for what makes a region dangerous.
if (!(await confirmWithUser(partition))) return;

// 4. Write, then verify.
await flash.write(partition.offset, image, { verify: true });
```

`write()` erases the affected sectors and writes, compressing on the way when
`CompressionStream` is available. `{ verify: true }` compares hashes afterwards.

### Which regions are dangerous

Three answers a UI should treat as different from "some partition":

- **Below `0x9000`** is the bootloader and the partition table. A mistake here
  does not corrupt data; it stops the chip booting at all.
- **`app` partitions** hold the firmware. Overwriting the running one is
  recoverable only over serial.
- **`ota`, `nvs_keys` and `efuse` subtypes** hold state the device needs to
  choose what to boot or to decrypt what it stores.

The reference app uses this to decide whether to require the user to type the
partition label before proceeding. See `assessRisk` in `web/actions.js`.

### Erasing

```js
await flash.eraseRegion(partition.offset, partition.size);
await flash.eraseAll();     // the whole chip
```

Both require the stub. `eraseRegion` needs 4 KB alignment and throws
`AlignmentError` otherwise, rather than quietly erasing a neighbour.

---

## 9. Progress and cancellation

Every long operation takes `onProgress` and `signal`:

```js
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

await flash.dump({
  signal: controller.signal,
  onProgress: ({ phase, done, total, bytesPerSecond }) => {
    bar.value = done / total;
    label.textContent = `${phase} ${done}/${total} (${bytesPerSecond} B/s)`;
  },
});
```

Aborting throws `OperationAbortedError`. **After a cancelled write or erase the
flash contents are undefined** — the operation stopped somewhere in the middle,
and only re-writing the region makes it defined again. That fact is in the
error message so it survives into logs.

---

## 10. Errors

Every error carries a stable `code` and a `details` object. `message` is
English and written for a developer; the library never produces user-facing
prose, which is what lets an application translate its own wording.

```js
try {
  await flash.read(0, 1024);
} catch (error) {
  switch (error.code) {
    case 'REQUIRES_STUB':      /* the ROM cannot read; load the stub */ break;
    case 'TRANSPORT_TIMEOUT':  /* the device stopped answering */ break;
    case 'OUT_OF_RANGE':       /* past the end of flash */ break;
    case 'CHECKSUM_MISMATCH':  /* what arrived is not what was sent */ break;
    default: throw error;
  }
}
```

The classes are exported, so `instanceof` works too: `TransportTimeoutError`,
`ChecksumError`, `UnsupportedOperationError`, `NvsCapacityError`,
`OperationAbortedError`, and the rest are listed in [api.md](./api.md).

Parsers do not throw for damaged data. They return what they could read and
describe the rest in `issues`, each with its own `code` and `level`.

---

## 11. Going faster

Everything starts at 115200 baud, because that is the rate every chip greets
at. Raising it after the stub is up makes a large read several times quicker:

```js
await loader.loadStub();
await loader.changeBaudRate(921600);
```

**Faster is not always more reliable, and the relationship is not monotonic.**
Measured on one CH340 board, 115200 completed two of four 256 KB reads while
460800 completed four of four — slower was both less reliable *and* slower. On
another board 921600 failed outright while 1500000 worked.

So: treat the rate as something to measure rather than assume, and verify it
before trusting it. The stub covers every read with its own MD5, so a rate the
link cannot carry produces a thrown error rather than quiet corruption — which
is what makes trying safe.

```js
await loader.changeBaudRate(rate);
try {
  await flash.read(0, 0x1000, { attempts: 1 });   // one attempt, deliberately
} catch {
  await loader.changeBaudRate(115200);            // fall back to what worked
}
```

Which rates a board accepts is not predictable from the outside. Boards whose
serial port is a microcontroller running bridge firmware — the CH552 on an M5
ATOM, for instance — implement a fixed set and cannot do 921600 at all, while
handling 250000, 500000, 750000 and 1500000. The reference app offers both
families for that reason.

---

## 12. Outside a browser

There is no Node build of the transport, and that is a decision rather than an
omission: Node has no serial API, so one would mean a native dependency that
every consumer would pay for. The `Transport` interface is five methods, and
[transports.md](./transports.md) has a complete Node implementation you can
paste.

Two things bite everyone who tries:

**The stub cannot be fetched.** `loadStub()` asks `fetch()` for a URL beside
the module, and Node's fetch does not implement `file:`. Register the images
yourself:

```js
import { registerStub } from 'esp-flashjs';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./node_modules/esp-flashjs/dist/stub/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  registerStub(file.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
}
```

Register **every** file in the directory rather than a list of chip names. Some
chips need a stub per silicon revision — the ESP32-P4 below v3.0 does — and a
hand-maintained list will miss it, presenting as an unexplained stub failure.

**Reads and timeouts must not race.** A transport that races the underlying
read against a timer abandons the in-flight chunk when the timer wins, so every
later frame arrives one behind. Use a background pump; `transports.md` explains
it and `src/transport/web-serial.js` is a worked example.

For checking your own setup, `tools/hardware-check.mjs` drives the library
against a board and compares the result with an esptool capture.

---

## Where to go next

| If you want to | Read |
| --- | --- |
| A list of every export | [api.md](./api.md) |
| Something to work that does not | [troubleshooting.md](./troubleshooting.md) |
| To support a format the library does not | [analyzers.md](./analyzers.md) |
| To reach a device some other way | [transports.md](./transports.md) |
| To know why a decision was made | [spec.md](./spec.md) |
| To change the library itself | [development.md](./development.md) |
