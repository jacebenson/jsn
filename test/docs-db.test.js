import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { rmSync } from 'node:fs';
import { getDocsDbPath, getDocsSourceDir, getDocsSourceMarkdownDir } from '../src/commands/docs/db.js';

describe('Docs DB paths', () => {
  it('should resolve docs DB path under the JSN data home', () => {
    const dbPath = getDocsDbPath();
    assert.ok(dbPath.endsWith('.jsn/docs/docs.db'));
  });

  it('should resolve source markdown dir under source dir', () => {
    const src = getDocsSourceDir();
    const md = getDocsSourceMarkdownDir();
    assert.ok(md.startsWith(src));
    assert.ok(md.endsWith('/markdown'));
  });
});

describe('Docs data migration', () => {
  const originalDataHome = process.env.JSN_DATA_HOME;
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  const tempRoots = [];

  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.JSN_DATA_HOME;
    else process.env.JSN_DATA_HOME = originalDataHome;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('keeps fresh installs in the new data root', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-docs-fresh-'));
    tempRoots.push(root);
    process.env.JSN_DATA_HOME = path.join(root, 'data');
    process.env.XDG_CACHE_HOME = path.join(root, 'cache');

    assert.strictEqual(getDocsDbPath(), path.join(root, 'data', 'docs', 'docs.db'));
    assert.ok(!fs.existsSync(path.join(root, 'cache', 'servicenow-cli', 'docs')));
  });

  it('migrates the database and source directories once', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-docs-migrate-'));
    tempRoots.push(root);
    const legacy = path.join(root, 'cache', 'servicenow-cli', 'docs');
    process.env.JSN_DATA_HOME = path.join(root, 'data');
    process.env.XDG_CACHE_HOME = path.join(root, 'cache');
    mkdirSync(path.join(legacy, 'source', 'markdown'), { recursive: true });
    mkdirSync(path.join(legacy, 'community'), { recursive: true });
    writeFileSync(path.join(legacy, 'docs.db'), 'database');
    writeFileSync(path.join(legacy, 'source', 'markdown', 'guide.md'), '# Guide');

    assert.strictEqual(getDocsDbPath(), path.join(root, 'data', 'docs', 'docs.db'));
    assert.strictEqual(fs.readFileSync(path.join(root, 'data', 'docs', 'source', 'markdown', 'guide.md'), 'utf8'), '# Guide');
    assert.ok(!fs.existsSync(legacy));
    assert.strictEqual(getDocsDbPath(), path.join(root, 'data', 'docs', 'docs.db'));
  });

  it('leaves legacy data intact when migration cannot complete', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-docs-failed-migrate-'));
    tempRoots.push(root);
    const legacy = path.join(root, 'cache', 'servicenow-cli', 'docs');
    const destination = path.join(root, 'data', 'docs');
    process.env.JSN_DATA_HOME = path.join(root, 'data');
    process.env.XDG_CACHE_HOME = path.join(root, 'cache');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(path.join(legacy, 'source'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    mkdirSync(path.join(destination, 'source'), { recursive: true });
    writeFileSync(path.join(legacy, 'docs.db'), 'database');

    assert.throws(() => getDocsDbPath(), /destination already exists/);
    assert.strictEqual(fs.readFileSync(path.join(legacy, 'docs.db'), 'utf8'), 'database');
  });
});

describe('Docs index statistics (temp DB)', () => {
  it('aggregates documents, bundles, doc types, embedding coverage, synced_at', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-docs-stats-'));
    const dbPath = path.join(tmpDir, 'docs.db');

    const { openDocsDb, closeDocsDb, initDocsSchema, setMeta } = await import('../src/commands/docs/db.js');
    const { getDocsIndexStats } = await import('../src/commands/docs/db.js');

    const db = openDocsDb({ dbPath });
    try {
      initDocsSchema(db);
      setMeta(db, 'synced_at', '1700000000000');
      db.prepare(
        `INSERT INTO docs (path, title, bundle, doc_type, frontmatter, body, hrr_vector)
         VALUES ('a.md', 'A', 'b1', 'docs', '{}', 'alpha body', x'00')`
      ).run();
      db.prepare(
        `INSERT INTO docs (path, title, bundle, doc_type, frontmatter, body)
         VALUES ('b.md', 'B', 'b2', 'community', '{}', 'beta body')`
      ).run();

      const stats = getDocsIndexStats(db);
      assert.strictEqual(stats.documents, 2);
      assert.strictEqual(stats.bundles, 2);
      assert.strictEqual(stats.docTypes, 2);
      assert.strictEqual(stats.embeddedCount, 1);
      assert.strictEqual(stats.syncedAt, '1700000000000');
    } finally {
      closeDocsDb(db);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
