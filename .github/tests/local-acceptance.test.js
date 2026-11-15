import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseOptions, runLocal } from '../scripts/run-acceptance.mjs';
import { publishResults, projectionDigest } from '../scripts/acceptance/publish.mjs';

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
      const local = JSON.parse(fs.readFileSync(path.join(output, 'local-summary.json')));
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
