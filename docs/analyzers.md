# Writing an analyzer

[日本語](./analyzers.ja.md) · **English**

An analyzer teaches ESP FlashJS to recognise and describe a binary format. The
library ships analyzers for partition tables, firmware images, OTA data, NVS,
SPIFFS, LittleFS and FAT; anything else — a vendor's provisioning blob, a
config region, a proprietary log — is a plugin you can register at runtime.

This page is about writing one. The type definitions are in
[spec.md §9](./spec.md#9-binary-analyzers-and-plugins).

---

## The shape

```js
import { registerAnalyzer } from 'esp-flashjs/core';

registerAnalyzer({
  id: 'my-format',
  name: 'My Format',
  detect(data, ctx) { return { confidence: 0.0 }; },
  analyze(data, ctx) { return { /* AnalysisResult */ }; },
});
```

`detect` answers "is this mine, and how sure am I?". `analyze` runs only for
the winner and produces the description the UI renders. Both receive the same
`ctx`: `{ offset?, partition?, flashSize? }`, where `partition` is the entry
from the partition table the data came from, when it is known.

---

## A worked example

Say a device stores a provisioning record: an eight-byte magic, a version, a
length, then a UTF-8 JSON payload.

```js
import { registerAnalyzer } from 'esp-flashjs/core';

const MAGIC = 'PROVCFG1';

/** @param {Uint8Array} data */
function hasMagic(data) {
  if (data.length < 16) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

registerAnalyzer({
  id: 'provcfg',
  name: 'Provisioning Config',

  detect(data) {
    if (!hasMagic(data)) return { confidence: 0 };
    const length = new DataView(data.buffer, data.byteOffset).getUint32(12, true);
    // A magic plus a length that fits is strong evidence. A magic whose length
    // runs off the end of the region is a corrupted record, not a coincidence,
    // so it still counts as a match — just not a confident one.
    return length + 16 <= data.length
      ? { confidence: 0.9, reasonCode: 'magicAndLength' }
      : { confidence: 0.5, reasonCode: 'lengthOverruns' };
  },

  analyze(data) {
    const view = new DataView(data.buffer, data.byteOffset);
    const version = view.getUint32(8, true);
    const length = view.getUint32(12, true);
    const issues = [];

    const available = Math.min(length, data.length - 16);
    if (available < length) {
      issues.push({
        level: 'error',
        code: 'provcfg.truncated',
        params: { declared: length, available },
      });
    }

    let payload = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(data.subarray(16, 16 + available)));
    } catch (error) {
      issues.push({ level: 'error', code: 'provcfg.badJson', params: { message: String(error) } });
    }

    return {
      type: 'provcfg',
      confidence: available === length ? 0.9 : 0.5,
      metadata: { version, length, keys: payload ? Object.keys(payload).length : 0 },
      regions: [
        { offset: 0, length: 16, label: 'Header', kind: 'header' },
        { offset: 16, length: available, label: 'JSON payload', kind: 'data' },
      ],
      issues,
      model: payload,
    };
  },
});
```

Registering it is enough — `analyzeBinary` picks it up from then on, in the web
app as well as in your own code.

---

## Rules that are not obvious

### `detect` must be cheap

It runs for every registered analyzer on every buffer, including multi-megabyte
ones. Check a magic, check a length, sample a header. Do not parse the whole
region to decide whether you can parse the whole region.

Where a format has no magic — SPIFFS and NVS do not — lean on
`ctx.partition.subtypeName` and fall back to parsing with a single default
configuration, never a sweep.

### `detect` must not throw

A detector that throws is skipped and the sweep continues. Relying on that is
still a bug: an exception is not a decision, and it costs you the chance to
return a *low* confidence, which is often the honest answer.

### Never claim erased flash

This one bit the built-in analyzers. A blank `nvs` partition is still an `nvs`
partition as far as the table is concerned, so an analyzer leaning on the
subtype hint will happily claim a region of `0xFF` and report a filesystem
containing no files. "Empty" and "never formatted" then look identical, and
only one of them means the device is working.

```js
detect(data, ctx) {
  if (isUniform(data, 0xff) || isUniform(data, 0x00)) return { confidence: 0 };
  ...
}
```

Let the `raw` analyzer answer instead; it reports `contents: 'erased'`, which
is the true answer.

### Confidence is a claim about evidence, not about effort

| Value | What it should mean |
| --- | --- |
| 1.0 | A magic *and* a checksum or hash both verify |
| 0.8–0.95 | A magic matches, or the partition subtype says so and the structure agrees |
| 0.5 | A magic matches but something contradicts it, or the structure fits with nothing to corroborate it |
| 0.3–0.4 | Inference only — a plausible header and nothing else |
| 0.0 | Not mine |

Below 0.3 the `raw` analyzer wins, which is the right outcome for a guess.
Inflating confidence to make your analyzer win does not make it right; it makes
a wrong answer harder to notice.

The bundled analyzers put a partition subtype in the 0.8–0.9 band rather than
treating it as a bare guess: the table is a strong statement about what the
region is meant to hold. It is still not proof about the bytes, which is why
nothing identified by subtype alone reaches 1.0 — `nvs` stops at 0.9 because
the NVS format contains nothing that names itself.

### Report problems, do not throw them

`analyze` runs after detection has already committed to your analyzer. Throwing
loses everything — including the parts that parsed. Fill `issues` and return
what you have, with `complete: false` or a reduced confidence where that
applies. A partial answer with a stated problem is more useful than an
exception, especially to someone looking at a device that is already broken.

### Regions are for the hex view

Every `BinaryRegion` offset is relative to the buffer handed to `analyze`, not
to the flash address it came from. Emitting them lets the hex viewer label and
highlight structure; emitting thousands of them does not help anyone, so cap
long lists (the filesystem analyzers stop at 512 files).

---

## Testing an analyzer

The one rule that matters, from
[the development guide](./development.md#33-two-kinds-of-fixture-and-when-each-one-lies):

> When a parser reads a format this project did not invent, at least one test
> must run against bytes this project did not produce.

An analyzer tested only against images its own writer produced will agree with
itself whether or not it is right. Every format bug in this project's history
passed a full suite for exactly that reason.

Beyond that, two checks are worth writing for any analyzer:

```js
// Nothing else may claim your region…
assert.deepEqual(detectFormat(myData, {}).filter((c) => c.id !== 'provcfg'), []);

// …and you may not claim anyone else's.
for (const other of [nvsImage, spiffsImage, fatImage, erasedFlash]) {
  assert.equal(detect(other, {}).confidence, 0);
}
```

A false positive is not obviously wrong when you look at it: a filesystem
misidentified as another filesystem still produces a plausible file list.

---

## Removing and listing

```js
unregisterAnalyzer('provcfg');
listAnalyzers();  // -> [{ id, name }, …]
```

`analyzeBinaryAs('provcfg', data, ctx)` forces a specific analyzer regardless
of detection, which is what the web app's format selector uses. It is also the
quickest way to see what your analyzer makes of a region it did not win.
