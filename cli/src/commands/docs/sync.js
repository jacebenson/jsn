// Clone or update the ServiceNow docs repo locally.

import fs from 'node:fs';
import path from 'node:path';
import { docsInstallLease, docsHaveReaders } from './locks.js';
import { spawnSync } from 'node:child_process';
import { getDocsSourceDir, getDocsSourceMarkdownDir, resolveDocsDbPath, resolveDocsRelease, withDocsDb, setMeta } from './db.js';
import { ingestDocs } from './ingest.js';
import { refreshDocs } from './refresh.js';

const REPO_URL = 'https://github.com/ServiceNow/ServiceNowDocs';

function git(args, cwd, stdio = 'inherit') {
  const r = spawnSync('git', args, { cwd, stdio: stdio === 'inherit' ? ['ignore', 2, 2] : stdio });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('git is not installed. Install git to sync docs, or download the docs repo manually.');
  }
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${r.status}).`);
  }
}

export function syncDocs(opts = {}) {
  const repoDir = opts.repoDir || getDocsSourceDir(opts.release);
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  const release = docsInstallLease(repoDir);
  try {
    if (docsHaveReaders(repoDir)) throw new Error('Raw documentation source is in use; retry after the current refresh finishes.');
    return syncDocsLocked(opts);
  } finally { release(); }
}
function syncDocsLocked(opts = {}) {
  const repoDir = opts.repoDir || getDocsSourceDir(opts.release);
  const markdownDir = opts.markdownDir || getDocsSourceMarkdownDir(opts.release);
  const dbPath = opts.dbPath || resolveDocsDbPath(opts.release);
  const branch = resolveDocsRelease(opts.release);
  const embed = opts.embed !== false;
  const noIngest = opts.noIngest === true;

  const initialStatus = {
    clone: !fs.existsSync(path.join(repoDir, '.git')),
    docsApprox: 51000,
    willEmbed: embed && noIngest === false,
    minutesHint: embed ? 5 : 1,
  };

  process.stderr.write('Note: docs sync downloads ~51k markdown files and builds an FTS5 + HRR index. ');
  process.stderr.write(`Estimated ${embed ? '5–25' : '1–5'} minutes; actual time varies by host and indexing options.\n`);
  if (initialStatus.willEmbed) {
    process.stderr.write('Pass --no-embed to skip semantic embeddings and finish faster.\n');
  }
  process.stderr.write('\n');

  if (!initialStatus.clone) {
    process.stderr.write(`Updating existing clone at ${repoDir} ...\n`);
    git(['-C', repoDir, 'fetch', 'origin', branch], repoDir, 'inherit');
    git(['-C', repoDir, 'checkout', branch], repoDir, 'inherit');
    git(['-C', repoDir, 'merge', '--ff-only', 'FETCH_HEAD'], repoDir, 'inherit');
  } else {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    process.stderr.write(`Cloning ${REPO_URL} (branch ${branch}) into ${repoDir} ...\n`);
    git([
      'clone',
      '--depth', '1',
      '--branch', branch,
      '--config', 'core.longpaths=true',
      REPO_URL,
      repoDir,
    ], undefined, 'inherit');
  }

  if (!fs.existsSync(markdownDir)) {
    throw new Error(`Expected markdown folder not found at ${markdownDir}.`);
  }

  const revisionResult = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revisionResult.status !== 0) throw new Error('Could not read documentation source revision.');
  const revision = revisionResult.stdout.trim();
  const recordRevision = () => withDocsDb({ dbPath }, db => { setMeta(db, 'source_revision', revision); setMeta(db, 'source_branch', branch); });

  if (noIngest) {
    return { repoDir, markdownDir, dbPath, ingested: false, note: 'Run without --no-ingest to build the index.' };
  }

  // If the DB already exists, use incremental refresh. Otherwise, full ingest.
  if (fs.existsSync(dbPath)) {
    process.stderr.write(`Docs DB found — running incremental refresh...\n`);
    const result = refreshDocs({ release: branch, docsDir: markdownDir, dbPath, sourceResource: repoDir, sourceLeaseHeld: true });
    recordRevision();
    return { repoDir, markdownDir, dbPath, revision, ingested: true, incremental: true, ...result };
  }

  process.stderr.write('No existing DB — running full ingest...\n');
  const result = ingestDocs({ release: branch, docsDir: markdownDir, dbPath, embed, sourceResource: repoDir, sourceLeaseHeld: true });
  recordRevision();
  return { repoDir, markdownDir, dbPath, revision, ingested: true, incremental: false, ...result };
}
