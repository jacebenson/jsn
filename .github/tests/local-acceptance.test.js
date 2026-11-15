import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseOptions, runLocal, allowedCommand, selectedExitCode, acquireArtifact } from '../scripts/run-acceptance.mjs';
import { publishResults, projectionDigest, validateProjection } from '../scripts/acceptance/publish.mjs';

test('adapter denies command drift and nonpassing selected outcomes', async () => {
  for (const args of [['completion'], ['records', 'delete'], ['records', 'list', '--table', 'sys_user'], ['version', '--instance', 'evil'], ['records', 'list', '--query', 'javascript:gs.now()']]) assert.equal(allowedCommand(args), false);
  for (const status of ['blocked-prerequisite', 'blocked-access', 'blocked-capability', 'excluded-mode', 'not-run', 'unsupported', 'failed']) assert.notEqual(selectedExitCode({ total: 1, counts: { [status]: 1 } }), 0);
  assert.equal(selectedExitCode({ total: 1, counts: { passed: 1 } }), 0);
  for (const version of ['latest', '^5.5.5', '5.5.5 --eval']) await assert.rejects(acquireArtifact(version, '/unused'));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: '@jacebenson/jsn', version: '5.5.4' }) });
    await assert.rejects(acquireArtifact('5.5.5', '/unused'));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: '@jacebenson/jsn', version: '5.5.5', gitHead: 'a'.repeat(40), dist: { integrity: 'sha512-' + 'A'.repeat(86) + '==', tarball: 'https://registry.npmjs.org/package.tgz' } }), arrayBuffer: async () => Buffer.from('tampered archive') });
    await assert.rejects(acquireArtifact('5.5.5', '/unused'));
  } finally { globalThis.fetch = original; }
});

test('local options require exact versions, target labels and explicit publication', () => {
  for (const version of ['latest', '^5.5.5', '5', '5.5.5 --eval']) assert.throws(() => parseOptions(['--version', version, '--target', 'vendor-1', '--output', 'out']));
  assert.throws(() => parseOptions(['--result', 'out']));
  assert.deepEqual(parseOptions(['--publish', '--result', 'out']), { publish: true, result: 'out' });
});

test('actual checkout and npm 5.5.5 execute bounded readonly scenarios, sanitized retention and exact publish readback', { timeout: 240000 }, async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'local-acceptance-test-'));
  const token = 'private-token-canary-'.repeat(3), id = 'a'.repeat(32), record = { sys_id: id, name: 'sys_user' };
  let mode = 200, stored, marker = true; const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/acceptance/runs') {
      let text = ''; for await (const chunk of req) text += chunk;
      assert.equal(req.headers.authorization, `Bearer ${token}`); stored = JSON.parse(text);
      res.writeHead(201); res.end(JSON.stringify({ status: 'accepted', runKey: stored.runKey })); return;
    }
    if (req.url.startsWith('/results/')) {
      assert.equal(req.headers.authorization, undefined);
      res.end(marker ? `<div data-run-key="${stored.runKey}" data-payload-digest="${projectionDigest(stored)}">${stored.provenance.version} ${stored.provenance.sourceSHA}</div>` : 'old renderer'); return;
    }
    assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(mode);
    res.end(JSON.stringify(mode === 200 ? { result: req.url.includes('/table/sys_properties') ? [{ name: 'glide.buildname', value: 'Zurich' }, { name: 'glide.buildtag', value: 'glide-zurich-01' }] : req.url.includes(`/sys_db_object/${id}`) ? record : [record] } : { error: { message: 'private-host-canary.example private-user-canary' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const old = { SERVICENOW_INSTANCE_URL: process.env.SERVICENOW_INSTANCE_URL, SERVICENOW_OAUTH_TOKEN: process.env.SERVICENOW_OAUTH_TOKEN };
  process.env.SERVICENOW_INSTANCE_URL = origin; process.env.SERVICENOW_OAUTH_TOKEN = token;
  try {
    for (const version of [undefined, '5.5.5']) {
      const output = path.join(root, version || 'checkout');
      const result = await runLocal({ version, target: 'vendor-1', output });
      const payload = JSON.parse(fs.readFileSync(result.file));
      assert.equal(payload.provenance.version, '5.5.5');
      assert.equal(payload.results.find(r => r.id === 'readonly.records').status, 'passed');
      assert.equal(payload.summary.complete, false);
      assert.equal(payload.results.length, 4);
      assert.equal(payload.results.find(r => r.id === 'local.version').status, 'passed');
      assert.equal(payload.results.some(r => r.id === 'local.completion'), false);
      assert.equal(payload.summary.missingCount > 1, true);
      assert.equal(selectedExitCode(payload.summary), 0);
      assert.equal(payload.environment.release.family, 'Zurich');
      const poisoned = structuredClone(payload); poisoned.environment.release.build = 'https://private-host.example';
      assert.throws(() => validateProjection(poisoned));
      const local = JSON.parse(fs.readFileSync(path.join(output, 'local-summary.json')));
      assert.equal(local.coverage.missing.length, payload.summary.missingCount);
      assert.equal(local.humanMeasurementsPassed, 2);
      assert.equal(local.release.family, 'Zurich');
      assert.equal(local.release.fields.family, 'glide.buildname');
      assert.equal(local.release.patch, null);
      assert.equal(local.testedArtifact.kind, version ? 'npm' : 'checkout');
      if (version) assert.match(local.testedArtifact.integrity, /^sha512-/);
      const retained = fs.readdirSync(output).map(name => fs.readFileSync(path.join(output, name), 'utf8')).join('');
      for (const canary of [origin, token, 'private-user-canary', 'private-host-canary', 'instance_url']) assert.equal(retained.includes(canary), false);
      assert.equal((await publishResults({ file: result.file, url: `${origin}/api/acceptance/runs`, token })).ok, true);
      marker = false;
      assert.equal((await publishResults({ file: result.file, url: `${origin}/api/acceptance/runs`, token })).result, 'readback-failed'); marker = true;
    }
    mode = 401;
    const failed = await runLocal({ target: 'vendor-2', output: path.join(root, 'rejected') });
    const rejectedText = fs.readdirSync(path.dirname(failed.file)).map(name => fs.readFileSync(path.join(path.dirname(failed.file), name), 'utf8')).join('');
    for (const secret of [token, origin, 'private-host-canary', 'private-user-canary']) assert.equal(rejectedText.includes(secret), false);
    assert.notEqual(failed.summary.counts.passed, failed.summary.total);
    assert.notEqual(selectedExitCode(failed.summary), 0);
    assert.equal((await publishResults({ file: failed.file, url: `${origin}/api/acceptance/runs`, token })).ok, true);
    assert.equal(stored.summary.complete, false);
    assert.equal(requests.filter(r => !r.path.startsWith('/api/acceptance/') && !r.path.startsWith('/results/')).every(r => r.method === 'GET'), true);
    await assert.rejects(runLocal({ target: 'vendor-1', output: path.join(root, 'checkout') }));
    // Keep sanitized evidence only when explicitly requested by the developer.
    if (process.env.JSN_LOCAL_FIXTURE_EVIDENCE) fs.cpSync(root, process.env.JSN_LOCAL_FIXTURE_EVIDENCE, { recursive: true });
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});
