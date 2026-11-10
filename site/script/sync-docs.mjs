// Compatibility entry point for the website's scheduled task. One family is
// built per invocation; the Rails worker owns the registry and state file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { syncDocumentation } from '../../cli/src/commands/docs/sync-service.js';
import { publishServiceSnapshot } from '../../cli/src/commands/docs/service-snapshot.js';

export { syncDocumentation };

const Database = createRequire(new URL('../../cli/package.json', import.meta.url))('better-sqlite3');

function validateFamily(storage, family) {
  const matches = value => value === family || (value == null && family === 'australia');
  const dbPath = path.join(storage, 'docs.sqlite3');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const branch = db.prepare("SELECT value FROM meta WHERE key='source_branch'").get()?.value;
      if (!matches(branch)) throw new Error('Documentation family metadata is missing or mismatched');
    } finally { db.close(); }
  }
  for (const file of ['status.json', 'snapshots/manifest.json']) {
    if (!fs.existsSync(path.join(storage, file))) continue;
    const value = JSON.parse(fs.readFileSync(path.join(storage, file), 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object' || !matches(value.release)) {
      throw new Error('Documentation family metadata is missing or mismatched');
    }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

// The frozen service engine resolves a released index through JSN_DATA_HOME,
// which would place it outside DOCS_STORAGE_DIR. The site therefore builds each
// family in its own storage directory and stamps the family onto the published
// metadata. Removing this stamp is what the CLI validates as a mismatched
// snapshot, so it must happen atomically with the publication.
function stampRelease(storage, family) {
  const statusPath = path.join(storage, 'status.json');
  const status = readJson(statusPath) || {};
  if (status.release !== family) writeJson(statusPath, { ...status, release: family });

  const manifestPath = path.join(storage, 'snapshots/manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) throw new Error('The sync published no snapshot manifest');
  if (manifest.release !== family) writeJson(manifestPath, { ...manifest, release: family });
}

// Run one family's build (or re-publish its existing index) inside its own
// storage directory. The engine's release-aware path resolver is deliberately
// bypassed so the index stays at <storage>/docs.sqlite3 for every family.
export async function syncFamily({ storage, family, source, republish = false } = {}) {
  if (!family) throw new Error('A documentation release family is required');
  validateFamily(storage, family);
  fs.mkdirSync(storage, { recursive: true });
  const previousRelease = process.env.JSN_DOCS_RELEASE;
  delete process.env.JSN_DOCS_RELEASE;
  try {
    if (republish) {
      const manifest = await publishServiceSnapshot(storage, { dbPath: path.join(storage, 'docs.sqlite3'), release: family });
      const previous = readJson(path.join(storage, 'status.json')) || {};
      const status = { ...previous, release: family, state: 'ready', revision: manifest.revision,
        documents: manifest.documents, checkedAt: new Date().toISOString(), changed: false, error: null };
      writeJson(path.join(storage, 'status.json'), status);
      return status;
    }
    await syncDocumentation({ storage, source, branch: family });
    stampRelease(storage, family);
    return readJson(path.join(storage, 'status.json')) || { state: 'ready', release: family };
  } finally {
    if (previousRelease !== undefined) process.env.JSN_DOCS_RELEASE = previousRelease;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const family = process.argv[2];
  const storage = process.env.DOCS_STORAGE_DIR || path.join(process.cwd(), 'storage/docs');
  try {
    const result = family
      ? await syncFamily({ storage, family, source: process.env.DOCS_SOURCE_URL, republish: process.argv.includes('--republish') })
      : await syncDocumentation();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
