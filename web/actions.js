// @ts-check
/**
 * Use cases.
 *
 * Every call into the library goes through this module. Components read state
 * and dispatch actions; they never touch EspLoader or EspFlash directly. That
 * keeps the safety rules — back up before writing, confirm destructive
 * operations — in one place instead of spread across the UI.
 */

import {
  EspFlash,
  EspLoader,
  WebSerialTransport,
  analyzeBinary,
  buildPartitionTable,
  findPartitionAt,
  formatByteSize,
  parsePartitionTable,
  toHexAddress,
  bytesToHex,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
} from './esp-flashjs.js';
import { store, BAUD_RATES, rememberBaudRate } from './store.js';
import { t } from './i18n.js';

/** @type {EspLoader|null} */
let loader = null;
/** @type {EspFlash|null} */
let flash = null;

/**
 * Records an Issue in the log.
 *
 * Issues use `warning`; the log uses `warn` to match the console convention.
 * Passing the former straight through produced entries the log stylesheet did
 * not recognize, so they rendered as ordinary text.
 *
 * @param {import('./esp-flashjs.js').Issue} issue
 */
function logIssue(issue) {
  store.log(issue.level === 'warning' ? 'warn' : 'error', issue.code, issue.params);
}

/** Regions where a mistaken write can stop the device from booting. */
const CRITICAL_SUBTYPES = new Set(['ota', 'nvs_keys', 'efuse']);

/* -------------------------------------------------------------------------- */
/* Connection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Opens a port and identifies the device.
 *
 * Must be invoked from a user gesture: the port picker will not open otherwise.
 */
export async function connect() {
  if (store.getState().device.status !== 'disconnected') return;
  store.setState({ device: { ...store.getState().device, status: 'connecting', error: null } });

  try {
    const transport = await WebSerialTransport.request();
    loader = new EspLoader(transport, {
      onLog: (level, code, params) => store.log(level, code, params),
    });
    await loader.connect();
    await loader.loadStub();

    flash = new EspFlash(loader);
    const info = await flash.getInfo();

    // Only now, with the stub running, is it worth going faster.
    const requested = store.getState().device.baudRate;
    const linkBaudRate = await raiseLinkSpeed(requested);

    store.setState({
      device: {
        status: 'connected',
        info,
        usingStub: loader.isStub,
        error: null,
        baudRate: requested,
        linkBaudRate,
      },
      flash: { size: info.flashSize },
    });
    store.log('info', 'op.connected');

    // A partition table is the entry point to everything else, so fetch it
    // straight away when the stub makes reading possible.
    if (loader.isStub) await readPartitionTable();
  } catch (error) {
    const err = /** @type {Error & {code?: string}} */ (error);
    // A cancelled port picker is a normal outcome, not a failure worth logging.
    const cancelled = err.name === 'NotFoundError' || err.name === 'AbortError';
    if (!cancelled) store.log('error', err.code ? `error.${err.code}` : 'error.unexpected', { message: err.message });

    await safeClose();
    store.setState({
      device: {
        status: 'disconnected',
        info: null,
        usingStub: false,
        error: cancelled ? null : err.message,
        baudRate: store.getState().device.baudRate,
        linkBaudRate: null,
      },
    });
  }
}

/**
 * Raises the line rate, but only if the link actually carries it.
 *
 * Applied to every port, including the chip's own USB. It was tempting to skip
 * those on the grounds that there is no UART in the path, but measurement says
 * the rate matters there too: on an ESP32-S3 and an ESP32-P4 over
 * USB-Serial/JTAG, reading 256 KB took 26 s at 115200 and 3.4 s at 1500000.
 *
 * Falling back to a fixed "safe" rate would also be wrong: measured on real
 * hardware, 115200 is not the most reliable rate — it was worse than 460800 on
 * the same board and cable, and the relationship is not monotonic. So the only
 * defensible move is to try what was asked for and keep it only if a real
 * transfer survives.
 *
 * The test is a small flash read, which the stub covers with its own MD5. That
 * makes a bad link a thrown error rather than plausible-looking wrong bytes,
 * which is what makes trying safe at all. One attempt, deliberately: retrying
 * here would mask exactly the flakiness being measured.
 *
 * @param {number} requested
 * @returns {Promise<number>} The rate the link ended up at.
 */
async function raiseLinkSpeed(requested) {
  const current = BAUD_RATES[0];
  if (!loader || !flash || requested === current) return current;

  try {
    await loader.changeBaudRate(requested);
    await flash.read(0, 0x1000, { attempts: 1 });
    store.log('info', 'op.linkFast', { baudRate: requested });
    return requested;
  } catch {
    try {
      await loader.changeBaudRate(current);
    } catch {
      // If even going back fails the connection is beyond saving; the caller's
      // error handling will close it.
    }
    store.log('warn', 'op.linkFallback', { baudRate: requested, fallback: current });
    return current;
  }
}

/**
 * @param {number} baudRate
 */
export function setBaudRate(baudRate) {
  if (!BAUD_RATES.includes(baudRate)) return;
  rememberBaudRate(baudRate);
  store.setState({ device: { ...store.getState().device, baudRate } });
}

export async function disconnect() {
  await safeClose();
  store.setState({
    device: {
      status: 'disconnected',
      info: null,
      usingStub: false,
      error: null,
      baudRate: store.getState().device.baudRate,
      linkBaudRate: null,
    },
    flash: { size: null },
    partitions: { table: null, source: null },
    partitionStates: new Map(),
    selection: { kind: null, id: null },
  });
  store.log('info', 'op.disconnected');
}

async function safeClose() {
  try {
    await loader?.disconnect();
  } catch {
    // Losing the port during teardown is not worth surfacing.
  }
  loader = null;
  flash = null;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Reads and parses the partition table from the device. */
export async function readPartitionTable() {
  const data = await readRegion(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
  if (!data) return;

  // Keep the bytes whatever happens. Spec §18: a region that cannot be parsed
  // is still worth showing, and when the parse fails this buffer is the only
  // way to find out why.
  addBuffer({
    name: 'partition-table.bin',
    data,
    source: 'device',
    address: PARTITION_TABLE_OFFSET,
    partitionLabel: null,
  });

  try {
    const table = parsePartitionTable(data);
    store.setState({ partitions: { table, source: 'device' } });
    for (const issue of table.issues) logIssue(issue);
    await probePartitions(table.partitions);
  } catch (error) {
    store.log('error', 'error.INVALID_MAGIC', {
      message: /** @type {Error} */ (error).message,
    });
    // The leading bytes separate the likely causes at a glance: 0xFFFF means
    // erased flash, 0x0000 means never written, anything else means the read
    // landed somewhere unexpected.
    store.log('warn', 'partition.rawHead', {
      offset: toHexAddress(PARTITION_TABLE_OFFSET),
      bytes: bytesToHex(data.subarray(0, 16), ' '),
    });
  }
}

/**
 * Reads an arbitrary flash region into a buffer.
 *
 * The partition table describes neither the bootloader nor the space around
 * it, but those are often exactly what someone wants to look at or keep a copy
 * of, so every region on the map is readable — not just the ones with an entry.
 *
 * @param {number} address
 * @param {number} size
 * @param {string} name
 * @returns {Promise<string|null>} The buffer id.
 */
export async function readFlashRegion(address, size, name) {
  const data = await readRegion(address, size);
  if (!data) return null;
  const id = addBuffer({ name, data, source: 'device', address, partitionLabel: null });
  store.log('info', 'op.readRegion', { name, address: toHexAddress(address), size: formatByteSize(size) });
  return id;
}

/**
 * Reads the head of every partition so the map can say which are still empty.
 *
 * @param {import('./esp-flashjs.js').Partition[]} partitions
 */
export async function probePartitions(partitions) {
  if (!flash) return;
  const controller = new AbortController();
  try {
    const states = await withBusy(controller, () =>
      /** @type {EspFlash} */ (flash).probePartitions(partitions, {
        signal: controller.signal,
        onProgress: reportProgress,
      }),
    );
    store.setState({ partitionStates: states });

    const empty = [...states.entries()].filter(([, v]) => v === 'erased' || v === 'zeroed');
    if (empty.length > 0) {
      store.log('info', 'partition.someUninitialized', {
        labels: empty.map(([label]) => label).join(', '),
      });
    }
  } catch (error) {
    logError(error);
  }
}

/**
 * Reads a partition into a buffer.
 * @param {import('./esp-flashjs.js').Partition} partition
 */
export async function readPartition(partition) {
  const data = await readRegion(partition.offset, partition.size);
  if (!data) return;

  const id = addBuffer({
    name: `${partition.label}.bin`,
    data,
    source: 'device',
    address: partition.offset,
    partitionLabel: partition.label,
    analysisContext: { partition, offset: partition.offset },
  });
  store.log('info', 'op.readPartition', {
    label: partition.label,
    size: formatByteSize(data.length),
  });
  select('buffer', id);
}

/** Reads the whole flash into a buffer. */
export async function dumpFlash() {
  const size = store.getState().flash.size;
  if (size === null) return;
  const data = await readRegion(0, size);
  if (!data) return;
  addBuffer({ name: 'flash-dump.bin', data, source: 'device', address: 0, partitionLabel: null });
  exportBytes(data, 'flash-dump.bin');
}

/**
 * @param {number} address
 * @param {number} size
 * @returns {Promise<Uint8Array|null>}
 */
async function readRegion(address, size) {
  if (!flash) return null;
  const controller = new AbortController();
  try {
    return await withBusy(controller, () =>
      /** @type {EspFlash} */ (flash).read(address, size, {
        signal: controller.signal,
        onProgress: reportProgress,
      }),
    );
  } catch (error) {
    logError(error);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Writes a buffer to a partition, after backing the region up.
 *
 * @param {import('./esp-flashjs.js').Partition} partition
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {boolean} [options.backup] Defaults to true.
 */
export async function writePartition(partition, data, { backup = true } = {}) {
  if (!flash) return;

  if (data.length > partition.size) {
    store.log('error', 'error.OUT_OF_RANGE', {
      address: toHexAddress(partition.offset),
      size: data.length,
      limit: partition.size,
    });
    return;
  }

  // Back up before touching anything. A failed backup aborts the write: the
  // whole point is to have a way back, and proceeding without one silently
  // removes it.
  if (backup) {
    const original = await readRegion(partition.offset, partition.size);
    if (!original) {
      store.log('error', 'error.unexpected', { message: 'Backup failed; write cancelled.' });
      return;
    }
    const name = `${partition.label}-backup.bin`;
    addBuffer({
      name,
      data: original,
      source: 'device',
      address: partition.offset,
      partitionLabel: partition.label,
    });
    exportBytes(original, name);
    store.log('info', 'op.backupSaved', { name });
  }

  const controller = new AbortController();
  try {
    await withBusy(controller, () =>
      /** @type {EspFlash} */ (flash).write(partition.offset, data, {
        signal: controller.signal,
        onProgress: reportProgress,
        verify: true,
      }),
    );
    store.log('info', 'op.wrote', {
      size: formatByteSize(data.length),
      address: toHexAddress(partition.offset),
    });
    store.log('info', 'op.verified');
  } catch (error) {
    logError(error);
  }
}

/**
 * @param {import('./esp-flashjs.js').Partition} partition
 */
export async function erasePartition(partition) {
  if (!flash) return;
  const controller = new AbortController();
  try {
    await withBusy(controller, () =>
      /** @type {EspFlash} */ (flash).eraseRegion(partition.offset, partition.size, {
        signal: controller.signal,
      }),
    );
    store.log('info', 'op.erased', {
      size: formatByteSize(partition.size),
      address: toHexAddress(partition.offset),
    });
  } catch (error) {
    logError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Decides whether an operation needs an explicit confirmation.
 *
 * @param {number} address
 * @param {number} size
 * @returns {{critical: boolean, reasons: string[], partition: import('./esp-flashjs.js').Partition|undefined}}
 */
export function assessRisk(address, size) {
  const state = store.getState();
  const table = state.partitions.table;
  const partition = table ? findPartitionAt(table.partitions, address) : undefined;
  /** @type {string[]} */
  const reasons = [];

  const bootloaderOffset = state.device.info?.bootloaderOffset ?? 0x1000;
  if (address < PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE) {
    reasons.push(address >= bootloaderOffset ? 'bootloader' : 'reserved');
  }
  if (address < PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE && address + size > PARTITION_TABLE_OFFSET) {
    reasons.push('partitionTable');
  }
  if (partition) {
    if (partition.type === 0) reasons.push('appPartition');
    if (CRITICAL_SUBTYPES.has(partition.subtypeName)) reasons.push(partition.subtypeName);
    if (partition.encrypted) reasons.push('encrypted');
  }

  return { critical: reasons.length > 0, reasons, partition };
}

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {File} file
 */
export async function importFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const id = addBuffer({ name: file.name, data, source: 'file', address: null, partitionLabel: null });
  store.log('info', 'op.imported', { name: file.name, size: formatByteSize(data.length) });

  // A partition table dropped in on its own should populate the map, so the
  // offline path reaches the same views as the connected one.
  const buffer = store.getState().buffers.get(id);
  if (buffer?.analysis?.type === 'partition-table' && !store.getState().partitions.table) {
    store.setState({
      partitions: {
        table: /** @type {import('./esp-flashjs.js').PartitionTable} */ (buffer.analysis.model),
        source: 'file',
      },
    });
  }
  select('buffer', id);
}

/**
 * @param {Uint8Array} data
 * @param {string} name
 */
export function exportBytes(data, name) {
  const blob = new Blob([/** @type {BlobPart} */ (/** @type {unknown} */ (data))], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  store.log('info', 'op.exported', { name });
}

/** Writes the log out as text, with enough context to be useful in a report. */
export function exportLog() {
  const state = store.getState();
  const info = state.device.info;
  const header = [
    `ESP FlashJS log`,
    `chip: ${info?.chip ?? 'n/a'}`,
    `flash: ${state.flash.size ?? 'n/a'}`,
    `stub: ${state.device.usingStub}`,
    `agent: ${navigator.userAgent}`,
    '',
  ];
  // Deliberately in English: these end up attached to bug reports.
  const lines = state.log.map(
    (e) =>
      `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.code}` +
      (e.params ? ` ${JSON.stringify(e.params)}` : ''),
  );
  exportBytes(new TextEncoder().encode([...header, ...lines].join('\n')), 'esp-flashjs-log.txt');
}

/* -------------------------------------------------------------------------- */
/* Buffers and selection                                                       */
/* -------------------------------------------------------------------------- */

let bufferCounter = 0;

/**
 * Identity of a buffer for replacement purposes.
 *
 * Two reads of the same device region are the same buffer, so the second
 * replaces the first instead of piling up another entry in the file list.
 * File imports are keyed by name, and anything without an address falls back
 * to a unique key so unrelated buffers never collide.
 *
 * @param {{source: 'device'|'file', name: string, address: number|null, size: number}} spec
 * @returns {string}
 */
function bufferKey({ source, name, address, size }) {
  if (source === 'device' && address !== null) return `device:${address}:${size}`;
  return `${source}:${name}`;
}

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {Uint8Array} spec.data
 * @param {'device'|'file'} spec.source
 * @param {number|null} spec.address
 * @param {string|null} spec.partitionLabel
 * @param {object} [spec.analysisContext]
 * @returns {string} The buffer id.
 */
export function addBuffer({ name, data, source, address, partitionLabel, analysisContext }) {
  const key = bufferKey({ source, name, address, size: data.length });
  const buffers = new Map(store.getState().buffers);
  const previous = [...buffers.values()].find((b) => b.key === key);

  if (previous) {
    // Re-reading is allowed on purpose — a flaky link or failing flash can hand
    // back different bytes, and being able to check that is the point. Last
    // read wins, and whether it changed is worth saying out loud.
    const changed =
      previous.data.length !== data.length || !equalBytes(previous.data, data);
    store.log(changed ? 'warn' : 'info', changed ? 'op.rereadDiffers' : 'op.rereadSame', {
      name,
      address: address === null ? '' : toHexAddress(address),
    });
    buffers.delete(previous.id);
  }

  let analysis = null;
  try {
    analysis = analyzeBinary(data, analysisContext ?? { offset: address ?? 0 });
    for (const issue of analysis.issues) logIssue(issue);
  } catch (error) {
    store.log('error', 'analyze.failed', {
      analyzer: 'auto',
      message: /** @type {Error} */ (error).message,
    });
  }

  // Keep the previous id when replacing, so a selection pointing at it survives.
  const id = previous?.id ?? `buf-${++bufferCounter}`;
  buffers.set(id, { id, key, name, data, source, address, partitionLabel, analysis });
  store.setState({ buffers });
  return id;
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** @param {string} id */
export function removeBuffer(id) {
  const buffers = new Map(store.getState().buffers);
  buffers.delete(id);
  const selection = store.getState().selection;
  store.setState({
    buffers,
    selection: selection.id === id ? { kind: null, id: null } : selection,
  });
}

/**
 * @param {'partition'|'buffer'|'region'|null} kind
 * @param {string|null} id For a region: `<kind>@<offset>+<size>`.
 */
export function select(kind, id) {
  store.setState({ selection: { kind, id } });
}

/** @param {'analyze'|'hex'} tab */
export function setInspectorTab(tab) {
  store.setState({ inspector: { tab } });
}

/**
 * Regenerates the partition table binary from the current model.
 * @returns {Uint8Array|null}
 */
export function buildCurrentPartitionTable() {
  const table = store.getState().partitions.table;
  if (!table) return null;
  return buildPartitionTable(table);
}

/* -------------------------------------------------------------------------- */
/* Progress plumbing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @template T
 * @param {AbortController} controller
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withBusy(controller, operation) {
  store.setState({
    busy: { active: true, phase: '', done: 0, total: 0, cancel: () => controller.abort() },
  });
  try {
    return await operation();
  } finally {
    store.setState({ busy: { active: false, phase: '', done: 0, total: 0, cancel: null } });
  }
}

/** @param {import('../src/util/events.js').Progress} progress */
function reportProgress(progress) {
  const busy = store.getState().busy;
  store.setState({
    busy: {
      ...busy,
      active: true,
      phase: progress.phase,
      done: progress.done,
      total: progress.total,
    },
  });
}

/** @param {unknown} error */
function logError(error) {
  const err = /** @type {Error & {code?: string, details?: Record<string, unknown>}} */ (error);
  if (err.code) store.log('error', `error.${err.code}`, err.details ?? {});
  else store.log('error', 'error.unexpected', { message: err.message });
}

/**
 * @param {string} code
 * @returns {string}
 */
export function describeError(code) {
  return t(`error.${code}`);
}
