import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDKClient } from '../src/sdk.js';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';
const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const id = '0123456789abcdef0123456789abcdef';
const history = ['state', 'priority', 'impact', 'urgency'].map(fieldname => ({ fieldname, oldvalue: { value: '1' }, newvalue: { value: '2' }, sys_created_on: '2026-01-01', sys_created_by: 'fixture' }));
const encode = body => Buffer.from(JSON.stringify(body)).toString('base64');
async function fixture(t, { total = '7', batchMode = 'ok', delay = 0 } = {}) {
  const calls = []; let active = 0, peak = 0, auditFinished = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null, auditFinished };
    const parsed = new URL(req.url, 'http://fixture');
    const validationRead = (parsed.pathname === '/api/now/table/sys_db_object' && parsed.searchParams.get('sysparm_query')?.startsWith('nameSTARTSWITH'))
      || parsed.searchParams.get('sysparm_fields') === 'sys_id,name,super_class'
      || parsed.searchParams.get('sysparm_fields') === 'sys_id,name,element,internal_type,reference'
      || parsed.searchParams.get('sysparm_query') === 'user_name=javascript:gs.getUserName()';
    if (!validationRead) calls.push(call);
    else { assert.equal(req.method, 'GET'); assert.ok(new URL(req.url, 'http://fixture').searchParams.get('sysparm_limit') <= 1000); }
    const respond = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    const dataFor = path => {
      const url = new URL(path, 'http://fixture');
      if (url.pathname.endsWith('/sys_audit')) return { result: history };
      if (url.pathname.endsWith('/sys_choice')) return { result: [{ label: `label:${url.searchParams.get('sysparm_query')}` }] };
      if (url.pathname.endsWith('/incident')) return { result: [{ sys_id: id, number: 'INC_FIXTURE' }] };
      return { result: [] };
    };
    if (req.method === 'POST' && req.url === '/api/now/v1/batch') {
      assert.ok(auditFinished, 'choice discovery must follow audit response');
      for (const item of call.body.rest_requests) assert.equal(item.method, 'GET');
      if (batchMode === 'unsupported') return respond(404, { error: 'unsupported' });
      if (batchMode === 'denied') return respond(403, { error: 'denied' });
      if (batchMode === 'malformed') return respond(200, { unexpected: true });
      const items = call.body.rest_requests;
      return respond(200, { batch_request_id: call.body.batch_request_id, serviced_requests: items.slice().reverse().map(item => ({ id: item.id, status_code: batchMode === 'partial' && item.id === '1' ? 403 : 200, body: encode(dataFor(item.url)) })), unserviced_requests: [] });
    }
    assert.equal(req.method, 'GET', 'no provider writes');
    if (req.url.startsWith('/api/now/table/sys_choice?')) {
      assert.ok(auditFinished); active++; peak = Math.max(peak, active);
      const value = new URL(req.url, 'http://fixture').searchParams.get('sysparm_query');
      await new Promise(resolve => setTimeout(resolve, delay + (value?.includes('value=1^') ? 15 : 0))); active--;
    }
    if (req.url.startsWith('/api/now/stats/')) return respond(200, { result: { stats: { count: '7' } } });
    if (req.url.startsWith('/api/now/table/sys_audit?')) auditFinished = true;
    respond(200, dataFor(req.url), total === null ? {} : { 'X-Total-Count': total });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'jsn-perf-test-'));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(join(home, 'config', 'servicenow'), { recursive: true });
  await writeFile(join(home, 'config', 'servicenow', 'config.json'), JSON.stringify({ profiles: { other: { instance: origin } } }));
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), JSN_HERMES_BASE_DIR: join(home, 'hermes'), SERVICENOW_OAUTH_TOKEN: 'fixture-only', JSN_ALWAYS_WARM_SESSION: '0', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', CI: 'true', NO_COLOR: '1' });
  return { calls, peak: () => peak, origin,
    run: async args => JSON.parse((await exec(process.execPath, [...credentialFixtureArgs, bin, '--instance', origin, ...args, '--json'], { env, timeout: 20000 })).stdout),
  };
}
for (const total of ['7', '0', null, '', '-1', '1.5', '9007199254740992', '7junk']) {
  test(`records list exact HTTP count and pagination for header ${JSON.stringify(total)}`, async t => {
    const f = await fixture(t, { total });
    const result = await f.run(['records', 'list', '--table', 'incident', '--columns', 'sys_id,number', '--limit', '1', '--offset', '2', '--query', 'active=true']);
    const valid = total === '7' || total === '0';
    assert.equal(f.calls.length, valid ? 1 : 2);
    assert.equal(result.data.pagination.total, total === '0' ? 0 : 7);
    assert.equal(result.data.pagination.hasMore, total !== '0');
    assert.ok(f.calls.every(call => call.method === 'GET'));
    if (!valid) assert.equal(new URL(f.calls[1].path, f.origin).searchParams.get('sysparm_query'), 'active=true');
  });
}
test('no count, direct sys_id and distinct query/fields/profile invocations do not reuse receipts', async t => {
  const f = await fixture(t);
  for (const args of [
    ['--no-count'], ['--sys-id', id], ['--query', 'active=true', '--columns', 'sys_id'],
    ['--query', 'active=false', '--columns', 'number'], ['--profile', 'other', '--query', 'priority=1'],
  ]) await f.run(['records', 'list', '--table', 'incident', ...args]);
  assert.equal(f.calls.length, 5);
  assert.equal(new Set(f.calls.map(call => call.path)).size, 5);
});
for (const batchMode of ['ok', 'partial', 'denied', 'malformed', 'unsupported']) {
  test(`real records inspect ${batchMode}: exact reads, dependency order, partial labels, no writes`, async t => {
    const f = await fixture(t, { batchMode, delay: 30 });
    const result = await f.run(['records', 'inspect', 'incident', id]);
    const batches = f.calls.filter(call => call.method === 'POST');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].body.rest_requests.length, 8);
    assert.equal(f.calls.filter(call => call.path.startsWith('/api/now/table/sys_choice?')).length, batchMode === 'unsupported' ? 8 : 0);
    assert.equal(f.calls.length, batchMode === 'unsupported' ? 13 : 5);
    if (batchMode === 'unsupported') assert.equal(f.peak(), 4);
    assert.equal(result.data.history.length, 4);
    assert.equal(result.data.history[0].oldValue.startsWith('label:'), ['ok', 'partial', 'unsupported'].includes(batchMode));
    assert.equal(result.data.history[0].newValue.startsWith('label:'), ['ok', 'unsupported'].includes(batchMode));
    if (['ok', 'unsupported'].includes(batchMode)) {
      for (const row of result.data.history) {
        assert.equal(row.oldValue, `label:name=incident^element=${row.field}^value=1^language=en`);
        assert.equal(row.newValue, `label:name=incident^element=${row.field}^value=2^language=en`);
      }
    }
    assert.ok(f.calls.every(call => call.method === 'GET' || call.path === '/api/now/v1/batch'));
  });
}
test('batch fallback cap and result order survive out-of-order completions, separate SDK/auth contexts and queries', async t => {
  const previous = process.env.JSN_ALWAYS_WARM_SESSION;
  process.env.JSN_ALWAYS_WARM_SESSION = '0';
  t.after(() => { if (previous === undefined) delete process.env.JSN_ALWAYS_WARM_SESSION; else process.env.JSN_ALWAYS_WARM_SESSION = previous; });
  const f = await fixture(t, { batchMode: 'unsupported', delay: 20 });
  // Exercise the public SDK with synthetic header auth and real loopback HTTP.
  const sdk = new SDKClient(f.origin, { getCredentials: () => ({ auth_method: 'oauth', access_token: 'fixture-only' }) });
  const urls = Array.from({ length: 9 }, (_, n) => ({ id: String(n), url: `/api/now/table/incident?sysparm_query=priority=${n}&sysparm_fields=${n % 2 ? 'number' : 'sys_id'}` }));
  // This fixture's batch endpoint checks discovery order for CLI calls; first perform audit discovery.
  await sdk.list('sys_audit');
  const result = await sdk.batch(urls);
  assert.deepEqual(result.results.map(item => item.id), urls.map(item => item.id));
  assert.equal(result.counts.successful, 9);
  const other = new SDKClient(f.origin, { getCredentials: () => ({ auth_method: 'oauth', access_token: 'different-fixture' }) });
  await other.batch(urls.slice(0, 1));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2, 'support state must not leak across SDK credentials');
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/now/table/incident?')).length, 10, 'different query/field reads must not coalesce');
});
