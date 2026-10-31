import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Docs search — bundle filter (regression)', () => {
  const INTEG = process.env.JSN_INTEGRATION_TESTS === 'true';

  it('should not crash when filtering by bundle', { skip: !INTEG }, async () => {
    const { searchDocs } = await import('../src/commands/docs/search.js');
    const { docsDbExists } = await import('../src/commands/docs/db.js');
    if (!docsDbExists()) return;
    const result = searchDocs({ query: 'knowledge', mode: 'keyword', bundle: 'community', limit: 5 });
    assert.ok(Array.isArray(result.results));
    assert.ok(result.total >= 0);
  });
});

describe('Docs search — punctuation in queries (regression #385)', () => {
  let dbPath;

  async function makeDb() {
    const { mkdtempSync: mkdtemp } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const tmpDir = mkdtemp(path.join(tmpdir(), 'jsn-docs-fts-'));
    tempRoots.push(tmpDir);
    dbPath = path.join(tmpDir, 'docs.db');

    const { openDocsDb, closeDocsDb, initDocsSchema } = await import('../src/commands/docs/db.js');
    const db = openDocsDb({ dbPath });
    initDocsSchema(db);
    const insert = db.prepare(
      `INSERT INTO docs (path, title, release, bundle, doc_type, locale, frontmatter, body)
       VALUES (@path, @title, 'x', 'bundle-a', 'docs', 'en', '{}', @body)`
    );
    insert.run({
      path: 'markdown/plugin/itsm-roles.md',
      title: 'Request ITSM Roles',
      body: 'Install the plugin com.snc.itsm.roles to delegate problem management roles.',
    });
    insert.run({
      path: 'markdown/security/escape-jelly.md',
      title: 'Escape jelly script',
      body: 'Set glide.ui.escape_all_script so jelly output escapes script tags.',
    });
    insert.run({
      path: 'markdown/change/states.md',
      title: 'Change Management states',
      body: 'Change-management states move through the change-management process.',
    });
    closeDocsDb(db);
  }

  it('sanitizes FTS5 syntax characters while keeping operators and prefixes', async () => {
    const { sanitizeFts5Query } = await import('../src/commands/docs/fts.js');

    assert.equal(sanitizeFts5Query('com.snc.itsm.roles'), '"com.snc.itsm.roles"');
    assert.equal(sanitizeFts5Query('change management com.snc.itsm.roles'), 'change management "com.snc.itsm.roles"');
    assert.equal(sanitizeFts5Query('change-management'), '"change-management"');
    assert.equal(sanitizeFts5Query('cmdb:ci'), '"cmdb:ci"');
    assert.equal(sanitizeFts5Query('com.snc.*'), '"com.snc."*');
    assert.equal(sanitizeFts5Query('knowledge*'), 'knowledge*');
    assert.equal(sanitizeFts5Query('"change management"'), '"change management"');
    assert.equal(sanitizeFts5Query('title:knowledge'), 'title: knowledge');
    assert.equal(sanitizeFts5Query('knowledge AND incident'), 'knowledge AND incident');
    assert.equal(sanitizeFts5Query('knowledge AND NOT incident'), 'knowledge NOT incident');
    assert.equal(sanitizeFts5Query('product AND'), 'product');
    assert.equal(sanitizeFts5Query('"unbalanced change'), '"unbalanced change"');
    assert.equal(sanitizeFts5Query('*'), '');
    assert.equal(sanitizeFts5Query(''), '');
  });

  it('searches dotted, hyphenated and punctuated identifiers instead of throwing', async () => {
    await makeDb();
    const { searchDocs } = await import('../src/commands/docs/search.js');

    const dotted = searchDocs({ query: 'com.snc.itsm.roles', dbPath, mode: 'keyword' });
    assert.equal(dotted.total, 1);
    assert.equal(dotted.results[0].title, 'Request ITSM Roles');

    const mixed = searchDocs({ query: 'roles com.snc.itsm.roles', dbPath, mode: 'keyword' });
    assert.equal(mixed.total, 1);

    const hyphen = searchDocs({ query: 'change-management', dbPath, mode: 'keyword' });
    assert.equal(hyphen.total, 1);
    assert.equal(hyphen.results[0].title, 'Change Management states');

    const dottedPreference = searchDocs({ query: 'glide.ui.escape_all_script', dbPath, mode: 'hybrid' });
    assert.equal(dottedPreference.total, 1);
    assert.equal(dottedPreference.results[0].title, 'Escape jelly script');
  });

  it('returns no results for punctuation-only queries and keeps boolean operators working', async () => {
    await makeDb();
    const { searchDocs } = await import('../src/commands/docs/search.js');

    const punctuationOnly = searchDocs({ query: '*', dbPath, mode: 'keyword' });
    assert.deepEqual(punctuationOnly, { query: '*', mode: 'keyword', total: 0, count: 0, results: [] });

    const both = searchDocs({ query: 'plugin AND roles', dbPath, mode: 'keyword' });
    assert.equal(both.total, 1);

    const excluded = searchDocs({ query: 'plugin NOT escape', dbPath, mode: 'keyword' });
    assert.equal(excluded.total, 1);
    assert.equal(excluded.results[0].title, 'Request ITSM Roles');
  });

  it('finds a doc by dotted identifier in the docs show fallback', async () => {
    await makeDb();
    const { getDocByIdOrPath } = await import('../src/commands/docs/search.js');
    const doc = getDocByIdOrPath('com.snc.itsm.roles', { dbPath });
    assert.ok(doc, 'dotted identifier should resolve through the FTS fallback');
    assert.equal(doc.path, 'markdown/plugin/itsm-roles.md');
  });
});

describe('Docs show — id/path/FTS fallback (temp DB)', () => {
  it('finds docs by numeric id, path substring, then FTS match', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-docs-test-'));
    tempRoots.push(tmpDir);
    const dbPath = path.join(tmpDir, 'docs.db');

    const { openDocsDb, closeDocsDb, initDocsSchema } = await import('../src/commands/docs/db.js');
    const { getDocByIdOrPath } = await import('../src/commands/docs/search.js');

    const db = openDocsDb({ dbPath });
    initDocsSchema(db);
    const insert = db.prepare(
      `INSERT INTO docs (path, title, release, bundle, doc_type, locale, frontmatter, body)
       VALUES (@path, @title, 'x', 'bundle-a', 'docs', 'en', '{}', @body)`
    );
    insert.run({ path: 'markdown/alpha/widget.md', title: 'Widget Guide', body: 'How to configure the widget frobnicate lever.' });
    insert.run({ path: 'markdown/beta/gadget.md', title: 'Gadget Guide', body: 'The gadget supports zymurgy workflows.' });
    closeDocsDb(db);

    // 1. Numeric id hits the primary key directly.
    const byId = getDocByIdOrPath('1', { dbPath });
    assert.ok(byId, 'id lookup should find doc 1');
    assert.strictEqual(byId.path, 'markdown/alpha/widget.md');

    // 2. Non-numeric falls back to path substring (LIKE %...%).
    const byPath = getDocByIdOrPath('beta/gadget', { dbPath });
    assert.ok(byPath, 'path LIKE fallback should find the gadget doc');
    assert.strictEqual(byPath.title, 'Gadget Guide');

    // 3. No path match → FTS match against title/body.
    const byFts = getDocByIdOrPath('zymurgy', { dbPath });
    assert.ok(byFts, 'FTS fallback should match body text');
    assert.strictEqual(byFts.path, 'markdown/beta/gadget.md');

    // 4. Nothing matches → undefined (handler turns that into not_found).
    const missing = getDocByIdOrPath('nonexistentterm', { dbPath });
    assert.strictEqual(missing, undefined);
  });
});
