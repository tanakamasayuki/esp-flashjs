// @ts-check
/**
 * The plugin example from docs/analyzers.md, executed.
 *
 * A documented example that does not run is worse than no example: it looks
 * authoritative while teaching an API that has moved. This file is the same
 * analyzer the guide prints, so the guide cannot drift without a test failing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerAnalyzer,
  unregisterAnalyzer,
  listAnalyzers,
  detectFormat,
  analyzeBinary,
  analyzeBinaryAs,
  isUniform,
} from '../src/core.js';

const MAGIC = 'PROVCFG1';

/** @param {Uint8Array} data */
function hasMagic(data) {
  if (data.length < 16) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** The analyzer exactly as the guide presents it. */
const provcfgAnalyzer = {
  id: 'provcfg',
  name: 'Provisioning Config',

  /** @param {Uint8Array} data */
  detect(data) {
    if (isUniform(data, 0xff) || isUniform(data, 0x00)) return { confidence: 0 };
    if (!hasMagic(data)) return { confidence: 0 };
    const length = new DataView(data.buffer, data.byteOffset).getUint32(12, true);
    return length + 16 <= data.length
      ? { confidence: 0.9, reasonCode: 'magicAndLength' }
      : { confidence: 0.5, reasonCode: 'lengthOverruns' };
  },

  /** @param {Uint8Array} data */
  analyze(data) {
    const view = new DataView(data.buffer, data.byteOffset);
    const version = view.getUint32(8, true);
    const length = view.getUint32(12, true);
    /** @type {any[]} */
    const issues = [];

    const available = Math.min(length, data.length - 16);
    if (available < length) {
      issues.push({
        level: 'error',
        code: 'provcfg.truncated',
        params: { declared: length, available },
      });
    }

    let payload = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(data.subarray(16, 16 + available)));
    } catch (error) {
      issues.push({ level: 'error', code: 'provcfg.badJson', params: { message: String(error) } });
    }

    return {
      type: 'provcfg',
      confidence: available === length ? 0.9 : 0.5,
      metadata: { version, length, keys: payload ? Object.keys(payload).length : 0 },
      regions: [
        { offset: 0, length: 16, label: 'Header', kind: /** @type {const} */ ('header') },
        { offset: 16, length: available, label: 'JSON payload', kind: /** @type {const} */ ('data') },
      ],
      issues,
      model: payload,
    };
  },
};

/**
 * @param {object} payload
 * @param {object} [options]
 * @param {number} [options.declaredLength] Override, to fake a truncated record.
 * @returns {Uint8Array}
 */
function provcfgBytes(payload, { declaredLength } = {}) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(16 + json.length);
  out.set(new TextEncoder().encode(MAGIC));
  const view = new DataView(out.buffer);
  view.setUint32(8, 1, true);
  view.setUint32(12, declaredLength ?? json.length, true);
  out.set(json, 16);
  return out;
}

test('a plugin analyzer takes over its own format once registered', (t) => {
  t.after(() => unregisterAnalyzer('provcfg'));
  registerAnalyzer(provcfgAnalyzer);

  assert.ok(listAnalyzers().some((a) => a.id === 'provcfg'));

  const data = provcfgBytes({ ssid: 'lab', channel: 6 });
  const result = analyzeBinary(data, {});
  assert.equal(result.type, 'provcfg');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.metadata.keys, 2);
  assert.deepEqual(result.model, { ssid: 'lab', channel: 6 });
  assert.deepEqual(result.issues, []);
});

test('a contradicted magic lowers confidence rather than being ignored', (t) => {
  t.after(() => unregisterAnalyzer('provcfg'));
  registerAnalyzer(provcfgAnalyzer);

  // The record claims more bytes than the region holds. That is a damaged
  // record, not a coincidence, so the analyzer must still claim it — reporting
  // the damage is the whole point of claiming it.
  const data = provcfgBytes({ ssid: 'lab' }, { declaredLength: 9999 });
  const result = analyzeBinary(data, {});
  assert.equal(result.type, 'provcfg');
  assert.equal(result.confidence, 0.5);
  assert.ok(result.issues.some((i) => i.code === 'provcfg.truncated'));
});

test('a plugin does not claim erased flash, whatever its magic check says', (t) => {
  t.after(() => unregisterAnalyzer('provcfg'));
  registerAnalyzer(provcfgAnalyzer);

  const erased = new Uint8Array(4096).fill(0xff);
  assert.equal(provcfgAnalyzer.detect(erased).confidence, 0);
  assert.equal(analyzeBinary(erased, {}).metadata.contents, 'erased');
});

test('registration is reversible', () => {
  registerAnalyzer(provcfgAnalyzer);
  unregisterAnalyzer('provcfg');

  assert.ok(!listAnalyzers().some((a) => a.id === 'provcfg'));
  const data = provcfgBytes({ ssid: 'lab' });
  assert.deepEqual(detectFormat(data, {}), [], 'nothing built in should claim it');
  assert.equal(analyzeBinary(data, {}).type, 'raw');
});

test('a format can be forced regardless of what detection decided', (t) => {
  t.after(() => unregisterAnalyzer('provcfg'));
  registerAnalyzer(provcfgAnalyzer);

  // Bytes that are plainly not a provisioning record. Forcing the analyzer is
  // how the UI's format selector works, and how you find out what your
  // analyzer makes of a region it did not win.
  const notMine = new Uint8Array(64).fill(0x41);
  assert.equal(provcfgAnalyzer.detect(notMine).confidence, 0);

  const forced = analyzeBinaryAs('provcfg', notMine, {});
  assert.equal(forced.type, 'provcfg');
  assert.ok(forced.issues.length > 0, 'it should say what is wrong rather than throw');
});
