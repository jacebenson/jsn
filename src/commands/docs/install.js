import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { docsReaderLease } from './locks.js';
import { getDocsDbPath, getDocsCacheDir, getDocsSourceDir } from './db.js';
import { fetchManifest, installSnapshot, snapshotEstimate, validateDatabase, installDatabase, docsSnapshotStatus, DEFAULT_MANIFEST_URL } from './snapshot.js';
import { canUsePicker } from '../../helpers.js';
import { errUsageHint } from '../../errors.js';

export async function installDocumentation(source, options = {}) {
  if (source === 'skip') return { source, skipped: true };
  if (source === 'snapshot') {
    const manifestURL = options.manifestURL || DEFAULT_MANIFEST_URL;
    const manifest = options.manifest || await fetchManifest(manifestURL);
    process.stderr.write(`Prebuilt searchable database: ${snapshotEstimate(manifest)}.\n`);
    return installSnapshot({ manifestURL, manifest });
  }
  if (source !== 'github') throw errUsageHint('Choose a documentation source.', 'Use jsn docs install --source snapshot|github|skip');
  process.stderr.write('Raw GitHub source: approximately 51,000 files plus local indexing; estimated around five minutes (actual time and download size vary).\n');
  fs.mkdirSync(getDocsCacheDir(), { recursive: true });
  const staging = fs.mkdtempSync(path.join(getDocsCacheDir(), '.github-install-'));
  try {
    const { syncDocs } = await import('./sync.js');
    const { ingestDocs } = await import('./ingest.js');
    const repoDir = getDocsSourceDir(), dbPath = path.join(staging, 'docs.db');
    syncDocs({ repoDir, markdownDir: path.join(repoDir, 'markdown'), noIngest: true, embed: false });
    const releaseSource = docsReaderLease(repoDir);
    let result;
    try { result = ingestDocs({ dbPath, roots: [{ dir: path.join(repoDir, 'markdown'), prefix: '' }], embed: true }); }
    finally { releaseSource(); }
    if (result.errors) throw new Error('Raw documentation indexing failed; existing index retained');
    validateDatabase(dbPath);
    installDatabase(dbPath, getDocsDbPath(), { afterInstall: () => fs.rmSync(`${getDocsDbPath()}.snapshot.json`, { force: true }) });
    return { source, documents: result.count, dbPath: getDocsDbPath() };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
export async function chooseDocumentationSource() {
  const { select } = await import('../../prompts.js');
  return select({ message: 'Install optional offline documentation?', choices: [
    { name: 'Skip for now (first search will explain installation)', value: 'skip' },
    { name: 'Prebuilt searchable database from jsn.jace.pro (size and estimate before approval)', value: 'snapshot' },
    { name: 'GitHub raw source + local indexing (~51,000 files; estimated ~5 minutes)', value: 'github' },
  ] });
}
export async function offerDocumentation(_app, _argv = {}) {
  let source = await chooseDocumentationSource();
  let approvedManifest;
  if (source === 'snapshot') {
    try {
      const manifest = await fetchManifest(DEFAULT_MANIFEST_URL, { fetchFn: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }) });
      approvedManifest = manifest;
      const { confirm } = await import('../../prompts.js');
      if (!await confirm({ message: `Download prebuilt searchable database: ${snapshotEstimate(manifest)}?`, default: false })) source = 'skip';
    } catch {
      throw errUsageHint('Prebuilt documentation is unavailable; nothing downloaded.', 'Choose GitHub raw source with jsn docs install --source github, or retry the snapshot later.');
    }
  }
  return installDocumentation(source, { manifest: approvedManifest });
}
export async function ensureDocumentation(app, argv) {
  if (fs.existsSync(getDocsDbPath())) { scheduleFreshnessCheck(); return; }
  if (!canUsePicker(app, argv)) throw errUsageHint('No local documentation index. Documentation installation is optional and requires a source choice.',
    'Run jsn docs install --source snapshot for a verified prebuilt database, or --source github for raw files + local indexing (estimated ~5 minutes). Use --source skip to defer.');
  const result = await offerDocumentation(app, argv);
  if (result.skipped) throw errUsageHint('Documentation installation skipped.', 'Run jsn docs install --source snapshot|github when ready.');
}
export function scheduleFreshnessCheck() {
  if (process.env.JSN_NO_DOCS_CHECK === '1') return;
  const receipt = docsSnapshotStatus();
  if (!receipt) return;
  try {
    const stamp = `${getDocsDbPath()}.check-stamp`;
    try {
      if (Date.now() - fs.statSync(stamp).mtimeMs < 86400000) return;
      fs.rmSync(stamp);
    } catch (error) { if (error.code !== 'ENOENT') return; }
    fs.writeFileSync(stamp, '', { flag: 'wx' });
    // A separate bounded worker prevents network from delaying local search.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./snapshot-check.js', import.meta.url)), getDocsDbPath()], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* Local search remains available offline. */ }
}
