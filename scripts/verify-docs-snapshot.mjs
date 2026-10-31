import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSnapshot, validateManifest } from '../cli/src/commands/docs/snapshot.js';
const directory = process.argv[2];
const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-snapshot-verify-'));
try {
  await installSnapshot({ manifest, dbPath: path.join(temporary, 'docs.db'), fetchFn: async url => {
    if (url !== manifest.url) throw new Error('Unexpected verification URL');
    return new Response(fs.readFileSync(path.join(directory, path.basename(new URL(url).pathname))));
  } });
  process.stdout.write(`Verified schema ${manifest.schema}, revision ${manifest.revision}, ${manifest.documents} indexed documents.\n`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
