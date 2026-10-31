import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendMutation, listHistory, RETENTION_MS } from '../src/mutation-history.js';
import { SDKClient } from '../src/sdk.js';

test('history whitelists metadata, redacts reasons, filters and expires automatically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-history-'));
  const filename = path.join(dir, 'history.db');
  const now = Date.now();
  try {
    const event = { instance: 'https://user:password@example.test/path?token=secret', profile: 'dev', table: 'incident', sys_id: 'legacy-id', operation: 'update', outcome: 'succeeded', reason: 'ticket fix token=hidden Bearer hidden', payload: { password: 'hidden' } };
    appendMutation(event, { filename, now: now - RETENTION_MS - 1 });
    appendMutation(event, { filename, now });
    const rows = listHistory({ table: 'incident', record: 'legacy-id', profile: 'dev', operation: 'update', since: new Date(now - 1).toISOString() }, { filename, now });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].instance, 'https://example.test');
    assert.equal(rows[0].reason.includes('hidden'), false);
    assert.equal('payload' in rows[0], false);
    assert.equal(listHistory({ table: 'other' }, { filename, now }).length, 0);
    assert.throws(() => listHistory({ since: 'wrong' }, { filename, now }), /timestamp/);
    assert.throws(() => listHistory({ limit: -1 }, { filename, now }), /limit/);
    assert.equal(listHistory({}, { filename, now: now + RETENTION_MS + 1 }).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SDK logs whitelisted metadata and never changes write result on history failure', async () => {
  const events = [];
  const sdk = new SDKClient('https://example.test', null, { onMutation: event => events.push(event) });
  sdk._performAuthenticatedRequest = async () => ({ result: { sys_id: 'resolved-id', password: 'secret' } });
  const result = await sdk.request('https://example.test/api/now/table/incident', { method: 'POST', body: '{"password":"secret"}' });
  assert.equal(result.result.sys_id, 'resolved-id');
  assert.deepEqual(events, [{ table: 'incident', sys_id: 'resolved-id', operation: 'create', outcome: 'succeeded' }]);
  sdk.onMutation = () => { throw new Error('disk unavailable'); };
  assert.equal((await sdk.request('https://example.test/api/now/table/incident', { method: 'POST' })).result.sys_id, 'resolved-id');
});

test('SDK distinguishes definitive rejection from unknown transport outcome and ignores reads', async () => {
  const events = [];
  const sdk = new SDKClient('https://example.test', null, { onMutation: event => events.push(event) });
  sdk._performAuthenticatedRequest = async () => { throw Object.assign(new Error('sensitive provider body'), { status: 403 }); };
  await assert.rejects(sdk.request('https://example.test/api/now/table/incident/id', { method: 'PATCH' }));
  assert.equal(events[0].outcome, 'failed');
  sdk._performAuthenticatedRequest = async () => { throw new Error('lost connection'); };
  await assert.rejects(sdk.request('https://example.test/api/now/table/incident/id', { method: 'DELETE' }));
  assert.equal(events[1].outcome, 'unknown');
  sdk._performAuthenticatedRequest = async () => ({ result: [] });
  await sdk.request('https://example.test/api/now/table/incident');
  assert.equal(events.length, 2);
});

test('real CLI generic and specialized writes share automatic history and JSON querying', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-history-cli-'));
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const auth = new URL('../src/auth.js', import.meta.url).href;
  const preload = path.join(directory, 'fixture.mjs');
  fs.writeFileSync(preload, `
    import { AuthManager } from ${JSON.stringify(auth)};
    AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture-secret' }) });
    globalThis.fetch = async req => {
      const url = new URL(req.url);
      const table = url.pathname.split('/')[4];
      if (req.method === 'POST') return new Response(JSON.stringify({ result: { sys_id: 'full-resolved-id', number: 'INC0001', ...JSON.parse(await req.text()) } }));
      if (req.method === 'PATCH' || req.method === 'PUT') return new Response(JSON.stringify({ result: { sys_id: 'full-resolved-id' } }));
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ result: table === 'sys_scope' ? [{ sys_id: 'scoped-app', name: 'Fixture', scope: 'x_fixture' }]
        : table === 'u_custom' && url.searchParams.get('sysparm_query') === 'sys_id=full-resolved-id'
          ? [{ sys_id: 'full-resolved-id', active: false, private_field: 'never-store-this' }] : [] }));
    };
  `);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, JSN_DATA_HOME: directory,
    JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
    env, cwd: directory, encoding: 'utf8', timeout: 10000,
  });
  try {
    for (const args of [
      ['records', 'create', '--table', 'u_custom', '--data', '{"private_field":"never-store-this"}'],
      ['incidents', 'create', '--description', 'never-store-this'],
      ['properties', 'create', '--data', '{"name":"fixture","value":"never-store-this"}'],
      ['records', 'update', '--table', 'u_custom', '--sys-id', 'full-resolved-id', '--data', '{"active":false}'],
      ['records', 'delete', '--table', 'u_custom', '--sys-id', 'full-resolved-id', '--force'],
    ]) {
      const result = run([...args, '--instance', 'https://fixture.example.test', '--reason', 'maintenance', '--json']);
      assert.equal(result.status, 0, result.stderr + result.stdout);
    }
    const result = run(['history', 'list', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const entries = listHistory({}, { filename: path.join(directory, 'history.db') });
    assert.equal(entries.length, 5);
    assert.deepEqual(new Set(entries.map(e => e.operation)), new Set(['create', 'update', 'delete']));
    assert.ok(entries.every(e => e.reason === 'maintenance' && e.sys_id === 'full-resolved-id'));
    assert.doesNotMatch(result.stdout, /never-store-this|fixture-secret/);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const human = run(['history', '--styled']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /WHEN\s+ACTION/);
    const details = run(['history', 'list', '--details', '--styled']);
    assert.equal(details.status, 0, details.stderr);
    assert.match(details.stdout, /full-resolved-id/);
    assert.match(details.stdout, /maintenance/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('authentication retry logs exactly one final mutation event', async () => {
  const original = globalThis.fetch;
  const events = [];
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 401 })
    : new Response('{"result":{"sys_id":"created-id"}}');
  try {
    const sdk = new SDKClient('https://fixture.test', { getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture' }) }, {
      recovery: { recover: async () => true }, onMutation: event => events.push(event),
    });
    await sdk.create('incident', { short_description: 'not logged' });
    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].sys_id, 'created-id');
    assert.equal(events[0].outcome, 'succeeded');
  } finally { globalThis.fetch = original; }
});

test('App surfaces a local storage failure once without throwing or printing details', async () => {
  const { App } = await import('../src/app.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-history-failure-'));
  const blocked = path.join(directory, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const previous = process.env.JSN_DATA_HOME;
  const write = process.stderr.write;
  let stderr = '';
  try {
    process.env.JSN_DATA_HOME = blocked;
    process.stderr.write = chunk => { stderr += chunk; return true; };
    const app = new App({ profiles: {} });
    app._authArgv = { reason: 'ticket' };
    for (let i = 0; i < 2; i++) app.recordMutation('https://fixture.test', 'dev', {
      table: 'incident', sys_id: 'id', operation: 'update', outcome: 'succeeded',
    });
    assert.equal(stderr.split('Warning:').length - 1, 1);
    assert.match(stderr, /remote result is unchanged/);
    assert.doesNotMatch(stderr, /blocked|ENOTDIR|ticket/);
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.JSN_DATA_HOME;
    else process.env.JSN_DATA_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('human history uses local time and compact columns with full detail available', async () => {
  const { renderHistory } = await import('../src/commands/history.js');
  const entries = [{ timestamp: '2026-10-29T07:23:01.648Z', operation: 'delete', table: 'ecc_agent',
    sys_id: 'dcd9a31493d4d31016c8fd18dd03d6d4', outcome: 'succeeded',
    instance: 'https://example.service-now.com', profile: 'pdi', reason: 'test cleanup' }];
  const compact = renderHistory(entries, { timeZone: 'America/Chicago' });
  assert.match(compact, /29 Oct, 02:23/);
  assert.match(compact, /WHEN\s+ACTION\s+TABLE\s+RECORD\s+RESULT\s+CONNECTION/);
  assert.match(compact, /dcd9a31493d…/);
  assert.doesNotMatch(compact, /https:\/\//);
  const detailed = renderHistory(entries, { details: true, timeZone: 'America/Chicago' });
  assert.ok(detailed.includes(entries[0].sys_id));
  assert.ok(detailed.includes(entries[0].instance));
  assert.ok(detailed.includes(entries[0].reason));
  assert.equal(entries[0].timestamp, '2026-10-29T07:23:01.648Z');
  assert.equal(renderHistory([]), 'No local mutations in the last seven days.');
});
