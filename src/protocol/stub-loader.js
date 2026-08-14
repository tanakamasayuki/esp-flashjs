// @ts-check
/**
 * Flasher stub upload.
 *
 * The ROM loader cannot read flash or erase regions, so the stub is a hard
 * requirement for most of what this library does. It is uploaded into RAM and
 * started, after which it answers the same protocol plus the 0xD0-0xD3
 * commands.
 *
 * Stub binaries come from https://github.com/espressif/esp-flasher-stub and
 * are dual licensed Apache-2.0 OR MIT. See NOTICE.
 *
 * @module protocol/stub-loader
 */

import { CMD, memBeginPayload, memDataPayload, memEndPayload } from './commands.js';
import { StubLoadError, throwIfAborted } from '../util/errors.js';

/**
 * @typedef {import('./loader.js').EspLoader} EspLoader
 * @typedef {import('./chips.js').ChipDef} ChipDef
 */

/**
 * @typedef {object} StubImage
 * @property {number} entry
 * @property {string} text       Base64.
 * @property {number} text_start
 * @property {string} [data]     Base64.
 * @property {number} [data_start]
 * @property {number} [bss_start]
 */

/** The greeting the stub sends once it is running. */
const STUB_GREETING = 'OHAI';

/** @type {Map<string, StubImage>} */
const cache = new Map();

/**
 * Resolves the URL of a stub JSON file.
 *
 * Built from `import.meta.url` so the same code works when loaded from npm, a
 * CDN, the built `dist/`, or the source tree.
 *
 * @param {string} name
 * @returns {URL}
 */
export function stubUrl(name) {
  return new URL(`./stub/${name}.json`, import.meta.url);
}

/**
 * Fetches and caches a stub image.
 *
 * @param {string} name
 * @returns {Promise<StubImage>}
 * @throws {StubLoadError} If the file cannot be fetched or parsed.
 */
export async function fetchStub(name) {
  const cached = cache.get(name);
  if (cached) return cached;

  const url = stubUrl(name);
  let image;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    image = /** @type {StubImage} */ (await response.json());
  } catch (error) {
    throw new StubLoadError(`could not fetch ${url} (${/** @type {Error} */ (error).message})`);
  }

  if (typeof image?.entry !== 'number' || typeof image?.text !== 'string') {
    throw new StubLoadError(`${url} is not a valid stub image`);
  }

  cache.set(name, image);
  return image;
}

/**
 * Registers a stub image directly, bypassing the fetch.
 *
 * Lets embedders that bundle their own copies, and tests using a simulated
 * device, avoid network access entirely.
 *
 * @param {string} name
 * @param {StubImage} image
 */
export function registerStub(name, image) {
  cache.set(name, image);
}

/**
 * Uploads a stub into RAM and starts it.
 *
 * @param {EspLoader} loader
 * @param {ChipDef} chip
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {StubImage} [options.image] Overrides the bundled stub.
 * @returns {Promise<void>}
 * @throws {StubLoadError}
 */
export async function loadStub(loader, chip, { signal, image } = {}) {
  const stub = image ?? (await fetchStub(chip.stub));
  const blockSize = chip.ramBlockSize;

  /** @type {Array<{name: string, bytes: Uint8Array, address: number}>} */
  const segments = [
    { name: 'text', bytes: base64ToBytes(stub.text), address: stub.text_start },
  ];
  if (stub.data && stub.data_start !== undefined) {
    segments.push({ name: 'data', bytes: base64ToBytes(stub.data), address: stub.data_start });
  }

  for (const segment of segments) {
    throwIfAborted(signal, 'loading-stub');
    const blocks = Math.ceil(segment.bytes.length / blockSize);
    await loader.command(
      CMD.MEM_BEGIN,
      memBeginPayload(segment.bytes.length, blocks, blockSize, segment.address),
      { signal, timeoutMs: 5000 },
    );

    for (let i = 0; i < blocks; i++) {
      throwIfAborted(signal, 'loading-stub');
      const chunk = segment.bytes.subarray(i * blockSize, (i + 1) * blockSize);
      await loader.command(CMD.MEM_DATA, memDataPayload(chunk, i), { signal, timeoutMs: 5000 });
    }
  }

  throwIfAborted(signal, 'loading-stub');
  // MEM_END with an entry point makes the ROM jump into the stub. The reply to
  // this command comes from the ROM; the stub's greeting follows separately.
  await loader.command(CMD.MEM_END, memEndPayload(stub.entry), { signal, timeoutMs: 5000 });

  const greeting = await loader.readFrame({ timeoutMs: 3000, signal });
  const text = new TextDecoder().decode(greeting);
  if (text !== STUB_GREETING) {
    throw new StubLoadError(`expected "${STUB_GREETING}" from the stub, got "${text}"`);
  }
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  // atob exists in browsers and in Node 16+.
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // @ts-ignore -- Node-only fallback, not present in browser type definitions.
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
