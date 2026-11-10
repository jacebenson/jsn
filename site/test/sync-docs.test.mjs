import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../cli/package.json', import.meta.url))('better-sqlite3');
import { syncDocumentation, syncFamily } from '../script/sync-docs.mjs';

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
    const legacy = await syncFamily({ storage, source, family: 'australia', republish: true });
    assert.equal(legacy.release, 'australia', 'unlabelled legacy Australia metadata remains publishable');
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

test('a failed first family build retains identity and retries after upstream recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-site-family-retry-'));
  const source = path.join(dir, 'upstream');
  const storage = path.join(dir, 'releases', 'brazil');
  fs.mkdirSync(source, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'); };
  const statusPath = path.join(storage, 'status.json');
  try {
    git('init', '-b', 'brazil');
    fs.writeFileSync(path.join(source, 'README'), 'Initially missing markdown');
    commit();
    await assert.rejects(syncFamily({ storage, source, family: 'brazil' }), /markdown/);
    const failed = JSON.parse(fs.readFileSync(statusPath));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.release, 'brazil');
    assert.equal(fs.existsSync(path.join(storage, 'docs.sqlite3')), false);

    fs.mkdirSync(path.join(source, 'markdown'));
    const document = path.join(source, 'markdown', 'record.md');
    fs.writeFileSync(document, '---\ntitle: Record\nbundle: api\n---\nRecovered documentation.');
    commit();
    const recovered = await syncFamily({ storage, source, family: 'brazil' });
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.release, 'brazil');
    assert.equal(recovered.documents, 1);
    assert.equal(recovered.revision, git('rev-parse', 'HEAD'));
    const unchanged = await syncFamily({ storage, source, family: 'brazil' });
    assert.equal(unchanged.changed, false);
    fs.appendFileSync(document, '\nUpdated after recovery.');
    commit();
    const changed = await syncFamily({ storage, source, family: 'brazil' });
    assert.equal(changed.changed, true);
    assert.equal(changed.revision, git('rev-parse', 'HEAD'));
    const republished = await syncFamily({ storage, source, family: 'brazil', republish: true });
    assert.equal(republished.revision, changed.revision);
    assert.equal(republished.changed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'snapshots/manifest.json'))).release, 'brazil');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('initial unknown or foreign metadata is refused without writes, even when unsuccessful', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-site-family-unknown-'));
  try {
    for (const file of ['status.json', 'snapshots/manifest.json']) {
      for (const value of [{}, { state: 'ready' }, { state: 'failed' }, { state: 'syncing' },
        { release: 'australia', state: 'failed' }, { release: 'Brazil', state: 'syncing' }]) {
        const storage = path.join(dir, 'brazil');
        const target = path.join(storage, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const bytes = JSON.stringify(value);
        fs.writeFileSync(target, bytes);
        const entries = fs.readdirSync(storage, { recursive: true });
        for (const republish of [false, true]) {
          await assert.rejects(syncFamily({ storage, source: path.join(dir, 'missing-source'), family: 'brazil', republish }), /family metadata/i);
          assert.equal(fs.readFileSync(target, 'utf8'), bytes);
          assert.deepEqual(fs.readdirSync(storage, { recursive: true }), entries);
        }
        fs.rmSync(storage, { recursive: true });
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one family syncs into its own storage and stamps its release on the published manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-site-family-sync-'));
  const source = path.join(dir, 'upstream');
  const storage = path.join(dir, 'releases', 'brazil');
  fs.mkdirSync(path.join(source, 'markdown'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init', '-b', 'brazil');
    fs.writeFileSync(path.join(source, 'markdown', 'record.md'), '---\ntitle: Record\nbundle: api\n---\nBrazil documentation.');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');

    const first = await syncFamily({ storage, family: 'brazil', source });
    assert.equal(first.release, 'brazil');
    assert.equal(first.documents, 1);
    assert.ok(fs.existsSync(path.join(storage, 'docs.sqlite3')), 'the index stays inside the family storage directory');
    const manifest = JSON.parse(fs.readFileSync(path.join(storage, 'snapshots', 'manifest.json'), 'utf8'));
    assert.equal(manifest.release, 'brazil');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'status.json'), 'utf8')).release, 'brazil');

    const republished = await syncFamily({ storage, family: 'brazil', source, republish: true });
    assert.equal(republished.changed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'snapshots', 'manifest.json'), 'utf8')).release, 'brazil');
    for (const branch of ['australia', null, 'Brazil']) {
      const db = new Database(path.join(storage, 'docs.sqlite3'));
      db.prepare("DELETE FROM meta WHERE key='source_branch'").run();
      if (branch !== null) db.prepare("INSERT INTO meta(key,value) VALUES('source_branch', ?)").run(branch);
      db.close();
      const before = ['docs.sqlite3', 'status.json', 'snapshots/manifest.json'].map(file => fs.readFileSync(path.join(storage, file)));
      for (const republish of [true, false]) {
        await assert.rejects(syncFamily({ storage, family: 'brazil', source, republish }), /family metadata/i);
        before.forEach((bytes, i) => assert.deepEqual(fs.readFileSync(path.join(storage,
          ['docs.sqlite3', 'status.json', 'snapshots/manifest.json'][i])), bytes));
      }
    }
    const db = new Database(path.join(storage, 'docs.sqlite3'));
    db.prepare("UPDATE meta SET value='brazil' WHERE key='source_branch'").run();
    db.close();
    for (const file of ['status.json', 'snapshots/manifest.json']) {
      const target = path.join(storage, file);
      const original = fs.readFileSync(target);
      for (const metadata of ['{"release":"australia"}', '{}', '{broken']) {
        fs.writeFileSync(target, metadata);
        for (const republish of [false, true]) {
          await assert.rejects(syncFamily({ storage, source, family: 'brazil', republish }));
          assert.equal(fs.readFileSync(target, 'utf8'), metadata);
        }
      }
      fs.writeFileSync(target, original);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
