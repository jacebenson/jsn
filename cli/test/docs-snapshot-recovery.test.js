import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { buildSnapshot, installSnapshot, docsSnapshotStatus } from '../src/commands/docs/snapshot.js';
import { getDocsDbPath, getDocsSourceMarkdownDir, openDocsDb, closeDocsDb } from '../src/commands/docs/db.js';
import { ingestDocs } from '../src/commands/docs/ingest.js';
import { refreshDocs } from '../src/commands/docs/refresh.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-recovery-'));
  const previous = { JSN_DATA_HOME: process.env.JSN_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.JSN_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const artifact = (name, revision, count) => {
    const docsDir = path.join(directory, name), outputDir = path.join(directory, `${name}-output`);
    fs.mkdirSync(docsDir);
    for (let index = 0; index < count; index++) fs.writeFileSync(path.join(docsDir, `${index}.md`), `${name} GlideRecord documentation ${index}.`);
    const manifest = buildSnapshot({ docsDir, outputDir, revision, artifactBaseURL: 'https://fixture.invalid/', embed: false });
    const bytes = fs.readFileSync(path.join(outputDir, path.basename(manifest.url)));
    return { docsDir, manifest, fetchFn: async () => new Response(bytes) };
  };
  const original = artifact('original', 'a'.repeat(40), 1);
  const replacement = artifact('replacement', 'b'.repeat(40), 2);
  const dbPath = getDocsDbPath();
  return { directory, dbPath, original, replacement,
    install: selected => installSnapshot({ dbPath, manifest: selected.manifest, fetchFn: selected.fetchFn }) };
}

function documentCount(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT count(*) AS n FROM docs').get().n; }
  finally { db.close(); }
}

test('a killed WAL owner leaves recoverable sidecars and a new snapshot installs successfully', async t => {
  const f = fixture(t);
  await f.install(f.original);
  const childScript = `
    import { openDocsDb } from ${JSON.stringify(new URL('../src/commands/docs/db.js', import.meta.url).href)};
    const db = openDocsDb({ dbPath: ${JSON.stringify(f.dbPath)} });
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('crash_fixture','committed')").run();
    process.send({ ready: true });
    setInterval(() => {}, 10000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
  assert.equal(message.ready, true);
  const stopped = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
  assert.ok(child.kill('SIGKILL'));
  const [, signal] = await stopped;
  assert.equal(signal, 'SIGKILL');
  assert.ok(fs.existsSync(`${f.dbPath}-wal`), 'fixture must leave a real SQLite WAL, not a fabricated sidecar');
  assert.ok(fs.existsSync(`${f.dbPath}-shm`));
  await f.install(f.replacement);
  assert.equal(documentCount(f.dbPath), 2);
  assert.equal(docsSnapshotStatus().revision, f.replacement.manifest.revision);
  assert.equal(fs.existsSync(`${f.dbPath}.install-lock`), false);
});

test('a live reader blocks replacement and keeps both its view and installed snapshot intact', async t => {
  const f = fixture(t);
  await f.install(f.original);
  const reader = openDocsDb({ dbPath: f.dbPath });
  try {
    const before = fs.readFileSync(f.dbPath);
    await assert.rejects(f.install(f.replacement), /in use/);
    assert.deepEqual(fs.readFileSync(f.dbPath), before);
    assert.equal(reader.prepare('SELECT count(*) AS n FROM docs').get().n, 1);
    assert.equal(docsSnapshotStatus().revision, f.original.manifest.revision);
  } finally { closeDocsDb(reader); }
  await f.install(f.replacement);
  assert.equal(documentCount(f.dbPath), 2);
});

test('full ingestion during an active reader never unlinks or partially replaces the old index', async t => {
  const f = fixture(t);
  await f.install(f.original);
  const reader = openDocsDb({ dbPath: f.dbPath });
  try {
    const before = fs.readFileSync(f.dbPath);
    assert.throws(() => ingestDocs({ dbPath: f.dbPath, roots: [{ dir: f.replacement.docsDir, prefix: '' }], embed: false }), /in use/);
    assert.ok(fs.existsSync(f.dbPath));
    assert.deepEqual(fs.readFileSync(f.dbPath), before);
    assert.equal(reader.prepare('SELECT count(*) AS n FROM docs').get().n, 1);
    assert.equal(docsSnapshotStatus().revision, f.original.manifest.revision);
  } finally { closeDocsDb(reader); }
  assert.equal(documentCount(f.dbPath), 1);
});

test('snapshot-only refresh with no raw clone preserves the index and points to explicit installation', async t => {
  const f = fixture(t);
  await f.install(f.original);
  assert.equal(fs.existsSync(getDocsSourceMarkdownDir()), false);
  assert.throws(() => refreshDocs({ dbPath: f.dbPath }), error => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /source is missing/);
    assert.match(error.hint, /docs install --source snapshot/);
    assert.match(error.hint, /--source github/);
    return true;
  });
  assert.equal(documentCount(f.dbPath), 1);
  assert.equal(docsSnapshotStatus().revision, f.original.manifest.revision);
});

test('a stale existing raw clone cannot rewind a snapshot-backed index through refresh', async t => {
  const f = fixture(t);
  await f.install(f.original);
  const raw = getDocsSourceMarkdownDir();
  fs.mkdirSync(raw, { recursive: true });
  fs.writeFileSync(path.join(raw, 'stale.md'), 'Stale raw documentation that must not replace the snapshot.');
  assert.throws(() => refreshDocs({ dbPath: f.dbPath }), error => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /snapshot.*unrelated raw clone/);
    assert.match(error.hint, /docs install --source snapshot/);
    assert.match(error.hint, /docs sync/);
    return true;
  });
  const db = new Database(f.dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT body FROM docs').all();
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /original GlideRecord/);
    assert.doesNotMatch(rows[0].body, /Stale raw/);
  } finally { db.close(); }
  assert.equal(docsSnapshotStatus().revision, f.original.manifest.revision);
});

test('snapshot status rejects a receipt from a different database revision without changing the index', async t => {
  const f = fixture(t);
  await f.install(f.original);
  assert.equal(docsSnapshotStatus().revision, f.original.manifest.revision);
  const receiptPath = `${f.dbPath}.snapshot.json`;
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, revision: f.replacement.manifest.revision }));
  assert.equal(docsSnapshotStatus(), null);
  assert.equal(documentCount(f.dbPath), 1);
});
