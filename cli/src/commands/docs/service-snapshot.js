// Publish a portable backup of the live service index, without re-ingesting docs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { validateDatabase, validateManifest } from './snapshot.js';

export async function publishServiceSnapshot(storage) {
  const output = path.join(storage, 'snapshots');
  fs.mkdirSync(output, { recursive: true });
  const db = new Database(path.join(storage, 'docs.sqlite3'), { readonly: true, fileMustExist: true });
  const temporary = fs.mkdtempSync(path.join(output, '.export-'));
  try {
    const revision = db.prepare("SELECT value FROM meta WHERE key='source_revision'").get()?.value;
    if (!/^[a-f0-9]{7,64}$/.test(revision || '')) throw new Error('Index has no valid source revision');
    try {
      const cached = validateManifest(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')));
      if (cached.revision === revision && fs.existsSync(path.join(output, path.basename(cached.url)))) return cached;
    } catch { /* no published snapshot yet */ }
    const filename = path.join(temporary, 'docs.sqlite3');
    await db.backup(filename);
    const copy = new Database(filename);
    try {
      copy.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('snapshot_revision', ?)").run(revision);
      copy.pragma('wal_checkpoint(TRUNCATE)');
      copy.pragma('journal_mode = DELETE');
    } finally { copy.close(); }
    const documents = validateDatabase(filename);
    const bytes = fs.readFileSync(filename);
    const compressed = gzipSync(bytes);
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    const name = `docs-${revision}-${sha256}.sqlite.gz`;
    const manifest = validateManifest({ format: 1, schema: 1, cliCompatibility: 'docs-schema-1', revision,
      documents, sha256, compressedBytes: compressed.length, databaseBytes: bytes.length,
      builtAt: new Date().toISOString(), url: `https://jsn.jace.pro/docs-index/artifacts/${name}` });
    fs.writeFileSync(path.join(temporary, name), compressed);
    fs.renameSync(path.join(temporary, name), path.join(output, name));
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest) + '\n');
    fs.renameSync(path.join(temporary, 'manifest.json'), path.join(output, 'manifest.json'));
    return manifest;
  } finally { db.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
