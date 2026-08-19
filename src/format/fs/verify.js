// @ts-check
/**
 * The self-check every filesystem builder runs before it hands an image back.
 *
 * A builder that is wrong in the same way as its parser produces an image that
 * round-trips perfectly and does not mount. This project has already been
 * caught by the reading half of that: SPIFFS page flags were read the wrong way
 * round, and the tests agreed with the parser because the fixtures came from
 * it. So the rule for the writing half is that the reader used here must be one
 * that has been checked against bytes this project did not produce — the
 * hardware captures — and, where the format allows, must reach the data by a
 * different route than the parser does.
 *
 * @module format/fs/verify
 */

/**
 * @typedef {import('./types.js').FsImage} FsImage
 */

/**
 * Compares a freshly built image against what was asked for.
 *
 * @param {FsImage} image     The result, read back.
 * @param {Array<{path: string, data: Uint8Array}>} expected
 * @param {string} format     Named in the message, so the failure says which.
 * @throws {Error} On any difference. A build that cannot prove itself fails.
 */
export function verifyFsBuild(image, expected, format) {
  const errors = image.issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `${format} build self-check failed: reading the result back reports ${errors[0].code}.`,
    );
  }

  const got = new Map(image.files.filter((f) => !f.directory).map((f) => [f.path, f]));

  for (const file of expected) {
    const found = got.get(file.path);
    if (!found) {
      throw new Error(`${format} build self-check failed: "${file.path}" is missing from the result.`);
    }
    if (found.size !== file.data.length) {
      throw new Error(
        `${format} build self-check failed: "${file.path}" came back ${found.size} bytes, ` +
          `expected ${file.data.length}.`,
      );
    }
    const bytes = found.read();
    for (let i = 0; i < file.data.length; i++) {
      if (bytes[i] !== file.data[i]) {
        throw new Error(`${format} build self-check failed: "${file.path}" differs at byte ${i}.`);
      }
    }
    got.delete(file.path);
  }

  if (got.size > 0) {
    throw new Error(
      `${format} build self-check failed: the result also holds ${[...got.keys()].join(', ')}.`,
    );
  }
}
