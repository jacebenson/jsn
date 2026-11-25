// Offline cross-platform acceptance against real docs and perf entry points.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestDocs } from '../src/commands/docs/ingest.js';
import { searchDocs } from '../src/commands/docs/search.js';
import { DocumentationIndex } from '../src/commands/docs/index.js';
import { buildSnapshot, installSnapshot, validateDatabase } from '../src/commands/docs/snapshot.js';
import { publishServiceSnapshot } from '../src/commands/docs/service-snapshot.js';
import { captureRun, getRun, compareRuns, listRuns } from '../src/perf.js';
import Database from '../src/sqlite.js';

function sdk(count) {
  return { async list() { return []; }, async get() { return null; }, async aggregate() { return { groups: [] }; }, async aggregateCount(table) { return table === 'incident' ? count : 0; } };
}
test('real docs ingestion, keyword/prefix/BM25, hybrid, service backup and snapshot download', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-sqlite-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'glide.md'), '---\ntitle: GlideRecord\nbundle: api\n---\nGlideRecord documentation queries records.');
  fs.writeFileSync(path.join(source, 'other.md'), '---\ntitle: Other reference\nbundle: api\n---\nDocumentation about another unrelated topic.');
  const dbPath = path.join(dir, 'docs.sqlite3');
  assert.equal(ingestDocs({ dbPath, roots: [{ dir: source }] }).count, 2);
  const prefix = searchDocs({ dbPath, query: 'Glide*', mode: 'keyword' });
  assert.equal(prefix.total, 1); assert.equal(prefix.results[0].title, 'GlideRecord');
  assert.equal(typeof prefix.results[0].score, 'number');
  assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).mode, 'hybrid');
  const db = new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('source_revision',?)").run('a'.repeat(40)); db.close();
  const index = new DocumentationIndex(dir);
  try { assert.equal(index.search({ query: 'GlideRecord' }).total, 1); assert.equal(index.document({ path: 'glide.md' }).title, 'GlideRecord'); }
  finally { index.close(); }
  const published = await publishServiceSnapshot(dir);
  const publishedBytes = fs.readFileSync(path.join(dir, 'snapshots', path.basename(published.url)));
  const installed = path.join(dir, 'download.db');
  await installSnapshot({ dbPath: installed, manifest: published, fetchFn: async () => new Response(publishedBytes) });
  assert.equal(validateDatabase(installed), 2);
  assert.equal(searchDocs({ dbPath: installed, query: 'Glide*', mode: 'keyword' }).total, 1);
  const manifest = buildSnapshot({ docsDir: source, outputDir: path.join(dir, 'built'), revision: 'b'.repeat(40), artifactBaseURL: 'https://fixture.invalid/' });
  assert.equal(manifest.documents, 2);
  const probe = new Database(':memory:');
  const sqliteVersion = probe.prepare('SELECT sqlite_version() AS version').get().version;
  probe.close();
  console.log(JSON.stringify({ platform: process.platform, node: process.version, sqlite: sqliteVersion, docs: 'ingest, MATCH, prefix, BM25, hybrid, readonly website index, service backup, snapshot install' }));
});

test('real perf capture persists, reopens, compares and JSON-exports synthetic snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-sqlite-perf-'));
  const previous = process.env.JSN_DATA_HOME; process.env.JSN_DATA_HOME = dir;
  t.after(() => { if (previous === undefined) delete process.env.JSN_DATA_HOME; else process.env.JSN_DATA_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const first = await captureRun({ sdk: sdk(7), instance: 'https://fixture.invalid', label: 'before' });
  const second = await captureRun({ sdk: sdk(9), instance: 'https://fixture.invalid', label: 'after' });
  assert.deepEqual(getRun(first.run_id), first);
  assert.equal(listRuns().length, 2);
  const comparison = compareRuns(getRun(first.run_id), getRun(second.run_id));
  assert.equal(comparison.status, 'complete');
  assert.ok(comparison.metrics.some(metric => metric.baseline === 7 && metric.new === 9 && metric.delta === 2));
  const exported = path.join(dir, 'export.json'); fs.writeFileSync(exported, JSON.stringify(getRun(first.run_id)));
  assert.deepEqual(JSON.parse(fs.readFileSync(exported)), first);
});

// An optional pre-migration artifact is supplied by the verification harness.
// It is produced by the unchanged base's better-sqlite3 buildSnapshot, not by
// this adapter, and travels unchanged between Linux and native Windows.
test('pre-migration schema-1 snapshot remains readable and searchable', { skip: !process.env.JSN_SQLITE_LEGACY_FIXTURE }, async t => {
  const fixture = process.env.JSN_SQLITE_LEGACY_FIXTURE;
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-sqlite-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'docs.db');
  const bytes = fs.readFileSync(path.join(fixture, path.basename(manifest.url)));
  await installSnapshot({ dbPath, manifest, fetchFn: async () => new Response(bytes) });
  assert.equal(validateDatabase(dbPath), 2);
  assert.equal(searchDocs({ dbPath, query: 'Glide*', mode: 'keyword' }).total, 1);
  assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).mode, 'hybrid');
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'perf-expected.json')));
  const perfPath = path.join(dir, 'perf.db');
  fs.copyFileSync(path.join(fixture, 'perf', 'perf.db'), perfPath);
  const perfDb = new Database(perfPath, { readonly: true });
  try {
    const restored = getRun(expected.run_id, perfDb);
    assert.deepEqual(restored, expected);
    assert.equal(compareRuns(expected, restored).status, 'complete');
    assert.ok(compareRuns(expected, restored).metrics.every(metric => metric.delta === 0));
  } finally { perfDb.close(); }
});
