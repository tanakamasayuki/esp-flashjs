// @ts-check
/**
 * Bundles the library into dist/.
 *
 * esbuild is used for bundling and minification only — `target` is left alone
 * so no syntax is rewritten. The sources already run natively everywhere the
 * package claims to support.
 *
 * Two entry points are produced:
 *   - full: everything, including the serial transport and protocol.
 *   - core: parsers and binary utilities only, for offline analysis and Node.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** @type {Array<{entry: string, out: string}>} */
const BUNDLES = [
  { entry: 'src/index.js', out: 'esp-flashjs' },
  { entry: 'src/core.js', out: 'esp-flashjs.core' },
];

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const banner = [
    `/*! ${pkg.name} v${pkg.version} | ${pkg.license} | ${pkg.homepage}`,
    ' * Includes flasher stubs from espressif/esp-flasher-stub (Apache-2.0 OR MIT).',
    ' */',
  ].join('\n');

  for (const { entry, out } of BUNDLES) {
    for (const minify of [false, true]) {
      const outfile = join(DIST, `${out}${minify ? '.min' : ''}.js`);
      await esbuild.build({
        entryPoints: [join(ROOT, entry)],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        minify,
        // No `target`: do not transpile. The sources are already ES2022.
        legalComments: 'none',
        banner: { js: banner },
        // Stubs are fetched at runtime relative to import.meta.url, so they
        // must not be inlined into the bundle.
        external: ['*.json'],
      });
      const size = (await readFile(outfile)).length;
      console.log(`  ${outfile.slice(ROOT.length + 1)}  ${(size / 1024).toFixed(1)} KB`);
    }
  }

  // The stub JSON files sit next to the bundle so `new URL('./stub/x.json',
  // import.meta.url)` resolves the same way from dist/ as it does from src/.
  await cp(join(ROOT, 'src', 'protocol', 'stub'), join(DIST, 'stub'), { recursive: true });
  console.log('  dist/stub/  (flasher stubs)');

  await writeFile(
    join(DIST, 'README.md'),
    `Build output for ${pkg.name} v${pkg.version}. Do not edit; run \`npm run build\`.\n`,
    'utf8',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
