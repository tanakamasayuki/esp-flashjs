// @ts-check
/**
 * Progress reporting helpers.
 *
 * @module util/events
 */

/**
 * @typedef {'erasing'|'writing'|'reading'|'verifying'|'analyzing'|'connecting'|'loading-stub'} ProgressPhase
 */

/**
 * @typedef {object} Progress
 * @property {ProgressPhase} phase       Stable identifier, used as a translation key.
 * @property {number} done               Bytes (or units) completed.
 * @property {number} total              Total bytes (or units).
 * @property {number} [bytesPerSecond]   Throughput estimate, when meaningful.
 */

/** @typedef {(progress: Progress) => void} ProgressCallback */

const MIN_INTERVAL_MS = 50; // 20 Hz

/**
 * Wraps a progress callback so it fires at most 20 times per second, with the
 * final call always delivered.
 *
 * Flash operations report per block — a 16 MB dump at 4 KB blocks is 4096
 * callbacks. Unthrottled, that is enough DOM work to visibly slow the transfer
 * it is reporting on.
 *
 * @param {ProgressCallback|undefined} callback
 * @param {ProgressPhase} phase
 * @param {number} total
 * @returns {{ report: (done: number) => void, finish: () => void }}
 */
export function createProgressReporter(callback, phase, total) {
  if (!callback) {
    return { report: () => {}, finish: () => {} };
  }

  const startedAt = now();
  let lastEmit = 0;
  let lastDone = 0;

  /** @param {number} done */
  const emit = (done) => {
    const elapsed = (now() - startedAt) / 1000;
    callback({
      phase,
      done,
      total,
      bytesPerSecond: elapsed > 0 ? Math.round(done / elapsed) : undefined,
    });
  };

  return {
    /** @param {number} done */
    report(done) {
      lastDone = done;
      const t = now();
      if (t - lastEmit < MIN_INTERVAL_MS) return;
      lastEmit = t;
      emit(done);
    },
    finish() {
      // Always deliver a terminal event so progress bars land on 100%.
      emit(Math.max(lastDone, total));
    },
  };
}

/** @returns {number} */
function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
