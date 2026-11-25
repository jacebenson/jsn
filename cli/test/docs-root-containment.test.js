import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestDocs } from '../src/commands/docs/ingest.js';
import { refreshDocs } from '../src/commands/docs/refresh.js';
import { buildSnapshot, installSnapshot } from '../src/commands/docs/snapshot.js';
import { withDocsDb } from '../src/commands/docs/db.js';
import { syncDocumentation } from '../src/commands/docs/sync-service.js';
import { execFileSync } from 'node:child_process';

const rows = dbPath => withDocsDb({ dbPath }, db => db.prepare('SELECT path, body FROM docs ORDER BY path').all());
function fixture(t) {
  // Canonicalize the OS temp directory itself (e.g. platform-owned /var aliases).
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jsn-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const docs = path.join(base, 'source', 'markdown'), outside = path.join(base, 'outside');
  fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(docs, 'good.md'), '# Good\nPublic documentation.');
  fs.writeFileSync(path.join(outside, 'private.md'), '# Private\nSYNTHETIC_OUTSIDE_NOTE');
  return { base, docs, outside };
}
function link(t, target, destination, type = 'dir') {
  try { fs.symlinkSync(target, destination, process.platform === 'win32' && type === 'dir' ? 'junction' : type); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Filesystem cannot create ${type} links: ${error.code}`); return false;
    }
    throw error;
  }
  return true;
}

for (const alias of ['root', 'ancestor', 'inside-root', 'dangling']) {
  test(`${alias} source alias cannot replace an index or publish a snapshot`, async t => {
    const { base, docs, outside } = fixture(t);
    const dbPath = path.join(base, 'live.db'), outputDir = path.join(base, 'artifacts');
    const build = docsDir => buildSnapshot({ docsDir, outputDir, revision: 'abcdef012345', artifactBaseURL: 'https://example.test/', embed: false });
    ingestDocs({ dbPath, roots: [{ dir: docs }], embed: false });
    const expected = rows(dbPath);
    const manifest = build(docs);
    const artifacts = new Map(fs.readdirSync(outputDir).map(name => [name, fs.readFileSync(path.join(outputDir, name))]));
    let invalid;
    if (alias === 'ancestor') {
      invalid = path.join(base, 'alias', 'markdown');
      if (!link(t, path.dirname(docs), path.dirname(invalid))) return;
    } else {
      invalid = path.join(base, 'alias');
      const target = alias === 'inside-root' ? docs : alias === 'dangling' ? path.join(base, 'absent') : outside;
      if (!link(t, target, invalid)) return;
    }
    for (const ingest of [ingestDocs, refreshDocs]) {
      assert.throws(() => ingest({ dbPath, roots: [{ dir: invalid }], embed: false }), /source.*(symlink|symbolic|alias)/i);
      assert.deepEqual(rows(dbPath), expected);
    }
    assert.throws(() => build(invalid), /source.*(symlink|symbolic|alias)/i);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), [...artifacts.keys()].sort());
    for (const [name, bytes] of artifacts) assert.deepEqual(fs.readFileSync(path.join(outputDir, name)), bytes);
    const installed = path.join(base, 'installed.db');
    await installSnapshot({ dbPath: installed, manifest, fetchFn: async () => new Response(artifacts.get(path.basename(manifest.url))) });
    assert.deepEqual(rows(installed), expected);
  });
}

test('default root selection rejects an aliased community root without replacing good content', t => {
  const { base, docs, outside } = fixture(t);
  const communityDir = path.join(base, 'community');
  if (!link(t, outside, communityDir)) return;
  const dbPath = path.join(base, 'live.db');
  ingestDocs({ dbPath, roots: [{ dir: docs }], embed: false });
  const expected = rows(dbPath);
  assert.throws(() => ingestDocs({ dbPath, docsDir: docs, communityDir, sourceResource: path.dirname(docs), embed: false }), /source.*(symlink|symbolic|alias)/i);
  assert.deepEqual(rows(dbPath), expected);
});

test('snapshot entry point rejects an outside alias before creating any public artifact', t => {
  const { base, outside } = fixture(t);
  const alias = path.join(base, 'alias');
  if (!link(t, outside, alias)) return;
  const outputDir = path.join(base, 'artifacts');
  assert.throws(() => buildSnapshot({ docsDir: alias, outputDir, revision: 'abcdef012345', artifactBaseURL: 'https://example.test/', embed: false }), /source.*(symlink|symbolic|alias)/i);
  assert.deepEqual(fs.readdirSync(outputDir), []);
});

test('service sync rejects source aliases and retains its last published index and artifacts', async t => {
  const { base, docs, outside } = fixture(t);
  const source = path.dirname(docs), storage = path.join(base, 'service');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '-b', 'australia'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  await syncDocumentation({ source, storage });
  const dbPath = path.join(storage, 'docs.sqlite3'), expected = rows(dbPath);
  const artifactDir = path.join(storage, 'snapshots');
  const before = new Map(fs.readdirSync(artifactDir).map(name => [name, fs.readFileSync(path.join(artifactDir, name))]));
  const markdown = path.join(storage, 'source', 'markdown');
  fs.renameSync(markdown, markdown + '-real');
  if (!link(t, outside, markdown)) return;
  await assert.rejects(syncDocumentation({ source, storage, force: true }), /source.*(symlink|symbolic|alias)/i);
  assert.deepEqual(rows(dbPath), expected);
  assert.deepEqual(fs.readdirSync(artifactDir).sort(), [...before.keys()].sort());
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(artifactDir, name)), bytes);
  assert.equal(fs.readFileSync(path.join(outside, 'private.md'), 'utf8'), '# Private\nSYNTHETIC_OUTSIDE_NOTE');
});

test('real roots, normalized paths, and nested links keep only authorized Markdown', async t => {
  const { base, docs, outside } = fixture(t);
  if (!link(t, outside, path.join(docs, 'external'))) return;
  if (!link(t, path.join(outside, 'private.md'), path.join(docs, 'linked.md'), 'file')) return;
  const dbPath = path.join(base, 'live.db');
  const normalized = path.join(docs, '..', 'markdown') + path.sep;
  const result = ingestDocs({ dbPath, roots: [{ dir: normalized }], embed: false });
  assert.equal(result.count, 1);
  assert.deepEqual(rows(dbPath), [{ path: 'good.md', body: '# Good\nPublic documentation.' }]);
  const outputDir = path.join(base, 'artifacts');
  const manifest = buildSnapshot({ docsDir: normalized, outputDir, revision: 'abcdef012345', artifactBaseURL: 'https://example.test/', embed: false });
  await installSnapshot({ dbPath: path.join(base, 'copy.db'), manifest, fetchFn: async () => new Response(fs.readFileSync(path.join(outputDir, path.basename(manifest.url)))) });
  assert.deepEqual(rows(path.join(base, 'copy.db')), rows(dbPath));
});
