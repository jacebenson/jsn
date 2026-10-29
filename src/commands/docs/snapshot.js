// Shared, versioned docs artifact format. Never touches mutation history.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { getDocsDbPath, getDocsCacheDir } from './db.js';
import { docsReaderLease } from './locks.js';
import { ingestDocs } from './ingest.js';
import { installDatabase } from './replace.js';
export { installDatabase } from './replace.js';

export const SNAPSHOT_SCHEMA = 1;
export const DEFAULT_MANIFEST_URL = 'https://jsn.jace.pro/docs-index/manifest.json';
const MAX_COMPRESSED = 512 * 1024 * 1024;
const MAX_DATABASE = 2 * 1024 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateManifest(manifest) {
  if (manifest?.format !== 1 || manifest.schema !== SNAPSHOT_SCHEMA || manifest.cliCompatibility !== 'docs-schema-1') throw new Error('Incompatible docs snapshot format/schema');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !/^[a-f0-9]{7,64}$/.test(manifest.revision || '')) throw new Error('Invalid snapshot checksum or revision');
  for (const [field, max] of [['compressedBytes', MAX_COMPRESSED], ['databaseBytes', MAX_DATABASE]]) {
    if (!Number.isSafeInteger(manifest[field]) || manifest[field] <= 0 || manifest[field] > max) throw new Error(`Invalid snapshot ${field}`);
  }
  const url = new URL(manifest.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Snapshot downloads require HTTPS');
  return manifest;
}
export function validateDatabase(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Snapshot SQLite integrity check failed');
    if (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value !== String(SNAPSHOT_SCHEMA)) throw new Error('Incompatible snapshot database schema');
    const count = db.prepare('SELECT count(*) AS n FROM docs').get().n;
    if (!count) throw new Error('Snapshot index is empty');
    db.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'documentation' LIMIT 1").all();
    return count;
  } finally { db.close(); }
}
export function buildSnapshot({ docsDir, outputDir, revision, artifactBaseURL, embed = true }) {
  if (!/^[a-f0-9]{7,64}$/.test(revision || '')) throw new Error('A source commit revision is required');
  fs.mkdirSync(outputDir, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(outputDir, '.build-'));
  try {
    const filename = path.join(temporary, 'docs.db');
    const result = ingestDocs({ dbPath: filename, roots: [{ dir: docsDir, prefix: '' }], embed });
    if (result.errors || !result.count) throw new Error(`Docs build rejected: ${result.errors} ingestion errors, ${result.count} documents`);
    const db = new Database(filename);
    try {
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('snapshot_revision', ?)").run(revision);
      db.pragma('wal_checkpoint(TRUNCATE)'); db.pragma('journal_mode = DELETE');
    } finally { db.close(); }
    const documents = validateDatabase(filename);
    const bytes = fs.readFileSync(filename), compressed = gzipSync(bytes);
    const name = `docs-schema-${SNAPSHOT_SCHEMA}-${revision}.sqlite.gz`;
    const manifest = validateManifest({ format: 1, schema: SNAPSHOT_SCHEMA, cliCompatibility: 'docs-schema-1', revision,
      sha256: digest(compressed), compressedBytes: compressed.length, databaseBytes: bytes.length,
      documents, buildSeconds: result.secs, builtAt: new Date().toISOString(), url: new URL(name, artifactBaseURL.endsWith('/') ? artifactBaseURL : artifactBaseURL + '/').href });
    const artifact = path.join(outputDir, name);
    if (fs.existsSync(artifact) && digest(fs.readFileSync(artifact)) !== manifest.sha256) throw new Error('Immutable artifact already exists with different content');
    fs.writeFileSync(path.join(temporary, name), compressed);
    fs.renameSync(path.join(temporary, name), artifact);
    // Publish this manifest only after uploading the immutable artifact successfully.
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(path.join(temporary, 'manifest.json'), path.join(outputDir, 'manifest.json'));
    return manifest;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function download(url, maxBytes, fetchFn) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(120000) });
  if (response.url && new URL(response.url).protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(response.url).hostname)) throw new Error('Docs download redirected to insecure transport');
  if (!response.ok) throw new Error(`Docs download rejected (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Docs download exceeds size limit'); }
  const parts = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Docs download exceeds size limit');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export async function fetchManifest(url = DEFAULT_MANIFEST_URL, { fetchFn = fetch } = {}) {
  // Validate transport before making a request, including configured mirrors.
  validateManifest({ format: 1, schema: 1, cliCompatibility: 'docs-schema-1', revision: 'abcdef0', sha256: '0'.repeat(64), compressedBytes: 1, databaseBytes: 1, url });
  return validateManifest(JSON.parse((await download(url, 65536, fetchFn)).toString('utf8')));
}
export function snapshotEstimate(manifest) {
  return `${(manifest.compressedBytes / 1048576).toFixed(1)} MiB; estimated ${Math.max(1, Math.ceil(manifest.compressedBytes / 5242880))} seconds at 5 MiB/s plus verification (actual time varies)`;
}
export async function installSnapshot({ manifestURL = DEFAULT_MANIFEST_URL, manifest, dbPath = getDocsDbPath(), fetchFn = fetch } = {}) {
  manifest = manifest ? validateManifest(manifest) : await fetchManifest(manifestURL, { fetchFn });
  const compressed = await download(manifest.url, manifest.compressedBytes, fetchFn);
  if (compressed.length !== manifest.compressedBytes || digest(compressed) !== manifest.sha256) throw new Error('Docs snapshot checksum/size mismatch; existing index retained');
  const bytes = gunzipSync(compressed, { maxOutputLength: manifest.databaseBytes });
  if (bytes.length !== manifest.databaseBytes) throw new Error('Docs database size mismatch');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staged = `${dbPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staged, bytes, { mode: 0o600, flag: 'wx' });
    validateDatabase(staged);
    const db = new Database(staged, { readonly: true });
    try {
      if (db.prepare("SELECT value FROM meta WHERE key='snapshot_revision'").get()?.value !== manifest.revision) throw new Error('Snapshot source revision mismatch');
    } finally { db.close(); }
    const receipt = `${dbPath}.snapshot.json`, receiptStage = `${staged}.receipt`;
    try {
      fs.writeFileSync(receiptStage, JSON.stringify({ ...manifest, manifestURL, checkedAt: Date.now() }), { mode: 0o600 });
      installDatabase(staged, dbPath, { afterInstall: () => fs.renameSync(receiptStage, receipt) });
    } finally { fs.rmSync(receiptStage, { force: true }); }
    return { revision: manifest.revision, documents: manifest.documents, dbPath, source: 'snapshot' };
  } finally { fs.rmSync(staged, { force: true }); }
}
export function rollbackSnapshot(dbPath = getDocsDbPath()) {
  const previous = `${dbPath}.previous`;
  if (!fs.existsSync(previous)) throw new Error('No previous docs snapshot is available');
  validateDatabase(previous);
  const staged = `${dbPath}.${randomUUID()}.tmp`;
  try { fs.copyFileSync(previous, staged); installDatabase(staged, dbPath, { afterInstall: () => fs.rmSync(`${dbPath}.snapshot.json`, { force: true }) }); }
  finally { fs.rmSync(staged, { force: true }); }
  return { dbPath, rolledBack: true };
}
export function docsSnapshotStatus() {
  const receipt = path.join(getDocsCacheDir(), 'docs.db.snapshot.json');
  let release, db;
  try {
    release = docsReaderLease(getDocsDbPath());
    const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    db = new Database(getDocsDbPath(), { readonly: true, fileMustExist: true });
    return db.prepare("SELECT value FROM meta WHERE key='snapshot_revision'").get()?.value === value.revision ? value : null;
  } catch { return null; } finally { db?.close(); release?.(); }
}
