// Ingest ServiceNow markdown docs into a SQLite database with FTS5 full-text search.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { openDocsDb, closeDocsDb, initDocsSchema, getDocsDbPath } from './db.js';
import { encodeText, phasesToBytes, docSurface, DEFAULT_DIM } from './hrr.js';

export function ingestDocs(opts = {}) {
  const docsDir = opts.docsDir;
  const dbPath = opts.dbPath || getDocsDbPath();
  const embed = opts.embed !== false;

  if (!fs.existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  // Fresh build each run.
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  const db = openDocsDb({ dbPath });
  initDocsSchema(db);

  const insert = db.prepare(`
    INSERT INTO docs (path, title, release, bundle, doc_type, locale, frontmatter, body, size, mtime, hash, hrr_vector)
    VALUES (@path, @title, @release, @bundle, @doc_type, @locale, @frontmatter, @body, @size, @mtime, @hash, @hrr_vector)
  `);

  function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) yield full;
    }
  }

  let count = 0;
  let errors = 0;
  const startedAt = Date.now();

  db.exec('BEGIN');
  for (const file of [...walk(docsDir)]) {
    try {
      const stat = fs.statSync(file);
      const raw = fs.readFileSync(file, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex');
      let data = {};
      let body = raw;
      try {
        const parsed = matter(raw);
        data = parsed.data || {};
        body = parsed.content || '';
      } catch {
        // Malformed frontmatter: keep raw body, empty metadata.
      }
      const hrr = embed
        ? phasesToBytes(encodeText(docSurface(data.title ?? null, body), DEFAULT_DIM))
        : null;
      insert.run({
        path: path.relative(docsDir, file).split(path.sep).join('/'),
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
      count++;
      if (count % 5000 === 0) {
        process.stderr.write(`  ...${count} files\n`);
      }
    } catch (err) {
      errors++;
      if (errors <= 10) process.stderr.write(`Skipped ${file}: ${err.message}\n`);
    }
  }
  db.exec('COMMIT');

  db.exec("INSERT INTO docs_fts(docs_fts) VALUES('optimize');");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('hrr_dim', ?)").run(String(DEFAULT_DIM));
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('synced_at', ?)").run(String(Date.now()));
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('embeddings', ?)").run(String(embed));
  closeDocsDb(db);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  return { count, errors, secs, dbPath, embedded: embed };
}
