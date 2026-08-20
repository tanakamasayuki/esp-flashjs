// @ts-check
/**
 * ESP-IDF core dump parsing.
 *
 * A core dump is what the panic handler writes to a `coredump` partition
 * before the chip reboots: a short header, an `ET_CORE` ELF image holding one
 * register set and one stack per task, and a checksum. The header layout is
 * documented in ESP-IDF's own `esp_core_dump.h`; everything below that comes
 * from measuring three dumps written by three different chips and cross-
 * checking against `esp_coredump`, the reference decoder Espressif ships.
 *
 * ```
 *  0  4  TOTAL_LEN    everything on flash, checksum included
 *  4  4  VERSION      (chip id << 16) | (major << 8) | minor
 *  8  4  TASKS_NUM    written as 0 in the ELF format
 * 12  4  TCB_SIZE     written as 0 in the ELF format
 * 16  4  MEM_SEG_NUM  written as 0 in the ELF format   (v2.1 and v2 only)
 * 20  4  CHIP_REV                                       (v2.1 only)
 *  .  .  ET_CORE ELF image
 *  .  .  zero padding
 * end-4  4  CRC-32 over everything before it            (or a 32-byte SHA-256)
 * ```
 *
 * The header is **not** a fixed 24 bytes: its length and the checksum
 * algorithm both depend on the version word, and picking the wrong one shifts
 * the ELF and invalidates the checksum. {@link COREDUMP_LAYOUTS} is the table.
 *
 * Two things make this format unusual among the ones this library reads. It
 * carries a magic *and* a checksum, so a match can honestly reach confidence
 * 1.0. And it holds RAM rather than constants, so no two dumps are alike even
 * from the same binary — tests here assert meaning, never bytes.
 *
 * What this does not do is unwind a call stack. That needs the application's
 * own ELF to resolve addresses to functions, and nothing in the dump carries
 * it; `esp_coredump` shells out to GDB for exactly this reason. The PC and SP
 * of every task are reported, which is where such an unwind would start.
 *
 * @module format/coredump
 */

import { crc32 } from '../binary/hash.js';
import { bytesToHex, decodeCString } from '../util/hex.js';
import { IMAGE_CHIP_IDS } from './image.js';

/**
 * @typedef {import('./partition.js').Issue} Issue
 */

/** Data format carried in the version word's major byte. */
export const COREDUMP_FORMAT = Object.freeze({ BINARY: 0, ELF: 1 });

/** `e_machine` values ESP-IDF emits. */
export const COREDUMP_MACHINE = Object.freeze({ XTENSA: 0x5e, RISCV: 0xf3 });

/**
 * ELF note types ESP-IDF uses, beyond the standard `NT_PRSTATUS`.
 *
 * The values are Espressif's own and do not follow any convention; they are
 * listed in `esp_coredump/corefile/elf.py` as `PT_ESP_*`.
 */
export const COREDUMP_NOTE = Object.freeze({
  PRSTATUS: 1,
  EXTRA_INFO: 677,
  TASK_INFO: 678,
  PANIC_DETAILS: 679,
  INFO: 8266,
});

/**
 * Header size and checksum algorithm, by the low 16 bits of the version word.
 *
 * These are not derivable from the bytes — a dump whose header is 20 bytes and
 * one whose header is 24 both start with a plausible `TOTAL_LEN` — so the
 * version has to be trusted for this one thing and then checked by whether the
 * ELF magic lands where the table says it should.
 *
 */
export const COREDUMP_LAYOUTS = Object.freeze(
  /** @type {Record<number, {headerSize: number, checksum: 'crc32'|'sha256', label: string}>} */ ({
    0x0001: { headerSize: 16, checksum: 'crc32', label: 'binary v1' },
    0x0002: { headerSize: 20, checksum: 'crc32', label: 'binary v2' },
    0x0003: { headerSize: 24, checksum: 'crc32', label: 'binary v2.1' },
    0x0100: { headerSize: 20, checksum: 'crc32', label: 'ELF v2' },
    0x0101: { headerSize: 20, checksum: 'sha256', label: 'ELF v2' },
    0x0102: { headerSize: 24, checksum: 'crc32', label: 'ELF v2.1' },
    0x0103: { headerSize: 24, checksum: 'sha256', label: 'ELF v2.1' },
    0x0104: { headerSize: 12, checksum: 'sha256', label: 'ELF v2.2' },
  }),
);

/** Offset of `pr_pid` — which holds the TCB address — within `elf_prstatus`. */
const PRSTATUS_PID_OFFSET = 24;

/** Offset of the register set within `elf_prstatus`. */
const PRSTATUS_REGS_OFFSET = 72;

/**
 * Xtensa general register indices, from `gdb/xtensa-tdep.h`.
 *
 * ESP-IDF normalizes the window before writing, so `windowbase` is zero and
 * `ar[0..15]` are the task's current `a0..a15`. That is why the stack pointer
 * can be read straight out of `ar[1]` rather than rotated into place.
 */
const XTENSA_REG = Object.freeze({ PC: 0, PS: 1, LBEG: 2, LEND: 3, LCOUNT: 4, SAR: 5, AR: 64 });

/** RISC-V general registers, in gregset order. */
const RISCV_REG_NAMES = Object.freeze([
  'pc', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
  't3', 't4', 't5', 't6',
]);

/** Xtensa special register numbers that appear as ids in the EXTRA_INFO note. */
const XTENSA_EPC1 = 177;
const XTENSA_EPS2 = 194;

/**
 * @typedef {object} CoreDumpSegment
 * @property {number} index
 * @property {number} type        `PT_LOAD` (1) or `PT_NOTE` (4).
 * @property {number} offset      Offset within the buffer, not within the ELF.
 * @property {number} address     Virtual address the bytes came from; 0 for notes.
 * @property {number} length
 * @property {'tcb'|'stack'|'memory'|'notes'} role
 * @property {number|null} taskIndex Task this belongs to, for `tcb` and `stack`.
 */

/**
 * @typedef {object} CoreDumpTask
 * @property {number} index
 * @property {number} tcbAddress  FreeRTOS TCB pointer; ESP-IDF stores it in `pr_pid`.
 * @property {string|null} name   Read out of the TCB; see {@link findTaskNameOffset}.
 * @property {number} pc
 * @property {number|null} stackPointer
 * @property {boolean} crashed
 * @property {{address: number, length: number}|null} stack Bytes present in the dump.
 * @property {Array<{name: string, value: number}>} registers
 */

/**
 * @typedef {object} CoreDumpChecksum
 * @property {'crc32'|'sha256'} algorithm
 * @property {number} offset
 * @property {string} stored      Hex, so both algorithms read the same way.
 * @property {string|null} computed `null` when this build cannot verify it.
 * @property {boolean|null} valid `null` means "not checked", never "wrong".
 */

/**
 * @typedef {object} CoreDump
 * @property {number} totalLength   From the header; may exceed the buffer.
 * @property {number} version       The whole 32-bit version word.
 * @property {number} major
 * @property {number} minor
 * @property {'elf'|'binary'} dataFormat
 * @property {string} versionLabel
 * @property {number} chipId
 * @property {string} chipName
 * @property {number|null} chipRevision  `major * 100 + minor`, as the eFuse
 *   reports it: 301 is v3.1. Absent before header v2.1.
 * @property {number} headerSize
 * @property {CoreDumpChecksum|null} checksum
 * @property {'xtensa'|'riscv'|'unknown'} architecture
 * @property {number|null} machine
 * @property {CoreDumpTask[]} tasks
 * @property {CoreDumpTask|null} crashedTask
 * @property {string|null} panicReason
 * @property {string|null} appElfSha256  Prefix of the app image's ELF hash.
 * @property {Array<{name: string, value: number}>} exceptionRegisters
 * @property {CoreDumpSegment[]} segments
 * @property {CoreDumpNote[]} notes
 * @property {number|null} taskNameOffset
 * @property {Issue[]} issues
 */

/**
 * Whether a buffer starts with a core dump header this module understands.
 *
 * Cheap enough for a detection pass: it reads the version word, looks the
 * layout up, and checks that the ELF magic is where that layout puts it.
 *
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function isCoreDump(data) {
  if (data.length < 32) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const layout = COREDUMP_LAYOUTS[view.getUint32(4, true) & 0xffff];
  if (!layout) return false;
  const total = view.getUint32(0, true);
  if (total < layout.headerSize + checksumSize(layout.checksum) || total > data.length) return false;
  // The binary format has no ELF in it, so the version word plus a length that
  // fits is all there is to go on.
  if (view.getUint32(4, true) >> 8 === COREDUMP_FORMAT.BINARY) return true;
  const at = layout.headerSize;
  return data[at] === 0x7f && data[at + 1] === 0x45 && data[at + 2] === 0x4c && data[at + 3] === 0x46;
}

/**
 * Parses a core dump partition image.
 *
 * Trailing erased flash is expected and ignored: the partition is 64 KB and a
 * dump is rarely more than a few.
 *
 * @param {Uint8Array} data
 * @returns {CoreDump}
 */
export function parseCoreDump(data) {
  /** @type {Issue[]} */
  const issues = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // The shortest header any version defines is twelve bytes. Below that there
  // is nothing to read, and a partial read of a partition is a real way to get
  // here — see `flash.readRetry`.
  const short = data.length < 12;
  const totalLength = short ? 0 : view.getUint32(0, true);
  const version = short ? 0 : view.getUint32(4, true);
  const chipId = version >>> 16;
  const dumpVersion = version & 0xffff;
  const major = (dumpVersion >> 8) & 0xff;
  const minor = dumpVersion & 0xff;
  const layout = COREDUMP_LAYOUTS[dumpVersion];

  /** @type {CoreDump} */
  const dump = {
    totalLength,
    version,
    major,
    minor,
    dataFormat: major === COREDUMP_FORMAT.ELF ? 'elf' : 'binary',
    versionLabel: layout?.label ?? `unknown (0x${dumpVersion.toString(16)})`,
    chipId,
    chipName: IMAGE_CHIP_IDS[chipId] ?? 'unknown',
    chipRevision: null,
    headerSize: layout?.headerSize ?? 24,
    checksum: null,
    architecture: 'unknown',
    machine: null,
    tasks: [],
    crashedTask: null,
    panicReason: null,
    appElfSha256: null,
    exceptionRegisters: [],
    segments: [],
    notes: [],
    taskNameOffset: null,
    issues,
  };

  if (short) {
    issues.push({
      level: 'error',
      code: 'coredump.truncated',
      params: { declared: 0, available: data.length },
    });
    return dump;
  }
  if (!layout) {
    issues.push({ level: 'error', code: 'coredump.unknownVersion', params: { version } });
    return dump;
  }
  // A declared length that cannot hold its own header and checksum is damage,
  // not a short dump — and reading a checksum at a negative offset would take
  // bytes from the end of the buffer and call them a stored value.
  if (totalLength > data.length || totalLength < layout.headerSize + checksumSize(layout.checksum)) {
    issues.push({
      level: 'error',
      code: 'coredump.truncated',
      params: { declared: totalLength, available: data.length },
    });
    return dump;
  }

  dump.chipRevision =
    layout.headerSize >= 24 ? view.getUint32(20, true)
    : layout.headerSize === 12 ? view.getUint32(8, true)
    : null;
  dump.checksum = verifyChecksum(data, totalLength, layout.checksum, issues);

  if (dump.dataFormat === 'binary') {
    // Pre-IDF-4.1 dumps store task headers and raw TCBs rather than an ELF.
    // Nothing this project can reach still writes them, so the header is
    // reported and the body is left as bytes rather than parsed blind.
    issues.push({ level: 'warning', code: 'coredump.legacyFormat', params: {} });
    return dump;
  }

  const elf = parseElf(data, layout.headerSize, totalLength, issues);
  if (!elf) return dump;

  dump.machine = elf.machine;
  dump.architecture =
    elf.machine === COREDUMP_MACHINE.XTENSA ? 'xtensa'
    : elf.machine === COREDUMP_MACHINE.RISCV ? 'riscv'
    : 'unknown';

  const notes = readNotes(data, elf, issues);
  dump.notes = notes.entries;
  dump.panicReason = notes.panicReason;
  dump.appElfSha256 = notes.appElfSha256;
  dump.exceptionRegisters = decodeExtraInfo(notes.extraInfo, dump.architecture);

  // The version appears twice — in the flash header and in the INFO note —
  // and IDF's own loader refuses an app image whose recorded version differs.
  // A mismatch here means the two halves came from different dumps.
  if (notes.infoVersion !== null && notes.infoVersion !== version) {
    issues.push({
      level: 'warning',
      code: 'coredump.versionMismatch',
      params: { header: version, note: notes.infoVersion },
    });
  }

  buildTasks(dump, data, elf, notes, issues);

  if (dump.tasks.length === 0) {
    issues.push({ level: 'warning', code: 'coredump.noTasks', params: {} });
  }
  return dump;
}

/* -------------------------------------------------------------------------- */
/* Checksum                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {Uint8Array} data
 * @param {number} totalLength
 * @param {'crc32'|'sha256'} algorithm
 * @param {Issue[]} issues
 * @returns {CoreDumpChecksum}
 */
function verifyChecksum(data, totalLength, algorithm, issues) {
  const offset = totalLength - checksumSize(algorithm);

  if (algorithm === 'sha256') {
    const stored = bytesToHex(data.subarray(offset, totalLength));
    // The only SHA-256 available here is `crypto.subtle`, which is async, and
    // an async parser would infect every caller for a build variant that is
    // off by default. Saying "not checked" is honest; saying "valid" would
    // not be, and `valid: false` would accuse a sound dump.
    issues.push({ level: 'warning', code: 'coredump.checksumNotVerified', params: {} });
    return { algorithm, offset, stored, computed: null, valid: null };
  }

  // IDF hashes the header and the body together — everything before the
  // checksum — with the ordinary reflected CRC-32, seed 0xFFFFFFFF. Not the
  // `esp_rom_crc32_le` convention otadata and NVS use; that one starts the
  // loop at zero and would reject every valid dump.
  const computed = crc32(data.subarray(0, offset));
  const storedValue = new DataView(data.buffer, data.byteOffset).getUint32(offset, true);
  const valid = computed === storedValue;
  if (!valid) {
    issues.push({
      level: 'error',
      code: 'coredump.checksumMismatch',
      params: { expected: toHex32(storedValue), actual: toHex32(computed) },
    });
  }
  return {
    algorithm,
    offset,
    stored: toHex32(storedValue).slice(2),
    computed: toHex32(computed).slice(2),
    valid,
  };
}

/* -------------------------------------------------------------------------- */
/* ELF                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} ElfView
 * @property {number} base       Offset of the ELF header within the buffer.
 * @property {number} machine
 * @property {Array<{type: number, offset: number, address: number, length: number, flags: number}>} phdrs
 */

/**
 * @param {Uint8Array} data
 * @param {number} base
 * @param {number} limit
 * @param {Issue[]} issues
 * @returns {ElfView|null}
 */
function parseElf(data, base, limit, issues) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[base] !== 0x7f || data[base + 1] !== 0x45 || data[base + 2] !== 0x4c || data[base + 3] !== 0x46) {
    issues.push({ level: 'error', code: 'coredump.notElf', params: { offset: toHex32(base) } });
    return null;
  }
  const type = view.getUint16(base + 16, true);
  if (type !== 4) {
    issues.push({ level: 'warning', code: 'coredump.notCoreElf', params: { type } });
  }
  const machine = view.getUint16(base + 18, true);
  const phoff = view.getUint32(base + 28, true);
  const phentsize = view.getUint16(base + 42, true);
  const phnum = view.getUint16(base + 44, true);

  /** @type {ElfView['phdrs']} */
  const phdrs = [];
  for (let i = 0; i < phnum; i++) {
    const at = base + phoff + i * phentsize;
    if (at + 32 > limit) {
      issues.push({ level: 'error', code: 'coredump.truncatedSegments', params: { index: i, declared: phnum } });
      break;
    }
    const offset = base + view.getUint32(at + 4, true);
    const length = view.getUint32(at + 16, true);
    if (offset + length > limit) {
      issues.push({ level: 'error', code: 'coredump.segmentOverruns', params: { index: i } });
      continue;
    }
    phdrs.push({
      type: view.getUint32(at, true),
      offset,
      address: view.getUint32(at + 8, true),
      length,
      flags: view.getUint32(at + 24, true),
    });
  }
  return { base, machine, phdrs };
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} CoreDumpNote
 * @property {number} segment  Index of the program header holding it.
 * @property {number} offset   Offset within the buffer.
 * @property {number} length   Including the name, the descriptor and padding.
 * @property {string} name
 * @property {number} type
 */

/**
 * @typedef {object} CoreDumpNotes
 * @property {Array<{tcbAddress: number, registers: Uint32Array}>} prstatus
 * @property {string|null} panicReason
 * @property {string|null} appElfSha256
 * @property {number|null} infoVersion
 * @property {number[]} extraInfo
 * @property {CoreDumpNote[]} entries
 */

/**
 * @param {Uint8Array} data
 * @param {ElfView} elf
 * @param {Issue[]} issues
 * @returns {CoreDumpNotes}
 */
function readNotes(data, elf, issues) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  /** @type {CoreDumpNotes} */
  const notes = {
    prstatus: [],
    panicReason: null,
    appElfSha256: null,
    infoVersion: null,
    extraInfo: [],
    entries: [],
  };

  for (const [index, phdr] of elf.phdrs.entries()) {
    if (phdr.type !== 4) continue;
    let at = phdr.offset;
    const end = phdr.offset + phdr.length;
    while (at + 12 <= end) {
      const nameSize = view.getUint32(at, true);
      const descSize = view.getUint32(at + 4, true);
      const type = view.getUint32(at + 8, true);
      const descAt = at + 12 + align4(nameSize);
      if (descAt + descSize > end) {
        issues.push({ level: 'warning', code: 'coredump.truncatedNote', params: { offset: toHex32(at) } });
        break;
      }
      const name = decodeCString(data.subarray(at + 12, at + 12 + nameSize));
      const desc = data.subarray(descAt, descAt + descSize);
      notes.entries.push({ segment: index, offset: at, length: descAt + align4(descSize) - at, name, type });

      if (type === COREDUMP_NOTE.PRSTATUS && descSize > PRSTATUS_REGS_OFFSET) {
        const count = (descSize - PRSTATUS_REGS_OFFSET) >> 2;
        const registers = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
          registers[i] = view.getUint32(descAt + PRSTATUS_REGS_OFFSET + i * 4, true);
        }
        notes.prstatus.push({
          tcbAddress: view.getUint32(descAt + PRSTATUS_PID_OFFSET, true),
          registers,
        });
      } else if (type === COREDUMP_NOTE.PANIC_DETAILS) {
        notes.panicReason = decodeCString(desc) || null;
      } else if (type === COREDUMP_NOTE.INFO && descSize >= 4) {
        notes.infoVersion = view.getUint32(descAt, true);
        // The field is a fixed 65-byte buffer holding as much of the app ELF's
        // SHA-256 as `CONFIG_APP_RETRIEVE_LEN_ELF_SHA` asked for, NUL padded.
        notes.appElfSha256 = decodeCString(desc.subarray(4)) || null;
      } else if (type === COREDUMP_NOTE.EXTRA_INFO) {
        for (let i = 0; i + 4 <= descSize; i += 4) notes.extraInfo.push(view.getUint32(descAt + i, true));
      }
      at = descAt + align4(descSize);
    }
  }
  return notes;
}

/**
 * Names the exception registers in the EXTRA_INFO note.
 *
 * The note is the crashed task's TCB followed by `(register id, value)` pairs.
 * The first two pairs are always EXCCAUSE and EXCVADDR — identified by
 * position, which is what the reference decoder does, rather than by the id
 * beside them — and the rest are matched by id.
 *
 * On RISC-V the note is just the TCB and a terminator, so this returns nothing
 * and the panic reason string carries the whole story.
 *
 * @param {number[]} words
 * @param {'xtensa'|'riscv'|'unknown'} architecture
 * @returns {Array<{name: string, value: number}>}
 */
function decodeExtraInfo(words, architecture) {
  if (architecture !== 'xtensa' || words.length < 5) return [];
  /** @type {Array<{name: string, value: number}>} */
  const out = [
    { name: 'exccause', value: words[2] },
    { name: 'excvaddr', value: words[4] },
  ];
  for (let i = 5; i + 1 < words.length; i += 2) {
    const id = words[i];
    if (id >= XTENSA_EPC1 && id <= XTENSA_EPC1 + 6) {
      out.push({ name: `epc${id - XTENSA_EPC1 + 1}`, value: words[i + 1] });
    } else if (id >= XTENSA_EPS2 && id <= XTENSA_EPS2 + 5) {
      out.push({ name: `eps${id - XTENSA_EPS2 + 2}`, value: words[i + 1] });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Assembles one task per PRSTATUS note, with its TCB, stack and name.
 *
 * @param {CoreDump} dump
 * @param {Uint8Array} data
 * @param {ElfView} elf
 * @param {CoreDumpNotes} notes
 * @param {Issue[]} issues
 */
function buildTasks(dump, data, elf, notes, issues) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const loads = elf.phdrs
    .map((phdr, index) => ({ ...phdr, index }))
    .filter((phdr) => phdr.type === 1);
  const tcbAddresses = new Set(notes.prstatus.map((p) => p.tcbAddress));
  const tcbSegments = loads.filter((seg) => tcbAddresses.has(seg.address));
  const crashedTcb = notes.extraInfo.length > 0 ? notes.extraInfo[0] : null;

  dump.taskNameOffset = findTaskNameOffset(data, tcbSegments);

  /** @type {Map<number, number>} Segment index to the task that owns it. */
  const owner = new Map();

  for (const [index, status] of notes.prstatus.entries()) {
    const tcb = tcbSegments.find((seg) => seg.address === status.tcbAddress);
    // `pxTopOfStack` is the TCB's first field, and it points into the part of
    // the stack the dump kept. Pairing on that rather than on segment order
    // means a dump that also carries plain memory regions still pairs right.
    const topOfStack = tcb && tcb.length >= 4 ? view.getUint32(tcb.offset, true) : null;
    const stackSegment = topOfStack === null ? undefined
      : loads.find((seg) => !tcbAddresses.has(seg.address)
          && topOfStack >= seg.address && topOfStack < seg.address + seg.length);

    if (tcb) owner.set(tcb.index, index);
    if (stackSegment) owner.set(stackSegment.index, index);

    const registers = namedRegisters(status.registers, dump.architecture);
    const stackPointer = registers.find((r) => r.name === 'sp')?.value ?? null;

    dump.tasks.push({
      index,
      tcbAddress: status.tcbAddress,
      name: tcb && dump.taskNameOffset !== null
        ? decodeCString(data.subarray(tcb.offset + dump.taskNameOffset, tcb.offset + tcb.length))
        : null,
      pc: registers.find((r) => r.name === 'pc')?.value ?? 0,
      stackPointer,
      crashed: crashedTcb !== null && status.tcbAddress === crashedTcb,
      stack: stackSegment ? { address: stackSegment.address, length: stackSegment.length } : null,
      registers,
    });

    if (!tcb) {
      issues.push({
        level: 'warning',
        code: 'coredump.missingTcb',
        params: { address: toHex32(status.tcbAddress) },
      });
    }
  }

  dump.crashedTask = dump.tasks.find((task) => task.crashed) ?? null;

  for (const [index, phdr] of elf.phdrs.entries()) {
    const taskIndex = owner.get(index);
    dump.segments.push({
      index,
      type: phdr.type,
      offset: phdr.offset,
      address: phdr.address,
      length: phdr.length,
      role: phdr.type === 4 ? 'notes'
        : taskIndex === undefined ? 'memory'
        : tcbAddresses.has(phdr.address) ? 'tcb'
        : 'stack',
      taskIndex: taskIndex ?? null,
    });
  }
}

/**
 * Finds where the task name sits inside a FreeRTOS TCB.
 *
 * `pcTaskName` has no fixed offset: what precedes it depends on
 * `configMAX_TASK_NAME_LEN`, MPU wrappers and list-integrity checks, all build
 * options. Hard-coding the 52 that three Arduino cores happen to agree on
 * would read garbage out of any other build and present it as a task name.
 *
 * The dump constrains it instead. Every TCB in one dump has the same layout,
 * so an offset is only a candidate if a NUL-terminated printable string starts
 * there in *every* one of them — and across the three chips measured here
 * exactly one offset survives that. Where none does, this returns `null` and
 * tasks go unnamed, which is the honest outcome.
 *
 * @param {Uint8Array} data
 * @param {Array<{offset: number, length: number}>} tcbSegments
 * @returns {number|null}
 */
export function findTaskNameOffset(data, tcbSegments) {
  if (tcbSegments.length === 0) return null;
  const shortest = Math.min(...tcbSegments.map((seg) => seg.length));
  // FreeRTOS aligns the fields before the name, and no build puts it beyond
  // the first couple of hundred bytes of the structure.
  const limit = Math.min(shortest - 2, 256);

  for (let offset = 0; offset < limit; offset += 4) {
    let ok = true;
    for (const seg of tcbSegments) {
      if (!isTaskName(data, seg.offset + offset, Math.min(16, seg.length - offset))) {
        ok = false;
        break;
      }
    }
    if (ok) return offset;
  }
  return null;
}

/**
 * @param {Uint8Array} data
 * @param {number} at
 * @param {number} width
 * @returns {boolean}
 */
function isTaskName(data, at, width) {
  if (width < 2) return false;
  let i = 0;
  while (i < width && data[at + i] >= 0x20 && data[at + i] < 0x7f) i++;
  return i >= 1 && i < width && data[at + i] === 0;
}

/**
 * @param {Uint32Array} registers
 * @param {'xtensa'|'riscv'|'unknown'} architecture
 * @returns {Array<{name: string, value: number}>}
 */
function namedRegisters(registers, architecture) {
  /** @type {Array<{name: string, value: number}>} */
  const out = [];
  if (architecture === 'riscv') {
    for (const [i, name] of RISCV_REG_NAMES.entries()) {
      if (i < registers.length) out.push({ name, value: registers[i] });
    }
    return out;
  }
  if (architecture !== 'xtensa') return out;

  out.push({ name: 'pc', value: registers[XTENSA_REG.PC] ?? 0 });
  out.push({ name: 'ps', value: registers[XTENSA_REG.PS] ?? 0 });
  // Only the current window's sixteen. The other 48 are the rest of the
  // physical file and mean nothing without unwinding the window chain.
  for (let i = 0; i < 16 && XTENSA_REG.AR + i < registers.length; i++) {
    out.push({ name: `a${i}`, value: registers[XTENSA_REG.AR + i] });
  }
  // a1 *is* the stack pointer on Xtensa. Naming it twice is worth it: every
  // consumer wants "the stack pointer" without knowing the calling convention.
  if (XTENSA_REG.AR + 1 < registers.length) {
    out.push({ name: 'sp', value: registers[XTENSA_REG.AR + 1] });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** @param {'crc32'|'sha256'} algorithm @returns {number} */
function checksumSize(algorithm) {
  return algorithm === 'crc32' ? 4 : 32;
}

/** @param {number} n @returns {number} */
function align4(n) {
  return (n + 3) & ~3;
}

/** @param {number} value @returns {string} */
function toHex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
