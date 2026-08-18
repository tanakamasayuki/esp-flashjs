// @ts-check
/**
 * Downloads flasher stub JSON files from esp-flasher-stub.
 *
 * The release tag is pinned in this file rather than resolved at runtime. The
 * older esptool-legacy-flasher-stub project is GPL-2.0 and must never end up
 * in this repository; pinning the URL is what keeps that from happening by
 * accident.
 *
 * Usage: node scripts/fetch-stub.js [--tag v1.2.1]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'protocol', 'stub');

/** Pinned release of https://github.com/espressif/esp-flasher-stub */
const DEFAULT_TAG = 'v1.2.1';

/** Stub file names, matching `ChipDef.stub` in src/protocol/chips.js. */
const CHIPS = [
  'esp32',
  'esp32s2',
  'esp32s3',
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32c61',
  'esp32h2',
  'esp32p4',
  // Revisions below v3.0 map RAM differently and need their own build. Every
  // P4 shipped so far is one of them, so this is not an edge case.
  'esp32p4-rev1',
];

/**
 * @param {string} tag
 * @param {string} chip
 * @returns {string}
 */
function urlFor(tag, chip) {
  return `https://github.com/espressif/esp-flasher-stub/releases/download/${tag}/${chip}.json`;
}

async function main() {
  const tagIndex = process.argv.indexOf('--tag');
  const tag = tagIndex !== -1 ? process.argv[tagIndex + 1] : DEFAULT_TAG;

  await mkdir(OUT_DIR, { recursive: true });

  /** @type {string[]} */
  const fetched = [];
  /** @type {string[]} */
  const missing = [];

  for (const chip of CHIPS) {
    const url = urlFor(tag, chip);
    process.stdout.write(`  ${chip} ... `);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (typeof json.entry !== 'number' || typeof json.text !== 'string') {
        throw new Error('unexpected JSON shape');
      }
      await writeFile(join(OUT_DIR, `${chip}.json`), JSON.stringify(json), 'utf8');
      fetched.push(chip);
      process.stdout.write('ok\n');
    } catch (error) {
      missing.push(chip);
      process.stdout.write(`skipped (${error.message})\n`);
    }
  }

  await writeFile(
    join(OUT_DIR, 'README.md'),
    [
      '# Flasher stubs',
      '',
      'Do not edit these files by hand. Regenerate with `npm run fetch-stub`.',
      '',
      `- Source: https://github.com/espressif/esp-flasher-stub`,
      `- Release: \`${tag}\``,
      '- License: Apache-2.0 OR MIT (see ../../../NOTICE)',
      '',
      `Fetched: ${fetched.join(', ') || '(none)'}`,
      missing.length > 0 ? `Unavailable at this release: ${missing.join(', ')}` : '',
      '',
      'The legacy `esptool-legacy-flasher-stub` project is GPL-2.0 licensed and is',
      'deliberately not used here.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`\n${fetched.length} stub(s) written to src/protocol/stub/`);
  if (missing.length > 0) {
    console.log(`${missing.length} unavailable: ${missing.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
