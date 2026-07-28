// Clone or update the ServiceNow docs repo locally.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDocsSourceDir, getDocsSourceMarkdownDir, getDocsDbPath } from './db.js';
import { ingestDocs } from './ingest.js';

const REPO_URL = 'https://github.com/ServiceNow/ServiceNowDocs';
const BRANCH = 'australia';

function git(args, cwd, stdio = 'inherit') {
  const r = spawnSync('git', args, { cwd, stdio });
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

  if (fs.existsSync(path.join(repoDir, '.git'))) {
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
    return { repoDir, markdownDir, dbPath, ingested: false };
  }

  process.stderr.write('Ingesting markdown into docs.db...\n');
  const result = ingestDocs({ docsDir: markdownDir, dbPath, embed });
  return { repoDir, markdownDir, dbPath, ingested: true, ...result };
}
