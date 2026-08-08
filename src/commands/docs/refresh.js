// Incremental refresh: sync docs.db to the current state of the markdown folder
// after a ServiceNow docs update (e.g. `git pull` in the docs repo).

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { openDocsDb, closeDocsDb, getDocsDbPath, walkDocs, defaultDocsRoots } from './db.js';
import { encodeText, phasesToBytes, docSurface, DEFAULT_DIM } from './hrr.js';

export function refreshDocs(opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();
  const roots = opts.roots || defaultDocsRoots(opts);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}. Run "jsn docs sync" first for the initial build.`);
  }

  const db = openDocsDb({ dbPath });
  db.exec('PRAGMA journal_mode = WAL');

  const cols = db.prepare('PRAGMA table_info(docs)').all().map((c) => c.name);
  if (!cols.includes('hash')) db.exec('ALTER TABLE docs ADD COLUMN hash TEXT');
  if (!cols.includes('hrr_vector')) db.exec('ALTER TABLE docs ADD COLUMN hrr_vector BLOB');

  const embeddingsEnabled =
    db.prepare('SELECT COUNT(*) AS n FROM docs WHERE hrr_vector IS NOT NULL').get().n > 0 ||
    !cols.includes('hrr_vector');

  const isBackfill = db.prepare('SELECT COUNT(*) AS n FROM docs WHERE hash IS NOT NULL').get().n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM docs').get().n > 0;
  const setHash = db.prepare('UPDATE docs SET hash = ? WHERE id = ?');

  const existing = new Map();
  for (const row of db.prepare('SELECT id, path, hash FROM docs').all()) {
    existing.set(row.path, { id: row.id, hash: row.hash });
  }

  const upsert = db.prepare(`
    INSERT INTO docs (path, title, release, bundle, doc_type, locale, frontmatter, body, size, mtime, hash, hrr_vector)
    VALUES (@path, @title, @release, @bundle, @doc_type, @locale, @frontmatter, @body, @size, @mtime, @hash, @hrr_vector)
    ON CONFLICT(path) DO UPDATE SET
      title=@title, release=@release, bundle=@bundle, doc_type=@doc_type, locale=@locale,
      frontmatter=@frontmatter, body=@body, size=@size, mtime=@mtime, hash=@hash, hrr_vector=@hrr_vector
  `);
  const del = db.prepare('DELETE FROM docs WHERE id = ?');

  let added = 0, updated = 0, removed = 0, unchanged = 0, errors = 0;
  const seen = new Set();
  const started = Date.now();

  const files = [...walkDocs(roots)];

  db.exec('BEGIN');
  for (const { file, rel } of files) {
    try {
      seen.add(rel);
      const raw = fs.readFileSync(file, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex');

      const prev = existing.get(rel);
      if (prev && prev.hash === hash) {
        unchanged++;
        continue;
      }

      if (isBackfill && prev) {
        setHash.run(hash, prev.id);
        unchanged++;
        continue;
      }

      const stat = fs.statSync(file);
      let data = {}, body = raw;
      try {
        const parsed = matter(raw);
        data = parsed.data || {};
        body = parsed.content || '';
      } catch {
        // keep raw body on malformed frontmatter
      }

      const hrr = embeddingsEnabled
        ? phasesToBytes(encodeText(docSurface(data.title ?? null, body), DEFAULT_DIM))
        : null;

      upsert.run({
        path: rel,
        title: data.title ?? null,
        release: data.release ?? null,
        bundle: data.bundle ?? null,
        doc_type: data.doc_type ?? null,
        locale: data.locale ?? null,
        frontmatter: JSON.stringify(data),
        body,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        hash,
        hrr_vector: hrr,
      });
      if (prev) updated++; else added++;
    } catch (err) {
      errors++;
      if (errors <= 10) process.stderr.write(`Skipped ${file}: ${err.message}\n`);
    }
  }

  for (const [rel, row] of existing) {
    if (!seen.has(rel)) {
      del.run(row.id);
      removed++;
    }
  }
  db.exec('COMMIT');

  db.exec("INSERT INTO docs_fts(docs_fts) VALUES('optimize');");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('synced_at', ?)").run(String(Date.now()));
  closeDocsDb(db);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  return { added, updated, removed, unchanged, errors, secs, dbPath, embeddingsEnabled };
}
