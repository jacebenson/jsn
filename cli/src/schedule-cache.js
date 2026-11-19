import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cacheDir } from './config.js';
import { AppError } from './errors.js';

const MAX = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new AppError('invalid_catalog', message); };
const file = () => path.join(cacheDir(), 'subscription-schedules-v1.json');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateCatalog(catalog) {
  if (catalog?.schema_version !== 1 || !hash(catalog.revision) || !Array.isArray(catalog.schedules) || !catalog.schedules.length) fail('Invalid catalog schema.');
  const ids = new Set();
  for (const r of catalog.schedules) {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.id) || ids.has(r.id) || typeof r.product !== 'string' || !r.product.trim()) fail('Invalid or duplicate schedule ID/product.');
    ids.add(r.id);
    let source;
    try { source = new URL(r.source_url); } catch { fail('Missing source provenance.'); }
    if (source.protocol !== 'https:' || source.hostname !== 'www.servicenow.com' || source.username || source.password || !source.pathname.endsWith('.pdf') || !Number.isFinite(Date.parse(r.retrieved_at || r.fetched_at))) fail('Unsafe or missing source provenance.');
    if (r.id !== 'itom-2026-04-09' && (!Array.isArray(r.source_sections) || !r.source_sections.length || !Array.isArray(r.skus) || !['normalized', 'partial'].includes(r.normalization_status))) fail('Invalid normalized record schema.');
  }
  return catalog;
}
function safeURL(value, origin) {
  let u;
  try { u = new URL(value); } catch { fail('Invalid catalog URL.'); }
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) || (origin && u.origin !== origin)) fail('Catalog URL must use HTTPS and the approved manifest origin (explicit loopback HTTP is allowed).');
  return u;
}
async function download(url, cap) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000), credentials: 'omit' });
  if (!response.ok) fail(`Catalog HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > cap) fail('Catalog exceeds size cap.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > cap) { await response.body.cancel().catch(() => {}); fail('Catalog exceeds size cap.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function refreshSchedules(manifestURL) {
  if (!manifestURL) fail('Specify --manifest-url or configure JSN_DOCS_URL / global docs.url.');
  const url = safeURL(manifestURL);
  const manifest = JSON.parse(await download(url, 16384));
  if (manifest.schema_version !== 1 || !hash(manifest.revision) || !hash(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX || !Number.isFinite(Date.parse(manifest.published_at))) fail('Invalid manifest schema or size.');
  const artifactURL = safeURL(manifest.catalog_url, url.origin);
  const bytes = await download(artifactURL, MAX);
  if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.sha256) fail('Catalog byte length or SHA256 mismatch.');
  const catalog = validateCatalog(JSON.parse(bytes));
  if (catalog.revision !== manifest.revision) fail('Catalog revision mismatch.');
  const entry = { manifest, manifest_url: url.href, retrieved_at: new Date().toISOString(), artifact: bytes.toString('utf8') };
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const temp = `${file()}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file()); }
  finally { fs.rmSync(temp, { force: true }); }
  return cachedSchedules().provenance;
}
export function cachedSchedules() {
  try {
    if (fs.statSync(file()).size > MAX * 2) return null;
    const entry = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const bytes = Buffer.from(entry.artifact);
    if (bytes.length > MAX || bytes.length !== entry.manifest.bytes || digest(bytes) !== entry.manifest.sha256) return null;
    const catalog = validateCatalog(JSON.parse(bytes));
    if (catalog.revision !== entry.manifest.revision || !Number.isFinite(Date.parse(entry.retrieved_at))) return null;
    return { schedules: catalog.schedules, provenance: { source: 'validated-cache', revision: catalog.revision, sha256: entry.manifest.sha256, retrieved_at: entry.retrieved_at, manifest_url: entry.manifest_url, stale: Date.now() - Date.parse(entry.retrieved_at) > 86400000, freshness: 'last-good snapshot; no network freshness check' } };
  } catch { return null; }
}
