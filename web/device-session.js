// @ts-check
/**
 * What happens to the data on screen when a device is attached.
 *
 * Everything read from a device describes one particular board at one
 * particular moment. Keeping it across a reconnect is not merely untidy: the
 * partition table, the buffers and any half-finished edits stay on screen with
 * their write-back controls live, pointed at a device the data may not have
 * come from and which has certainly been running since. Writing one board's
 * NVS into another — or writing back a copy taken before the application
 * rewrote it — is exactly what this tool exists to help people avoid.
 *
 * An earlier version kept the data when the MAC matched. That is convenient
 * and it is one more rule to get right, in an area where every bug so far has
 * been a stale-state bug. The rule is now a sentence:
 *
 *   **Connecting discards everything read from a device.**
 *
 * The objection to that is losing a backup, and it does not hold: a write
 * downloads its backup to disk before touching anything, so what is discarded
 * here is time, not data. Re-reading is what {@link shouldAutoRead} keeps
 * cheap.
 *
 * Kept out of the components and out of the actions module so it can be tested
 * against plain objects.
 *
 * @module device-session
 */

/**
 * How long a read is allowed to take before it stops being automatic.
 *
 * A budget in seconds rather than a size in bytes, because the thing being
 * rationed is the user's patience. 100 KB is two and a half seconds at 460800
 * and nine at 115200 — the same limit is imperceptible on one link and looks
 * like a hang on another.
 */
export const AUTO_READ_SECONDS = 3;

/**
 * @typedef {object} SessionReset
 * @property {object} changes  The state patch to apply.
 * @property {Map<string, any>} changes.buffers
 * @property {{table: unknown, source: string|null}} changes.partitions
 * @property {Map<string, unknown>} changes.partitionStates
 * @property {{kind: string|null, id: string|null}} changes.selection
 * @property {number} dropped  Device buffers discarded, for the log.
 */

/**
 * Drops everything that was read from a device.
 *
 * @param {object} state
 * @param {Map<string, {source: string}>} state.buffers
 * @param {{table: unknown, source: string|null}} state.partitions
 * @param {{kind: string|null, id: string|null}} state.selection
 * @returns {SessionReset|null} Null when there was nothing to drop.
 */
export function discardDeviceState(state) {
  const buffers = new Map(
    // Anything imported from a file stays. It was never about a device, and
    // throwing away a firmware image someone opened because they plugged a
    // board in would be its own kind of surprise.
    [...state.buffers.entries()].filter(([, buffer]) => buffer.source !== 'device'),
  );
  const dropped = state.buffers.size - buffers.size;
  const hadTable = state.partitions.source === 'device';
  if (dropped === 0 && !hadTable) return null;

  return {
    dropped,
    changes: {
      buffers,
      partitions: hadTable ? { table: null, source: null } : state.partitions,
      partitionStates: new Map(),
      // A selection pointing at something that is gone renders as an empty
      // inspector with nothing to explain why.
      selection:
        state.selection.kind === 'buffer' &&
        state.selection.id !== null &&
        buffers.has(state.selection.id)
          ? state.selection
          : { kind: null, id: null },
    },
  };
}

/**
 * Roughly how long reading `size` bytes will take.
 *
 * Ten bits on the wire per byte — eight plus a start and a stop — which
 * ignores SLIP framing, the acknowledgement after each block and the time the
 * chip spends reading its own flash. It is therefore a floor, not an estimate,
 * and that is the useful direction to be wrong in: nothing is auto-read that
 * this says is slow.
 *
 * @param {number} size
 * @param {number} baudRate
 * @returns {number} Seconds.
 */
export function estimateReadSeconds(size, baudRate) {
  if (!baudRate || baudRate <= 0) return Infinity;
  return (size * 10) / baudRate;
}

/**
 * Whether selecting a partition should read it without being asked.
 *
 * @param {object} options
 * @param {number} options.size
 * @param {number|null} options.baudRate  What the link settled on.
 * @param {boolean} options.alreadyRead
 * @param {boolean} options.canRead       Connected, stubbed and idle.
 * @param {number} [options.budgetSeconds]
 * @returns {boolean}
 */
export function shouldAutoRead({
  size,
  baudRate,
  alreadyRead,
  canRead,
  budgetSeconds = AUTO_READ_SECONDS,
}) {
  if (!canRead || alreadyRead || size <= 0) return false;
  return estimateReadSeconds(size, baudRate ?? 0) <= budgetSeconds;
}
