// @ts-check
/**
 * The one release condition that has to be checked before npm bumps anything.
 *
 * Wired into `preversion`, alongside `npm run check`. Everything else about a
 * release is either verified by the test suite or fixed automatically by
 * `sync-version.js` — but "is there anything written about this release?" can
 * only be answered here, and answering it later is expensive: npm raises the
 * version in package.json *before* it runs the `version` hook and does not put
 * it back when that hook fails. Discovering an empty changelog at that point
 * leaves a raised version, a dirty tree and no tag, to be unpicked by hand.
 *
 * It cannot live in `npm run check`: right after a release the section is
 * legitimately empty, and CI would fail on every ordinary push.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unreleasedEntries } from './sync-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const entries = unreleasedEntries(changelog);

  if (entries.length === 0) {
    console.error(
      'Nothing is written under "## Unreleased" in CHANGELOG.md.\n' +
        'Write what changed before releasing — even a re-publish deserves a line saying so.',
    );
    process.exit(1);
  }

  const lines = entries.split('\n').filter((line) => line.startsWith('- '));
  console.log(`Ready to release: ${lines.length} changelog line(s) waiting.`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
