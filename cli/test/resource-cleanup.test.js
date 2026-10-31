import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDocsDb } from '../src/commands/docs/db.js';

function database(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-cleanup-'));
  const previous = process.env.JSN_DATA_HOME;
  process.env.JSN_DATA_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.JSN_DATA_HOME;
    else process.env.JSN_DATA_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { dbPath: path.join(directory, 'test.db') };
}

test('docs connection closes after success and preserves the operation result', (t) => {
  const options = database(t);
  let connection;
  const result = withDocsDb(options, (db) => {
    connection = db;
    db.exec('CREATE TABLE items (name TEXT)');
    return { count: 0 };
  });
  assert.deepEqual(result, { count: 0 });
  assert.equal(connection.open, false);
});

test('docs failure rolls back unfinished writes, closes the connection and preserves the error', (t) => {
  const options = database(t);
  withDocsDb(options, (db) => db.exec('CREATE TABLE items (name TEXT)'));
  let connection;
  const failure = new Error('original failure');
  assert.throws(() => withDocsDb(options, (db) => {
    connection = db;
    db.exec("BEGIN; INSERT INTO items VALUES ('uncommitted')");
    throw failure;
  }), (error) => error === failure);
  assert.equal(connection.open, false);
  assert.equal(withDocsDb(options, (db) => db.prepare('SELECT COUNT(*) AS n FROM items').get().n), 0);
});
