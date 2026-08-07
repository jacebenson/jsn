// Built-in HTTP server for docs search (node:http only, no Express).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import Database from 'better-sqlite3';
import { getDocsDbPath, hasEmbeddings } from './db.js';
import { encodeText, similarity, bytesToPhases, DEFAULT_DIM } from './hrr.js';

const PUBLIC_DIR = path.join(import.meta.dirname, 'public');

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function serveStatic(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

export function serveDocs(opts = {}) {
  const dbPath = opts.dbPath || getDocsDbPath();
  const port = parseInt(opts.port, 10) || 3000;
  const host = opts.host || '127.0.0.1';

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}. Run "jsn docs sync" first.`);
  }

  const db = new Database(dbPath, { readonly: true });
  const hasEmb = hasEmbeddings(db);
  const hrrDim = (() => {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='hrr_dim'").get();
      return row ? parseInt(row.value, 10) : DEFAULT_DIM;
    } catch {
      return DEFAULT_DIM;
    }
  })();

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/health') {
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/stats') {
        const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
        return sendJSON(res, 200, { documents: total, db: path.resolve(dbPath), embeddings: hasEmb, hrr_dim: hrrDim });
      }

      if (pathname === '/bundles') {
        const rows = db
          .prepare('SELECT bundle, COUNT(*) AS count FROM docs WHERE bundle IS NOT NULL GROUP BY bundle ORDER BY count DESC')
          .all();
        return sendJSON(res, 200, rows);
      }

      if (pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return sendJSON(res, 400, { error: "Missing query parameter 'q'." });

        const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 20, 100);
        const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
        const bundle = url.searchParams.get('bundle') || null;
        const docType = url.searchParams.get('doc_type') || null;
        let mode = (url.searchParams.get('mode') || (hasEmb ? 'hybrid' : 'keyword')).toString();
        if (mode === 'hybrid' && !hasEmb) mode = 'keyword';

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

        try {
          if (mode === 'keyword') {
            const rows = db
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
            return sendJSON(res, 200, { query: q, mode, count: rows.length, results: rows });
          }

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
            return sendJSON(res, 200, { query: q, mode, count: 0, results: [] });
          }

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
          const results = candidates.slice(offset, offset + limit);
          return sendJSON(res, 200, { query: q, mode, count: results.length, results });
        } catch (err) {
          return sendJSON(res, 400, { error: `Invalid FTS query: ${err.message}` });
        }
      }

      if (pathname.startsWith('/doc/')) {
        const id = pathname.slice(5);
        if (!id) return sendJSON(res, 400, { error: "Missing 'id'." });
        const row = db.prepare('SELECT * FROM docs WHERE id = ?').get(id);
        if (!row) return sendJSON(res, 404, { error: 'Not found' });
        row.frontmatter = safeParse(row.frontmatter);
        return sendJSON(res, 200, row);
      }

      if (pathname === '/doc') {
        const p = url.searchParams.get('path') || '';
        if (!p) return sendJSON(res, 400, { error: "Missing 'path'." });
        const row = db.prepare('SELECT * FROM docs WHERE path = ?').get(p);
        if (!row) return sendJSON(res, 404, { error: 'Not found' });
        row.frontmatter = safeParse(row.frontmatter);
        return sendJSON(res, 200, row);
      }

      // Static files.
      let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
      // Security: prevent escaping public dir.
      filePath = path.resolve(filePath);
      const publicResolved = path.resolve(PUBLIC_DIR);
      if (!filePath.startsWith(publicResolved + path.sep) && filePath !== publicResolved) {
        return sendText(res, 403, 'Forbidden');
      }
      return serveStatic(req, res, filePath);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    let currentPort = parseInt(port, 10);
    const maxAttempts = 10;
    let attempts = 0;
    let resolved = false;

    function onListening() {
      if (resolved) return;
      resolved = true;
      server.removeListener('error', onError);
      process.stderr.write(`ServiceNow docs search listening on http://${host}:${currentPort}\n`);
      resolve({ server, port: currentPort, host, dbPath });
    }

    function onError(err) {
      if (resolved) return;
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
        process.stderr.write(`Port ${currentPort} in use, trying ${currentPort + 1}...\n`);
        currentPort++;
        tryListen();
        return;
      }
      if (err.code === 'EADDRINUSE') {
        err.message = `Could not find an open port between ${port} and ${currentPort}. Try specifying one with --port.`;
      }
      resolved = true;
      reject(err);
    }

    function tryListen() {
      attempts++;
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(currentPort, host);
    }

    tryListen();
  });
}
