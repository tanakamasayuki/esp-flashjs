#!/usr/bin/env python3
"""A serial port, exposed to a process that has no serial API.

Node has no way to open a serial port, and adding one to this project would
mean a native dependency the published package must not carry. This bridge
exists so the library can be driven against real hardware anyway: it owns the
port, and speaks a two-byte-header protocol over stdio.

    stdout   raw bytes read from the port, and nothing else
    stdin    commands, framed as below
    stderr   diagnostics

Commands:

    W <u32 length> <payload>   write payload to the port
    S <u8 flags>               set DTR (bit 0) and RTS (bit 1)
    B <u32 baud>               change the line rate
    F                          discard whatever has arrived but not been read

Usage:

    serial-bridge.py /dev/ttyUSB0 [baud]
"""

import os
import struct
import sys
import threading

try:
    import serial
except ImportError:  # pragma: no cover - environment problem, not a code path
    sys.stderr.write("pyserial is required: pip install pyserial\n")
    raise SystemExit(2)


def read_exactly(stream, count):
    """Reads exactly `count` bytes, or returns None at end of input.

    A pipe read can return short whatever the sender did, so a single read()
    is not enough to recover a frame that was written in one go.
    """
    out = bytearray()
    while len(out) < count:
        chunk = stream.read(count - len(out))
        if not chunk:
            return None
        out.extend(chunk)
    return bytes(out)


def pump_port_to_stdout(port, out):
    """Forwards everything the device says, as it arrives.

    Reading on its own thread is what makes a timeout on the other side safe:
    a chunk that arrives after the reader gave up is still delivered, rather
    than being abandoned inside a cancelled read.
    """
    while True:
        try:
            waiting = port.in_waiting or 1
            data = port.read(waiting)
        except Exception as error:  # the port went away
            sys.stderr.write(f"bridge: read failed: {error}\n")
            return
        if data:
            out.write(data)
            out.flush()


def main():
    if len(sys.argv) < 2:
        sys.stderr.write(__doc__)
        return 2

    path = sys.argv[1]
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

    # Opening with DTR and RTS already deasserted, so merely attaching does not
    # reset a board that is mid-operation.
    port = serial.Serial()
    port.port = path
    port.baudrate = baud
    port.timeout = 0.05
    port.dtr = False
    port.rts = False
    port.open()
    sys.stderr.write(f"bridge: {path} @ {baud}\n")
    sys.stderr.flush()

    stdout = os.fdopen(sys.stdout.fileno(), "wb", buffering=0)
    stdin = os.fdopen(sys.stdin.fileno(), "rb", buffering=0)

    reader = threading.Thread(target=pump_port_to_stdout, args=(port, stdout), daemon=True)
    reader.start()

    while True:
        kind = stdin.read(1)
        if not kind:
            break

        if kind == b"W":
            header = read_exactly(stdin, 4)
            if header is None:
                break
            (length,) = struct.unpack("<I", header)
            payload = read_exactly(stdin, length)
            if payload is None:
                break
            port.write(payload)
            port.flush()

        elif kind == b"S":
            flags = read_exactly(stdin, 1)
            if flags is None:
                break
            port.dtr = bool(flags[0] & 1)
            port.rts = bool(flags[0] & 2)

        elif kind == b"B":
            header = read_exactly(stdin, 4)
            if header is None:
                break
            (rate,) = struct.unpack("<I", header)
            port.baudrate = rate

        elif kind == b"F":
            port.reset_input_buffer()

        else:
            sys.stderr.write(f"bridge: unknown command {kind!r}\n")
            break

    port.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
