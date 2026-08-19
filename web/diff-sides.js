// @ts-check
/**
 * Deciding which two things the diff view compares.
 *
 * Separate from the component for the reason format-values.js is: a component
 * module calls `customElements.define` at load and cannot be imported outside
 * a browser, so anything kept inside one cannot be tested. This rule is worth
 * testing — getting it wrong is what made the tab look broken, since a diff
 * that ignores the selection appears not to react to anything the user does.
 *
 * @module diff-sides
 */

/** Stands for "whatever is selected", so a side can follow the selection. */
export const SELECTION = ' selection';

/**
 * @typedef {object} DiffOption
 * @property {string} key
 * @property {string} label
 * @property {Uint8Array} data
 */

/**
 * Picks the two sides, keeping any choice the user has already made.
 *
 * The selection is the "after" side — it is what the user is asking about, and
 * what is there *now* — and the older copy goes on the left. When the two
 * differ, that puts the change in the direction people read it.
 *
 * A choice that no longer exists is dropped rather than kept as a dangling
 * key: buffers come and go as regions are re-read, and a side pointing at a
 * buffer that has been replaced would render as an empty comparison instead of
 * falling back to something useful.
 *
 * @param {DiffOption[]} options       In offer order; the selection, if any, first.
 * @param {{size: number}|null} target What the inspector has selected.
 * @param {{left: string|null, right: string|null}} current
 * @returns {{left: string|null, right: string|null}}
 */
export function chooseDiffSides(options, target, current) {
  const has = (/** @type {string|null} */ key) =>
    key !== null && options.some((option) => option.key === key);

  let left = has(current.left) ? current.left : null;
  let right = has(current.right) ? current.right : null;

  if (right === null) {
    const selectionOffered = options[0]?.key === SELECTION;
    right = selectionOffered ? SELECTION : (options[options.length - 1]?.key ?? null);
  }

  if (left === null) {
    const others = options.filter((option) => option.key !== right);
    // Prefer something the same size as the selection: after a write, that is
    // the backup of the region being looked at, and "did that do what I meant?"
    // is the question this tab exists to answer.
    const sameSize = target
      ? others.find((option) => option.key !== SELECTION && option.data.length === target.size)
      : undefined;
    left = (sameSize ?? others[others.length - 1])?.key ?? null;
  }

  return { left, right };
}
