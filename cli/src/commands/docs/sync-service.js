// Server-owned GitHub mirror and atomic FTS5 publication. Reuses the CLI ingester.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { ingestDocs } from './ingest.js';
import { refreshDocs } from './refresh.js';

const defaultStorage = path.join(process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn'), 'docs-service');
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.error?.message || result.stderr?.slice(-1000) || result.status}`);
  return result.stdout.trim();
}
function writeStatus(storage, status) {
  const temporary = path.join(storage, `status-${randomUUID()}.json`);
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(temporary, path.join(storage, 'status.json'));
}
async function performSync(options = {}) {
  const storage = options.storage || process.env.DOCS_STORAGE_DIR || defaultStorage;
  const source = options.source || process.env.DOCS_SOURCE_URL || 'https://github.com/ServiceNow/ServiceNowDocs.git';
  const branch = options.branch || process.env.DOCS_SOURCE_BRANCH || 'australia';
  fs.mkdirSync(storage, { recursive: true });
  const repo = path.join(storage, 'source');
  const live = path.join(storage, 'docs.sqlite3');
  const staging = path.join(storage, `build-${randomUUID()}.sqlite3`);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(storage, 'status.json'), 'utf8')); } catch { /* first run */ }
  // The shared service lock excludes concurrent publishers.
  for (const name of fs.readdirSync(storage)) {
    if (/^(build|clone)-[a-f0-9-]+(?:\.sqlite3(?:-wal|-shm)?)?$/.test(name)) {
      fs.rmSync(path.join(storage, name), { recursive: true, force: true });
    }
  }
  const startedAt = new Date().toISOString();
  writeStatus(storage, { ...previous, state: 'syncing', startedAt });
  try {
    if (!fs.existsSync(path.join(repo, '.git'))) {
      const cloning = path.join(storage, `clone-${randomUUID()}`);
      try {
        git(['clone', '--depth', '1', '--branch', branch, '--', source, cloning]);
        if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
        fs.renameSync(cloning, repo);
      } finally { fs.rmSync(cloning, { recursive: true, force: true }); }
    } else {
      // This clone is private to the service. Never operate on a developer's checkout.
      git(['-C', repo, 'fetch', '--depth', '1', 'origin', branch]);
      git(['-C', repo, 'reset', '--hard', 'FETCH_HEAD']);
    }
    const revision = git(['-C', repo, 'rev-parse', 'HEAD']);
    const markdown = path.join(repo, 'markdown');
    if (!fs.statSync(markdown).isDirectory()) throw new Error('Source has no markdown directory');
    let oldRevision;
    if (fs.existsSync(live)) {
      const db = new Database(live, { readonly: true });
      try {
        oldRevision = db.prepare("SELECT value FROM meta WHERE key = 'source_revision'").get()?.value;
        if (oldRevision !== revision || options.force) await db.backup(staging);
      } finally { db.close(); }
    }
    if (oldRevision === revision && !options.force) {
      const status = { ...previous, state: 'ready', revision, checkedAt: new Date().toISOString(), startedAt, error: null, changed: false };
      writeStatus(storage, status);
      return status;
    }
    const roots = [{ dir: markdown, prefix: '' }];
    const result = fs.existsSync(staging)
      ? refreshDocs({ roots, dbPath: staging })
      : ingestDocs({ roots, dbPath: staging, embed: false });
    if (result.errors) throw new Error(`Indexing skipped ${result.errors} documents; retaining the published index`);
    const db = new Database(staging);
    let count;
    try {
      count = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
      if (!count) throw new Error('Refusing to publish an empty documentation index');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed');
      db.exec("INSERT INTO docs_fts(docs_fts, rank) VALUES('integrity-check', 1)");
      const set = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)');
      set.run('source_revision', revision);
      set.run('source_branch', branch);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('journal_mode = DELETE');
    } finally { db.close(); }
    fs.renameSync(staging, live);
    const status = { state: 'ready', revision, documents: count, startedAt, checkedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), changed: true, error: null, result };
    writeStatus(storage, status);
    return status;
  } catch (error) {
    writeStatus(storage, { ...previous, state: 'failed', startedAt, checkedAt: new Date().toISOString(), error: error.message });
    throw error;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(staging + suffix, { force: true });
  }
}
export async function syncDocumentation(options = {}) {
  const storage = options.storage || process.env.DOCS_STORAGE_DIR || defaultStorage;
  fs.mkdirSync(storage, { recursive: true });
  const lock = path.join(storage, 'sync-service.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* another process may be writing it */ }
    if (!pid) {
      if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return { state: 'syncing', changed: false };
      fs.rmSync(lock, { recursive: true, force: true });
      return syncDocumentation(options);
    }
    try { process.kill(pid, 0); return { state: 'syncing', changed: false }; }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.rmSync(lock, { recursive: true });
    // Retry acquisition, so another waiting publisher still wins exclusively.
    return syncDocumentation(options);
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  try { return await performSync(options); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await syncDocumentation()) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
