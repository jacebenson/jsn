import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivilegeRequests, formatPrivilegeRequests, privilegeRequestsSummary } from '../src/privilege-requests.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';
import { yargs } from '../src/cli-adapter.js';
import { privilegesCmd } from '../src/commands/_simple.js';
import { rankedDiscoveries } from '../src/commands/discover.js';

const id = c => c.repeat(32);
const SRC = id('a'), TGT = id('b');
const ref = (value, display_value) => ({ value, display_value });
const rca = (sys_id, status, extra = {}) => ({
  sys_id: ref(sys_id, sys_id), status: ref(status, ['Requested', 'Denied', 'Allowed', 'Invalidated'][status]), operation: ref('execute', 'Execute API'),
  source_scope: ref(SRC, 'Payroll Sync'), source_table: ref('sys_script_include', 'sys_script_include'), source: ref(id('c'), 'SalarySync'),
  target_scope: ref(TGT, 'Pay Core'), target_table: ref('sys_script_include', 'sys_script_include'), target: ref(id('d'), 'Script Include: GradeTable'),
  rca_type: ref('real_rca', 'Real RCA'), sys_updated_on: ref('2026-11-26 02:20:37', '2026-11-26 02:20:37'), ...extra,
});
const scopes = [{ sys_id: SRC, scope: 'x_acme_pays', name: 'Payroll Sync' }, { sys_id: TGT, scope: 'x_acme_payt', name: 'Pay Core' }];

function fixtureSdk(tables) {
  const calls = [];
  return { calls, async listStrict(table, params) {
    calls.push({ table, params: Object.fromEntries(params) });
    const value = tables[table];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value ?? [];
  } };
}
const scopeLookup = params => { const v = params.get('sysparm_query').match(/^scope=([^^]*)/)[1]; return scopes.filter(s => [s.scope, s.name, s.sys_id].includes(v)); };

test('reads open requests newest first with raw sys_ids, bounded, and names each source and target', async () => {
  const sdk = fixtureSdk({ sys_restricted_caller_access: [rca(id('1'), '0'), rca(id('2'), '3', { source: ref(id('e'), 'BonusRun') })] });
  const data = await readPrivilegeRequests(sdk, {});
  assert.deepEqual(sdk.calls, [{ table: 'sys_restricted_caller_access', params: {
    sysparm_query: 'statusIN0,1,3^ORDERBYDESCsys_updated_on',
    sysparm_fields: 'sys_id,status,operation,source_scope,source_table,source,target_scope,target_table,target,rca_type,sys_updated_on',
    sysparm_limit: '21', sysparm_display_value: 'all' } }]);
  assert.deepEqual(data.statuses, ['requested', 'denied', 'invalidated']);
  assert.deepEqual(data.requests[0], {
    sys_id: id('1'), status: 'requested', operation: 'execute',
    source_scope: { sys_id: SRC, name: 'Payroll Sync' }, source: { table: 'sys_script_include', sys_id: id('c'), name: 'SalarySync' },
    target_scope: { sys_id: TGT, name: 'Pay Core' }, target: { table: 'sys_script_include', sys_id: id('d'), name: 'Script Include: GradeTable' },
    rca_type: 'real_rca', updated: '2026-11-26 02:20:37',
  });
  assert.equal(data.requests[1].status, 'invalidated');
  assert.equal(data.requests[1].source.name, 'BonusRun');
  assert.deepEqual(data.pagination, { limit: 20, has_more: false });
  const text = formatPrivilegeRequests(data);
  assert.match(text, /Requested +Execute API +Payroll Sync: SalarySync +-> +Pay Core: Script Include: GradeTable +1{32}/);
  assert.match(text, /Invalidated +Execute API +Payroll Sync: BonusRun/);
  assert.match(text, /jsn privileges list/);
});

test('--status picks names or all, and scopes resolve by scope, name or sys_id to raw sys_ids', async () => {
  const sdk = fixtureSdk({ sys_scope: scopeLookup, sys_restricted_caller_access: [rca(id('1'), '2')] });
  const data = await readPrivilegeRequests(sdk, { status: 'allowed', sourceScope: 'Payroll Sync', targetScope: 'x_acme_payt', limit: 5 });
  assert.deepEqual(sdk.calls.map(c => [c.table, c.params.sysparm_query, c.params.sysparm_limit]), [
    ['sys_scope', 'scope=Payroll Sync^ORname=Payroll Sync', '2'],
    ['sys_scope', 'scope=x_acme_payt^ORname=x_acme_payt', '2'],
    ['sys_restricted_caller_access', `statusIN2^source_scope=${SRC}^target_scope=${TGT}^ORDERBYDESCsys_updated_on`, '6'],
  ]);
  assert.deepEqual(data.source_scope, { sys_id: SRC, scope: 'x_acme_pays', name: 'Payroll Sync' });
  const all = fixtureSdk({ sys_scope: scopeLookup, sys_restricted_caller_access: [] });
  const empty = await readPrivilegeRequests(all, { status: 'all', sourceScope: SRC });
  assert.equal(all.calls[0].params.sysparm_query, `scope=${SRC}^ORname=${SRC}^ORsys_id=${SRC}`);
  assert.match(all.calls[1].params.sysparm_query, /^statusIN0,1,2,3\^source_scope=a{32}\^ORDERBY/);
  assert.deepEqual(empty.statuses, ['requested', 'denied', 'allowed', 'invalidated']);
  assert.match(formatPrivilegeRequests(empty), /No readable requested, denied, allowed or invalidated requests\. ACLs can hide rows, so an empty list does not prove none exist\./);
  const both = fixtureSdk({ sys_restricted_caller_access: [] });
  await readPrivilegeRequests(both, { status: ['requested', 'denied,requested'] });
  assert.match(both.calls[0].params.sysparm_query, /^statusIN0,1\^/);
});

test('one row past the limit reports has_more and keeps the limit', async () => {
  const sdk = fixtureSdk({ sys_restricted_caller_access: [rca(id('1'), '0'), rca(id('2'), '0'), rca(id('3'), '0')] });
  const data = await readPrivilegeRequests(sdk, { limit: 2 });
  assert.equal(data.requests.length, 2);
  assert.deepEqual(data.pagination, { limit: 2, has_more: true });
  assert.match(formatPrivilegeRequests(data), /More match: raise --limit/);
  assert.equal(privilegeRequestsSummary(data), '2+ readable requested, denied or invalidated restricted caller access request(s)');
  const exact = await readPrivilegeRequests(fixtureSdk({ sys_restricted_caller_access: [rca(id('1'), '0'), rca(id('2'), '0')] }), { limit: 2 });
  assert.equal(exact.pagination.has_more, false);
  assert.equal(privilegeRequestsSummary(exact), '2 readable requested, denied or invalidated restricted caller access request(s)');
  assert.doesNotMatch(formatPrivilegeRequests(exact), /More match/);
  const max = formatPrivilegeRequests({ ...data, pagination: { limit: 1000, has_more: true } });
  assert.match(max, /More match: narrow with --status/);
  assert.doesNotMatch(max, /raise --limit/);
});

test('rejected input reads nothing', async () => {
  for (const opts of [{ status: 'pending' }, { status: '' }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { sourceScope: 'x^ORactive=true' }, { targetScope: '' }, { targetScope: 'a^b' }]) {
    const sdk = fixtureSdk({});
    await assert.rejects(readPrivilegeRequests(sdk, opts), { code: 'usage_error' }, JSON.stringify(opts));
    assert.equal(sdk.calls.length, 0, JSON.stringify(opts));
  }
});

test('missing, ambiguous, denied and malformed reads are never reported as requests', async () => {
  const cases = [
    [{ sys_scope: [] }, { sourceScope: 'x_none' }, /not found/i],
    [{ sys_scope: scopes }, { sourceScope: 'Pay' }, /more than one/],
    [{ sys_scope: [{ sys_id: id('f'), scope: 'x_other', name: 'Other' }] }, { sourceScope: 'x_acme_pays' }, /Malformed/],
    [{ sys_scope: [{ scope: 'x_acme_pays' }] }, { sourceScope: 'x_acme_pays' }, /Malformed/],
    [{ sys_restricted_caller_access: Object.assign(new Error('HTTP 403'), { code: 'forbidden' }) }, {}, /403/],
    [{ sys_restricted_caller_access: [null] }, {}, /Malformed/],
    [{ sys_restricted_caller_access: [rca('', '0')] }, {}, /Malformed/],
    [{ sys_restricted_caller_access: [rca(id('1'), '2')] }, {}, /Malformed/],
    [{ sys_restricted_caller_access: [rca(id('1'), '7')] }, { status: 'all' }, /Malformed/],
    [{ sys_scope: scopeLookup, sys_restricted_caller_access: [rca(id('1'), '0', { source_scope: ref(TGT, 'Pay Core') })] }, { sourceScope: SRC }, /Malformed/],
    [{ sys_scope: scopeLookup, sys_restricted_caller_access: [rca(id('1'), '0', { target_scope: ref(SRC, 'Payroll Sync') })] }, { targetScope: TGT }, /Malformed/],
  ];
  for (const [tables, opts, error] of cases) {
    await assert.rejects(readPrivilegeRequests(fixtureSdk(tables), opts), error, JSON.stringify(opts));
  }
});

test('a source with no display value falls back to its table and sys_id', async () => {
  const data = await readPrivilegeRequests(fixtureSdk({ sys_restricted_caller_access: [rca(id('1'), '0', { source: ref(id('c'), ''), source_table: ref('sys_script', 'sys_script') })] }), {});
  assert.match(formatPrivilegeRequests(data), /Payroll Sync: sys_script c{32}/);
});

test('a copy packaged in the source app is marked with its type; a real row is not', async () => {
  const data = await readPrivilegeRequests(fixtureSdk({ sys_restricted_caller_access: [rca(id('1'), '2', { rca_type: ref('requested_rca', 'Requested') }), rca(id('2'), '2')] }), { status: 'allowed' });
  const [copy, real] = formatPrivilegeRequests(data).split('\n').slice(1, 3);
  assert.match(copy, /1{32} {2}\(requested_rca\)$/);
  assert.match(real, /2{32}$/);
});

test('discover finds requests by the words a refused cross-scope call gives', () => {
  const registry = yargs().option('json', { type: 'boolean' }).command(privilegesCmd(fn => fn)).commandRegistry({ details: true });
  for (const query of ['cross-scope access refused', 'caller restriction', 'rca request', 'blocked cross-scope call']) {
    assert.equal(rankedDiscoveries(registry, { query })[0]?.invocation, 'jsn privileges requests --json', query);
  }
});

test('real CLI: read-only profile, JSON, --get, human output, strict validation, GET only', async () => {
  const calls = [];
  const tables = { sys_scope: scopeLookup, sys_restricted_caller_access: [rca(id('1'), '0')] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.startsWith('/api/now/table/') && url.pathname.split('/').pop();
    if (!table) { res.end(JSON.stringify({ result: [] })); return; }
    fixtureSdk(tables).listStrict(table, url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-privilege-requests-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'privileges', 'requests', ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['--target-scope', 'x_acme_payt', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data._formatted, undefined);
    assert.equal(envelope.data.requests[0].source.name, 'SalarySync');
    assert.equal(JSON.parse((await run(['--get', 'data.requests.0.status'])).stdout), 'requested');
    const human = (await run(['--styled'])).stdout;
    assert.match(human, /Requested +Execute API +Payroll Sync: SalarySync/);
    const tableCalls = () => calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    const before = tableCalls().length;
    for (const args of [['--typo'], ['--status', 'pending'], ['--limit', '0'], ['--source-scope', 'a^b'], ['extra']]) {
      await assert.rejects(run(args), undefined, JSON.stringify(args));
    }
    assert.equal(tableCalls().length, before, 'rejected input reads nothing');
    assert.match((await run(['--help'])).stdout, /sys_scope_privilege/);
    assert.match((await promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'privileges'], { env, cwd: dir, timeout: 20000 })).stdout, /requests/);
    assert.ok(tableCalls().length && tableCalls().every(call => call.method === 'GET'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
