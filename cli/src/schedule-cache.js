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
  const checkDepth = (value, depth = 0) => {
    if (depth > 32) fail('Catalog nesting exceeds schema limit.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) checkDepth(child, depth + 1);
  };
  checkDepth(catalog);
  if (catalog?.schema_version !== 1 || !hash(catalog.revision) || !Array.isArray(catalog.schedules) || !catalog.schedules.length) fail('Invalid catalog schema.');
  const ids = new Set();
  for (const r of catalog.schedules) {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.id) || ids.has(r.id) || typeof r.product !== 'string' || !r.product.trim()) fail('Invalid or duplicate schedule ID/product.');
    ids.add(r.id);
    for (const key of ['title', 'source_version', 'effective_date', 'applicability', 'measurement', 'normalization_status']) {
      if (r[key] !== undefined && r[key] !== null && typeof r[key] !== 'string') fail(`Invalid record ${key}.`);
    }
    for (const key of ['source_sections', 'skus', 'unknowns', 'exceptions', 'limitations']) {
      if (r[key] !== undefined && (!Array.isArray(r[key]) || r[key].some(v => typeof v !== 'string'))) fail(`Invalid record ${key}.`);
    }
    if (r.definitions !== undefined && (!r.definitions || typeof r.definitions !== 'object')) fail('Invalid definitions.');
    if (Array.isArray(r.definitions) && r.definitions.some(d => !d || typeof d.term !== 'string' || typeof d.definition !== 'string' || !Array.isArray(d.source_sections) || d.source_sections.some(v => typeof v !== 'string'))) fail('Invalid definition provenance.');
    if (r.meter !== undefined && (!r.meter || typeof r.meter !== 'object' || Array.isArray(r.meter))) fail('Invalid meter.');
    if (r.meter?.rules !== undefined && (!Array.isArray(r.meter.rules) || r.meter.rules.some(v => !v || typeof v !== 'object' || Array.isArray(v)))) fail('Invalid meter rules.');
    for (const key of ['packages', 'entitlements', 'section_coverage', 'capability_lists']) {
      if (r[key] !== undefined && (!r[key] || typeof r[key] !== 'object')) fail(`Invalid record ${key}.`);
    }
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
    if (size > cap) { fail('Catalog exceeds size cap.'); }
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
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const catalog = validateCatalog(JSON.parse(text));
  if (catalog.revision !== manifest.revision) fail('Catalog revision mismatch.');
  const entry = { manifest, manifest_url: url.href, retrieved_at: new Date().toISOString(), artifact: text };
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized) > MAX * 2) fail('Serialized cache exceeds size cap.');
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const temp = `${file()}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file()); }
  finally { fs.rmSync(temp, { force: true }); }
  return cachedSchedules().provenance;
}
export function cachedSchedules() {
  try {
    if (fs.statSync(file()).size > MAX * 2) return null;
    const entry = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const m = entry.manifest;
    if (m?.schema_version !== 1 || !hash(m.revision) || !hash(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX || !Number.isFinite(Date.parse(m.published_at))) return null;
    const approved = safeURL(entry.manifest_url);
    safeURL(m.catalog_url, approved.origin);
    if (typeof entry.artifact !== 'string') return null;
    const bytes = Buffer.from(entry.artifact);
    if (bytes.length > MAX || bytes.length !== entry.manifest.bytes || digest(bytes) !== entry.manifest.sha256) return null;
    const catalog = validateCatalog(JSON.parse(bytes));
    if (catalog.revision !== entry.manifest.revision || !Number.isFinite(Date.parse(entry.retrieved_at))) return null;
    return { schedules: catalog.schedules, provenance: { source: 'validated-cache', revision: catalog.revision, sha256: entry.manifest.sha256, retrieved_at: entry.retrieved_at, manifest_url: entry.manifest_url, stale: Date.now() - Date.parse(entry.retrieved_at) > 86400000, freshness: 'last-good snapshot; no network freshness check' } };
  } catch { return null; }
}
