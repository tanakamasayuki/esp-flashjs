// @ts-check
/**
 * Assembles site/ for GitHub Pages.
 *
 * The contents of web/ move to the site root so the app is the landing page,
 * while src/, examples/, dist/ and docs/ keep the same depth they have in the
 * repository. That one change of depth is absorbed by rewriting a single file,
 * web/esp-flashjs.js, which is the only place web/ reaches outside itself.
 *
 * The result is that the same sources behave identically when served from the
 * repository root during development and from the published site.
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/** Directories copied verbatim, keeping their repository-relative position. */
const VERBATIM = ['src', 'examples', 'dist', 'docs'];

async function main() {
  if (!existsSync(join(ROOT, 'dist'))) {
    console.error('dist/ is missing. Run `npm run build` first.');
    process.exit(1);
  }

  await rm(SITE, { recursive: true, force: true });
  await mkdir(SITE, { recursive: true });

  // web/* lands at the site root.
  for (const entry of await readdir(join(ROOT, 'web'), { withFileTypes: true })) {
    await cp(join(ROOT, 'web', entry.name), join(SITE, entry.name), { recursive: true });
  }

  for (const dir of VERBATIM) {
    if (!existsSync(join(ROOT, dir))) continue;
    await cp(join(ROOT, dir), join(SITE, dir), { recursive: true });
  }

  // The single indirection between web/ and the library. In the repository it
  // points one level up; on the site, src/ is a sibling. Rewriting just the
  // specifiers keeps the file's comments and type aliases intact.
  const { readFile } = await import('node:fs/promises');
  const bridge = await readFile(join(ROOT, 'web', 'esp-flashjs.js'), 'utf8');
  const rewritten = bridge.replace(/(['"(])\.\.\/src\//g, '$1./src/');
  if (rewritten === bridge) {
    console.error('web/esp-flashjs.js no longer references ../src/; build-site.js needs updating.');
    process.exit(1);
  }
  await writeFile(join(SITE, 'esp-flashjs.js'), rewritten, 'utf8');

  await assertNoAbsolutePaths();

  console.log(`site/ assembled from web/ + ${VERBATIM.join(', ')}`);
}

/**
 * Fails the build on absolute paths.
 *
 * The site is served from a subdirectory (`/esp-flashjs/`), so a leading slash
 * in any href, src or import specifier resolves to the wrong place. This is
 * cheap to check and expensive to notice by hand.
 */
async function assertNoAbsolutePaths() {
  const { readFile } = await import('node:fs/promises');
  /** @type {string[]} */
  const offenders = [];

  /** @param {string} dir */
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(html|js|css)$/.test(entry.name)) continue;
      const text = await readFile(path, 'utf8');
      const patterns = [
        /\b(?:src|href)\s*=\s*["']\/(?!\/)/g,
        /\bfrom\s+["']\/(?!\/)/g,
        /\bimport\s*\(\s*["']\/(?!\/)/g,
      ];
      for (const pattern of patterns) {
        if (pattern.test(text)) offenders.push(path.slice(SITE.length + 1));
      }
    }
  }

  await walk(SITE);
  if (offenders.length > 0) {
    console.error('Absolute paths found; the site is served from a subdirectory:');
    for (const file of new Set(offenders)) console.error(`  ${file}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
