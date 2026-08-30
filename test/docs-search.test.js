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
