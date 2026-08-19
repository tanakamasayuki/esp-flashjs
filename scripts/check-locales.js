// @ts-check
/**
 * Verifies that every locale covers the English catalogue.
 *
 * en.json is the canon. A missing key falls back to English at runtime rather
 * than blanking the UI, so this is a warning-shaped problem — but an unnoticed
 * one, which is exactly what CI is for. Unknown extra keys are reported too,
 * since they are usually a rename that only got applied to one file.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'web', 'locales');
const CANONICAL = 'en.json';

/** Placeholders must line up, or an interpolation silently renders literally. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Calls of the form `t('some.key')`.
 *
 * Only literal keys. A key built from a template — `t(`analyze.type.${x}`)` —
 * cannot be resolved statically, and guessing at the shape would either miss
 * real problems or invent imaginary ones.
 */
const LITERAL_KEY = /\bt\(\s*'([^']+)'/g;

/**
 * Every literal key any file under web/ asks for.
 *
 * A missing key does not blank the UI; `t` returns the key itself. That is the
 * right runtime behaviour and a terrible way to notice a typo, since
 * `fs.aply` renders as the plausible-looking text "fs.aply".
 *
 * @param {string} dir
 * @param {Set<string>} into
 */
async function collectKeys(dir, into) {
  for (const entry of await readdir(dir)) {
    if (entry === 'locales') continue;
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) {
      await collectKeys(path, into);
      continue;
    }
    if (!entry.endsWith('.js')) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(LITERAL_KEY)) into.add(match[1]);
  }
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function placeholdersIn(text) {
  return new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
}

async function main() {
  const english = JSON.parse(await readFile(join(LOCALES_DIR, CANONICAL), 'utf8'));
  const englishKeys = Object.keys(english);

  /** @type {string[]} */
  const problems = [];
  let checked = 0;

  for (const file of await readdir(LOCALES_DIR)) {
    if (!file.endsWith('.json') || file === CANONICAL) continue;
    const catalogue = JSON.parse(await readFile(join(LOCALES_DIR, file), 'utf8'));
    checked++;

    const missing = englishKeys.filter((key) => !(key in catalogue));
    const extra = Object.keys(catalogue).filter((key) => !(key in english));

    if (missing.length > 0) problems.push(`${file}: missing ${missing.length} key(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
    if (extra.length > 0) problems.push(`${file}: ${extra.length} unknown key(s): ${extra.slice(0, 8).join(', ')}`);

    for (const key of englishKeys) {
      if (!(key in catalogue)) continue;
      const expected = placeholdersIn(english[key]);
      const actual = placeholdersIn(catalogue[key]);
      const lost = [...expected].filter((p) => !actual.has(p));
      const gained = [...actual].filter((p) => !expected.has(p));
      if (lost.length > 0 || gained.length > 0) {
        problems.push(
          `${file}: "${key}" placeholder mismatch` +
            (lost.length ? ` (missing {${lost.join('}, {')}})` : '') +
            (gained.length ? ` (unexpected {${gained.join('}, {')}})` : ''),
        );
      }
    }
  }

  /** @type {Set<string>} */
  const used = new Set();
  await collectKeys(join(ROOT, 'web'), used);
  const unknown = [...used].filter((key) => !(key in english)).sort();
  if (unknown.length > 0) {
    problems.push(`web/: ${unknown.length} key(s) not in ${CANONICAL}: ${unknown.join(', ')}`);
  }

  if (problems.length > 0) {
    console.error('Locale problems:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `Locales OK: ${checked} translation(s) cover all ${englishKeys.length} keys, ` +
      `and all ${used.size} keys the app asks for by name exist.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
