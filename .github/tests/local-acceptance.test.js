import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FILES, HARNESS_SHA } from '../scripts/acceptance/prepare.mjs';
import { parseOptions, runLocal, selectedExitCode, acquireArtifact, stageHarness } from '../scripts/run-acceptance.mjs';
import { publishResults, projectionDigest, validateProjection } from '../scripts/acceptance/publish.mjs';

test('adapter rejects nonpassing selected outcomes and unverified artifacts', async () => {
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
  assert.equal(parseOptions(['--mode', 'full', '--profile', 'vendor', '--target', 'vendor1']).mode, 'full');
  assert.equal(parseOptions(['--profile', 'vendor', '--target', 'vendor1']).mode, 'full');
  const first = parseOptions(['--version', '5.5.5', '--profile', 'vendor', '--target', 'vendor1']);
  const second = parseOptions(['--version', '5.5.5', '--profile', 'vendor', '--target', 'vendor1']);
  assert.notEqual(first.output, second.output);
  assert.equal(path.dirname(first.output), path.join(os.homedir(), 'private-acceptance'));
  assert.deepEqual(parseOptions(['--publish', '--result', 'out']), { publish: true, result: 'out' });
});

test('immutable producer bytes and source guard survive candidate adaptation', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'acceptance-guard-'));
  try {
    const harness = stageHarness(root, '5.5.5');
    for (const file of FILES) assert.deepEqual(fs.readFileSync(path.join(harness, file)), execFileSync('git', ['show', `${HARNESS_SHA}:${file}`], { maxBuffer: 16 * 1024 * 1024 }));
    const support = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/support.mjs')));
    const foreign = path.join(root, 'foreign');
    for (const file of ['src', 'bin', 'package.json']) fs.cpSync(path.join(harness, 'cli', file), path.join(foreign, file), { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(foreign, 'package.json'))); pkg.version = '9.9.9';
    fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify(pkg));
    assert.throws(() => support.createContext({ profile: 'acceptance', mode: 'readonly', outputDir: path.join(root, 'bad'), cliPath: path.join(foreign, 'bin/jsn.js') }, { target: 'http://127.0.0.1' }), /source provenance/);
    let dispatches = 0;
    const ctx = support.createContext({ profile: 'acceptance', mode: 'readonly', outputDir: path.join(root, 'good') }, { target: 'http://127.0.0.1' }, { execute: async () => { dispatches++; throw Error('unexpected dispatch'); } });
    for (const args of [['records', 'delete', '--table', 'sys_user', '--sys-id', 'a'.repeat(32)], ['version', '--instance', 'private-target'], ['records', 'list', '--table', 'sys_user', '--query', 'javascript:evil()']]) await assert.rejects(ctx.command(args));
    assert.equal(dispatches, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
  // This provider deliberately implements stateless Bearer GETs, not UI sessions.
  const old = { JSN_ALWAYS_WARM_SESSION: process.env.JSN_ALWAYS_WARM_SESSION, SERVICENOW_INSTANCE_URL: process.env.SERVICENOW_INSTANCE_URL, SERVICENOW_OAUTH_TOKEN: process.env.SERVICENOW_OAUTH_TOKEN };
  process.env.JSN_ALWAYS_WARM_SESSION = '0';
  process.env.SERVICENOW_INSTANCE_URL = origin; process.env.SERVICENOW_OAUTH_TOKEN = token;
  try {
    for (const version of [undefined, '5.5.5']) {
      const output = path.join(root, version || 'checkout');
      const result = await runLocal({ mode: 'readonly', version, target: 'vendor-1', output });
      const payload = JSON.parse(fs.readFileSync(result.file));
      const expectedVersion = version || JSON.parse(fs.readFileSync(new URL('../../cli/package.json', import.meta.url))).version;
      // v5.5.7 removed `jsn history`; the checkout candidate retires its scenario
      // while the published 5.5.5 artifact keeps the original obligation.
      const expectedCount = version ? 71 : 70;
      assert.equal(payload.provenance.version, expectedVersion);
      assert.equal(payload.results.find(r => r.id === 'readonly.records').status, 'passed');
      assert.equal(payload.summary.complete, false);
      assert.equal(payload.results.length, expectedCount);
      assert.equal(payload.selection.full, true);
      assert.equal(payload.results.find(r => r.id === 'local.version').status, 'passed');
      assert.equal(payload.results.find(r => r.id === (version ? 'local.completion' : 'local.discovery-help')).status, 'passed');
      assert.equal(payload.results.some(r => r.id === 'local.history-empty'), Boolean(version));
      assert.equal(payload.summary.missingCount > 1, true);
      assert.notEqual(selectedExitCode(payload.summary), 0); // Fixture covers metadata only, not fabricated full provider behavior.
      assert.equal(payload.environment.release.family, 'Zurich');
      const poisoned = structuredClone(payload); poisoned.environment.release.build = 'https://private-host.example';
      assert.throws(() => validateProjection(poisoned));
      const local = JSON.parse(fs.readFileSync(path.join(output, 'local-summary.json')));
      assert.equal(local.coverage.missing.length, payload.summary.missingCount);
      assert.ok(local.humanMeasurementsPassed >= 2);
      assert.equal(local.coverage.applicableSelectedMode, expectedCount);
      assert.deepEqual(local.coverage.omittedReadonly, []);
      assert.equal(new Set(payload.selection.selected).size, expectedCount);
      assert.deepEqual(payload.results.map(r => r.id), payload.selection.selected);
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
    const failed = await runLocal({ mode: 'readonly', target: 'vendor-2', output: path.join(root, 'rejected') });
    const rejectedText = fs.readdirSync(path.dirname(failed.file)).map(name => fs.readFileSync(path.join(path.dirname(failed.file), name), 'utf8')).join('');
    for (const secret of [token, origin, 'private-host-canary', 'private-user-canary']) assert.equal(rejectedText.includes(secret), false);
    assert.notEqual(failed.summary.counts.passed, failed.summary.total);
    assert.notEqual(selectedExitCode(failed.summary), 0);
    assert.equal((await publishResults({ file: failed.file, url: `${origin}/api/acceptance/runs`, token })).ok, true);
    assert.equal(stored.summary.complete, false);
    mode = 200;
    const restored = await runLocal({ mode: 'readonly', target: 'vendor-2', output: path.join(root, 'restored') });
    assert.equal(JSON.parse(fs.readFileSync(restored.file)).results.find(r => r.id === 'readonly.records').status, 'passed');
    assert.equal(restored.summary.total, 70);
    assert.equal(requests.filter(r => !r.path.startsWith('/api/acceptance/') && !r.path.startsWith('/results/')).every(r => r.method === 'GET'), true);
    await assert.rejects(runLocal({ mode: 'readonly', target: 'vendor-1', output: path.join(root, 'checkout') }));
    // Keep sanitized evidence only when explicitly requested by the developer.
    if (process.env.JSN_LOCAL_FIXTURE_EVIDENCE) fs.cpSync(root, process.env.JSN_LOCAL_FIXTURE_EVIDENCE, { recursive: true });
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});
