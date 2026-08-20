# API reference

[日本語](./api.ja.md) · **English**

Every export, grouped by what it is for. This is a map rather than a tutorial —
for worked examples see [guide.md](./guide.md), and for why things are shaped
this way see [spec.md](./spec.md).

TypeScript declarations ship with the package (`types/index.d.ts`), generated
from the JSDoc in the source, so an editor will complete all of this.

---

## The two entry points

```js
import { … } from 'esp-flashjs';        // everything
import { … } from 'esp-flashjs/core';   // parsers and byte utilities only
```

`core` is pure computation over `Uint8Array`: no serial code, no browser APIs,
smaller, and usable in Node or a worker. Everything in `core` is re-exported
from the full entry point, so importing both is never necessary.

Names listed under **Device** below exist only in `esp-flashjs`. Everything
else is in both.

---

## Device

### `class EspLoader`

The bootloader protocol: reset, sync, chip identification, the stub, and the
raw command channel.

```js
new EspLoader(transport, { onLog })
```

| Member | Purpose |
| --- | --- |
| `connect({ signal, autoReset })` | Reset, sync, identify. Sets `chip` |
| `loadStub({ signal })` | Upload and start the flasher stub. Returns `false` on failure rather than throwing |
| `disconnect({ reset })` | Close, optionally resetting so the app boots |
| `chip` | The identified `ChipDef`, or null |
| `isStub` | Whether the stub is running |
| `secureDownloadMode` | Whether the chip is refusing RAM writes and flash reads |
| `changeBaudRate(rate)` | Only meaningful after the stub is up |
| `readReg(address)` / `writeReg(address, value, mask, delayUs)` | Register access |
| `readFlashId()` / `detectFlashSize()` | SPI flash identification |
| `command(op, payload, options)` | Send one command and await its reply |
| `readFrame({ timeoutMs, signal })` | Read one SLIP frame |
| `resync({ settleMs })` | Discard anything in flight after a failed operation |
| `sync()` / `reset(strategy)` / `detectChip()` / `getSecurityInfo()` | Steps of `connect()`, exposed for unusual flows |
| `attachSpiFlash()` / `runSpiFlashCommand(cmd, opts)` | Raw SPI |
| `stubNameFor(chip)` | Which stub build this silicon needs. Some chips differ by revision |
| `exclusive(run, { signal, phase })` | Run something with sole use of the link |
| `busy` | Whether an operation is running or waiting |

### `class EspFlash`

Flash operations, built on a connected loader.

```js
new EspFlash(loader)
```

| Member | Purpose |
| --- | --- |
| `getInfo({ refresh })` | Chip, MAC, flash size and id, security state |
| `read(address, size, { chunkSize, attempts, onProgress, signal })` | Requires the stub. Splits into chunks and retries each |
| `write(address, data, { compress, verify, onProgress, signal })` | Erases the affected sectors, then writes |
| `verify(address, data, { signal })` | Compare by device-side hash; no transfer |
| `eraseRegion(address, size, { signal })` | Requires 4 KB alignment |
| `eraseAll({ signal })` | The whole chip |
| `dump({ size, onProgress, signal })` | Read everything |
| `probePartitions(partitions, { probeBytes, onProgress, signal })` | First sector of each; returns `Map<label, 'erased'\|'zeroed'\|'data'\|'unreadable'>` |

**Operations are serialised.** A serial port carries one conversation, and two
started at once read each other's frames — which surfaces as a checksum
mismatch, then timeouts, then a device that looks like it has stopped
responding. So every operation above takes the link for its whole duration and
concurrent callers queue. Waiting is always recoverable; corruption is not, and
a caller cannot be expected to build this itself. A queued operation can still
be abandoned through its `signal`, and `loader.busy` says whether anything is
in flight for an application that would rather refuse than wait.

Constants: `FLASH_SECTOR_SIZE`, `READ_BLOCK_SIZE`.

### Transports

| Name | Purpose |
| --- | --- |
| `WebSerialTransport` | Web Serial. `.request({ filters, baudRate })`, `.list()`, `.isSupported()` |
| `MockTransport` | A simulated device for tests. Options include `chip`, `flash`, `flashSize`, `allowStub`, `flakyReads` |
| `canAutoReset(transport)` | Whether DTR/RTS can be driven, and therefore whether the board can be reset without the user |
| `delay(ms)` | — |

The `Transport` interface is five required methods and three optional ones;
[transports.md](./transports.md) documents it.

### Stubs

| Name | Purpose |
| --- | --- |
| `registerStub(name, image)` | Supply a stub image directly. **Required outside a browser** |
| `fetchStub(name)` | Fetch one from beside the module. Browser only |
| `stubUrl(name)` | The URL `fetchStub` would use |
| `loadStub(loader, chip, { signal, image, stubName })` | The lower-level form of `EspLoader#loadStub` |

### Protocol internals

`CMD`, `STUB_ONLY_COMMANDS`, `encodeRequest`, `decodeResponse`, `SlipDecoder`,
`slipEncode`, `slipUnescape`, `CHIP_DETECT_MAGIC_REG`, `FLASH_SIZE_BY_ID`,
`readDeviceInfo`, `readMac`, `VERSION`.

---

## Formats

### Partition tables

| Name | Purpose |
| --- | --- |
| `parsePartitionTable(data, { offset })` | → `{ partitions, md5Valid, hasMd5, issues }` |
| `buildPartitionTable(partitions, { withMd5 })` | → `Uint8Array` |
| `validatePartitionTable(partitions, { flashSize })` | → `Issue[]`; overlaps, alignment, duplicates |
| `describeFlashLayout(partitions, { flashSize, bootloaderOffset })` | Every region in address order, gaps included |
| `findPartitionAt(partitions, address)` / `findPartitionByLabel(partitions, label)` | — |
| `findUnallocatedRegions(partitions, flashSize)` | — |
| `typeName(type)` / `subtypeName(type, subtype)` | — |

Constants: `PARTITION_TABLE_OFFSET`, `PARTITION_TABLE_SIZE`,
`PARTITION_ENTRY_SIZE`, `PARTITION_MAGIC`, `PARTITION_MD5_MAGIC`,
`PARTITION_TYPE`, `MAX_PARTITIONS`.

### Firmware images

| Name | Purpose |
| --- | --- |
| `parseEspImage(data)` | → header, segments, checksum, SHA-256, app description |
| `parseAppDescription(data)` | The `esp_app_desc_t` block on its own |
| `verifyImageHash(data, image)` | `Promise<boolean\|null>`; async because it uses WebCrypto |
| `memoryRegionFor(chip, address)` | `'IRAM'\|'DRAM'\|'IROM'\|'DROM'\|'RTC'\|'unknown'` |

Constants: `ESP_IMAGE_MAGIC`, `IMAGE_CHIP_IDS`.

### OTA data

`parseOtaData(data)` → active sector, boot slot, sequence numbers, issues.
Constant: `OTADATA_SECTOR_SIZE`.

### Core dumps

| Name | Purpose |
| --- | --- |
| `parseCoreDump(data)` | → `CoreDump` |
| `isCoreDump(data)` | Cheap header check, for detection |
| `findTaskNameOffset(data, tcbSegments)` | Where `pcTaskName` sits in this build's TCB, or `null` |

`CoreDump` members: `totalLength`, `version`, `major`, `minor`, `dataFormat`,
`versionLabel`, `chipId`, `chipName`, `chipRevision`, `headerSize`, `checksum`,
`architecture`, `machine`, `tasks`, `crashedTask`, `panicReason`,
`appElfSha256`, `exceptionRegisters`, `segments`, `notes`, `taskNameOffset`,
`issues`.

Each `CoreDumpTask` carries `tcbAddress`, `name`, `pc`, `stackPointer`,
`crashed`, `stack` and the named `registers`. `checksum.valid` is `true`,
`false`, or `null` for a SHA-256 dump — that variant cannot be verified
synchronously, and `null` says so rather than claiming either answer.

Addresses are reported as recorded. Resolving them to symbols, or unwinding a
call stack, needs the ELF of the crashing build, which no core dump contains.

Constants: `COREDUMP_FORMAT`, `COREDUMP_LAYOUTS`, `COREDUMP_MACHINE`,
`COREDUMP_NOTE`.

### NVS

| Name | Purpose |
| --- | --- |
| `parseNvs(data, { strict })` | → `NvsStore` |
| `buildNvs(store, { size, version, selfCheck })` | → `Uint8Array`. Re-parses its own output before returning |
| `diffNvs(before, after, { detectRenames })` | → `NvsChange[]` |
| `summarizeNvsDiff(changes)` | → `{ added, modified, deleted, renamed, total }` |
| `inferNvsType(value)` / `sameValue(a, b)` | — |
| `entryCrc32(entry)` / `pageHeaderCrc32(page)` / `entryState(page, index)` | Low-level, for tooling |

`NvsStore` members: `namespaces`, `entries`, `erasedEntries`, `pages`,
`issues`, `isDirty`, `original`, `get(ns, key)`, `list(ns)`,
`set(ns, key, value, type)`, `delete(ns, key)`, `rename(ns, key, newKey)`,
`addNamespace(name)`, `deleteNamespace(name)`, `changes()`, `reset()`.

Constants: `NVS_PAGE_SIZE`, `NVS_ENTRY_SIZE`, `NVS_ENTRY_COUNT`,
`NVS_KEY_SIZE`, `NVS_MAX_KEY_LENGTH`, `NVS_MIN_PAGES`, `NVS_MAX_CHUNK_SIZE`,
`NVS_TYPE`, `NVS_TYPE_NAMES`, `PAGE_STATE`, `PAGE_STATE_NAMES`, `ENTRY_STATE`.

### Filesystems

All three return the same `FsImage`: `{ type, files, geometry, issues }`, where
each file is
`{ path, size, read(), pageIndices, complete, directory? }`.

| Name | Notes |
| --- | --- |
| `parseSpiffs(data, { pageSize, blockSize, objNameLen, detectGeometry })` | Geometry is inferred and scored; see the guide |
| `parseLittlefs(data, { blockSize })` | Geometry comes from the superblock |
| `parseFat(data, { wlDummySector })` | Reads through ESP-IDF's wear-levelling layer |

Helpers and constants: `spiffsLookupPages`, `SPIFFS_FLAG`, `SPIFFS_GEOMETRIES`,
`SPIFFS_PAGE_HEADER_SIZE`, `SPIFFS_NAME_OFFSET`, `SPIFFS_OBJ_ID_IX_FLAG`;
`ctzIndexOf`, `ctzPointerCount`, `LFS_TYPE`, `LITTLEFS_MAGIC`; `parseBpb`,
`readFatEntry`, `wlMapSector`, `FAT_ATTR`, `FAT_ATTR_LONG_NAME`.

### Editing and rebuilding a filesystem

| Name | Notes |
| --- | --- |
| `FsStore.from(image)` | A full copy of a parsed image, editable |
| `new FsStore(type, geometry)` | An empty one |
| `buildFs(store, { size, source, selfCheck })` | → `Uint8Array`, in the store's own format |
| `checkFsStore(store, type)` | → `Issue[]`: what the target format cannot represent. Capacity is not included; that is a build-time throw |
| `normalizeFsPath(path)` | Absolute, no trailing slash. Throws `FsPathError` on `..` |

`FsStore` members: `type`, `geometry`, `entries`, `paths`, `directories`,
`size`, `byteLength`, `incomplete`, `has(path)`, `read(path)`,
`write(path, contents)`, `mkdir(path)`, `delete(path)`, `rename(from, to)`,
`clone()`.

`incomplete` lists paths that were only partly recoverable from the source
image. They read back with zeros where the data was missing, so rebuilding
makes the gap permanent — which is what `checkFsStore` warns about.

**A rebuild regenerates at the original geometry.** It does not format a
filesystem to arbitrary parameters, and it compacts: the result holds the same
files and is not the same bytes. Modification times are not carried over.

Per-format builders, if you need to override geometry:

| Name | Notes |
| --- | --- |
| `buildSpiffs(store, { size, pageSize, blockSize, objNameLen, metaLength, selfCheck })` | — |
| `buildLittlefs(store, { size, blockSize, progSize, version, nameMax, fileMax, attrMax, inlineMax, selfCheck })` | — |
| `buildFat(store, { source, date, time, selfCheck })` | `source` is required: the wear-levelling state at the end of the partition can be carried over but never regenerated |

The self-checks, which are also useful on their own:

| Name | Notes |
| --- | --- |
| `readSpiffsViaIndex(data, options)` | → `FsImage`, read through the object indexes the way a device does, rather than by the page sweep `parseSpiffs` uses. The two disagree exactly when the indexes are wrong |
| `littlefsTraverse(data, { blockSize })` | → `{ blocks, pairs, issues }`, following the tail chain the block allocator follows. A pair that is off the chain reads fine and is handed out as free space on the next write |
| `verifyFsBuild(image, expected, format)` | Throws unless a rebuilt image reads back exactly as asked |

More constants: `spiffsMagic`, `spiffsIndexOffsets`, `SPIFFS_META_LENGTH`,
`SPIFFS_OBJ_NAME_LEN`, `SPIFFS_DATA_PAGE_FLAGS`, `SPIFFS_INDEX_PAGE_FLAGS`;
`ctzBlockCount`, `LITTLEFS_PROG_SIZE`, `LITTLEFS_VERSION`; `longNameRecords`,
`shortNameFor`, `shortNameChecksum`.

---

## Analysis

| Name | Purpose |
| --- | --- |
| `analyzeBinary(data, ctx)` | Run the highest-confidence analyzer |
| `analyzeBinaryAs(id, data, ctx)` | Force one |
| `detectFormat(data, ctx)` | Every candidate, descending by confidence |
| `registerAnalyzer(analyzer)` / `unregisterAnalyzer(id)` / `listAnalyzers()` | Plugins; see [analyzers.md](./analyzers.md) |
| `peakEntropy(data)` | Highest entropy in any 16 KB window |
| `classifyEntropy(entropy, ctx)` | `'encrypted'\|'possibly-encrypted'\|'high-entropy'\|'unknown'` |

`ctx` is `{ offset?, partition?, flashSize?, flashEncryptionEnabled? }`. The
last two are how the library avoids guessing: a partition subtype names formats
that have no magic, and the chip's own report of its encryption state settles
what high entropy means.

Built-in analyzers, exported so they can be inspected or replaced:
`partitionTableAnalyzer`, `espImageAnalyzer`, `otaDataAnalyzer`, `nvsAnalyzer`,
`spiffsAnalyzer`, `littlefsAnalyzer`, `fatAnalyzer`, `coreDumpAnalyzer`,
`rawAnalyzer`.
Constants: `CONFIDENCE_THRESHOLD`, `HIGH_ENTROPY_THRESHOLD`.

---

## Bytes

| Group | Names |
| --- | --- |
| Diff | `diffBinary(a, b, { minGap })`, `diffBinaryStream`, `diffSummary`, `isUniform`, `entropy` |
| Search | `searchBytes`, `searchText`, `parseHexPattern`, `extractStrings` |
| Hashes | `crc32`, `espCrc32Le`, `md5`, `md5Hex`, `sha256`, `espChecksum`, `ESP_CHECKSUM_MAGIC` |
| Reading and writing | `ByteReader`, `ByteWriter` |
| Formatting | `toHexAddress`, `bytesToHex`, `hexToBytes`, `parseAddress`, `hexDump`, `toPrintableAscii`, `formatByteSize`, `decodeCString`, `encodeCString` |

`espCrc32Le` is not the same as `crc32`: the ROM seeds and inverts differently,
and otadata is validated with it. Using the standard one makes every real
otadata sector look corrupt.

---

## Chips

`CHIPS`, `chipByName(name)`, `chipByImageId(id)`, `chipByMagic(value)`.

A `ChipDef` carries the identification values, the stub name, RAM and flash
block sizes, the bootloader offset, SPI register layout, a memory map, and —
where a decision depends on it — how to read the silicon revision.

---

## Errors

Every error has a stable `code` and a `details` object. `message` is English
and written for developers; the library never produces user-facing prose, which
is what lets an application supply its own wording.

| Class | `code` |
| --- | --- |
| `AlignmentError` | `BAD_ALIGNMENT` |
| `ChecksumError` | `CHECKSUM_MISMATCH` |
| `CommandFailedError` | `COMMAND_FAILED` |
| `FsCapacityError` | `FS_CAPACITY` |
| `FsPathError` | `FS_PATH` |
| `InvalidMagicError` | `INVALID_MAGIC` |
| `NvsCapacityError` | `NVS_CAPACITY` |
| `OperationAbortedError` | `ABORTED` |
| `OutOfRangeError` | `OUT_OF_RANGE` |
| `SecureDownloadModeError` | `SECURE_DOWNLOAD_MODE` |
| `StubLoadError` | `STUB_LOAD_FAILED` |
| `SyncFailedError` | `SYNC_FAILED` |
| `TransportClosedError` | `TRANSPORT_CLOSED` |
| `TransportTimeoutError` | `TRANSPORT_TIMEOUT` |
| `TruncatedDataError` | `TRUNCATED_DATA` |
| `UnknownChipError` | `UNKNOWN_CHIP` |
| `UnsupportedOperationError` | `REQUIRES_STUB` or `SECURE_DOWNLOAD_MODE` |

Base classes, for catching a family: `EspFlashError` ← `TransportError`,
`ProtocolError`, `DeviceError`, `FormatError`.

**Parsers do not throw for damaged data.** They return what they could read and
describe the rest in `issues`, each `{ level: 'error'|'warning', code, params }`.
The distinction is deliberate: an exception means "this call cannot proceed",
while an issue means "here is what is wrong with the data you asked about",
and a corrupted image is usually the one you most want to look at.
