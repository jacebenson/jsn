import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database, { requireFts5 } from '../src/sqlite.js';

test('SQLite preserves binding, rows, blobs, pragmas and nested rollback', () => {
  const db = new Database(':memory:');
  try {
    requireFts5(db);
    db.exec('CREATE TABLE data(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB)');
    const insert = db.prepare('INSERT INTO data(value, bytes) VALUES (@value, @bytes)');
    assert.equal(insert.run({ value: 'kept', bytes: Buffer.from([1, 255]) }).lastInsertRowid, 1);
    assert.deepEqual(db.prepare('SELECT value, bytes FROM data').get(), { value: 'kept', bytes: Buffer.from([1, 255]) });
    assert.throws(() => insert.run({ value: undefined, bytes: null }), /undefined|type/i);
    assert.throws(() => db.prepare('INSERT INTO data(value) VALUES (?)').run([undefined]), /undefined|type/i);
    assert.equal(db.prepare('SELECT count(*) AS n FROM data').get().n, 1);
    const inner = db.transaction(() => { insert.run({ value: 'rolled back', bytes: null }); throw new Error('inner'); });
    db.transaction(() => { assert.equal(db.inTransaction, true); assert.throws(inner, /inner/); insert.run({ value: 'outer', bytes: null }); })();
    assert.throws(db.transaction(() => { db.exec('DELETE FROM data'); throw new Error('outer'); }), /outer/);
    assert.deepEqual(db.prepare('SELECT value FROM data ORDER BY id').all(), [{ value: 'kept' }, { value: 'outer' }]);
    assert.equal(db.inTransaction, false);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.throws(db.transaction(() => Promise.resolve()), /synchronous/);
  } finally { db.close(); }
});

test('SQLite rejects async callbacks before invocation or post-await writes', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE data(value)');
    let invoked = false;
    assert.throws(() => db.transaction(async () => {
      invoked = true;
      db.exec('INSERT INTO data VALUES (1)');
      await Promise.resolve();
      db.exec('INSERT INTO data VALUES (2)');
    })(), /synchronous/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(invoked, false);
    assert.deepEqual(db.prepare('SELECT * FROM data').all(), []);
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});

test('SQLite refuses missing files and read-only writes; backups remain readable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.db');
  assert.throws(() => new Database(file, { fileMustExist: true }));
  assert.equal(fs.existsSync(file), false);
  const db = new Database(file);
  db.exec('CREATE TABLE data(value); INSERT INTO data VALUES (42)');
  await db.backup(path.join(dir, 'copy.db'));
  db.close();
  const copy = new Database(path.join(dir, 'copy.db'), { readonly: true, timeout: 19 });
  try {
    assert.deepEqual(copy.prepare('SELECT * FROM data').get(), { value: 42 });
    assert.equal(copy.pragma('busy_timeout', { simple: true }), 19);
    assert.throws(() => copy.exec('DELETE FROM data'), /readonly/);
  } finally { copy.close(); }
});

test('importing SQLite consumers does not load the experimental built-in', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../src/perf.js', import.meta.url).href)}); await import(${JSON.stringify(new URL('../src/commands/docs/index.js', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite.*experimental/i);
});

test('missing FTS5 reports an actionable runtime refusal', () => {
  assert.throws(() => requireFts5({ prepare() { throw new Error('no such module: fts5'); } }), error => error.code === 'sqlite_fts5_unavailable' && /upgrade.*Node.js/i.test(error.message));
});
