// Docs DB path resolution and schema helpers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const DOCS_DIR_NAME = 'servicenow-cli/docs';

function xdgCacheHome() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  return path.join(os.homedir(), '.cache');
}

export function getDocsCacheDir() {
  return path.join(xdgCacheHome(), DOCS_DIR_NAME);
}

export function getDocsDbPath() {
  return path.join(getDocsCacheDir(), 'docs.db');
}

export function getDocsSourceDir() {
  return path.join(getDocsCacheDir(), 'source');
}

export function getDocsSourceMarkdownDir() {
  return path.join(getDocsSourceDir(), 'markdown');
}

export function ensureDocsCacheDir() {
  const dir = getDocsCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function openDocsDb(opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();
  ensureDocsCacheDir();
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export function closeDocsDb(db) {
  try {
    db.close();
  } catch {
    // ignore
  }
}

export function docsDbExists() {
  return fs.existsSync(getDocsDbPath());
}

export function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

export function setSchemaVersion(db, version) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(version));
}

export function initDocsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,
      title       TEXT,
      release     TEXT,
      bundle      TEXT,
      doc_type    TEXT,
      locale      TEXT,
      frontmatter TEXT,
      body        TEXT,
      size        INTEGER,
      mtime       INTEGER,
      hash        TEXT,
      hrr_vector  BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title, body,
      content='docs',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
      INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

    CREATE INDEX IF NOT EXISTS idx_docs_bundle   ON docs(bundle);
    CREATE INDEX IF NOT EXISTS idx_docs_doc_type ON docs(doc_type);
    CREATE INDEX IF NOT EXISTS idx_docs_release  ON docs(release);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  setSchemaVersion(db, 1);
}

export function hasEmbeddings(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(docs)').all();
    if (!cols.some((c) => c.name === 'hrr_vector')) return false;
    return db.prepare('SELECT COUNT(*) AS n FROM docs WHERE hrr_vector IS NOT NULL').get().n > 0;
  } catch {
    return false;
  }
}

export function getMeta(db, key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(key, value);
}
