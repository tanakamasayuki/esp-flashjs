// @ts-check
/**
 * Whether an edited image can be written back, and if not, why not.
 *
 * Outside the components for the reason format-values.js is: a component module
 * calls `customElements.define` at load and cannot be imported outside a
 * browser, so logic kept inside one cannot be tested. This is worth testing
 * twice over — it was wrong in both directions at once.
 *
 * It said "read-only, connect and load the stub" to someone editing an image
 * they had opened from a file, where connecting fixes nothing. And it went
 * read-only immediately after a partition was read, because reading selects
 * the buffer rather than the partition and the buffer had forgotten which
 * partition it came from; clicking the partition again brought the controls
 * back, which is a maddening thing to have to discover.
 *
 * @module write-back
 */

/**
 * The reasons, so a test can check each one has something to say.
 *
 * @type {readonly string[]}
 */
export const WRITE_BACK_BLOCKERS = Object.freeze([
  'writeback.noPartition',
  'writeback.disconnected',
  'writeback.noStub',
]);

/**
 * @param {object} context
 * @param {unknown} context.partition   The partition behind the image, if any.
 * @param {string} context.status       Device connection status.
 * @param {boolean} context.usingStub
 * @returns {string|null} A translation key, or null when writing is possible.
 */
export function writeBackBlocker({ partition, status, usingStub }) {
  // Ordered by what the reader can do about it. Having nowhere to write comes
  // first because it is the only one connecting will not solve, so reporting
  // it as "not connected" would send someone to fix the wrong thing.
  if (!partition) return 'writeback.noPartition';
  if (status !== 'connected') return 'writeback.disconnected';
  if (!usingStub) return 'writeback.noStub';
  return null;
}
