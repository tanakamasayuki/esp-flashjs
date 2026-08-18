# Writing a transport

[日本語](./transports.ja.md) · **English**

A transport is the byte pipe between this library and a device. `WebSerialTransport`
is the one that ships; `MockTransport` is the one the tests use. Anything else —
Node.js, WebUSB, a TCP bridge to a remote board, a replay of a recorded session —
is roughly forty lines you write yourself.

---

## The interface

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(options?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<Uint8Array>} read
 * @property {(baudRate: number) => Promise<void>} [setBaudRate]
 * @property {(signals: {dtr?: boolean, rts?: boolean}) => Promise<void>} [setSignals]
 * @property {() => Promise<void>} [flushInput]
 * @property {string} [description]
 */
```

Five required methods. The three optional ones degrade gracefully:

| Missing | Consequence |
| --- | --- |
| `setSignals` | No automatic reset. The user holds BOOT and taps EN by hand; `canAutoReset()` reports this so the UI can say so |
| `setBaudRate` | The link stays at whatever it opened at |
| `flushInput` | Recovery after a failed operation is less reliable, because stale bytes from the abandoned transfer are decoded as the next reply |

---

## `read()` returns what has arrived, not what you asked for

There is no length parameter, and that is deliberate. SLIP frames are delimited
rather than length-prefixed, so the framing layer genuinely cannot know how many
bytes to ask for. Return whatever is buffered; the decoder above will ask again
if it needs more.

### The part that is easy to get wrong

**A timeout must not discard a read that is in flight.** The obvious
implementation races the underlying read against a timer:

```js
// Wrong. Do not do this.
async read({ timeoutMs = 3000 } = {}) {
  return Promise.race([
    this.reader.read().then((r) => r.value),
    new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError()), timeoutMs)),
  ]);
}
```

When the timer wins, the `reader.read()` promise is abandoned — but the read
itself is not cancelled. The chunk it eventually resolves with is dropped on the
floor. The next caller reads the chunk *after* that one, so every subsequent
frame is one behind.

This is not a theoretical concern. It shipped, and it presented as "chip
detection fails on all three boards" — a symptom with no visible connection to
timeouts. It was the second reply that went missing, not the first.

The fix is a **background pump**: one loop that reads continuously into a
buffer, and a `read()` that waits on the buffer with a deadline. A timeout then
stops the waiter, not the reading.

```js
class MyTransport {
  async open() {
    /* … */
    this.pending = new Uint8Array(0);
    this.pump = this.readLoop();   // never awaited here
  }

  async readLoop() {
    for (;;) {
      const chunk = await this.source.next();   // whatever your device gives you
      if (chunk === null) { this.closed = true; this.wake(); return; }
      this.append(chunk);
      this.wake();                              // release any waiting read()
    }
  }

  async read({ timeoutMs = 3000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const out = this.pending;
        this.pending = new Uint8Array(0);
        return out;
      }
      if (this.closed) throw new TransportClosedError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      await this.waitForData(remaining, signal);
    }
  }
}
```

`src/transport/web-serial.js` is a complete worked version of this shape.

---

## Node.js

The library does not ship a Node transport, and that is a decision rather than
an omission. Node has no serial API of its own, so one would mean depending on
`serialport`, which is a native module. This library has **zero runtime
dependencies**, which is what lets it run from a `<script type="module">` with
no build step, and a native dependency in the package would cost that for every
consumer — including the ones who only ever wanted to parse a `.bin` file.

Writing one in your own project costs about forty lines:

```js
import { SerialPort } from 'serialport';
import { EspLoader, EspFlash } from 'esp-flashjs';

class NodeSerialTransport {
  constructor(path, baudRate = 115200) {
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
    this.pending = [];
    this.waiters = [];
  }

  isOpen() { return Boolean(this.port?.isOpen); }
  get description() { return `${this.path} @ ${this.baudRate}`; }

  async open() {
    this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    // The pump: 'data' fires whenever bytes arrive, independently of read().
    this.port.on('data', (buf) => {
      this.pending.push(new Uint8Array(buf));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async close() {
    if (this.port?.isOpen) await new Promise((res) => this.port.close(() => res()));
    this.port = null;
  }

  async write(data) {
    await new Promise((res, rej) => this.port.write(Buffer.from(data), (e) => (e ? rej(e) : res())));
  }

  async read({ timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const total = this.pending.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of this.pending.splice(0)) { out.set(c, at); at += c.length; }
        return out;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('transport timeout');
      await new Promise((res) => {
        const timer = setTimeout(res, remaining);
        this.waiters.push(() => { clearTimeout(timer); res(); });
      });
    }
  }

  async setSignals({ dtr, rts }) {
    await new Promise((res, rej) =>
      this.port.set({ dtr: dtr ?? false, rts: rts ?? false }, (e) => (e ? rej(e) : res())));
  }

  async setBaudRate(baudRate) {
    this.baudRate = baudRate;
    await new Promise((res, rej) => this.port.update({ baudRate }, (e) => (e ? rej(e) : res())));
  }

  async flushInput() {
    this.pending.length = 0;
    await new Promise((res) => this.port.flush(() => res()));
  }
}

const loader = new EspLoader(new NodeSerialTransport('/dev/ttyUSB0'));
await loader.connect();
await loader.loadStub();
const info = await new EspFlash(loader).getInfo();
```

Note the `'data'` handler doing the pumping. `serialport` gives you that shape
for free, which is why this version is shorter than the Web Serial one.

---

## WebUSB

Not planned, for two different reasons depending on the device.

**Behind a bridge chip** — CP210x, CH340, FTDI — WebUSB means reimplementing
each vendor's control-transfer protocol for setting the line rate and toggling
DTR/RTS. That is three or more device-specific drivers to write and, more to the
point, to keep working; the browser already has one, and it is Web Serial.

**On the chip's own USB** — the USB-Serial/JTAG peripheral on the C3, S3, C6, H2
and P4 — WebUSB is a genuinely reasonable path, and would reach Android Chrome,
which supports WebUSB but not Web Serial. That is a real gap and the case for
closing it is real too. It is out of scope here rather than a bad idea: it needs
hardware testing this project cannot do from a test suite, and it only helps the
subset of chips with native USB.

If you want it, the interface above is all you need to implement; nothing else
in the library knows what a serial port is.

---

## Testing your transport

`MockTransport` exists so the protocol can be tested without hardware. For a
*transport*, the useful test is the opposite: drive your transport with a fake
byte source and check it survives the awkward cases.

```js
// A chunk that arrives after the read timed out must reach the next caller.
const t = new MyTransport(source);
await t.open();
await assert.rejects(() => t.read({ timeoutMs: 10 }));
source.emit(Uint8Array.of(1, 2, 3));
assert.deepEqual(await t.read({ timeoutMs: 100 }), Uint8Array.of(1, 2, 3));
```

That single test is the one that would have caught the bug described above;
`test/web-serial.test.js` contains it, along with repeated timeouts not
consuming queued data, and data arriving before any read at all. Frame
reassembly itself belongs a layer up and is covered by the `SlipDecoder` tests
in `test/protocol.test.js` — your transport does not need to worry about frame
boundaries.

`test/transport-contract.test.js` checks that a transport with only the five
required methods really can reach a device. Every transport shipped here
implements all eight, so without that test a hidden dependency on an optional
one would never surface.
