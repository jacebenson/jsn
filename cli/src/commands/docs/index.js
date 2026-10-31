// One search engine for the hosted website and the optional local service.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class DocumentationError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
export function documentationStatus(storage) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(storage, 'status.json'), 'utf8'));
    return Object.fromEntries(['state', 'checkedAt', 'publishedAt', 'documents', 'revision'].filter(key => key in value).map(key => [key, value[key]]));
  } catch { return { state: 'unavailable' }; }
}
function plain(value) {
  return String(value).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\([\p{P}\p{S}])/gu, '$1').replace(/[`*#]/g, '').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity])
    .replace(/\s+/g, ' ').trim();
}
function firstParagraph(body) {
  let fenced = false, current = [];
  const paragraphs = [];
  for (const line of String(body).split('\n')) {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^(?: {4}|\t)/.test(line)) continue;
    if (!line.trim()) { if (current.length) paragraphs.push(current.join(' ')); current = []; }
    else if (!/^\s*(?:\||#{1,6}\s|<|[-*+]\s|\d+\.\s|\*?\*?Parent Topic:)/i.test(line)) current.push(line.trim());
  }
  if (current.length) paragraphs.push(current.join(' '));
  return plain(paragraphs.find(text => text.length > 30) || '');
}
export function documentationSummary(input) {
  const { frontmatter, preview, ...row } = input;
  let metadata;
  try { metadata = JSON.parse(frontmatter || '{}'); } catch { metadata = {}; }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
  const description = typeof metadata.description === 'string' ? plain(metadata.description) : '';
  const excerpt = firstParagraph(preview || '');
  let summary = description || excerpt || `Read ${row.title || 'this reference'} in the ServiceNow documentation.`;
  if (summary.length > 280) summary = summary.slice(0, 280).match(/^(.{60,}[.!?])(?:\s|$)/)?.[1] || summary.slice(0, 279).replace(/\s+\S*$/, '') + '…';
  const classification = typeof metadata.classification === 'string' && metadata.classification ? metadata.classification : String(row.path || '').split('/')[0];
  const category = plain(classification.replaceAll('-', ' '));
  return { ...row, doc_type: row.doc_type || metadata.topic_type || null, summary,
    summary_source: description ? 'description' : excerpt ? 'paragraph' : 'fallback',
    category: typeof metadata.product === 'string' && metadata.product.trim() ? plain(metadata.product) : category.charAt(0).toUpperCase() + category.slice(1).replace(/^pi /, 'PI '),
  };
}
export class DocumentationIndex {
  constructor(storage) {
    try { this.db = new Database(path.join(storage, 'docs.sqlite3'), { readonly: true, fileMustExist: true, timeout: 2000 }); }
    catch { throw new DocumentationError('Documentation is being prepared. Please try again shortly.'); }
  }
  close() { this.db.close(); }
  revision() { return this.db.prepare("SELECT value FROM meta WHERE key = 'source_revision'").get()?.value || ''; }
  search({ query, limit = 20, offset = 0, bundle } = {}) {
    const text = String(query || '').trim();
    if (!text || text.length > 200) throw new DocumentationError('Enter a search of 1 to 200 characters.', 400);
    const tokens = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20);
    if (!tokens?.length) throw new DocumentationError('Enter a word to search for.', 400);
    limit = Number(limit); offset = Number(offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new DocumentationError('Limit must be 1–50 and offset 0–10000.', 400);
    const filter = bundle ? ' AND d.bundle = ?' : '';
    const binds = [tokens.map(token => `"${token}"`).join(' AND '), ...(bundle ? [bundle] : [])];
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?${filter}`).get(...binds).n;
    const results = this.db.prepare(`SELECT d.id, d.path, d.title, d.bundle, d.doc_type, d.release, d.frontmatter,
      substr(d.body, 1, 12000) AS preview, snippet(docs_fts, 1, '', '', ' … ', 24) AS snippet
      FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?${filter}
      ORDER BY CASE WHEN lower(d.title) = lower(?) THEN 0 WHEN instr(lower(d.title), lower(?)) = 1 THEN 1
      WHEN instr(lower(d.title), lower(?)) > 0 THEN 2 ELSE 3 END, bm25(docs_fts, 10.0, 1.0), d.id LIMIT ? OFFSET ?`)
      .all(...binds, text, text, text, limit, offset).map(documentationSummary);
    return { query: text, revision: this.revision(), total, count: results.length, limit, offset, results };
  }
  document({ id, path: docPath } = {}) {
    const select = 'SELECT id, path, title, bundle, doc_type, release, body FROM docs WHERE';
    const row = docPath ? this.db.prepare(`${select} path = ?`).get(docPath)
      : /^\d{1,18}$/.test(String(id)) ? this.db.prepare(`${select} id = ?`).get(String(id)) : null;
    if (!row) throw new DocumentationError('Document not found.', 404);
    return row;
  }
}
