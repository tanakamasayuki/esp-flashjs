// @ts-check
/**
 * Static file server for local development.
 *
 * Written against node:http rather than pulling in a dependency, matching the
 * project's zero-runtime-dependency stance. Serves the repository root, so
 * web/ and examples/ resolve `../src/...` exactly as they do on the published
 * site.
 *
 * Usage: node scripts/serve.js [--port 8080] [--root .]
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const rootIndex = args.indexOf('--root');
  return {
    port: portIndex !== -1 ? Number(args[portIndex + 1]) : 8080,
    root: resolve(rootIndex !== -1 ? args[rootIndex + 1] : REPO_ROOT),
  };
}

const { port, root } = parseArgs();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // Contain the served tree; `..` in a URL must not escape the root.
  const target = resolve(join(root, normalize(pathname)));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      await stat(file);
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${pathname}`);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // Always revalidate; stale modules during development are pure confusion.
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${root}`);
  console.log('');
  console.log(`  App       http://localhost:${port}/web/`);
  console.log(`  Examples  http://localhost:${port}/examples/`);
  console.log('');
  console.log('Web Serial needs a secure context; localhost qualifies, a LAN IP does not.');
});
