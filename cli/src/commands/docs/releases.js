import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_DOCS_RELEASE, resolveDocsDbPath, getMeta } from './db.js';
import { docsReaderLease } from './locks.js';

// Local discovery deliberately does not depend on the hosted service.
export function listDocsReleases() {
  const directory = path.join(path.dirname(resolveDocsDbPath()), 'releases');
  const families = new Set([DEFAULT_DOCS_RELEASE]);
  if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-z0-9-]{1,40}$/.test(entry.name)) families.add(entry.name);
  }
  const rows = [];
  for (const release of [...families].sort()) {
    const indexPath = resolveDocsDbPath(release);
    if (!fs.existsSync(indexPath)) continue;
    const unlock = docsReaderLease(indexPath);
    let db;
    try {
      db = new Database(indexPath, { readonly: true, fileMustExist: true });
      rows.push({ release, revision: getMeta(db, 'source_revision') || getMeta(db, 'snapshot_revision'),
        documents: db.prepare('SELECT COUNT(*) AS n FROM docs').get().n, indexPath, default: release === DEFAULT_DOCS_RELEASE });
    } finally { db?.close(); unlock(); }
  }
  return rows;
}
