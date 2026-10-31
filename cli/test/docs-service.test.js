import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentationIndex } from '../src/commands/docs/index.js';
import { syncDocumentation } from '../src/commands/docs/sync-service.js';
import { startDocumentationServer } from '../src/commands/docs/server.js';
import { ensureLocalDocumentation, documentationService } from '../src/commands/docs/local.js';
import { searchHostedDocs, getHostedDoc } from '../src/commands/docs/client.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-service-'));
  t.after(async () => {
    // Windows cannot remove the daemon's open log files until it exits.
    let pid;
    try { pid = JSON.parse(fs.readFileSync(path.join(root, 'service/server.json'), 'utf8')).pid; } catch { /* no daemon */ }
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* stopped */ }
      for (let attempt = 0; attempt < 40; attempt++) {
        try { process.kill(pid, 0); await delay(50); } catch { break; }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'upstream'), storage = path.join(root, 'service');
  fs.mkdirSync(path.join(source, 'markdown', 'api-reference'), { recursive: true });
  fs.writeFileSync(path.join(source, 'markdown/api-reference/GlideRecord.md'), '---\ntitle: GlideRecord\ndescription: Query **records** with the server API.\nproduct: Server APIs\n---\n# GlideRecord\n\nA useful reference for querying and updating records using the server API.\n');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '-b', 'australia'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  return { source, storage };
}
test('shared HTTP engine preserves search, exact paths, literal operators and revisions', async t => {
  const f = fixture(t); await syncDocumentation(f);
  const index = new DocumentationIndex(f.storage);
  try {
    assert.equal(index.search({ query: 'GlideRecord' }).results[0].summary, 'Query records with the server API.');
    assert.equal(index.search({ query: 'GlideRecord OR missing' }).count, 0);
    assert.throws(() => index.search({ query: '***' }), error => error.status === 400);
    assert.throws(() => index.document({ path: 'GlideRecord' }), error => error.status === 404);
  } finally { index.close(); }
  const { server, url } = await startDocumentationServer({ storage: f.storage, refresh: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await searchHostedDocs({ serviceUrl: url, query: 'GlideRecord' });
  assert.equal(result.count, 1); assert.equal(result.results[0].category, 'Server APIs');
  const doc = await getHostedDoc(result.results[0].path, { serviceUrl: url, revision: result.revision });
  assert.match(doc.body, /useful reference/);
  await assert.rejects(getHostedDoc(String(doc.id), { serviceUrl: url, revision: 'outdated' }), error => error.status === 409);
  assert.equal((await fetch(new URL('api/docs/search?q=x&limit=0', url))).status, 400);
});
test('managed local service starts once under concurrency and restarts when stopped', async t => {
  const f = fixture(t); await syncDocumentation(f);
  const [first, second] = await Promise.all([ensureLocalDocumentation(f), ensureLocalDocumentation(f)]);
  const pids = new Set([first.pid, second.pid]);
  t.after(async () => { for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* stopped */ } } await delay(200); });
  assert.equal(first.pid, second.pid);
  assert.equal((await searchHostedDocs({ query: 'GlideRecord', serviceUrl: first.url })).count, 1);
  process.kill(first.pid, 'SIGTERM'); await delay(200);
  const restarted = await ensureLocalDocumentation(f); pids.add(restarted.pid);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal((await searchHostedDocs({ query: 'GlideRecord', serviceUrl: restarted.url })).count, 1);
});
test('explicit endpoint overrides local mode without starting its server', async () => {
  const saved = process.env.JSN_DOCS_URL; process.env.JSN_DOCS_URL = 'https://example.test/docs';
  try { assert.equal(await documentationService({ docs: { source: 'local' } }), 'https://example.test/docs/'); }
  finally { if (saved === undefined) delete process.env.JSN_DOCS_URL; else process.env.JSN_DOCS_URL = saved; }
});

test('fresh service downloads a snapshot, skips cloning at the same revision, then updates from Git', async t => {
  const f = fixture(t);
  await syncDocumentation(f);
  const snapshots = path.join(f.storage, 'snapshots');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshots, 'manifest.json')));
  const artifact = fs.readFileSync(path.join(snapshots, path.basename(manifest.url)));
  const target = path.join(f.storage, '../downloaded');
  let downloads = 0;
  const options = { source: f.source, storage: target, manifestURL: 'https://fixture.test/manifest.json',
    fetchFn: async url => { downloads++; return new Response(String(url).endsWith('manifest.json') ? JSON.stringify(manifest) : artifact); } };
  const seeded = await syncDocumentation(options);
  assert.equal(seeded.revision, manifest.revision);
  assert.equal(downloads, 2);
  assert.equal(fs.existsSync(path.join(target, 'source')), false, 'unchanged Git revision needs no checkout');
  fs.writeFileSync(path.join(f.source, 'markdown/added.md'), '---\ntitle: New reference\n---\nNew documentation from GitHub.');
  const git = (...args) => execFileSync('git', ['-C', f.source, ...args], { stdio: 'pipe' });
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'update');
  const updated = await syncDocumentation(options);
  assert.notEqual(updated.revision, manifest.revision);
  assert.equal(updated.documents, 2);
  assert.equal(downloads, 2, 'subsequent updates never download the hosted seed');
  const index = new DocumentationIndex(target);
  try { assert.match(index.document({ path: 'added.md' }).body, /GitHub/); } finally { index.close(); }
  const lastGood = fs.readFileSync(path.join(target, 'docs.sqlite3'));
  fs.rmSync(f.source, { recursive: true });
  await assert.rejects(syncDocumentation(options));
  assert.deepEqual(fs.readFileSync(path.join(target, 'docs.sqlite3')), lastGood);
});
test('corrupt bootstrap falls back to Git without publishing the downloaded bytes', async t => {
  const f = fixture(t);
  await syncDocumentation(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.storage, 'snapshots/manifest.json')));
  const target = path.join(f.storage, '../fallback');
  const result = await syncDocumentation({ source: f.source, storage: target, manifestURL: 'https://fixture.test/manifest.json',
    fetchFn: async url => new Response(String(url).endsWith('manifest.json') ? JSON.stringify(manifest) : 'corrupt') });
  assert.equal(result.state, 'ready');
  assert.equal(result.documents, 1);
  assert.equal(fs.existsSync(path.join(target, 'source/.git')), true);
});
