import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../cli/package.json', import.meta.url))('better-sqlite3');
import { syncDocumentation } from '../script/sync-docs.mjs';

test('Git sync publishes additions, edits and deletions atomically and skips unchanged revisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-site-sync-'));
  const source = path.join(dir, 'upstream');
  const storage = path.join(dir, 'published');
  fs.mkdirSync(path.join(source, 'markdown'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'); };
  const doc = (name, body) => fs.writeFileSync(path.join(source, 'markdown', name + '.md'), `---\ntitle: ${name}\nbundle: api\n---\n${body}`);
  try {
    git('init', '-b', 'australia');
    doc('keep', 'GlideRecord original');
    doc('remove', 'obsolete content');
    commit();
    let result = await syncDocumentation({ storage, source });
    assert.equal(result.documents, 2);
    const live = path.join(storage, 'docs.sqlite3');
    const read = () => {
      const db = new Database(live, { readonly: true });
      try { return db.prepare('SELECT path, body FROM docs ORDER BY path').all(); } finally { db.close(); }
    };
    const before = fs.statSync(live).mtimeMs;
    result = await syncDocumentation({ storage, source });
    assert.equal(result.changed, false);
    assert.equal(fs.statSync(live).mtimeMs, before);
    doc('keep', 'GlideRecord updated');
    doc('added', 'New API reference');
    fs.unlinkSync(path.join(source, 'markdown/remove.md'));
    commit();
    result = await syncDocumentation({ storage, source });
    assert.equal(result.result.added, 1);
    assert.equal(result.result.updated, 1);
    assert.equal(result.result.removed, 1);
    assert.deepEqual(read().map(row => row.path), ['added.md', 'keep.md']);
    assert.equal(read()[1].body.trim(), 'GlideRecord updated');
    const previous = fs.readFileSync(live);
    fs.rmSync(path.join(source, 'markdown'), { recursive: true });
    commit();
    await assert.rejects(syncDocumentation({ storage, source }));
    assert.deepEqual(fs.readFileSync(live), previous);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'status.json'))).state, 'failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
