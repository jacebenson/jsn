// CLI search against the docs SQLite database.

import fs from 'node:fs';
import { getDocsDbPath, hasEmbeddings, openDocsDb, closeDocsDb, getMeta } from './db.js';
import { encodeText, similarity, bytesToPhases, DEFAULT_DIM } from './hrr.js';

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Fetch one doc for `jsn docs show`: exact id when the argument is numeric,
 * otherwise a path-substring match, falling back to a single best FTS match.
 * Returns the docs row, or undefined when nothing matches. Owns its DB
 * handle (pass opts.dbPath to target a non-default database — used by tests).
 */
export function getDocByIdOrPath(idOrPath, opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();
  const db = openDocsDb({ dbPath });
  try {
    let row;
    if (/^\d+$/.test(idOrPath)) {
      row = db.prepare('SELECT * FROM docs WHERE id = ?').get(parseInt(idOrPath, 10));
    } else {
      row = db.prepare('SELECT * FROM docs WHERE path LIKE ?').get(`%${idOrPath}%`);
      if (!row) {
        row = db.prepare(
          `SELECT d.* FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ? LIMIT 1`
        ).get(idOrPath);
      }
    }
    return row;
  } finally {
    closeDocsDb(db);
  }
}

export function searchDocs(opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();
  const q = (opts.query || '').toString().trim();
  if (!q) {
    throw new Error('Query is required.');
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}. Run "jsn docs sync" first.`);
  }

  const db = openDocsDb({ dbPath });
  const limit = Math.min(parseInt(opts.limit, 10) || 20, 1000);
  const offset = parseInt(opts.offset, 10) || 0;
  const bundle = opts.bundle ? String(opts.bundle) : null;
  const docType = opts.docType ? String(opts.docType) : null;
  const mode = opts.mode === 'keyword' ? 'keyword' : 'hybrid';
  const useHybrid = mode === 'hybrid' && hasEmbeddings(db);

  const filters = [];
  const params = { q, limit, offset };
  if (bundle) {
    filters.push('d.bundle = @bundle');
    params.bundle = bundle;
  }
  if (docType) {
    filters.push('d.doc_type = @docType');
    params.docType = docType;
  }
  const where = filters.length ? ' AND ' + filters.join(' AND ') : '';

  // Total matching docs (for pagination)
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH @q${where}`)
    .get({ q, ...(bundle && { bundle }), ...(docType && { docType }) }).n;

  let rows;
  if (!useHybrid) {
    rows = db
      .prepare(
        `SELECT d.id, d.path, d.title, d.bundle, d.doc_type, d.release,
                json_extract(d.frontmatter, '$.canonical_url') AS canonical_url,
                snippet(docs_fts, 1, '[', ']', ' … ', 12) AS snippet,
                bm25(docs_fts) AS score
         FROM docs_fts
         JOIN docs d ON d.id = docs_fts.rowid
         WHERE docs_fts MATCH @q${where}
         ORDER BY score
         LIMIT @limit OFFSET @offset`
      )
      .all(params);
  } else {
    const candParams = { q, cand: (limit + offset) * 4 + 20 };
    if (bundle) candParams.bundle = bundle;
    if (docType) candParams.docType = docType;
    const candidates = db
      .prepare(
        `SELECT d.id, d.path, d.title, d.bundle, d.doc_type, d.release, d.hrr_vector,
                json_extract(d.frontmatter, '$.canonical_url') AS canonical_url,
                snippet(docs_fts, 1, '[', ']', ' … ', 12) AS snippet,
                bm25(docs_fts) AS bm25
         FROM docs_fts
         JOIN docs d ON d.id = docs_fts.rowid
         WHERE docs_fts MATCH @q${where}
         ORDER BY bm25
         LIMIT @cand`
      )
      .all(candParams);

    if (candidates.length === 0) {
      rows = [];
    } else {
      const hrrDim = (() => {
        const value = getMeta(db, 'hrr_dim');
        const n = parseInt(value, 10);
        return Number.isInteger(n) ? n : DEFAULT_DIM;
      })();
      const queryVec = encodeText(q, hrrDim);
      const queryTokens = new Set(q.toLowerCase().split(/\s+/).filter(Boolean));

      const bmVals = candidates.map((c) => c.bm25);
      const bmMin = Math.min(...bmVals);
      const bmMax = Math.max(...bmVals);
      const bmRange = bmMax - bmMin || 1;

      const FTS_W = 0.4, JACCARD_W = 0.3, HRR_W = 0.3;

      for (const c of candidates) {
        const ftsScore = 1 - (c.bm25 - bmMin) / bmRange;
        const contentTokens = new Set(
          `${c.title || ''} ${c.path || ''}`.toLowerCase().split(/\s+/).filter(Boolean)
        );
        let inter = 0;
        for (const t of queryTokens) if (contentTokens.has(t)) inter++;
        const union = queryTokens.size + contentTokens.size - inter;
        const jaccard = union ? inter / union : 0;

        let hrrSim = 0.5;
        if (c.hrr_vector) {
          hrrSim = (similarity(queryVec, bytesToPhases(c.hrr_vector)) + 1) / 2;
        }

        c.score = FTS_W * ftsScore + JACCARD_W * jaccard + HRR_W * hrrSim;
        delete c.hrr_vector;
        delete c.bm25;
      }

      candidates.sort((a, b) => b.score - a.score);
      rows = candidates.slice(offset, offset + limit);
    }
  }

  closeDocsDb(db);

  // Post-process canonical_url JSON strings that may contain escaped content.
  for (const row of rows) {
    if (row.canonical_url) row.canonical_url = safeParse(row.canonical_url) || row.canonical_url;
  }

  return {
    query: q,
    mode: useHybrid ? 'hybrid' : 'keyword',
    total,
    count: rows.length,
    results: rows,
  };
}
