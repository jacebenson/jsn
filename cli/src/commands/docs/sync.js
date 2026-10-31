// Clone or update the ServiceNow docs repo locally.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDocsSourceDir, getDocsSourceMarkdownDir, getDocsDbPath, docsDbExists } from './db.js';
import { ingestDocs } from './ingest.js';
import { refreshDocs } from './refresh.js';

const REPO_URL = 'https://github.com/ServiceNow/ServiceNowDocs';
const BRANCH = 'australia';

function git(args, cwd, stdio = 'inherit') {
  const r = spawnSync('git', args, { cwd, stdio });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('git is not installed. Install git to sync docs, or download the docs repo manually.');
  }
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${r.status}).`);
  }
}

export function syncDocs(opts = {}) {
  const repoDir = opts.repoDir || getDocsSourceDir();
  const markdownDir = opts.markdownDir || getDocsSourceMarkdownDir();
  const dbPath = opts.dbPath || getDocsDbPath();
  const embed = opts.embed !== false;
  const noIngest = opts.noIngest === true;

  const initialStatus = {
    clone: !fs.existsSync(path.join(repoDir, '.git')),
    docsApprox: 45000,
    willEmbed: embed && noIngest === false,
    minutesHint: embed ? 3 : 1,
  };

  process.stderr.write('Note: docs sync downloads ~45k markdown files and builds an FTS5 + HRR index. ');
  process.stderr.write(`This normally takes ${initialStatus.minutesHint}-${initialStatus.minutesHint + 2} minutes.\n`);
  if (initialStatus.willEmbed) {
    process.stderr.write('Pass --no-embed to skip semantic embeddings and finish faster.\n');
  }
  process.stderr.write('\n');

  if (!initialStatus.clone) {
    process.stderr.write(`Updating existing clone at ${repoDir} ...\n`);
    git(['-C', repoDir, 'pull', '--ff-only'], repoDir, 'inherit');
  } else {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    process.stderr.write(`Cloning ${REPO_URL} (branch ${BRANCH}) into ${repoDir} ...\n`);
    git([
      'clone',
      '--depth', '1',
      '--branch', BRANCH,
      '--config', 'core.longpaths=true',
      REPO_URL,
      repoDir,
    ], undefined, 'inherit');
  }

  if (!fs.existsSync(markdownDir)) {
    throw new Error(`Expected markdown folder not found at ${markdownDir}.`);
  }

  if (noIngest) {
    return { repoDir, markdownDir, dbPath, ingested: false, note: 'Run without --no-ingest to build the index.' };
  }

  // If the DB already exists, use incremental refresh. Otherwise, full ingest.
  if (docsDbExists()) {
    process.stderr.write(`Docs DB found — running incremental refresh...\n`);
    const result = refreshDocs({ docsDir: markdownDir, dbPath });
    return { repoDir, markdownDir, dbPath, ingested: true, incremental: true, ...result };
  }

  process.stderr.write('No existing DB — running full ingest...\n');
  const result = ingestDocs({ docsDir: markdownDir, dbPath, embed });
  return { repoDir, markdownDir, dbPath, ingested: true, incremental: false, ...result };
}
