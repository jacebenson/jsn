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
import { listAccessAnalyses, showAccessAnalysis, formatAccessAnalysis } from '../src/access-analyzer.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const request = { sys_id: field(id(1), 'Not a join key'), analyze_by: field('user', 'User'), user: field(id(10), 'Synthetic User'), target_table: field('incident'), target_record: field(id(11), 'SYN0001'), last_run: field('2026-01-01 10:00:00') };
const results = ['Passed', 'Blocked', 'Skipped', 'Undefined'].map((state, index) => ({ sys_id: field(id(index + 2)), access_analyzer_request: field(id(1), 'Wrong display label'), operation: field(['read', 'write', 'create', 'delete'][index]), overall_access: field(state), acl_result: field(state), execution_id: field(index < 2 ? 'execution-a' : 'execution-b'), record_available: field('false') }));
const logs = ['Passed', 'Skipped', 'Undefined', 'Blocked'].map((state, index) => ({ sys_id: field(id(index + 20)), access_result: field(id(2), 'Wrong result label'), log_sequence: field(String(index + 1)), type: field(index ? 'ACL' : 'Business Rule'), path: field(`Synthetic check ${index}`), status: field(state), roles_result: field(state), condition_result: field(state), script_result: field(state) }));
const tables = { sn_access_analyzer_request: [request], sn_access_analyzer_access_result: results, sn_access_analyzer_debug_log: logs };
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    const query = params.get('sysparm_query');
    if (query.startsWith('sys_id=')) rows = rows.filter(row => row.sys_id.value === query.slice(7));
    return rows.slice(Number(params.get('sysparm_offset')), Number(params.get('sysparm_offset')) + Number(params.get('sysparm_limit')));
  } };
}

test('list preserves reference identities, bounded lookahead and deterministic query', async () => {
  const sdk = fixtureSdk({ sn_access_analyzer_request: [request, { ...request, sys_id: field(id(40)) }] });
  const data = await listAccessAnalyses(sdk, { limit: 1 });
  assert.deepEqual(data.records[0].user, field(id(10), 'Synthetic User'));
  assert.deepEqual(data.pagination, { limit: 1, offset: 0, has_more: true, next_offset: 1 });
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '2');
  assert.equal(sdk.calls[0].params.get('sysparm_display_value'), 'all');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), 'ORDERBYDESClast_run^ORDERBYsys_id');
  assert.match(formatAccessAnalysis(data, 'list'), /Synthetic User[\s\S]*SYN0001[\s\S]*2026-01-01/);
});

test('show with a request ID joins raw identity and preserves states without inventing shared runs', async () => {
  const sdk = fixtureSdk();
  const data = await showAccessAnalysis(sdk, id(1));
  assert.equal(data.kind, 'request');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), `sys_id=${id(1)}`);
  assert.equal(sdk.calls[1].params.get('sysparm_query'), `access_analyzer_request=${id(1)}^ORDERBYexecution_id^ORDERBYoperation^ORDERBYsys_id`);
  assert.deepEqual(data.records.map(row => row.overall_access.value), ['Passed', 'Blocked', 'Skipped', 'Undefined']);
  assert.equal(Object.hasOwn(data, 'executions'), false);
  for (const state of ['Passed', 'Blocked', 'Skipped', 'Undefined']) assert.ok(formatAccessAnalysis(data, data.kind).includes(state));
  const next = await showAccessAnalysis(sdk, id(1), { limit: 2, offset: 2 });
  assert.equal(next.count, 2);
  assert.equal(next.pagination.has_more, false);
});

test('show with a result ID falls through to the checks, ordering them by sequence', async () => {
  const sdk = fixtureSdk();
  const data = await showAccessAnalysis(sdk, id(2), { limit: 2, offset: 1 });
  assert.equal(data.kind, 'result');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), `sys_id=${id(2)}`, 'the request table is asked first');
  assert.equal(sdk.calls[2].params.get('sysparm_query'), `access_result=${id(2)}^ORDERBYlog_sequence^ORDERBYsys_id`);
  assert.deepEqual(data.records.map(row => row.log_sequence.value), ['2', '3']);
  assert.equal(data.pagination.has_more, true);
  const human = formatAccessAnalysis(data, data.kind);
  assert.match(human, /not itself an ACL failure/);
  assert.match(human, /Skipped[\s\S]*Undefined/);
});

test('all invalid IDs and bounds reject before transport', async () => {
  const sdk = fixtureSdk();
  for (const invalid of ['', 'bad', ` ${id(1)}`, `${id(1)}^NQ`, 123]) {
    await assert.rejects(showAccessAnalysis(sdk, invalid), /sys_id/);
  }
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(listAccessAnalyses(sdk, options), /--limit|--offset/);
    await assert.rejects(showAccessAnalysis(sdk, id(1), options), /--limit|--offset/);
  }
  assert.equal(sdk.calls.length, 0);
});

test('missing, empty, denied, unavailable and malformed evidence is never reported as successful access', async () => {
  await assert.rejects(showAccessAnalysis(fixtureSdk(), id(99)), /not found as an analysis request or an operation result/);
  const empty = await showAccessAnalysis(fixtureSdk({ sn_access_analyzer_access_result: [] }), id(1));
  assert.equal(empty.kind, 'request');
  assert.equal(empty.count, 0);
  assert.match(formatAccessAnalysis(empty, empty.kind), /do not prove access/);
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(listAccessAnalyses({ listStrict: async () => { throw error; } }), e => e === error);
  }
  await assert.rejects(listAccessAnalyses({ listStrict: async () => ({ result: [] }) }), /Malformed/);
});

test('verified No record availability and blank Business Rule paths retain actionable rule evidence', async () => {
  const result = { ...results[0], record_available: field('no', 'No'), overall_access: field('Passed') };
  const log = { ...logs[0], path: field(''), record_ref: field(id(80), 'Synthetic incident query'), log_table_name: field('sys_script'), status: field('Passed'), roles_result: field('Blocked') };
  const data = await showAccessAnalysis(fixtureSdk({ sn_access_analyzer_access_result: [result], sn_access_analyzer_debug_log: [log] }), id(2));
  assert.equal(data.kind, 'result');
  const human = formatAccessAnalysis(data, data.kind);
  assert.match(human, /not itself an ACL failure/);
  assert.match(human, /Synthetic incident query/);
  assert.ok(human.includes(id(80)));
  assert.match(human, /sys_script/);
  assert.equal(data.records[0].status.value, 'Passed');
  assert.equal(data.records[0].roles_result.value, 'Blocked');
  const listed = await listAccessAnalyses(fixtureSdk({ sn_access_analyzer_request: [{ ...request, target_ui_page: field('undefined'), target_rest_endpoint: 'undefined' }] }));
  assert.doesNotMatch(formatAccessAnalysis(listed, 'list'), /undefined/);
  assert.equal(listed.records[0].target_ui_page.value, 'undefined');
});

test('mismatched raw associations fail even when display labels look correct', async () => {
  await assert.rejects(showAccessAnalysis(fixtureSdk({ sn_access_analyzer_access_result: [{ ...results[0], access_analyzer_request: field(id(99), id(1)) }] }), id(1)), /mismatched/);
  await assert.rejects(showAccessAnalysis(fixtureSdk({ sn_access_analyzer_debug_log: [{ ...logs[0], access_result: field(id(99), id(2)) }] }), id(2)), /mismatched/);
});

test('real CLI supports read-only profile, JSON, --get, human rendering, strict validation and discovery', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query') });
    if (!url.pathname.startsWith('/api/now/table/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: [] }));
      return;
    }
    const table = url.pathname.split('/').pop();
    const sdk = fixtureSdk();
    Promise.resolve(sdk.listStrict(table, url.searchParams)).then(rows => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: rows }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-access-analyzer-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true }, writer: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic' } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    for (const args of [['list'], ['show', id(1)], ['show', id(2)]]) {
      const { stdout } = await run(['access-analyzer', ...args, '--json']);
      const envelope = JSON.parse(stdout);
      assert.equal(envelope.ok, true);
      assert.ok(envelope.data.records.length);
      const human = await run(['access-analyzer', ...args, '--format', 'styled']);
      assert.match(human.stdout, /Saved Access Analyzer evidence/);
    }
    const get = await run(['access-analyzer', 'show', id(1), '--get', 'data.request.user.value']);
    assert.ok(get.stdout.includes(id(10)));
    const before = calls.length;
    for (const args of [['show', 'bad'], ['show', id(2), '--limit', '0'], ['list', '--offset', '-1'], ['list', '--typo'], ['evaluate'], ['explain', id(2)]]) {
      await assert.rejects(run(['access-analyzer', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['access-analyzer', '--help']);
    for (const name of ['list', 'show', 'check', 'run']) assert.ok(help.stdout.includes(name));
    const runHelp = await run(['access-analyzer', 'run', '--help']);
    for (const flag of ['--user', '--table', '--record', '--operations', '--field', '--save']) assert.ok(runHelp.stdout.includes(flag), flag);
    // `run` can persist with --save, so it is a write-class path: a read-only
    // profile is refused before any request, exactly as for other mutations.
    const beforeRun = calls.length;
    const saved = await run(['access-analyzer', 'run', '--user', 'abel.tuter', '--table', 'incident', '--record', id(1), '--save', '--json']).catch(error => error);
    assert.equal(JSON.parse(saved.stdout).code, 'read_only');
    assert.match(JSON.parse(saved.stdout).error, /read-only/);
    const plain = await run(['access-analyzer', 'run', '--user', 'abel.tuter', '--table', 'incident', '--record', id(1), '--json']).catch(error => error);
    assert.equal(JSON.parse(plain.stdout).code, 'read_only');
    assert.equal(calls.length, beforeRun, 'a read-only profile sends nothing for run');
    // --save asks for confirmation before any request; unattended with no
    // --force it must fail closed, not run and write.
    const unconfirmed = await run(['access-analyzer', 'run', '--user', 'abel.tuter', '--table', 'incident', '--record', id(1), '--save', '--profile', 'writer', '--json']).catch(error => error);
    assert.equal(JSON.parse(unconfirmed.stdout).code, 'confirmation_required');
    assert.equal(calls.length, beforeRun, 'an unconfirmed --save sends nothing');
    // Validation still rejects before any instance request on a write profile;
    // these run against the read-only fixture, so the guard answers first.
    const discovery = await run(['access-analyzer', '--json']);
    assert.ok(discovery.stdout.includes('access-analyzer'));
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    assert.ok(calls.every(call => call.pathname.startsWith('/api/now/table/') || call.pathname === '/angular.do'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
