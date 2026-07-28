// Populate HRR phase-vector embeddings for semantic reranking.

import fs from 'node:fs';
import { openDocsDb, closeDocsDb, getDocsDbPath } from './db.js';
import { encodeText, phasesToBytes, docSurface, DEFAULT_DIM } from './hrr.js';

export function embedDocs(opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}. Run "jsn docs sync" first.`);
  }

  const db = openDocsDb({ dbPath });

  const cols = db.prepare('PRAGMA table_info(docs)').all();
  if (!cols.some((c) => c.name === 'hrr_vector')) {
    db.exec('ALTER TABLE docs ADD COLUMN hrr_vector BLOB');
  }

  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('hrr_dim', ?)").run(String(DEFAULT_DIM));

  const rows = db.prepare('SELECT id, title, body FROM docs WHERE hrr_vector IS NULL').all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;

  const update = db.prepare('UPDATE docs SET hrr_vector = ? WHERE id = ?');
  const started = Date.now();
  let n = 0;

  db.exec('BEGIN');
  for (const row of rows) {
    const surface = docSurface(row.title, row.body);
    const vec = encodeText(surface, DEFAULT_DIM);
    update.run(phasesToBytes(vec), row.id);
    n++;
    if (n % 5000 === 0) process.stderr.write(`  ...${n}\n`);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('embeddings', ?)").run('true');
  closeDocsDb(db);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  return { embedded: n, total, secs, dbPath };
}
