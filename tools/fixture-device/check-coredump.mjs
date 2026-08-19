// @ts-check
/**
 * Reads an ESP-IDF core dump partition and reports what is actually in it.
 *
 * This project has no core dump parser. That is the point of this script: it
 * exists so the fixture can be understood, and so a parser written later has
 * something to be wrong against. Nothing here imports from `src/`.
 *
 * The layout it checks is not guessed. ESP-IDF documents it in the header
 * shipped with the toolchain (`espcoredump/include/esp_core_dump.h`):
 *
 * ```text
 *   0   4  TOTAL_LEN    total length in flash, the checksum included
 *   4   4  VERSION
 *   8   4  TASKS_NUM    written as 0 in ELF format
 *  12   4  TCB_SIZE     written as 0 in ELF format
 *  16   4  MEM_SEG_NUM  written as 0 in ELF format
 *  20   4  CHIP_REV
 *  24   .  the dump itself; in ELF format an ET_CORE ELF image
 *   TOTAL_LEN-4  4  CRC-32 over everything before it
 * ```
 *
 * The checksum is what makes this worth having. A core dump proves its own
 * identity — magic *and* a checksum that verifies — which is the evidence the
 * confidence scale reserves 1.0 for, and something NVS can never do. If the
 * CRC matches, the header interpretation above is confirmed by the bytes
 * rather than assumed.
 *
 * CRC-32 comes from Node's zlib rather than from `src/binary/hash.js`. The
 * whole value of a hardware fixture is that the code under test did not
 * produce it, and that argument does not survive verifying it with the code
 * under test.
 *
 * Usage:
 *   node check-coredump.mjs <coredump.bin> [--mac aa:bb:cc:dd:ee:ff]
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';

/** ELF `e_machine` values for the architectures in the chip table. */
const MACHINES = { 94: 'Xtensa', 243: 'RISC-V' };

/** The flash write block a core dump is padded up to. */
const WRITE_ALIGN = 32;

/**
 * @typedef {object} CoreDumpReport
 * @property {string[]} problems  Reasons this is not a usable core dump.
 * @property {string[]} notes     Worth knowing, not wrong.
 * @property {Record<string, string|number>} facts
 * @property {string[]} strings   Printable runs, for a human to read.
 */

/**
 * @param {Uint8Array} data  The whole coredump partition, erased tail included.
 * @param {{mac?: number[]}} [options]
 * @returns {CoreDumpReport}
 */
export function checkCoreDump(data, options = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Record<string, string|number>} */
  const facts = {};

  if (data.length < 32) {
    return { problems: ['the partition is too short to hold a header'], notes, facts, strings: [] };
  }
  if (data.every((b) => b === 0xff)) {
    return {
      problems: ['the coredump partition is erased — nothing ever crashed'],
      notes,
      facts,
      strings: [],
    };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLen = view.getUint32(0, true);
  facts.totalLen = totalLen;
  facts.version = `0x${view.getUint32(4, true).toString(16).padStart(8, '0')}`;
  facts.chipRev = view.getUint32(20, true);

  if (totalLen < 32 || totalLen > data.length) {
    problems.push(
      `TOTAL_LEN is ${totalLen}, which does not fit in a ${data.length}-byte partition`,
    );
    return { problems, notes, facts, strings: [] };
  }

  // ELF format leaves these three at zero. A non-zero value means the binary
  // format, which this checker does not read.
  const binaryFormatFields = [
    ['TASKS_NUM', view.getUint32(8, true)],
    ['TCB_SIZE', view.getUint32(12, true)],
    ['MEM_SEG_NUM', view.getUint32(16, true)],
  ].filter(([, v]) => v !== 0);

  const elf = data.subarray(24);
  const isElf = elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46;

  if (isElf) {
    if (binaryFormatFields.length > 0) {
      notes.push(
        `an ELF dump with non-zero ${binaryFormatFields.map(([n]) => n).join(', ')} — ` +
          'harmless, but ESP-IDF documents these as unused in ELF format',
      );
    }
    const ev = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    const type = ev.getUint16(16, true);
    const machine = ev.getUint16(18, true);
    facts.elfType = type === 4 ? 'ET_CORE' : `${type} (expected 4 = ET_CORE)`;
    facts.machine = MACHINES[/** @type {keyof typeof MACHINES} */ (machine)] ?? `unknown (${machine})`;
    facts.programHeaders = ev.getUint16(44, true);
    if (type !== 4) problems.push(`the ELF image is type ${type}, not ET_CORE`);
    if (ev.getUint16(44, true) === 0) problems.push('the ELF image has no program headers');
  } else {
    notes.push('not an ELF dump — this build stores core dumps in the binary format');
    facts.format = 'binary';
  }

  // The check that makes the rest trustworthy: if this passes, the offsets
  // above were read the way the writer wrote them.
  const stored = view.getUint32(totalLen - 4, true);
  const computed = crc32(Buffer.from(data.subarray(0, totalLen - 4))) >>> 0;
  facts.storedCrc = `0x${stored.toString(16).padStart(8, '0')}`;
  if (stored === computed) {
    facts.checksum = 'valid';
  } else {
    facts.checksum = `MISMATCH (computed 0x${computed.toString(16).padStart(8, '0')})`;
    problems.push(
      'the CRC-32 in the image does not match its contents — either the dump is ' +
        'damaged, or this build uses the SHA-256 checksum instead of CRC-32',
    );
  }

  // Everything past the image should be erased, except that the writer pads
  // the last block. Anything beyond that is a leftover of an older, larger
  // dump, which is worth saying out loud because it is not part of this one.
  const padded = Math.ceil(totalLen / WRITE_ALIGN) * WRITE_ALIGN;
  let stale = 0;
  for (let i = padded; i < data.length; i++) if (data[i] !== 0xff) stale++;
  facts.padding = `${padded - totalLen} byte(s) to the ${WRITE_ALIGN}-byte write block`;
  if (stale > 0) {
    notes.push(
      `${stale} byte(s) after the image are not erased — the remains of an ` +
        'earlier, longer dump. Harmless, but not part of this one',
    );
  }
  facts.used = `${totalLen} of ${data.length} bytes (${((totalLen / data.length) * 100).toFixed(1)}%)`;
  if (totalLen > data.length * 0.9) {
    problems.push(
      'the dump nearly fills the partition — a slightly larger one would be ' +
        'truncated, and a truncated dump still writes a valid-looking header',
    );
  }

  // A core dump is the one fixture region whose contents are RAM rather than
  // constants this project chose, so it is the one that has to be read before
  // it is committed.
  const strings = printableRuns(data.subarray(0, totalLen), 5);

  if (options.mac && options.mac.length === 6) {
    const forms = [options.mac, [...options.mac].reverse()];
    for (const form of forms) {
      if (indexOfBytes(data.subarray(0, totalLen), form) >= 0) {
        problems.push('the MAC address appears in the dump — this must not be committed');
        break;
      }
    }
    // Interface MACs are derived from the base by varying the last byte.
    const base = options.mac.slice(0, 5);
    for (let b = 0; b < 256; b++) {
      if (indexOfBytes(data.subarray(0, totalLen), [...base, b]) >= 0) {
        problems.push(
          `a MAC derived from the base address appears in the dump (last byte 0x${b.toString(16)})`,
        );
        break;
      }
    }
    facts.macScan = problems.some((p) => p.includes('MAC')) ? 'FOUND' : 'absent';
  }

  return { problems, notes, facts, strings };
}

/**
 * @param {Uint8Array} haystack
 * @param {number[]} needle
 * @returns {number}
 */
function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * @param {Uint8Array} data
 * @param {number} min
 * @returns {string[]}
 */
function printableRuns(data, min) {
  /** @type {Set<string>} */
  const found = new Set();
  let run = '';
  for (const byte of data) {
    if (byte >= 0x20 && byte < 0x7f) {
      run += String.fromCharCode(byte);
      continue;
    }
    if (run.length >= min) found.add(run);
    run = '';
  }
  if (run.length >= min) found.add(run);
  return [...found].sort();
}

/* -------------------------------------------------------------------------- */

// Only when run as a command; `verify-fixture.mjs` imports checkCoreDump.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [, , path, ...rest] = process.argv;
  if (!path) {
    console.error('usage: node check-coredump.mjs <coredump.bin> [--mac aa:bb:cc:dd:ee:ff]');
    process.exit(2);
  }
  const macArg = rest[rest.indexOf('--mac') + 1];
  const mac =
    rest.includes('--mac') && macArg
      ? macArg.split(/[:-]/).map((h) => parseInt(h, 16))
      : undefined;

  const data = new Uint8Array(await readFile(path));
  const report = checkCoreDump(data, { mac });

  console.log(`core dump: ${path}\n`);
  for (const [key, value] of Object.entries(report.facts)) {
    console.log(`  ${key.padEnd(16)} ${value}`);
  }

  console.log(`\nprintable strings (${report.strings.length}) — read these before committing:`);
  for (const s of report.strings) console.log(`  ${s}`);

  if (report.notes.length > 0) {
    console.log('\nnotes:');
    for (const n of report.notes) console.log(`  - ${n}`);
  }
  if (report.problems.length > 0) {
    console.log('\nproblems:');
    for (const p of report.problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nCore dump looks good.');
}
