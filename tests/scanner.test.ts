import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { scanFiles } from '../src/indexer.js';

test('scanner counts raw body bytes, empty files and bounded oversized samples', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-counts-'));
  try {
    const body = Buffer.from('// 한글\n');
    fs.writeFileSync(path.join(root, 'app.ts'), body);
    fs.writeFileSync(path.join(root, 'unsupported.py'), Buffer.from([0xff, 0xfe, 0x61]));
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    fs.writeFileSync(path.join(root, 'large.ts'), Buffer.alloc(5000, 0x61));
    const result = scanFiles(root, 100);
    assert.deepEqual(result.reads, { bodyReads: 3, bodyBytes: body.length + 3, sampleReads: 1, sampleBytes: 4096 });
    assert.equal(result.skipped[0]?.contentSample?.length, 4096);
    assert.match(result.skipped[0]?.reason ?? '', /5000 > 100/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanner preserves an oversized skip on sample failure and closes the file', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-sample-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'large.ts'), 'x'.repeat(5000));
  const open = fs.openSync;
  const stat = fs.fstatSync;
  const opened: number[] = [];
  t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, args); opened.push(fd); return fd;
  });
  t.mock.method(fs, 'readSync', () => { throw new Error('forced sample read failure'); });
  syncBuiltinESMExports();
  try {
    const result = scanFiles(root, 100);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.contentSample, undefined);
    assert.deepEqual(result.reads, { bodyReads: 0, bodyBytes: 0, sampleReads: 0, sampleBytes: 0 });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const fd of opened) assert.throws(() => stat(fd), { code: 'EBADF' });
  }
});

test('scanner fails closed if opening an oversized file fails', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'large.ts'), 'x'.repeat(5000));
  t.mock.method(fs, 'openSync', () => { throw new Error('forced open failure'); });
  syncBuiltinESMExports();
  try { assert.throws(() => scanFiles(root, 100), /forced open failure/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('scanner rejects a leaf swapped to a symlink before open without reading it', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(root, 'app.ts');
  const privateFile = path.join(outside, 'private.ts');
  fs.writeFileSync(target, '// checked body\n');
  fs.writeFileSync(privateFile, '// outside marker\n');
  const open = fs.openSync;
  const read = fs.readSync;
  let swapped = false;
  let reads = 0;
  t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    if (args[0] === target) {
      fs.unlinkSync(target); fs.symlinkSync(privateFile, target); swapped = true;
    }
    return Reflect.apply(open, fs, args);
  });
  t.mock.method(fs, 'readSync', (...args: unknown[]) => { reads++; return Reflect.apply(read, fs, args); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => scanFiles(root, 100), /ELOOP|file changed/);
    assert.equal(swapped, true);
    assert.equal(reads, 0);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

for (const race of ['replacement', 'growth', 'short reads', 'read error'] as const) {
  test(`scanner bounds file reads and closes descriptors during ${race}`, (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'parallax-scanner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'app.ts');
    const replacement = path.join(root, 'node_modules', 'replacement.blob');
    const original = '// checked body\n';
    fs.writeFileSync(target, original);
    fs.mkdirSync(path.dirname(replacement));
    fs.writeFileSync(replacement, 'x'.repeat(200));
    const before = { openSync: fs.openSync, statSync: fs.statSync, fstatSync: fs.fstatSync, readSync: fs.readSync };
    const opened: number[] = [];
    let changed = false;
    let bytesRead = 0;
    const change = () => {
      if (changed) return;
      changed = true;
      if (race === 'replacement') fs.renameSync(replacement, target);
      if (race === 'growth') fs.appendFileSync(target, 'x'.repeat(200));
    };
    t.mock.method(fs, 'openSync', (...args: unknown[]) => {
      const fd = Reflect.apply(before.openSync, fs, args);
      if (args[0] === target) opened.push(fd);
      return fd;
    });
    t.mock.method(fs, 'statSync', (...args: unknown[]) => {
      const value = Reflect.apply(before.statSync, fs, args);
      if (args[0] === target) change();
      return value;
    });
    t.mock.method(fs, 'fstatSync', (...args: unknown[]) => {
      const value = Reflect.apply(before.fstatSync, fs, args);
      if (opened.includes(args[0] as number)) change();
      return value;
    });
    t.mock.method(fs, 'readSync', (...args: unknown[]) => {
      if (opened.includes(args[0] as number)) {
        if (race === 'read error') throw new Error('forced file read error');
        if (race === 'short reads') args[3] = Math.min(args[3] as number, 3);
      }
      const n = Reflect.apply(before.readSync, fs, args);
      if (opened.includes(args[0] as number)) bytesRead += n;
      return n;
    });
    syncBuiltinESMExports();
    try {
      if (race === 'growth' || race === 'read error') {
        assert.throws(() => scanFiles(root, 100), race === 'growth' ? /file changed/ : /forced file read error/);
      } else {
        let result: ReturnType<typeof scanFiles> | undefined;
        try { result = scanFiles(root, 100); }
        catch (error) {
          if (race !== 'replacement') throw error;
          assert.match(String(error), /file changed/);
        }
        if (result) {
          assert.equal(result.files[0]?.content, original);
          assert.equal(result.reads.bodyBytes, Buffer.byteLength(original));
          assert.equal(result.reads.bodyReads, 1);
        }
      }
      assert.ok(changed, 'the race must occur at the actual file check');
      assert.ok(bytesRead <= Buffer.byteLength(original), 'reads must stay within the checked size');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const fd of opened) assert.throws(() => before.fstatSync(fd), { code: 'EBADF' });
    }
  });
}
