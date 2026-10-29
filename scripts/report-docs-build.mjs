import { errUsage } from '../src/errors.js';
const [revision, state] = process.argv.slice(2);
if (!/^[a-f0-9]{7,64}$/.test(revision || '') || !['building', 'failed'].includes(state)) throw errUsage('Expected source revision and building|failed');
if (!process.env.DOCS_PUBLISH_TOKEN) { process.stdout.write('Build metadata reporting skipped: publisher is not configured.\n'); process.exit(0); }
const base = process.env.DOCS_SITE_URL || 'https://jsn.jace.pro';
if (new URL(base).protocol !== 'https:') throw new Error('Publisher requires HTTPS');
const response = await fetch(new URL('/internal/docs-builds', base), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
  headers: { Authorization: `Bearer ${process.env.DOCS_PUBLISH_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ revision, state }),
});
if (!response.ok) throw new Error(`Build state reporting rejected (HTTP ${response.status})`);
process.stdout.write(`Recorded docs build state ${state}.\n`);
