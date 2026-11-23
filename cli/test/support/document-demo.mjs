// Reproducible synthetic example. Never contacts a real ServiceNow instance.
// node cli/test/support/document-demo.mjs <existing-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { documentFixture } from './document-fixture.js';
import { renderInstanceDocumentation } from '../../src/instance-documentation.js';

const output = path.resolve(process.argv[2]);
if (!fs.statSync(output).isDirectory()) throw new Error('Supply an existing output directory.');
const fixture = await documentFixture();
const transcript = ['Synthetic fixture only. All requests use an isolated loopback provider.'];
try {
  const command = ['document', 'instance', '--profile', 'synthetic'];
  const destination = path.join(output, 'synthetic-instance.md');
  const result = await fixture.run([...command, '--output', destination, '--json']);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), envelope.data.markdown);
  assert.equal(renderInstanceDocumentation(JSON.parse(JSON.stringify(envelope.data))), envelope.data.markdown);
  transcript.push(`$ node cli/bin/jsn.js ${[...command, '--output', destination, '--json'].join(' ')}`, 'exit 0', result.stdout);
  fs.writeFileSync(path.join(output, 'synthetic-evidence.json'), result.stdout, { flag: 'wx', mode: 0o600 });
  for (const flags of [['--format', 'markdown'], ['--format', 'styled'], ['--get', 'data.release_identity']]) {
    const run = await fixture.run([...command, ...flags]);
    transcript.push(`$ node cli/bin/jsn.js ${[...command, ...flags].join(' ')}`, 'exit 0', run.stdout);
  }
  assert.deepEqual(fixture.violations, []);
  assert.ok(fixture.requests.every(r => r.method === 'GET' || r.path === '/angular.do'));
  fs.writeFileSync(path.join(output, 'synthetic-requests.json'), JSON.stringify(fixture.requests, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'synthetic-transcript.txt'), transcript.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ synthetic: true, applications: envelope.data.applications.length, portal_relations: envelope.data.portal_relations.length, requests_used: envelope.data.requests_used, provider_data_mutations: 0, deterministic_replay: true, output }));
} finally { await fixture.close(); }
