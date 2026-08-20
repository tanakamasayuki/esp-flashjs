// @ts-check
/**
 * Core dump parsing, against dumps three real chips wrote.
 *
 * This format cannot be tested the usual way. There is no builder to round-
 * trip against, and a dump is RAM at the instant of a crash — two runs of one
 * binary produce two different files. So the fixtures are the only source of
 * truth, and what is asserted is meaning, never bytes.
 *
 * There is one better oracle than the fixtures themselves, and it is used
 * here: on the boot after the crash, `fixture_device` asks ESP-IDF what it
 * thinks of the dump it just wrote and prints the answer. Those numbers are
 * recorded in tools/fixture-device/README.md, and they are the one account of
 * these bytes that this project cannot have got wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  parseCoreDump,
  isCoreDump,
  findTaskNameOffset,
  analyzeBinary,
  analyzeBinaryAs,
  detectFormat,
  COREDUMP_MACHINE,
} from '../src/core.js';
import { pathologicalInputs } from './helpers.js';

const CHIPS = [
  { slug: 'esp32', name: 'ESP32', architecture: 'xtensa', machine: COREDUMP_MACHINE.XTENSA },
  { slug: 'esp32s3', name: 'ESP32-S3', architecture: 'xtensa', machine: COREDUMP_MACHINE.XTENSA },
  { slug: 'esp32p4', name: 'ESP32-P4', architecture: 'riscv', machine: COREDUMP_MACHINE.RISCV },
];

/** @param {string} chip @returns {Uint8Array|null} */
function fixture(chip) {
  const path = new URL(`./fixtures/hardware/${chip}/coredump.bin`, import.meta.url);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

/* -------------------------------------------------------------------------- */
/* Real dumps                                                                  */
/* -------------------------------------------------------------------------- */

for (const chip of CHIPS) {
  test(`${chip.slug}: the dump parses with nothing to report`, (t) => {
    const data = fixture(chip.slug);
    if (!data) return t.skip('no captured fixture');

    const dump = parseCoreDump(data);
    assert.deepEqual(dump.issues, []);
    assert.equal(dump.dataFormat, 'elf');
    assert.equal(dump.chipName, chip.name);
    assert.equal(dump.architecture, chip.architecture);
    assert.equal(dump.machine, chip.machine);
    assert.equal(dump.checksum?.algorithm, 'crc32');
    assert.equal(dump.checksum?.valid, true);
    // A 64 KB partition holding a few KB of dump: the rest is erased flash and
    // must not be mistaken for part of it.
    assert.ok(dump.totalLength < data.length);
  });

  test(`${chip.slug}: every task has a name, a stack and a stack pointer inside it`, (t) => {
    const data = fixture(chip.slug);
    if (!data) return t.skip('no captured fixture');

    const dump = parseCoreDump(data);
    assert.ok(dump.tasks.length >= 5, `only ${dump.tasks.length} tasks`);

    for (const task of dump.tasks) {
      assert.ok(task.name, `task ${task.index} has no name`);
      assert.ok(task.stack, `${task.name} has no stack segment`);
      assert.ok(task.pc > 0, `${task.name} has no PC`);
      // The strongest self-check the dump offers. The stack pointer comes out
      // of the register set and the stack bounds come out of a program header,
      // by two unrelated paths — if either the gregset layout or the TCB-to-
      // stack pairing were wrong, they would not land on each other.
      assert.ok(
        task.stackPointer !== null
          && task.stackPointer >= task.stack.address
          && task.stackPointer < task.stack.address + task.stack.length,
        `${task.name}: sp 0x${(task.stackPointer ?? 0).toString(16)} is outside its dumped stack`,
      );
    }

    // Arduino always has these, and naming them proves the TCB offset landed
    // on real strings rather than on plausible-looking bytes.
    const names = dump.tasks.map((task) => task.name);
    for (const expected of ['loopTask', 'IDLE0', 'IDLE1']) {
      assert.ok(names.includes(expected), `no ${expected} among ${names.join(', ')}`);
    }
    assert.equal(dump.crashedTask?.name, 'loopTask');
    assert.match(/** @type {string} */ (dump.panicReason), /^abort\(\) was called at PC 0x[0-9a-f]+/);
  });

  test(`${chip.slug}: every segment belongs to something`, (t) => {
    const data = fixture(chip.slug);
    if (!data) return t.skip('no captured fixture');

    const dump = parseCoreDump(data);
    // ESP-IDF without CONFIG_ESP_COREDUMP_CAPTURE_DRAM dumps exactly one TCB
    // and one stack per task, and nothing else. An orphan segment would mean
    // the pairing dropped one — which is how a task would silently lose its
    // stack while the dump still looked complete.
    const loads = dump.segments.filter((s) => s.type === 1);
    assert.equal(loads.filter((s) => s.role === 'memory').length, 0);
    assert.equal(loads.filter((s) => s.role === 'tcb').length, dump.tasks.length);
    assert.equal(loads.filter((s) => s.role === 'stack').length, dump.tasks.length);
  });
}

test('the parse agrees with what the device said about its own dump', (t) => {
  const data = fixture('esp32s3');
  if (!data) return t.skip('no captured fixture');

  // Straight out of tools/fixture-device/README.md, which records what
  // esp_core_dump_image_get, esp_core_dump_image_check and
  // esp_core_dump_get_summary reported on the boot after the crash. Nothing in
  // this repository produced these numbers.
  const dump = parseCoreDump(data);
  assert.equal(dump.totalLength, 10884);
  assert.equal(dump.checksum?.valid, true);
  assert.equal(dump.panicReason, 'abort() was called at PC 0x42002db1 on core 1');
  assert.equal(dump.crashedTask?.name, 'loopTask');
  assert.equal(dump.version, 590082);
});

test('the version word names the chip that crashed', (t) => {
  // The chip id in the version is the one thing in the dump that identifies
  // the hardware, and it is what selects the register layout further down. If
  // it were read from the wrong half of the word every dump would decode as an
  // ESP32 and the P4's RISC-V registers would come out as Xtensa ones.
  for (const chip of CHIPS) {
    const data = fixture(chip.slug);
    if (!data) return t.skip('no captured fixture');
    const dump = parseCoreDump(data);
    assert.equal(dump.chipName, chip.name);
    assert.equal(dump.chipId, dump.version >>> 16);
    assert.equal(dump.versionLabel, 'ELF v2.1');
  }
});

test('the app hash lets a dump be matched to the build that produced it', (t) => {
  const seen = new Set();
  for (const chip of CHIPS) {
    const data = fixture(chip.slug);
    if (!data) return t.skip('no captured fixture');
    const hash = parseCoreDump(data).appElfSha256;
    assert.match(/** @type {string} */ (hash), /^[0-9a-f]+$/);
    seen.add(hash);
  }
  // Three chips, three different builds of the same sketch. A parser reading
  // the field at the wrong offset would return the same NUL-padded nothing for
  // all three and this would not notice.
  assert.equal(seen.size, CHIPS.length);
});

test('an Xtensa dump reports the exception registers, a RISC-V one does not pretend to', (t) => {
  const xtensa = fixture('esp32s3');
  const riscv = fixture('esp32p4');
  if (!xtensa || !riscv) return t.skip('no captured fixture');

  const names = parseCoreDump(xtensa).exceptionRegisters.map((r) => r.name);
  assert.ok(names.includes('exccause'));
  assert.ok(names.includes('excvaddr'));
  assert.ok(names.includes('epc1'));

  // The RISC-V EXTRA_INFO note is the crashed TCB and a terminator, nothing
  // else. Inventing register names for it would be worse than saying nothing.
  assert.deepEqual(parseCoreDump(riscv).exceptionRegisters, []);
});

/* -------------------------------------------------------------------------- */
/* The task name offset                                                        */
/* -------------------------------------------------------------------------- */

test('the task name offset is derived from the dump, not assumed', (t) => {
  const data = fixture('esp32s3');
  if (!data) return t.skip('no captured fixture');

  const dump = parseCoreDump(data);
  // 52 is what all three Arduino cores happen to use. The value is not the
  // point — that it was found rather than hard-coded is, because
  // configMAX_TASK_NAME_LEN and the MPU wrappers move it between builds.
  assert.equal(dump.taskNameOffset, 52);

  // One TCB disagreeing is enough to withdraw the answer for all of them. A
  // name is only trustworthy because every task in the dump corroborates it,
  // so a partial match must produce no names rather than mostly-right ones.
  const damaged = data.slice();
  const tcb = dump.segments.find((s) => s.role === 'tcb' && s.taskIndex === 1);
  assert.ok(tcb);
  damaged.fill(0x01, tcb.offset + 52, tcb.offset + 68);
  assert.equal(parseCoreDump(damaged).taskNameOffset, null);
  assert.deepEqual(
    parseCoreDump(damaged).tasks.map((task) => task.name),
    parseCoreDump(damaged).tasks.map(() => null),
  );
});

test('with no TCBs to agree, no offset is claimed', () => {
  assert.equal(findTaskNameOffset(new Uint8Array(256), []), null);
});

/* -------------------------------------------------------------------------- */
/* Damage                                                                      */
/* -------------------------------------------------------------------------- */

test('a corrupted dump is still read, and still called corrupted', (t) => {
  const data = fixture('esp32');
  if (!data) return t.skip('no captured fixture');

  const damaged = data.slice();
  damaged[2000] ^= 0xff;
  const dump = parseCoreDump(damaged);

  assert.equal(dump.checksum?.valid, false);
  assert.ok(dump.issues.some((i) => i.code === 'coredump.checksumMismatch'));
  // Whoever is looking at this has a device that already went wrong. Refusing
  // to show the task list because one byte moved would take away the only
  // record of what it was doing.
  assert.ok(dump.tasks.length > 0);
  assert.equal(dump.crashedTask?.name, 'loopTask');

  // ...and the confidence has to fall, or a damaged dump would outrank an
  // intact one when both are on offer.
  const result = analyzeBinary(damaged, {});
  assert.equal(result.type, 'coredump');
  assert.equal(result.confidence, 0.5);
});

test('a dump cut short by a partial read says so instead of guessing', (t) => {
  const data = fixture('esp32');
  if (!data) return t.skip('no captured fixture');

  const dump = parseCoreDump(data.subarray(0, 4096));
  assert.ok(dump.issues.some((i) => i.code === 'coredump.truncated'));
  assert.equal(dump.tasks.length, 0);
  // The header still parsed, and saying which chip wrote the dump is worth
  // more than nothing at all.
  assert.equal(dump.chipName, 'ESP32');

  // Detection must not claim it either: a half-read region is not a core dump
  // this library can describe.
  assert.deepEqual(detectFormat(data.subarray(0, 4096), {}), []);
});

test('no parser input makes this one throw', () => {
  for (const [name, data] of Object.entries(pathologicalInputs())) {
    assert.doesNotThrow(() => parseCoreDump(data), name);
    assert.doesNotThrow(() => isCoreDump(data), name);
  }
});

/* -------------------------------------------------------------------------- */
/* Header variants                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds a minimal dump: header, an ELF with one note, padding, checksum.
 *
 * Only the header variants need this. Everything about the body is tested
 * against real dumps, because a body written here would agree with whatever
 * this file believes rather than with what a chip does.
 *
 * @param {object} options
 * @param {number} options.version     Full 32-bit version word.
 * @param {number} options.headerSize
 * @param {number} [options.checksumSize]
 * @returns {Uint8Array}
 */
function coreDumpBytes({ version, headerSize, checksumSize = 4 }) {
  // namesz 6 and descsz 5, each padded to a 4-byte boundary: 12 + 8 + 8.
  const note = new Uint8Array(28);
  const nv = new DataView(note.buffer);
  nv.setUint32(0, 6, true); // namesz, "ESP_P" and its terminator
  nv.setUint32(4, 5, true); // descsz, "boom" and its terminator
  nv.setUint32(8, 679, true); // PANIC_DETAILS
  note.set(new TextEncoder().encode('ESP_P\0'), 12);
  note.set(new TextEncoder().encode('boom\0'), 20);

  const elf = new Uint8Array(52 + 32 + note.length);
  const ev = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  ev.setUint16(16, 4, true); // ET_CORE
  ev.setUint16(18, 0x5e, true); // EM_XTENSA
  ev.setUint32(20, 1, true);
  ev.setUint32(28, 52, true); // e_phoff
  ev.setUint16(40, 52, true); // e_ehsize
  ev.setUint16(42, 32, true); // e_phentsize
  ev.setUint16(44, 1, true); // e_phnum
  ev.setUint32(52, 4, true); // PT_NOTE
  ev.setUint32(56, 84, true); // p_offset
  ev.setUint32(68, note.length, true); // p_filesz
  elf.set(note, 84);

  const total = headerSize + elf.length + checksumSize;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, total, true);
  ov.setUint32(4, version, true);
  out.set(elf, headerSize);
  if (checksumSize === 4) ov.setUint32(total - 4, crcOf(out.subarray(0, total - 4)), true);
  return out;
}

/**
 * CRC-32 written out longhand.
 *
 * Calling the library's own `crc32` here would make the fixture agree with the
 * implementation it exists to check, which is the failure mode this whole test
 * directory is arranged around.
 *
 * @param {Uint8Array} data
 * @returns {number}
 */
function crcOf(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

test('the header length comes from the version, not from a constant', () => {
  // Four header lengths are in circulation and the version word is the only
  // thing that says which one is in front of you. Reading a 20-byte header as
  // 24 puts the ELF magic four bytes off and the dump reads as unrecognised
  // data — which is exactly how a working device looks broken.
  for (const [version, headerSize] of [
    [0x00090100, 20], // ELF v2, CRC-32
    [0x00090102, 24], // ELF v2.1, CRC-32 — what everything current writes
  ]) {
    const data = coreDumpBytes({ version, headerSize });
    assert.ok(isCoreDump(data), `0x${version.toString(16)}`);
    const dump = parseCoreDump(data);
    assert.equal(dump.headerSize, headerSize);
    assert.equal(dump.checksum?.valid, true);
    assert.equal(dump.panicReason, 'boom');
  }

  // Reading a v2 dump with the v2.1 header length is the mistake being guarded
  // against; spelled out so the guard is visibly doing something.
  const shifted = coreDumpBytes({ version: 0x00090102, headerSize: 20 });
  assert.equal(isCoreDump(shifted), false);
});

test('a SHA-256 dump is reported as unchecked, not as valid or as broken', () => {
  // Espressif's SHA-256 variant is off by default and no fixture exists for
  // it. The only SHA-256 available here is async, so it cannot be verified
  // inside a synchronous parser. Claiming it verified would be a lie, and
  // claiming it failed would accuse a sound dump.
  const data = coreDumpBytes({ version: 0x00090103, headerSize: 24, checksumSize: 32 });
  const dump = parseCoreDump(data);

  assert.equal(dump.checksum?.algorithm, 'sha256');
  assert.equal(dump.checksum?.valid, null);
  assert.equal(dump.checksum?.computed, null);
  assert.equal(dump.checksum?.stored.length, 64);
  assert.ok(dump.issues.some((i) => i.code === 'coredump.checksumNotVerified'));
  assert.equal(dump.panicReason, 'boom');

  // Magic without a verified checksum is 0.9, the same as everything else that
  // is well-identified but not proven.
  assert.equal(analyzeBinary(data, {}).confidence, 0.9);
});

test('a version nobody has seen is refused rather than parsed hopefully', () => {
  const data = coreDumpBytes({ version: 0x00090109, headerSize: 24 });
  assert.equal(isCoreDump(data), false);

  const dump = parseCoreDump(data);
  assert.ok(dump.issues.some((i) => i.code === 'coredump.unknownVersion'));
  assert.equal(dump.tasks.length, 0);
  // Guessing a header length would produce a task list from misaligned bytes,
  // and nothing downstream could tell it from a real one.
  assert.equal(dump.checksum, null);

  // Forcing the analyzer skips detection, so it has to reach the same verdict
  // on its own. It used to say 0.5 here — the value that means "a checksum was
  // checked and did not match", when none was checked at all.
  assert.equal(analyzeBinaryAs('coredump', data, {}).confidence, 0);
});

test('the pre-4.1 binary format is named but not decoded', () => {
  const data = coreDumpBytes({ version: 0x00000003, headerSize: 24 });
  const dump = parseCoreDump(data);

  assert.equal(dump.dataFormat, 'binary');
  assert.equal(dump.chipName, 'ESP32');
  assert.ok(dump.issues.some((i) => i.code === 'coredump.legacyFormat'));
  // There is no ELF in one of these. Reporting no tasks is right; reporting
  // tasks read out of an ELF that is not there would not be.
  assert.equal(dump.tasks.length, 0);
});
