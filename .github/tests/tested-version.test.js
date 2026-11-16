import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseTestedVersion, testedVersion, checkoutIdentity } from '../scripts/acceptance/tested-version.mjs';
import { validateProjection } from '../scripts/acceptance/publish.mjs';
import { runAndPublish } from '../scripts/acceptance/ci.mjs';

const sha = 'a'.repeat(40);
const harness = 'b'.repeat(40);
test('executed CLI prerelease survives parsing, public validation and publication', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tested-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'cli.cjs');
  fs.writeFileSync(cli, `if (process.argv.slice(2).join(' ') !== 'version --json') process.exit(1); console.log(JSON.stringify({ok:true,data:{version:'5.5.5-dev.197.1'}}));`);
  const version = testedVersion(cli);
  assert.equal(version, '5.5.5-dev.197.1');
  const payload = { schemaVersion: 1, runKey: `acceptance_${'c'.repeat(32)}`, mode: 'readonly', provenance: { sourceSHA: sha, version, node: process.version, binarySHA256: 'd'.repeat(64), sourceDirty: false }, platform: 'linux', environment: { domainSeparation: 'UNKNOWN' }, selection: { full: false, selected: ['readonly.records'] }, summary: { total: 1, counts: { passed: 1 }, complete: true, missingCount: 0 }, performance: null, results: [{ id: 'readonly.records', status: 'passed', durationMs: 1 }] };
  assert.equal(validateProjection(payload).provenance.version, version);
  const file = path.join(dir, 'private.json');
  const publicFile = path.join(dir, 'public.json');
  const evidenceFile = path.join(dir, 'executed.jsonl');
  fs.writeFileSync(file, JSON.stringify(payload));
  fs.writeFileSync(evidenceFile, JSON.stringify({ runKey: payload.runKey, id: 'readonly.records' }));
  const code = await runAndPublish({ run: async () => 0, file, publicFile, evidenceFile, expectedSHA: sha, publish: async ({ file: published }) => {
    assert.equal(JSON.parse(fs.readFileSync(published)).provenance.version, version);
    return { ok: true, result: 'accepted' };
  } });
  assert.equal(code, 0);
  const identity = checkoutIdentity(payload.provenance, harness);
  assert.ok(identity.includes(`CLI ${version}`));
  assert.ok(identity.includes(`Source commit: ${sha}`));
  assert.ok(identity.includes(`Harness commit: ${harness}`));
  assert.ok(identity.includes('npm channel: not tested'));
});

test('version parsing refuses prose, unsafe strings and unsuccessful envelopes', () => {
  for (const value of ['5.5.5-dev.197.1', '5.5.5', '5.5.5-rc.1']) assert.equal(parseTestedVersion(JSON.stringify({ ok: true, data: { version: value } })), value);
  for (const value of ['5.5.5\nsecret', '5.5.5-<script>', '', '5.5']) assert.throws(() => parseTestedVersion(JSON.stringify({ ok: true, data: { version: value } })));
  assert.throws(() => parseTestedVersion('5.5.5-dev.197.1'));
  assert.throws(() => parseTestedVersion(JSON.stringify({ ok: false, data: { version: '5.5.5' } })));
});
