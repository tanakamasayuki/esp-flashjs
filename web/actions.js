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
import { store } from './store.js';
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

    store.setState({
      device: { status: 'connected', info, usingStub: loader.isStub, error: null },
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
      },
    });
  }
}

export async function disconnect() {
  await safeClose();
  store.setState({
    device: { status: 'disconnected', info: null, usingStub: false, error: null },
    flash: { size: null },
    partitions: { table: null, source: null },
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
  const id = `buf-${++bufferCounter}`;
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

  const buffers = new Map(store.getState().buffers);
  buffers.set(id, { id, name, data, source, address, partitionLabel, analysis });
  store.setState({ buffers });
  return id;
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
 * @param {'partition'|'buffer'|'gap'|null} kind
 * @param {string|null} id
 */
export function select(kind, id) {
  store.setState({ selection: { kind, id } });
}

/** @param {'info'|'hex'|'analyze'|'edit'|'diff'} tab */
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
