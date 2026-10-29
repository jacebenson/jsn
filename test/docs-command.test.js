import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docsCmd } from '../src/commands/docs/docs.js';
import { closeDocsDb, initDocsSchema, openDocsDb } from '../src/commands/docs/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function fakeWrap(handler) {
  return async (...args) => handler(...args);
}

describe('Docs Command', () => {
  it('should define docs command with correct properties', () => {
    const cmd = docsCmd(fakeWrap);
    assert.strictEqual(cmd.command, 'docs [subcommand]');
    assert.strictEqual(typeof cmd.describe, 'string');
    assert.strictEqual(typeof cmd.builder, 'function');
    assert.strictEqual(typeof cmd.handler, 'function');
  });

  it('should define sync, status, search, serve, embed, refresh subcommands', () => {
    const cmd = docsCmd(fakeWrap);
    const yargs = {
      command: (c) => {
        yargs.commands.push(typeof c === 'function' ? c(fakeWrap) : c);
        return yargs;
      },
      commands: [],
    };
    cmd.builder(yargs);
    const names = yargs.commands.map((c) => c.command || c);
    assert.ok(names.some((n) => n.toString().startsWith('sync')));
    assert.ok(names.some((n) => n.toString().startsWith('status')));
    assert.ok(names.some((n) => n.toString().startsWith('search')));
    assert.ok(names.some((n) => n.toString().startsWith('serve')));
    assert.ok(names.some((n) => n.toString().startsWith('embed')));
    assert.ok(names.some((n) => n.toString().startsWith('refresh')));
  });
});

describe('Docs status — no DB', () => {
  it('should return not-downloaded state when nothing exists', async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-docs-status-'));
    const previous = { JSN_DATA_HOME: process.env.JSN_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.JSN_DATA_HOME = path.join(root, 'data');
    process.env.XDG_CACHE_HOME = path.join(root, 'cache');
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });
    const cmd = docsCmd(fakeWrap);
    const all = [];
    const y2 = {
      command: (c) => {
        all.push(typeof c === 'function' ? c(fakeWrap) : c);
        return y2;
      },
    };
    cmd.builder(y2);
    const statusCmd = all.find((c) => c.command === 'status');

    let result = null;
    const app = { ok: (data) => { result = data; } };
    const handler = statusCmd.handler;
    await handler({}, app);

    assert.ok(result, 'handler should call app.ok');
    assert.strictEqual(result.state, 'not downloaded');
    assert.strictEqual(result.downloaded.ok, false);
    assert.strictEqual(result.db.ok, false);
    assert.strictEqual(result.embedded.ok, false);
    assert.strictEqual(typeof result.downloaded.path, 'string');
    assert.strictEqual(typeof result.db.path, 'string');
  });
});

describe('Docs sync — incremental path', () => {
  const INTEG = process.env.JSN_INTEGRATION_TESTS === 'true';

  it('should use incremental refresh when DB already exists', { skip: !INTEG }, async (t) => {
    const { syncDocs } = await import('../src/commands/docs/sync.js');
    const { docsDbExists } = await import('../src/commands/docs/db.js');

    if (!docsDbExists()) {
      t.skip('requires an existing docs index from a prior sync');
      return;
    }

    // With noIngest, we won't hit the incremental branch — need to test the real path.
    // Actually: noIngest skips both. Let's just verify the import works and the function
    // returns the right shape for the incremental case.
    const full = syncDocs({ noIngest: false });
    assert.strictEqual(typeof full.repoDir, 'string');
    assert.strictEqual(typeof full.markdownDir, 'string');
    assert.strictEqual(typeof full.dbPath, 'string');
    assert.strictEqual(full.ingested, true);
    assert.strictEqual(full.incremental, true, 'existing DB should trigger incremental refresh');
    assert.strictEqual(typeof full.added, 'number');
    assert.strictEqual(typeof full.updated, 'number');
    assert.strictEqual(typeof full.removed, 'number');
    assert.strictEqual(typeof full.secs, 'string');
  });
});

describe('Docs serve — port fallback guard', () => {
  it('should start a server on an assigned port', async () => {
    const { serveDocs } = await import('../src/commands/docs/serve.js');
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-docs-serve-'));
    const dbPath = path.join(root, 'docs.db');
    const db = openDocsDb({ dbPath });
    initDocsSchema(db);
    closeDocsDb(db);

    try {
      const { server } = await serveDocs({ dbPath, port: 0, host: '127.0.0.1' });
      assert.ok(server);
      assert.ok(server.address().port > 0);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } catch (err) {
      assert.fail(`serveDocs failed: ${err.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
