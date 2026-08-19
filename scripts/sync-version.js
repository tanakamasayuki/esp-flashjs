// @ts-check
/**
 * Propagates a new version into everything derived from it.
 *
 * Wired into the `version` npm lifecycle script, which runs after `npm version`
 * has bumped package.json and before it commits and tags. That timing is the
 * whole point: the tag must land on a commit where the version is already
 * consistent everywhere, so a release cannot be tagged with last release's CDN
 * URLs still in the README.
 *
 * This is deliberately not a GitHub Action. An Action fires on the tag push,
 * which is *after* the commit exists — anything it rewrote would describe a
 * different commit than the tag points at, and GitHub Pages would publish the
 * stale version in between.
 *
 * What it touches:
 *
 *   1. The `VERSION` constant in `src/index.js`, which the web app displays.
 *   2. Every `esp-flashjs@<version>` in the documentation and examples — CDN
 *      URLs and npm links. Left to a checklist item and a `grep`, these drift,
 *      and someone following the README loads last release's code.
 *   3. The changelog: `## Unreleased` becomes `## <version>` with a fresh empty
 *      `## Unreleased` above it.
 *
 * What it refuses rather than guesses: an empty `## Unreleased`. A release with
 * nothing written about it is almost always a forgotten entry, and the one case
 * where it is not — a re-publish — still deserves a line saying so.
 *
 * Staging is done here rather than in package.json so that the list of files
 * lives in one place. `npm version` commits whatever is staged.
 */

import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A pinned reference to a released version, in a CDN URL or an npm link.
 *
 * Written without a sample version on purpose: the rule this enforces is that
 * every such reference in the repository names the current release, and a
 * sample here would be the one that does not. It caught itself the first time
 * it ran, which is a good sign about the rule and a bad sign about examples.
 *
 * A historical mention — "0.1.0 was a test release" — is written without the
 * package name in front of it, so it is prose rather than a pin.
 */
export const PACKAGE_PIN = /esp-flashjs@\d+\.\d+\.\d+/g;

/**
 * Files that may mention a released version of this package.
 *
 * A directory is walked; a file is taken as it is. Anything not listed here is
 * still covered by the test that no stale pin exists anywhere, so a new file
 * with a CDN URL fails the build rather than going quietly out of date.
 */
const PINNED = ['README.md', 'README.ja.md', 'docs', 'examples'];

/**
 * One file rewritten in full.
 *
 * @typedef {object} Edit
 * @property {string} path
 * @property {string} text
 */

/**
 * @param {string} target
 * @returns {Promise<string[]>} Absolute paths.
 */
async function expand(target) {
  const path = join(ROOT, target);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    /** @type {string[]} */
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...(await expand(join(target, entry.name))));
      else files.push(join(path, entry.name));
    }
    return files;
  } catch {
    return [path];
  }
}

/**
 * @param {string} version
 * @returns {Promise<Edit[]>}
 */
async function planVersionConstant(version) {
  const path = join(ROOT, 'src', 'index.js');
  const pattern = /(export const VERSION = ')[^']*(')/;
  const source = await readFile(path, 'utf8');

  if (!pattern.test(source)) {
    throw new Error(`Could not find the VERSION constant in ${path}.`);
  }
  const text = source.replace(pattern, `$1${version}$2`);
  return text === source ? [] : [{ path, text }];
}

/**
 * @param {string} version
 * @returns {Promise<Edit[]>}
 */
async function planPins(version) {
  /** @type {Edit[]} */
  const edits = [];
  for (const target of PINNED) {
    for (const path of await expand(target)) {
      const source = await readFile(path, 'utf8');
      const text = source.replace(PACKAGE_PIN, `esp-flashjs@${version}`);
      if (text !== source) edits.push({ path, text });
    }
  }
  return edits;
}

/**
 * The entries waiting under `## Unreleased`.
 *
 * Exported so `preversion` can refuse an empty one *before* npm has bumped
 * package.json. Discovering it afterwards leaves the version raised, the tree
 * dirty and no tag — a state that has to be unpicked by hand.
 *
 * @param {string} changelog
 * @returns {string}
 */
export function unreleasedEntries(changelog) {
  const marker = '\n## Unreleased\n';
  const at = changelog.indexOf(marker);
  if (at < 0) throw new Error('CHANGELOG.md has no "## Unreleased" section.');
  const body = changelog.slice(at + marker.length);
  const end = body.indexOf('\n## ');
  return (end < 0 ? body : body.slice(0, end + 1)).trim();
}

/**
 * Turns the accumulated `## Unreleased` entries into a released section.
 *
 * @param {string} version
 * @returns {Promise<Edit[]>}
 */
async function planChangelog(version) {
  const path = join(ROOT, 'CHANGELOG.md');
  const source = await readFile(path, 'utf8');

  if (source.includes(`\n## ${version}\n`)) {
    console.log(`CHANGELOG.md already has a ${version} section.`);
    return [];
  }
  if (unreleasedEntries(source).length === 0) {
    throw new Error(
      `CHANGELOG.md has nothing under "## Unreleased". Write what changed in ${version} ` +
        'before releasing — even a re-publish deserves a line saying so.',
    );
  }

  const marker = '\n## Unreleased\n';
  const at = source.indexOf(marker) + marker.length;
  return [{ path, text: `${source.slice(0, at)}\n## ${version}\n${source.slice(at)}` }];
}

async function main() {
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

  // Everything is worked out before anything is written. An earlier version
  // rewrote the READMEs and then threw on the changelog, leaving the tree
  // carrying a version number that was never released and no tag to explain
  // it — the failure mode a release script exists to avoid.
  const edits = [
    ...(await planVersionConstant(version)),
    ...(await planPins(version)),
    ...(await planChangelog(version)),
  ];

  if (edits.length === 0) {
    console.log(`Everything already says ${version}.`);
    return;
  }

  for (const edit of edits) {
    await writeFile(edit.path, edit.text, 'utf8');
    console.log(`  ${relative(ROOT, edit.path)} -> ${version}`);
  }
  // Staged here so `npm version` picks them up in the commit it is about to
  // make. Without this they would sit in the working tree, outside the tag.
  execFileSync('git', ['add', '--', ...edits.map((e) => e.path)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

// Only when run as a command. `check-releasable.js` imports `unreleasedEntries`
// from here, and a module that rewrites files merely because it was imported is
// a trap — it happened to be harmless the first time only because the version
// had not been bumped yet.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
