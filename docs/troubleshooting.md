# Troubleshooting

[日本語](./troubleshooting.ja.md) · **English**

Symptoms first, because that is what you have. Nearly everything here was found
on real hardware, and several entries exist because the obvious explanation was
the wrong one.

Two habits are worth more than anything on this page:

- **Read the error, not the summary.** Most tooling around ESP32 flash collapses
  a specific failure into the word "failed". The specific failure is almost
  always in reach.
- **Compare against esptool.** It shares no code with this library. Where the
  two agree, the agreement is evidence; where they differ, one of them has a
  bug worth finding.

---

## Contents

- [The browser cannot see any device](#the-browser-cannot-see-any-device)
- [Connecting fails or the chip is not recognised](#connecting-fails-or-the-chip-is-not-recognised)
- [The stub will not load](#the-stub-will-not-load)
- [Reads fail or return short](#reads-fail-or-return-short)
- [Reads work but the data looks wrong](#reads-work-but-the-data-looks-wrong)
- [A partition shows as empty when it should not](#a-partition-shows-as-empty-when-it-should-not)
- [A filesystem lists files but their contents are wrong](#a-filesystem-lists-files-but-their-contents-are-wrong)
- [Writing NVS is refused](#writing-nvs-is-refused)
- [Everything is slow](#everything-is-slow)
- [It works in the browser but not in Node](#it-works-in-the-browser-but-not-in-node)

---

## The browser cannot see any device

**No port picker appears, or `WebSerialTransport.isSupported()` is false.**

Web Serial needs all three of these, and the failure looks the same when any
one is missing:

| Requirement | How it fails |
| --- | --- |
| A Chromium-based **desktop** browser | Firefox and Safari do not implement Web Serial. Neither does Chrome on Android or iOS |
| A **secure context** — HTTPS or `localhost` | Opening the page from `file://` fails; so does plain HTTP on anything but localhost |
| A **user gesture** | `requestPort()` outside a click handler is rejected |

Say which one is missing rather than reporting a generic failure. A user on
Firefox and a user on `file://` need different advice.

**The picker appears but the board is not in the list.** That is a driver
question, not a browser one. Check the port exists at the operating-system
level first — `ls /dev/tty*`, or Device Manager on Windows.

---

## Connecting fails or the chip is not recognised

**`connect()` throws, or `loader.chip` stays null.**

### Something else is holding the port

A serial port cannot be shared. Two processes reading one port consume each
other's replies, and the result looks exactly like a broken device or a bad
cable. This is the single most common cause and the easiest to rule out:

```sh
fuser -v /dev/ttyUSB0        # Linux
lsof /dev/tty.usbserial-*    # macOS
```

A serial monitor left open in an IDE counts. So does an `esptool` that hung.

### The board did not enter its bootloader

`connect()` toggles DTR and RTS to reset the chip into download mode, which is
how most development boards are wired. Boards without that circuit need it done
by hand: hold BOOT, tap EN, release BOOT, then connect with
`{ autoReset: false }`.

`canAutoReset(transport)` reports whether the transport can drive those lines
at all, so the UI can say which of the two situations the user is in.

### The reply is arriving but being dropped

If chip detection fails on *every* board you try, suspect the transport rather
than the boards. A transport that races the underlying read against a timeout
abandons the in-flight chunk when the timeout wins — the data is not cancelled,
just discarded — so every subsequent frame arrives one behind. It presents as
"unknown chip" with no visible connection to timeouts.

This is why `WebSerialTransport` reads on a background pump. If you wrote your
own transport, see [transports.md](./transports.md#the-part-that-is-easy-to-get-wrong).

---

## The stub will not load

**`loadStub()` returns false**, and reads then throw `REQUIRES_STUB`.

The message on the warning says which of these it was.

### `could not fetch …` — you are not in a browser

`fetchStub` asks `fetch()` for a URL beside the module. Node's fetch does not
implement the `file:` scheme, so this can never work outside a browser. Call
`registerStub` with the images yourself — see
[guide §12](./guide.md#12-outside-a-browser).

Register **every** JSON in `dist/stub/`, not a list of chip names you maintain
by hand. Which brings us to:

### `expected "OHAI" from the stub, got …` — the wrong stub for this silicon

The stub uploaded fine and the chip jumped into it, but nothing came back.
Almost always this means the stub was written to addresses that do not exist on
this particular part.

**The ESP32-P4 below revision v3.0 is the case in the wild.** It places RAM
somewhere else and needs `esp32p4-rev1`. Every P4 in circulation today is below
v3.0, so a build missing that stub does not work on the family at all. The
library reads the revision from eFuse and chooses; a hand-rolled Node setup
that registers stubs by chip name will miss it.

### `Secure Download Mode` — the chip is refusing on purpose

Secure Download Mode disables the commands the stub needs. Nothing is wrong;
the device is configured not to allow this. Reads are impossible in this state,
writes may still work.

---

## Reads fail or return short

**`flash read checksum mismatch: expected 4096 bytes, got 4092`**, or a read
times out part way through.

The link is losing bytes. This is not a speed setting being "too fast" in the
usual sense, and it is not corruption you can retry your way out of.

A `READ_FLASH` transfer is **all-or-nothing**: the stub sends one MD5 over the
whole range, so one dropped byte discards everything. A 4 MB read on a link
that drops a byte every 100 KB will never complete, no matter how many
attempts you allow.

**Ask for less at a time.** That is the only thing that helps:

```js
await flash.read(offset, size, { chunkSize: 0x8000 });   // 32 KB at a time
```

The reference tooling does the same: `tools/fixture-device/capture.sh` halves
its chunk size on repeated failure, and `tools/hardware-check.mjs` takes
`--chunk`.

### Then change the speed — but measure, do not assume

Slower is **not** reliably safer. Measured on one CH340 board over a USB
passthrough, four 256 KB reads at each rate:

| baud | succeeded |
| --- | --- |
| 115200 | 2/4 |
| 230400 | 1/4 |
| **460800** | **4/4** |
| 921600 | 0/4 |
| 1500000 | 0/4 |

115200 was both slower *and* less reliable than 460800, and the ordering does
not transfer to another cable or host. Measure it:

```sh
for b in 115200 230400 250000 460800 500000 750000 921600 1500000; do
  esptool --port "$PORT" --baud $b read-flash 0x0 0x40000 /tmp/t.bin >/dev/null 2>&1 \
    && echo "$b ok" || echo "$b FAILED"
done
```

Use 256 KB, not 64 KB. Rates that pass a small read collapse over a megabyte.

### Rule out the library

Run the same read through esptool. If esptool fails too, it is the link:

```sh
esptool --port "$PORT" --baud 460800 read-flash 0x290000 0x50000 /tmp/t.bin
```

### If you are on a virtual machine

A USB passthrough — WSL2's usbipd, or a VM's USB forwarding — drops bytes far
more readily than a direct connection. Check whether the port is one:

```sh
ls -l /sys/class/tty/ttyUSB0/device/driver     # under vhci_hcd means usbip
```

Running the read on the host and copying the file across is faster and more
certain than tuning the passthrough.

---

## Reads work but the data looks wrong

**Two reads of the same region differ**, or a parser rejects data the device
clearly wrote.

Read the region twice and compare first. If the two reads differ, it is the
link — go back to the section above. If they agree, the bytes are what the
device holds and the question is what they mean.

### The device rewrote it between reads

Applications write to flash while running. NVS in particular accumulates erased
entries and advances its page sequence numbers on every boot, so a partition
captured an hour ago will not be byte-identical now even though nothing about
it is wrong. Compare *content*, not bytes:

```js
const before = parseNvs(fixture);
const after = parseNvs(justRead);
console.log(diffNvs(before, after));    // empty means nothing meaningful changed
```

### The image is a different format than its partition claims

A partition labelled `spiffs` can hold LittleFS. ESP-IDF's LittleFS defaults
its partition label to `"spiffs"` for historical reasons, so a sketch that
mounts both without naming their partitions formats one over the other. The
symptom is a `spiffs` partition full of data and a `littlefs` partition that is
entirely `0xFF`.

Look at offset 8: the string `littlefs` there is a LittleFS superblock,
whatever the label says.

---

## A partition shows as empty when it should not

**A filesystem or NVS partition parses with no files and no entries.**

Three different situations look identical in a summary, and only one of them
is "empty":

| Actually | How to tell |
| --- | --- |
| Never formatted | Every byte is `0xFF`. `analyzeBinary` reports `contents: 'erased'` |
| Formatted, genuinely empty | Structure is present — a superblock, valid NVS pages — with nothing in it |
| Full, but unreadable | Structure is absent *and* the bytes are not uniform |

The third is the one that matters. For NVS, an encrypted partition looks like
this: NVS encryption is a separate feature from flash encryption, keyed from an
`nvs_keys` partition, and it turns the whole region into ciphertext. The
analyzer says so when it sees no readable pages and high entropy.

**Note that flash encryption does not cover NVS.** A chip reporting "encryption
enabled" invites the opposite conclusion, and the analyzer warns about exactly
that.

---

## A filesystem lists files but their contents are wrong

**The right filenames appear; the bytes in them are scrambled.**

This is a SPIFFS geometry problem, and it is nastier than a failure would be.

SPIFFS records nothing about its own page and block size, so those have to be
inferred. A wrong geometry that happens to be a divisor of the right one still
lands on every object index header — so it finds all the correct filenames —
and reassembles the data from the wrong offsets. Read with 128-byte pages, a
real 256-byte-page image yields four correct names and four corrupted files.

`parseSpiffs` scores candidate geometries on whether the files they find hold
together rather than on how many they find, so this should not happen by
default. If you passed a geometry explicitly, or set `detectGeometry: false`,
try letting it decide:

```js
const image = parseSpiffs(bytes);          // detection on
console.log(image.geometry);               // and show the user what it chose
```

For FAT, the equivalent trap is the wear-levelling layer: ignoring it parses
the boot sector perfectly and then reads the file allocation table as the root
directory. `parseFat` locates the spare sector automatically;
`{ wlDummySector: -1 }` turns that off and should only be used on an image with
no wear-levelling layer at all.

---

## Writing NVS is refused

**`buildNvs` throws `NvsCapacityError`.**

The data does not fit, and it refuses rather than truncating a partition that a
device has to boot from. `error.details` says how much space would have been
needed.

Two things consume more room than people expect:

- **Blobs cost one entry per 32 bytes.** A 9000-byte blob is 285 entries. On a
  20 KB partition — five pages of 126 entries, one of which NVS holds free for
  garbage collection, so 504 usable — that is more than half of it.
- **One page is always reserved.** An image that used every page would leave
  the device unable to write anything at all, so `buildNvs` will not produce
  one.

If it genuinely does not fit, the answer is a larger partition, not a smaller
safety margin.

**`RangeError: … does not fit the declared type`** means a value is outside its
type — 300 in a `U8`, say. Change the value or the type; the reference app
rejects this at the input field rather than at build time, so the user finds
out before reading a confirmation dialog.

---

## Everything is slow

A 4 MB dump at 115200 takes about six minutes. At 1500000 it takes under one.

Raise the rate after the stub is loaded — that is the only point at which the
device can be told to change — and verify before trusting it:

```js
await loader.loadStub();
await loader.changeBaudRate(460800);
```

**The rate matters even on the chip's own USB.** It is tempting to assume that
USB-Serial/JTAG ignores it, since there is no UART in the path. Measured on an
ESP32-S3 and an ESP32-P4, reading 256 KB took 26 s at 115200 and 3.4 s at
1500000 — nearly eight times. Do not skip it there.

See [guide §11](./guide.md#11-going-faster) for choosing a rate.

---

## It works in the browser but not in Node

Three things differ, and all three are load-bearing:

1. **The stub cannot be fetched.** See [above](#the-stub-will-not-load).
2. **There is no transport.** Node has no serial API; write one against the
   five-method interface in [transports.md](./transports.md), which includes a
   complete example.
3. **Timeouts must not abandon reads.** The commonest mistake in a hand-written
   transport, and its symptom — chip detection failing on every board — points
   nowhere near the cause.

`tools/hardware-check.mjs` is a working Node setup you can read or run. It
drives the library against a board and compares the result with an esptool
capture, which is also the quickest way to find out whether a problem is yours
or the link's.

---

## Still stuck

Collect these before asking anyone:

- What the log says, with the error `code` rather than a paraphrase
- Chip, board, and how it is connected (direct USB, hub, VM passthrough)
- Whether esptool succeeds at the same operation
- Whether two reads of the same region agree

The first and third rule out most of this page.
