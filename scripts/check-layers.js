// @ts-check
/**
 * Enforces the dependency direction described in docs/spec.ja.md.
 *
 * The rule that matters most is that format/ and binary/ stay pure: they take
 * byte arrays and return data. If a parser ever reaches for the transport, the
 * "analyze a file without a device" promise quietly stops being true, and
 * nothing else in the build would catch it.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Layer name to the layers it may import from. */
const ALLOWED = {
  util: [],
  binary: ['util'],
  format: ['binary', 'util'],
  transport: ['util'],
  protocol: ['transport', 'binary', 'util'],
  device: ['protocol', 'binary', 'format', 'util'],
  // The device simulator implements Transport but has to speak the protocol to
  // answer commands, so it sits above protocol rather than beside transport.
  testing: ['protocol', 'transport', 'binary', 'format', 'util'],
};

/** Browser globals that must not appear outside the Web Serial transport. */
const DOM_GLOBALS = /\b(?:document|window)\s*\./g;
const DOM_EXEMPT = new Set(['transport/web-serial.js']);

/** @type {string[]} */
const errors = [];

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collect(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

/**
 * @param {string} specifier
 * @param {string} fromFile
 * @returns {string|null} The layer the specifier resolves into.
 */
function layerOf(specifier, fromFile) {
  const resolved = relative(SRC, join(dirname(fromFile), specifier));
  const segments = resolved.split(/[\\/]/);
  return segments.length > 1 ? segments[0] : null;
}

async function main() {
  for (const file of await collect(SRC)) {
    const relPath = relative(SRC, file).replace(/\\/g, '/');
    const layer = relPath.includes('/') ? relPath.split('/')[0] : null;
    const source = await readFile(file, 'utf8');

    // Extension-less specifiers do not resolve in a browser; catch them here
    // rather than at runtime in someone else's page.
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]*)['"]/g)) {
      const specifier = match[1];
      if (!specifier.endsWith('.js') && !specifier.endsWith('.json')) {
        errors.push(`${relPath}: import "${specifier}" is missing a file extension`);
      }

      if (!layer) continue;
      const target = layerOf(specifier, file);
      if (target === null || target === layer) continue;

      const allowed = ALLOWED[/** @type {keyof typeof ALLOWED} */ (layer)];
      if (allowed && !allowed.includes(target)) {
        errors.push(`${relPath}: ${layer}/ must not import from ${target}/`);
      }
    }

    if (!DOM_EXEMPT.has(relPath)) {
      const hits = source.replace(/^\s*\*.*$/gm, '').match(DOM_GLOBALS);
      if (hits) errors.push(`${relPath}: references a DOM global (${hits[0].trim()})`);
    }
  }

  if (errors.length > 0) {
    console.error('Layer violations:');
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log('Layer boundaries OK.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
