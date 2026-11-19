import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSchedule } from '../src/subscriptions.js';
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const records = JSON.parse(fs.readFileSync(new URL('../src/schedules/public-inventory.json', import.meta.url)));
function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'subscriptions', ...args], { env: { ...process.env, ...env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' }, timeout: 20000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('real CLI refresh validates HTTP bytes, preserves last-good on every rejection, and inspects offline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-schedules-'));
  const env = { XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root };
  let mode = 'good', calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    let catalog = { schema_version: 1, revision: 'a'.repeat(64), schedules: records };
    if (mode === 'schema') catalog.schema_version = 2;
    if (mode === 'duplicate') catalog.schedules = [records[0], records[0]];
    if (mode === 'record-schema') catalog.schedules = [{ ...records[0], definitions: 42 }];
    if (mode === 'source') catalog.schedules = [{ ...records[0], source_url: 'https://evil.example/a.pdf' }];
    let bytes = Buffer.from(JSON.stringify(catalog));
    if (mode === 'invalid-utf8') bytes = Buffer.concat([bytes.subarray(0, 10), Buffer.from([255]), bytes.subarray(10)]);
    if (mode === 'bom') bytes = Buffer.concat([Buffer.from([239, 187, 191]), bytes]);
    if (req.url === '/manifest' || req.url === '/subscription-schedules/v1/manifest.json') {
      const manifest = { schema_version: 1, revision: catalog.revision, sha256: mode === 'hash' ? '0'.repeat(64) : sha(bytes), bytes: mode === 'oversize' ? 5000000 : bytes.length, published_at: new Date().toISOString(), catalog_url: `${origin}/artifact` };
      if (mode === 'unsafe') manifest.catalog_url = 'https://evil.example/a.json';
      if (mode === 'revision') manifest.revision = 'b'.repeat(64);
      if (mode === 'manifest-schema') manifest.schema_version = 2;
      res.end(JSON.stringify(manifest));
    } else if (mode === 'stream-oversize') res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
    else res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await run(['refresh', '--manifest-url', `${origin}/manifest`, '--json'], env);
    assert.equal(good.code, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).data.provenance.source, 'validated-cache');
    const configured = await run(['refresh', '--json'], { ...env, JSN_DOCS_URL: origin });
    assert.equal(configured.code, 0, configured.stderr);
    fs.mkdirSync(path.join(root, 'servicenow'), { recursive: true });
    fs.writeFileSync(path.join(root, 'servicenow/config.json'), JSON.stringify({ docs: { schedule_manifest_url: `${origin}/manifest` } }));
    const configRefresh = await run(['refresh', '--json'], env);
    assert.equal(configRefresh.code, 0, configRefresh.stderr);
    const cache = path.join(root, 'servicenow/subscription-schedules-v1.json');
    const lastGood = fs.readFileSync(cache, 'utf8');
    for (mode of ['hash', 'invalid-utf8', 'bom', 'schema', 'record-schema', 'duplicate', 'source', 'unsafe', 'oversize', 'stream-oversize', 'revision', 'manifest-schema']) {
      const bad = await run(['refresh', '--manifest-url', `${origin}/manifest`, '--json'], env);
      assert.notEqual(bad.code, 0, mode);
      assert.equal(fs.readFileSync(cache, 'utf8'), lastGood, mode);
    }
    for (const url of ['http://example.com/manifest', `${origin.replace('http://', 'http://user:pass@')}/manifest`, 'file:///etc/passwd']) {
      const bad = await run(['refresh', '--manifest-url', url], env);
      assert.notEqual(bad.code, 0, url);
      assert.equal(fs.readFileSync(cache, 'utf8'), lastGood);
    }
    const before = calls.length;
    const record = records.find(r => r.id === 'servicenow-otto-overview');
    const json = await run(['schedules', '--id', record.id, '--json'], env);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).data.schedules, [record]);
    const human = await run(['schedules', '--id', record.id, '--styled'], env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /validated-cache/); assert.match(human.stdout, /USAGE RULES/);
    const get = await run(['schedules', '--id', record.id, '--get', 'data.schedules[0].id'], env);
    assert.equal(JSON.parse(get.stdout), record.id);
    assert.equal(calls.length, before, 'inspection must not call any HTTP provider');
    await new Promise(resolve => server.close(resolve));
    const offline = await run(['schedules', '--id', record.id, '--json'], env);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(JSON.parse(offline.stdout).data.provenance.source, 'validated-cache');
    const failed = await run(['refresh', '--manifest-url', `${origin}/manifest`], env);
    assert.notEqual(failed.code, 0); assert.equal(fs.readFileSync(cache, 'utf8'), lastGood);
    const stale = JSON.parse(lastGood); stale.retrieved_at = '2020-01-01T00:00:00Z';
    fs.writeFileSync(cache, JSON.stringify(stale));
    const staleRead = await run(['schedules', '--json'], env);
    assert.equal(JSON.parse(staleRead.stdout).data.provenance.stale, true);
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    try {
      process.env.XDG_CACHE_HOME = root;
      // Even a validated cache with a colliding estimator ID cannot supply its adapter.
      const pinned = loadSchedule();
      const replacement = { ...pinned, categories: [{ id: 'invented', resources_per_su: 999, classes: [] }] };
      const changed = JSON.parse(lastGood);
      changed.artifact = JSON.stringify({ schema_version: 1, revision: changed.manifest.revision, schedules: [replacement] });
      changed.manifest.bytes = Buffer.byteLength(changed.artifact);
      changed.manifest.sha256 = sha(changed.artifact);
      fs.writeFileSync(cache, JSON.stringify(changed));
      const inspectReplacement = await run(['schedules', '--id', pinned.id, '--json'], env);
      assert.equal(JSON.parse(inspectReplacement.stdout).data.schedules[0].categories[0].id, 'invented');
      assert.deepEqual(loadSchedule().categories, pinned.categories);
    } finally {
      if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalCacheHome;
    }
    fs.writeFileSync(cache, '{broken');
    const fallback = await run(['schedules', '--id', record.id, '--json'], env);
    assert.equal(JSON.parse(fallback.stdout).data.provenance.source, 'bundled');
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
