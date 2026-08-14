// @ts-check
/**
 * Copies the version from package.json into src/index.js.
 *
 * Wired into the `version` npm lifecycle script, so `npm version minor` keeps
 * the exported `VERSION` constant in step automatically. Left to a manual
 * step, this is exactly the kind of thing that drifts and then shows up in a
 * bug report as a misleading version number.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'src', 'index.js');
const PATTERN = /(export const VERSION = ')[^']*(')/;

async function main() {
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const source = await readFile(TARGET, 'utf8');

  if (!PATTERN.test(source)) {
    console.error(`Could not find the VERSION constant in ${TARGET}.`);
    process.exit(1);
  }

  const updated = source.replace(PATTERN, `$1${version}$2`);
  if (updated === source) {
    console.log(`VERSION already ${version}.`);
    return;
  }

  await writeFile(TARGET, updated, 'utf8');
  console.log(`VERSION -> ${version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
