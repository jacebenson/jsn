// Fetch ServiceNow Community pages, convert them to markdown, and index them
// into the local docs DB alongside the ServiceNowDocs clone.
//
// Community content is written to <cache>/servicenow-cli/docs/community/ as
// markdown with frontmatter, then picked up by ingest/refresh via walkDocs().

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import TurndownService from 'turndown';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { getDocsCommunityDir, getDocsDbPath, docsDbExists } from './db.js';
import { refreshDocs } from './refresh.js';
import { ingestDocs } from './ingest.js';

const DEFAULT_SOURCES_FILE = path.join(import.meta.dirname, 'community-sources.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// --- Extraction helpers (pure, exported for tests) ---

export function extractBodyHtml(html) {
  const marker = 'lia-message-body-content';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const open = html.indexOf('>', start) + 1;
  if (open <= 0) return null;
  // Depth-count the <div> nesting from the body content element.
  let depth = 1;
  let i = open;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextOpen === -1 && nextClose === -1) break;
    if (nextClose === -1 || (nextOpen !== -1 && nextOpen < nextClose)) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return html.slice(open, i);
}

export function extractMeta(html) {
  const title = (() => {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1) return stripTags(h1[1]).trim();
    const t = html.match(/<title>([\s\S]*?)<\/title>/);
    return t ? t[1].trim().replace(/\s*-\s*ServiceNow Community\s*$/i, '') : null;
  })();

  const author = (() => {
    const m = html.match(/<span\s+content="([^"]+)"\s+itemprop="name"[^>]*>/);
    return m ? m[1] : null;
  })();

  const authorUrl = (() => {
    const m = html.match(/class="[^"]*lia-user-name-link[^"]*"[^>]*href="([^"]+)"/);
    return m ? m[1] : null;
  })();

  return { title, author, authorUrl };
}

export function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ''));
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// --- HTML -> markdown ---

export function htmlToMarkdown(html) {
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// --- Community page fetch ---

async function fetchPage(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.status === 429) {
        const wait = 5000 * (attempt + 1);
        process.stderr.write(`  rate limited (429), waiting ${wait / 1000}s...\n`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 400) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Link extraction for --expand ---

export function extractCommunityLinks(html, baseUrl) {
  const bodyHtml = extractBodyHtml(html) || html;
  const out = new Set();
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(bodyHtml))) {
    let u = m[1].replace(/&amp;/g, '&');
    if (u.startsWith('#')) continue;
    try {
      u = new URL(u, baseUrl).toString();
    } catch {
      continue;
    }
    // Only new Khoros community article/blog pages: /community/<section>/<slug>/t[abdp]-p/<id>
    const km = u.match(/^https?:\/\/www\.servicenow\.com\/community\/[a-z0-9-]+\/[^/]+\/t[abdp]-p\/\d+/);
    if (!km) continue;
    // Strip query/hash for dedupe.
    const clean = km[0];
    if (/\/user\/|viewprofilepage|notifymoderator|kudos|printpage|\/s\//.test(clean)) continue;
    out.add(clean);
  }
  return [...out];
}

// --- File naming ---

export function slugify(title, fallback = 'untitled') {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function frontmatter(body, data) {
  return matter.stringify(body, data);
}

// --- Write a community doc to disk ---

export function writeCommunityDoc({ author, title, url, bodyMd, docType, sourceUrl, published, fetchedAt, communityDir } = {}) {
  const baseDir = communityDir || getDocsCommunityDir();
  const authorDir = path.join(baseDir, slugify(author, 'unknown'));
  fs.mkdirSync(authorDir, { recursive: true });
  // Include the post id (t[abdp]-p/<id>) so identical titles across posts
  // never collide on disk. e.g. 456-articles-blogs-videos.../ba-p/2292127
  const id = (url.match(/\/(t[abdp]-p\/\d+)\/?$/) || [])[1] || null;
  const idPart = id ? id.replace(/[^a-z0-9]+/g, '-') : null;
  const titleSlug = slugify(title, 'untitled');
  const slug = idPart ? `${titleSlug}-${idPart}` : titleSlug;
  const rel = path.join(authorDir, `${slug}.md`);
  const fm = {
    title,
    author,
    bundle: 'community',
    doc_type: docType,
    canonical_url: url,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(published ? { published } : {}),
    ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
  };
  const md = frontmatter(bodyMd, fm);
  fs.writeFileSync(rel, md);
  return { file: rel, rel: path.relative(baseDir, rel).split(path.sep).join('/') };
}

// --- Sync entry points ---

function loadSources(sourcesFile) {
  const file = sourcesFile || DEFAULT_SOURCES_FILE;
  if (!fs.existsSync(file)) {
    throw new Error(`Community sources file not found: ${file}`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.sources)) {
    throw new Error(`Invalid community sources file ${file}: expected { "sources": [...] }`);
  }
  return data.sources;
}

export async function syncCommunity(opts = {}) {
  const sources = loadSources(opts.sourcesFile);
  const expand = opts.expand === true;
  const force = opts.force === true;
  const delayMs = opts.delayMs != null ? opts.delayMs : 500;
  const dbPath = opts.dbPath || getDocsDbPath();

  const results = { hubs: [], articles: [], skipped: [], errors: [] };

  for (const source of sources) {
    const url = source.url || source.hub_url;
    if (!url) {
      results.errors.push({ source: source.name || '?', error: 'missing url' });
      continue;
    }
    process.stderr.write(`Fetching hub: ${url}\n`);
    try {
      const html = await fetchPage(url);
      const meta = extractMeta(html);
      const title = meta.title || source.name || url;
      const author = meta.author || source.author || 'ServiceNow Community';
      const authorUrl = meta.authorUrl || source.author_url;
      const bodyHtml = extractBodyHtml(html);
      if (!bodyHtml) {
        results.errors.push({ url, error: 'no article body found' });
        continue;
      }
      const bodyMd = htmlToMarkdown(bodyHtml);
      const written = writeCommunityDoc({
        author,
        title,
        url,
        bodyMd,
        docType: 'hub',
        fetchedAt: new Date().toISOString(),
      });
      results.hubs.push({ title, author, authorUrl, url, file: written.rel });

      if (expand) {
        const links = extractCommunityLinks(html, url);
        const urlIndex = buildUrlIndex();
        process.stderr.write(`  ${links.length} linked article(s) found\n`);
        for (const link of links) {
          // Skip already-downloaded files unless --force.
          const existing = findExisting(link, urlIndex);
          if (existing && !force) {
            results.skipped.push({ url: link, reason: 'already downloaded' });
            continue;
          }
          process.stderr.write(`  Fetching: ${link}\n`);
          try {
            const pageHtml = await fetchPage(link);
            const pageMeta = extractMeta(pageHtml);
            const pageBody = extractBodyHtml(pageHtml);
            if (!pageBody) {
              results.skipped.push({ url: link, reason: 'no article body' });
              continue;
            }
            const md = htmlToMarkdown(pageBody);
            const wrote = writeCommunityDoc({
              author: pageMeta.author || author,
              title: pageMeta.title || link,
              url: link,
              bodyMd: md,
              docType: 'article',
              sourceUrl: url,
              fetchedAt: new Date().toISOString(),
            });
            results.articles.push({ title: pageMeta.title, url: link, file: wrote.rel });
          } catch (err) {
            results.errors.push({ url: link, error: err.message });
          }
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
      results.errors.push({ url, error: err.message });
    }
  }

  // Refresh the index so new community docs are searchable. Fall back to a
  // full ingest when no DB exists yet.
  const refreshResult = docsDbExists()
    ? refreshDocs({ dbPath })
    : ingestDocs({ dbPath, roots: [{ dir: getDocsCommunityDir(), prefix: 'community/' }], embed: true });

  return { ...results, refresh: refreshResult };
}

function buildUrlIndex() {
  const communityDir = getDocsCommunityDir();
  if (!fs.existsSync(communityDir)) return new Map();
  const index = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.md')) {
        try {
          const parsed = matter(fs.readFileSync(full, 'utf8'));
          if (parsed.data.canonical_url) index.set(parsed.data.canonical_url, full);
        } catch { /* ignore */ }
      }
    }
  };
  walk(communityDir);
  return index;
}

function findExisting(url, urlIndex) {
  if (!urlIndex) return null;
  return urlIndex.get(url) || null;
}

export function listCommunityDocs({ dbPath } = {}) {
  const dbFile = dbPath || getDocsDbPath();
  if (!fs.existsSync(dbFile)) return { total: 0, docs: [] };
  const db = new Database(dbFile, { readonly: true });
  const rows = db
    .prepare(`SELECT id, path, title, doc_type, frontmatter FROM docs WHERE bundle = 'community' ORDER BY path`)
    .all()
    .map((r) => {
      let fm = {};
      try { fm = JSON.parse(r.frontmatter || '{}'); } catch { /* ignore */ }
      return { id: r.id, path: r.path, title: r.title || fm.title, doc_type: r.doc_type, author: fm.author, canonical_url: fm.canonical_url };
    });
  db.close();
  return { total: rows.length, docs: rows };
}
