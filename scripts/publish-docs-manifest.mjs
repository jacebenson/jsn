import fs from 'node:fs';
import { validateManifest } from '../src/commands/docs/snapshot.js';
const manifest = validateManifest(JSON.parse(fs.readFileSync(process.argv[2])));
const base = process.env.DOCS_SITE_URL || 'https://jsn.jace.pro';
if (new URL(base).protocol !== 'https:') throw new Error('Publisher requires HTTPS');
if (!process.env.DOCS_PUBLISH_TOKEN) throw new Error('Configure DOCS_PUBLISH_TOKEN before promoting a snapshot; uploaded immutable release remains available');
const response = await fetch(new URL('/internal/docs-builds', base), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.DOCS_PUBLISH_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ revision: manifest.revision, state: 'published', manifest }),
});
if (!response.ok) throw new Error(`Manifest promotion rejected (HTTP ${response.status}); last known-good manifest retained`);
process.stdout.write(`Promoted verified docs source revision ${manifest.revision}.\n`);
