import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, installSnapshot, rollbackSnapshot, validateManifest } from '../src/commands/docs/snapshot.js';
import { refreshDocs } from '../src/commands/docs/refresh.js';
import { searchDocs } from '../src/commands/docs/search.js';
import { openDocsDb, closeDocsDb } from '../src/commands/docs/db.js';

test('centrally built snapshot searches identically, rejects corruption, preserves rollback and active readers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-snapshot-'));
  const docs = path.join(directory, 'markdown'), output = path.join(directory, 'artifacts'), dbPath = path.join(directory, 'installed.db');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'record.md'), '---\ntitle: GlideRecord\n---\nGlideRecord documentation supports database queries.');
  try {
    const manifest = buildSnapshot({ docsDir: docs, outputDir: output, revision: 'abcdef012345', artifactBaseURL: 'https://artifacts.example.test/' });
    const bytes = fs.readFileSync(path.join(output, path.basename(manifest.url)));
    const fetchFn = async () => new Response(bytes);
    await installSnapshot({ manifest, dbPath, fetchFn });
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 1);
    const good = fs.readFileSync(dbPath);
    assert.throws(() => refreshDocs({ dbPath, roots: [{ dir: path.join(directory, 'missing-source'), prefix: '' }] }), /source is missing/);
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 1);
    await assert.rejects(installSnapshot({ manifest, dbPath, fetchFn: async () => new Response(Buffer.from('interrupted')) }), /checksum|size/);
    assert.deepEqual(fs.readFileSync(dbPath), good);
    assert.throws(() => validateManifest({ ...manifest, schema: 99 }), /Incompatible/);
    assert.throws(() => validateManifest({ ...manifest, url: 'http://unsafe.example.test/file' }), /HTTPS/);
    const active = openDocsDb({ dbPath });
    try { await assert.rejects(installSnapshot({ manifest, dbPath, fetchFn }), /in use/); }
    finally { closeDocsDb(active); }
    await installSnapshot({ manifest, dbPath, fetchFn });
    rollbackSnapshot(dbPath);
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 1);
    assert.equal(fs.existsSync(dbPath + '.install-lock'), false);
    fs.writeFileSync(path.join(docs, 'record.md'), 'changed');
    assert.throws(() => buildSnapshot({ docsDir: docs, outputDir: output, revision: manifest.revision, artifactBaseURL: 'https://artifacts.example.test/' }), /Immutable/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))).sha256, manifest.sha256);
    fs.writeFileSync(path.join(docs, 'record.md'), 'GlideRecord documentation for version two.');
    fs.writeFileSync(path.join(docs, 'second.md'), 'GlideRecord documentation for a second page.');
    const newer = buildSnapshot({ docsDir: docs, outputDir: output, revision: 'abcdef987654', artifactBaseURL: 'https://artifacts.example.test/' });
    const newBytes = fs.readFileSync(path.join(output, path.basename(newer.url)));
    await assert.rejects(installSnapshot({ manifest: newer, dbPath, fetchFn: async () => { throw new Error('offline interruption'); } }), /offline interruption/);
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 1);
    await installSnapshot({ manifest: newer, dbPath, fetchFn: async () => new Response(newBytes) });
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 2);
    rollbackSnapshot(dbPath);
    assert.equal(searchDocs({ dbPath, query: 'GlideRecord' }).count, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy source selection skips safely and hosted search reports an offline service', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-choice-'));
  const preload = path.join(directory, 'offline.mjs');
  fs.writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('unexpected network'); };\n");
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, JSN_DATA_HOME: directory,
    JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args, '--json'], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
  try {
    for (const args of [['docs', 'install', '--source', 'skip'], ['setup', '--docs-source', 'skip']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).data.skipped, true);
    }
    const result = run(['docs', 'search', 'GlideRecord']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Could not reach the documentation service/);
    assert.doesNotMatch(result.stdout + result.stderr, /unexpected network/);
    assert.equal(fs.existsSync(path.join(directory, 'docs', 'docs.db')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
