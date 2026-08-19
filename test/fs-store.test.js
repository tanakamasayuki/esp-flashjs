// @ts-check
/**
 * The editable filesystem tree.
 *
 * Nothing here touches a real image; the store is deliberately just paths and
 * bytes. What is worth testing is the part that has opinions: which paths are
 * refused, what a delete takes with it, and whether the record of "this file
 * was only partly recoverable" survives being edited around.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FsStore, normalizeFsPath } from '../src/format/fs/store.js';
import { FsPathError } from '../src/util/errors.js';

test('paths are normalised to one absolute form', () => {
  assert.equal(normalizeFsPath('/a/b.txt'), '/a/b.txt');
  assert.equal(normalizeFsPath('a/b.txt'), '/a/b.txt');
  assert.equal(normalizeFsPath('//a///b.txt'), '/a/b.txt');
  assert.equal(normalizeFsPath('/a/b/'), '/a/b');
  assert.equal(normalizeFsPath('/'), '/');
});

test('a relative segment is refused rather than resolved', () => {
  // There is no working directory here, so resolving ".." would be inventing
  // an answer. Refusing surfaces the caller's bug instead of burying it.
  assert.throws(() => normalizeFsPath('/a/../b'), FsPathError);
  assert.throws(() => normalizeFsPath('/a/./b'), FsPathError);
  assert.throws(() => normalizeFsPath('/a/b\0c'), FsPathError);
  assert.throws(() => normalizeFsPath(''), FsPathError);
});

test('writing a file creates the directories above it', () => {
  const store = new FsStore('littlefs');
  store.write('/logs/2026/08/today.txt', 'hello');

  assert.deepEqual(store.paths, ['/logs/2026/08/today.txt']);
  assert.deepEqual(store.directories, ['/logs', '/logs/2026', '/logs/2026/08']);
  assert.equal(new TextDecoder().decode(store.read('/logs/2026/08/today.txt')), 'hello');
});

test('read returns a copy, so the store cannot be edited behind its own back', () => {
  const store = new FsStore('spiffs');
  store.write('/a.bin', Uint8Array.of(1, 2, 3));

  const first = store.read('/a.bin');
  first[0] = 99;
  assert.equal(store.read('/a.bin')[0], 1);
});

test('a file and a directory cannot share a name', () => {
  const store = new FsStore('fat');
  store.write('/thing', 'x');
  assert.throws(() => store.mkdir('/thing'), FsPathError);

  const other = new FsStore('fat');
  other.mkdir('/thing');
  assert.throws(() => other.write('/thing', 'x'), FsPathError);
});

test('deleting a directory takes its subtree with it', () => {
  const store = new FsStore('littlefs');
  store.write('/keep.txt', 'k');
  store.write('/logs/a.txt', 'a');
  store.write('/logs/deep/b.txt', 'b');

  const removed = store.delete('/logs');
  assert.equal(removed, 4, 'two files, the directory and its subdirectory');
  assert.deepEqual(store.paths, ['/keep.txt']);
  assert.deepEqual(store.directories, []);
});

test('deleting something that is not there is not an error', () => {
  const store = new FsStore('spiffs');
  assert.equal(store.delete('/nope.txt'), 0);
});

test('rename moves a whole subtree', () => {
  const store = new FsStore('littlefs');
  store.write('/old/a.txt', 'a');
  store.write('/old/deep/b.txt', 'b');

  store.rename('/old', '/new');
  assert.deepEqual(store.paths, ['/new/a.txt', '/new/deep/b.txt']);
  assert.deepEqual(store.directories, ['/new', '/new/deep']);
});

test('a directory cannot be renamed into itself', () => {
  const store = new FsStore('littlefs');
  store.write('/a/f.txt', 'x');
  assert.throws(() => store.rename('/a', '/a/b'), FsPathError);
});

test('incomplete files are remembered, and stop being incomplete when replaced', () => {
  // This is the one piece of provenance the store has to carry. A file read
  // out of a damaged image comes back with zeros where the data was missing,
  // and rebuilding writes those zeros down as though they were the file.
  const image = {
    type: /** @type {const} */ ('spiffs'),
    geometry: {},
    issues: [],
    files: [
      { path: '/good.txt', size: 1, read: () => Uint8Array.of(1), pageIndices: [], complete: true },
      { path: '/torn.bin', size: 4, read: () => new Uint8Array(4), pageIndices: [], complete: false },
    ],
  };

  const store = FsStore.from(image);
  assert.deepEqual(store.incomplete, ['/torn.bin']);

  store.write('/torn.bin', 'now it is whole');
  assert.deepEqual(store.incomplete, []);
});

test('from() takes a full copy, so the source image can be discarded', () => {
  let reads = 0;
  const image = {
    type: /** @type {const} */ ('littlefs'),
    geometry: { blockSize: 4096 },
    issues: [],
    files: [
      {
        path: '/a.txt',
        size: 2,
        read: () => {
          reads++;
          return Uint8Array.of(0x68, 0x69);
        },
        pageIndices: [],
        complete: true,
      },
    ],
  };

  const store = FsStore.from(image);
  assert.equal(reads, 1, 'read once, at snapshot time');
  assert.deepEqual([...store.read('/a.txt')], [0x68, 0x69]);
  assert.equal(reads, 1, 'and not again afterwards');
  assert.deepEqual(store.geometry, { blockSize: 4096 });
});

test('clone is independent of the original', () => {
  const store = new FsStore('fat');
  store.write('/a.txt', 'one');

  const copy = store.clone();
  copy.write('/a.txt', 'two');
  copy.write('/b.txt', 'new');

  assert.equal(new TextDecoder().decode(store.read('/a.txt')), 'one');
  assert.deepEqual(store.paths, ['/a.txt']);
});

test('entries list parents before their children', () => {
  const store = new FsStore('fat');
  store.write('/b/deep/x.txt', 'x');
  store.write('/a.txt', 'a');

  assert.deepEqual(
    store.entries.map((e) => e.path),
    ['/a.txt', '/b', '/b/deep', '/b/deep/x.txt'],
  );
});
