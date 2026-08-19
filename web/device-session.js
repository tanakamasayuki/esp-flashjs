// @ts-check
/**
 * Deciding what survives when a different board is plugged in.
 *
 * Everything read from a device describes one particular board. Carrying it
 * across a reconnect is not merely untidy: the partition table, the buffers and
 * any half-finished edits stay on screen with their write-back controls live,
 * pointed at a device the data never came from. Writing one board's NVS into
 * another is exactly the mistake this application exists to help people avoid.
 *
 * Kept out of a component, and out of the actions module, so it can be tested
 * against plain objects — the rule has three branches and each one is a way to
 * get this wrong.
 *
 * @module device-session
 */

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
 * What to keep now that `mac` is the device attached.
 *
 * @param {object} state Enough of the app state to decide.
 * @param {{deviceId: string|null}} state.session
 * @param {Map<string, {source: string}>} state.buffers
 * @param {{table: unknown, source: string|null}} state.partitions
 * @param {{kind: string|null, id: string|null}} state.selection
 * @param {string|null|undefined} mac
 * @returns {SessionReset|null} Null when nothing has to change.
 */
export function discardOtherDeviceState(state, mac) {
  // Kept only when this is provably the same board. An identity that cannot be
  // established is not evidence of sameness — treating "unknown" as "same" is
  // the one reading of it that can destroy something.
  if (state.session.deviceId && mac && state.session.deviceId === mac) return null;

  const buffers = new Map(
    [...state.buffers.entries()].filter(([, buffer]) => buffer.source !== 'device'),
  );
  const dropped = state.buffers.size - buffers.size;
  const hadTable = state.partitions.source === 'device';
  if (dropped === 0 && !hadTable) return null;

  return {
    dropped,
    changes: {
      buffers,
      // A table read from a file was never about a device, and neither were
      // the buffers imported alongside it.
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
