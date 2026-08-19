# Changelog

[日本語](./CHANGELOG.ja.md) · **English**

## 1.0.0 — unreleased

The first release verified against hardware. Every format this library parses
is now checked against flash captured from an ESP32, an ESP32-S3 and an
ESP32-P4, and the protocol stack is checked by driving those same boards.

### If you are on 0.1.0

**0.1.0 could not talk to a device.** It was published before any hardware was
available, and five separate faults each prevented a session from completing.
None of them showed up in the test suite, because the suite compared the
library against fixtures and a mock the library itself produced.

- **Reads were lost to their own timeout.** `read()` raced the underlying read
  against a timer; when the timer won, the in-flight chunk was abandoned rather
  than cancelled, so every later frame arrived one behind. It presented as chip
  detection failing on every board.
- **Data command checksums covered the header.** The ROM answers `0x07 Invalid
  CRC`. The checksum is over the payload only.
- **READ_FLASH acknowledgements were sent unframed.** The stub waits for a SLIP
  frame, so the transfer stalled after the first block.
- **Partition table magic was byte-reversed.** The parser accepted only its own
  output; a real table was rejected as invalid.
- **otadata used standard CRC-32.** The ROM uses an inverted-seed convention,
  so every real otadata sector looked corrupt.

### Added

- **NVS building and diffing.** `buildNvs` serialises a store back to a
  partition image and re-parses its own output before returning; `diffNvs`
  compares two images, with optional rename detection.
- **Filesystems.** `parseSpiffs`, `parseLittlefs` and `parseFat` read files out
  of an image, including nested directories and files spanning many storage
  units. FAT is read through ESP-IDF's wear-levelling layer.
- **Analyzers for NVS, SPIFFS, LittleFS and FAT**, so a region is recognised
  and described rather than reported as an unimplemented format.
- **Chunked reads with per-chunk retry.** A READ_FLASH transfer is
  all-or-nothing, so a link that drops bytes could never deliver a large range
  however often it was retried. `read()` now splits the range and retries each
  piece.
- **Filesystem editing and rebuilding.** `FsStore` holds an editable tree and
  `buildFs` writes it back as a SPIFFS, LittleFS or FAT image at the geometry
  it came from. Each format is checked by something a round trip cannot fake:
  SPIFFS is read back through its object indexes the way a device reads it,
  LittleFS is walked along the tail chain the block allocator follows, and FAT
  carries the wear-levelling state over rather than regenerating it.
  `checkFsStore` says what the target format cannot hold before anything is
  built.
- **A link-speed control in the web app**, and a filesystem tree with add,
  replace, delete and write-back, an NVS editor and a binary diff view in the
  inspector.
- **Documentation for writing analyzers and transports**, both with worked
  examples that are executed by the test suite.
- **`tools/hardware-check.mjs`**, which drives the library against a board and
  compares the result with an esptool capture. `--rebuild` goes further: it
  edits each filesystem, writes it back, resets the board and reads the chip's
  own driver reporting what it found — the only check that can establish that
  an image this library writes is one a device will mount.

### Fixed

- **The ESP32-P4 could not be used at all.** Silicon below revision v3.0 places
  RAM elsewhere and needs its own flasher stub; the ordinary one was uploaded
  to addresses that do not exist and the chip never greeted back. Every P4 in
  circulation is below v3.0. The revision is now read from eFuse and the stub
  chosen accordingly.
- **Analyzers claimed erased flash.** A blank `nvs` partition is still an `nvs`
  partition as far as the table is concerned, so the subtype hint alone made
  analyzers report unformatted flash as an empty filesystem — which reads as
  "nothing stored here" rather than "never initialised".
- **Encryption detection contradicted the chip.** High entropy alone cannot
  separate ciphertext from compressed data, and an unencrypted LittleFS image
  holding a counter file scores a perfect 8.0 bits/byte. Detection now defers
  to what the device reports about itself, and says so plainly when it does not
  know.
- **The boot area was unrecognised on two chips in three.** The bootloader
  starts at 0x0, 0x1000 or 0x2000 depending on the family; only offset 0 was
  examined.
- **A partition table's `encrypted` flag was treated as evidence.** It is a
  policy bit that means nothing on a chip with encryption disabled.
- **A FAT volume whose first directory entry had a long name read as empty.**
  The wear-levelling spare is located by finding real directory entries where
  the boot sector says the root directory is, and that test insisted on an 8.3
  name — but a long-name entry is UTF-16, so detection failed outright and the
  volume was reported as having no valid layout.
- **LittleFS user attributes were matched by exact type.** The type is 0x300
  plus a byte the application chose, so none of the real ones matched; ESP-IDF
  stores the modification time under `'t'`, which is 0x374.

### Known limitations

- **Rebuilding regenerates at the original geometry.** Formatting a filesystem
  to arbitrary parameters is out of scope, FAT needs the image it came from,
  and modification times are not carried over.
- Long FAT file names are **not covered by a committed fixture**: nothing the
  provisioning sketch writes has a name that needs them. `hardware-check.mjs
  --rebuild` exercises them against a board instead.
- `fetchStub` needs a browser: it asks `fetch()` for a URL beside the module,
  and Node's fetch does not implement `file:`. Outside a browser, call
  `registerStub`. See [docs/transports.md](./docs/transports.md).
- Decrypting an encrypted region is
  [deliberately not implemented](./docs/spec.md#95-decryption-deliberately-not-implemented).
- Verified on ESP32, ESP32-S3 and ESP32-P4. Other chips in the table are
  implemented but untested on hardware, and the README says which is which.

## 0.1.0 — 2026-08-16

First publication. Transport, bootloader protocol, chip detection, stub
loading, flash read/write/erase/verify/dump, partition tables, firmware images,
OTA data, binary diff and search, and the reference web app.

Published before any hardware was available. See the note above.
