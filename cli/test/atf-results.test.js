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
import { readAtfResultDetail, formatAtfResult } from '../src/atf-results.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const assertion = `Synthetic step\n\n\nFull logging from step execution:\n00:43:13.618 Loading script: jasmine_lib/jasmine31.js\n00:43:13.697 App:<a href="sys_scope.do?sys_id=${id(90)}" target="_blank">Synthetic</a> x_synthetic: Assertion failed: five users exist should have been 5 but was 1\n`;
const step = (n, result, order, status, output, name = 'Run Server Side Script') => ({ sys_id: field(id(n)), test_result: field(result, 'Not a join key'), order: field(String(order)), step: field(id(n + 100), name), status: field(status, status[0].toUpperCase() + status.slice(1)), summary: field(output), output: field(output), start_time: field('2026-11-26 08:43:13'), end_time: field('2026-11-26 08:43:14') });
const tables = {
  sys_atf_test_result: [
    { sys_id: field(id(1)), test: field(id(2), 'Synthetic login'), status: field('failure', 'Failure'), parent: field(id(10), 'TES0001'), start_time: field('2026-11-26 08:43:12') },
    { sys_id: field(id(3)), test: field(id(5), 'Synthetic pass'), status: field('success', 'Success'), parent: field(id(10), 'TES0001'), start_time: field('2026-11-26 08:43:20') },
    { sys_id: field(id(4)), test: field(id(6), 'Synthetic error'), status: field('error', 'Error'), parent: field(id(10), 'TES0001'), start_time: field('2026-11-26 08:43:30') },
  ],
  sys_atf_test_suite_result: [
    { sys_id: field(id(10)), number: field('TES0001'), test_suite: field(id(11), 'Synthetic suite'), status: field('failure', 'Failure'), start_time: field('2026-11-26 08:43:10') },
    { sys_id: field(id(12)), number: field('TES0002'), test_suite: field(id(13), 'Synthetic child suite'), status: field('failure', 'Failure'), parent: field(id(10), 'TES0001'), start_time: field('2026-11-26 08:43:40') },
    { sys_id: field(id(14)), number: field('TES0003'), test_suite: field(id(15), 'Synthetic passing child'), status: field('success', 'Success'), parent: field(id(10), 'TES0001'), start_time: field('2026-11-26 08:43:50') },
  ],
  sys_atf_test_result_step: [
    step(20, id(1), 1, 'success', 'Successfully created user', 'Create a User'),
    step(21, id(1), 2, 'failure', assertion),
    step(22, id(1), 3, 'skipped', 'Skipped', 'Impersonate'),
    step(23, id(3), 1, 'success', 'UI test script passed', 'UI Test Script'),
    step(24, id(4), 1, 'error', 'Error: script threw TypeError: x is undefined'),
  ],
  sys_atf_test_result_item: [
    { sys_id: field(id(30)), test_result: field(id(1)), sys_class_name: field('sys_atf_test_result_item'), type: field('client_log', 'Client Log'), output: field('amb.MessageClient [INFO] >>> connection exists'), start_time: field('2026-11-26 08:43:13') },
    { sys_id: field(id(31)), test_result: field(id(4)), sys_class_name: field('sys_atf_test_result_item'), type: field('client_log', 'Client Log'), output: field('Synthetic suite log line'), start_time: field('2026-11-26 08:43:31') },
  ],
};
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    for (const clause of (params.get('sysparm_query') || '').split('^')) {
      const [, name, op, value] = clause.match(/^(\w+?)(=|IN)(.*)$/) || [];
      if (name) rows = rows.filter(row => op === 'IN' ? value.split(',').includes(row[name]?.value) : row[name]?.value === value);
    }
    return rows.slice(0, Number(params.get('sysparm_limit')));
  } };
}
const queries = sdk => sdk.calls.map(call => [call.table, call.params.get('sysparm_query'), call.params.get('sysparm_limit')]);

test('a test result lists every step in order, joined on the raw result sys_id, and shows why the failed step failed', async () => {
  const sdk = fixtureSdk();
  const data = await readAtfResultDetail(sdk, id(1));
  assert.deepEqual(queries(sdk), [
    ['sys_atf_test_result', `sys_id=${id(1)}`, '1'],
    ['sys_atf_test_result_step', `test_result=${id(1)}^ORDERBYorder`, '201'],
  ]);
  assert.ok(sdk.calls.every(call => call.params.get('sysparm_display_value') === 'all' && call.params.get('sysparm_fields')));
  assert.equal(sdk.calls[1].params.get('sysparm_fields'), 'sys_id,test_result,order,step,status,summary,output,start_time,end_time');
  assert.deepEqual(data.result_record, { table: 'sys_atf_test_result', sys_id: id(1), test: id(2), test_name: 'Synthetic login', status: 'failure', status_label: 'Failure', started: '2026-11-26 08:43:12', suite_result: id(10) });
  assert.equal(data.failed_tests, undefined);
  assert.equal(data.logs, undefined);
  assert.deepEqual(data.steps.records.map(s => [s.order, s.status, s.step_name, s.step]), [['1', 'success', 'Create a User', id(120)], ['2', 'failure', 'Run Server Side Script', id(121)], ['3', 'skipped', 'Impersonate', id(122)]]);
  assert.deepEqual({ ...data.steps.records[1], summary: undefined }, { sys_id: id(21), test_result: id(1), order: '2', step: id(121), step_name: 'Run Server Side Script', status: 'failure', status_label: 'Failure', summary: undefined, output: assertion, output_length: assertion.length, truncated: false, start_time: '2026-11-26 08:43:13', end_time: '2026-11-26 08:43:14' });
  assert.equal(data.steps.has_more, false);
  const human = formatAtfResult(data);
  assert.match(human, /^Synthetic login: Failure\nsys_atf_test_result 0+1, started 2026-11-26 08:43:12 UTC/);
  assert.match(human, /Steps \(3\):\n {4}1 {2}success {2}Create a User\n {4}2 {2}failure {2}Run Server Side Script\n {9}00:43:13\.697 App:Synthetic x_synthetic: Assertion failed: five users exist should have been 5 but was 1\n {4}3 {2}skipped {2}Impersonate/);
  assert.doesNotMatch(human, /<a href|Loading script|Log lines/);
});

test('a suite result shows its failed and errored tests with only their failed steps, and lists failed child suites', async () => {
  const sdk = fixtureSdk();
  const data = await readAtfResultDetail(sdk, id(10));
  assert.deepEqual(queries(sdk), [
    ['sys_atf_test_result', `sys_id=${id(10)}`, '1'],
    ['sys_atf_test_suite_result', `sys_id=${id(10)}`, '1'],
    ['sys_atf_test_result', `parent=${id(10)}^statusINfailure,error^ORDERBYstart_time`, '51'],
    ['sys_atf_test_suite_result', `parent=${id(10)}^statusINfailure,error^ORDERBYstart_time`, '51'],
    ['sys_atf_test_result_step', `test_resultIN${id(1)},${id(4)}^statusINfailure,error^ORDERBYorder`, '201'],
  ]);
  assert.deepEqual(data.result_record, { table: 'sys_atf_test_suite_result', sys_id: id(10), number: 'TES0001', test_suite: id(11), test_suite_name: 'Synthetic suite', status: 'failure', status_label: 'Failure', started: '2026-11-26 08:43:10', parent_suite_result: null });
  assert.deepEqual(data.failed_suites, { count: 1, has_more: false, records: [{ sys_id: id(12), number: 'TES0002', test_suite: id(13), test_suite_name: 'Synthetic child suite', status: 'failure', status_label: 'Failure', started: '2026-11-26 08:43:40' }] });
  assert.deepEqual(data.failed_tests.records.map(t => [t.sys_id, t.test_name, t.status]), [[id(1), 'Synthetic login', 'failure'], [id(4), 'Synthetic error', 'error']]);
  assert.deepEqual(data.steps.records.map(s => [s.test_result, s.order, s.status]), [[id(1), '2', 'failure'], [id(4), '1', 'error']]);
  const human = formatAtfResult(data);
  assert.match(human, /^Synthetic suite: Failure\nsys_atf_test_suite_result 0+a \(TES0001\), started 2026-11-26 08:43:10 UTC/);
  assert.match(human, /Failed tests \(2\):\n {2}Synthetic login: Failure \(sys_atf_test_result 0+1\)\n {6}2 {2}failure {2}Run Server Side Script\n {11}00:43:13\.697 App:Synthetic x_synthetic: Assertion failed/);
  assert.match(human, / {2}Synthetic error: Error \(sys_atf_test_result 0+4\)\n {6}1 {2}error {4}Run Server Side Script\n {11}Error: script threw TypeError: x is undefined/);
  assert.match(human, /x is undefined\n\nFailed child suites \(1\), each shown by jsn atf results <id>:\n {2}Synthetic child suite: Failure \(sys_atf_test_suite_result 0+c\)$/);
  assert.doesNotMatch(human, /Synthetic pass|Create a User|passing child/);
  const parentOnly = fixtureSdk({ sys_atf_test_result: [tables.sys_atf_test_result[1]] });
  const onlySuites = await readAtfResultDetail(parentOnly, id(10));
  assert.deepEqual([onlySuites.failed_tests.count, onlySuites.failed_suites.count, queries(parentOnly).length], [0, 1, 4]);
  assert.match(formatAtfResult(onlySuites), /UTC\n\nFailed child suites \(1\)/);
  const clean = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result: [tables.sys_atf_test_result[1]], sys_atf_test_suite_result: tables.sys_atf_test_suite_result.slice(0, 1) }), id(10));
  assert.deepEqual([clean.failed_tests.count, clean.failed_suites.count, clean.steps.count], [0, 0, 0]);
  assert.match(formatAtfResult(clean), /No failed or errored test or child suite results were readable for this suite result\.$/);
});

test('--logs reads the base-class result items in recorded order for the tests shown', async () => {
  const sdk = fixtureSdk();
  const data = await readAtfResultDetail(sdk, id(1), { logs: true });
  assert.deepEqual(queries(sdk).at(-1), ['sys_atf_test_result_item', `test_resultIN${id(1)}^sys_class_name=sys_atf_test_result_item^ORDERBYrecorded_at`, '201']);
  assert.deepEqual(data.logs, { table: 'sys_atf_test_result_item', count: 1, has_more: false, records: [{ sys_id: id(30), test_result: id(1), type: 'client_log', time: '2026-11-26 08:43:13', message: 'amb.MessageClient [INFO] >>> connection exists', message_length: 46, truncated: false }] });
  assert.match(formatAtfResult(data), /Log lines \(1\):\n {4}2026-11-26 08:43:13 client_log amb\.MessageClient \[INFO\] >>> connection exists/);
  const suite = fixtureSdk();
  const suiteData = await readAtfResultDetail(suite, id(10), { logs: true });
  assert.equal(queries(suite).at(-1)[1], `test_resultIN${id(1)},${id(4)}^sys_class_name=sys_atf_test_result_item^ORDERBYrecorded_at`);
  assert.match(formatAtfResult(suiteData), /Synthetic error: Error[^]*Log lines \(1\):\n {6}2026-11-26 08:43:31 client_log Synthetic suite log line/);
  const empty = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result_step: [] }), id(1), { logs: true });
  assert.match(formatAtfResult(empty), /No step results were readable: the test stopped before its first step, is still running, or ACLs hide them\.\n\n {2}Log lines \(1\):/);
});

test('a passing step is cut at 16 KB, a failed step keeps its whole output, and long reads say more exist', async () => {
  const long = 'x'.repeat(20000), tail = `${'debug line\n'.repeat(3000)}Assertion failed: the last line`;
  const data = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result_step: [step(20, id(1), 1, 'success', long), step(21, id(1), 2, 'failure', tail)] }), id(1));
  assert.deepEqual([data.steps.records[0].summary.length, data.steps.records[0].output.length, data.steps.records[0].output_length, data.steps.records[0].truncated], [16384, 16384, 20000, true]);
  assert.deepEqual([data.steps.records[1].output, data.steps.records[1].truncated], [tail, false]);
  assert.match(formatAtfResult(data), / {9}Assertion failed: the last line$/m);
  const quiet = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result_step: [step(21, id(1), 1, 'failure', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))] }), id(1));
  assert.match(formatAtfResult(quiet), / {9}line 11\n {9}\(\+8 more line\(s\), --json for the whole output\)/);
  const many = Array.from({ length: 205 }, (_, i) => step(1000 + i, id(1), i + 1, 'success', 'ok'));
  const capped = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result_step: many }), id(1));
  assert.deepEqual([capped.steps.count, capped.steps.has_more], [200, true]);
  assert.match(formatAtfResult(capped), /More step results exist than the 200 read\./);
  const failures = Array.from({ length: 55 }, (_, i) => ({ ...tables.sys_atf_test_result[0], sys_id: field(id(2000 + i)) }));
  const suite = await readAtfResultDetail(fixtureSdk({ sys_atf_test_result: failures }), id(10));
  assert.deepEqual([suite.failed_tests.count, suite.failed_tests.has_more], [50, true]);
  assert.match(formatAtfResult(suite), /More failed tests exist than the 50 read\./);
  const children = Array.from({ length: 52 }, (_, i) => ({ ...tables.sys_atf_test_suite_result[1], sys_id: field(id(3000 + i)) }));
  const nested = await readAtfResultDetail(fixtureSdk({ sys_atf_test_suite_result: [tables.sys_atf_test_suite_result[0], ...children] }), id(10));
  assert.deepEqual([nested.failed_suites.count, nested.failed_suites.records.length, nested.failed_suites.has_more], [50, 50, true]);
  assert.match(formatAtfResult(nested), /More failed child suites exist than the 50 read\.$/);
});

test('invalid result IDs reject before any request', async () => {
  const sdk = fixtureSdk();
  for (const invalid of ['', 'bad', ` ${id(1)}`, `${id(1)}^NQ`, `${id(1)},${id(2)}`, 123, undefined]) await assert.rejects(readAtfResultDetail(sdk, invalid), /sys_id/);
  assert.equal(sdk.calls.length, 0);
});

function answering(table, rows) {
  const sdk = fixtureSdk();
  const base = sdk.listStrict;
  sdk.listStrict = async (name, params) => name === table ? (sdk.calls.push({ table: name, params }), rows) : base(name, params);
  return sdk;
}

test('an unknown id is no detail, and mismatched, denied or malformed reads are never reported as steps', async () => {
  assert.equal(await readAtfResultDetail(fixtureSdk(), id(99)), null);
  await assert.rejects(readAtfResultDetail(answering('sys_atf_test_result', [{ ...tables.sys_atf_test_result[0], sys_id: field(id(98), id(1)) }]), id(1)), /different record/);
  await assert.rejects(readAtfResultDetail(answering('sys_atf_test_suite_result', [{ ...tables.sys_atf_test_suite_result[0], sys_id: field(id(98), id(10)) }]), id(10)), /different record/);
  await assert.rejects(readAtfResultDetail(answering('sys_atf_test_result_step', [{ ...tables.sys_atf_test_result_step[0], test_result: field(id(98), id(1)) }]), id(1)), /another test result/);
  await assert.rejects(readAtfResultDetail(answering('sys_atf_test_result_item', [{ ...tables.sys_atf_test_result_item[0], test_result: field(id(98), id(1)) }]), id(1), { logs: true }), /another test result/);
  const strayParent = fixtureSdk({ sys_atf_test_result: [] });
  const base = strayParent.listStrict;
  strayParent.listStrict = async (name, params) => params.get('sysparm_query').startsWith('parent=') ? [{ ...tables.sys_atf_test_result[0], parent: field(id(98), 'TES0001') }] : base(name, params);
  await assert.rejects(readAtfResultDetail(strayParent, id(10)), /^Error: sys_atf_test_result returned rows from another suite result/);
  const strayChild = fixtureSdk();
  strayChild.listStrict = async (name, params) => name === 'sys_atf_test_suite_result' && params.get('sysparm_query').startsWith('parent=') ? [{ ...tables.sys_atf_test_suite_result[1], parent: field(id(98), 'TES0001') }] : fixtureSdk().listStrict(name, params);
  await assert.rejects(readAtfResultDetail(strayChild, id(10)), /^Error: sys_atf_test_suite_result returned rows from another suite result/);
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(readAtfResultDetail({ listStrict: async () => { throw error; } }, id(1)), e => e === error && e.table === 'sys_atf_test_result');
  }
  await assert.rejects(readAtfResultDetail({ listStrict: async () => [null] }, id(1)), /Malformed/);
  await assert.rejects(readAtfResultDetail(answering('sys_atf_test_result_step', [[]]), id(1)), /Malformed/);
});

test('real CLI shows a result with its steps on a read-only profile, and rejects bad input before any request', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const parts = url.pathname.split('/');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/now/table/sys_atf_test_result_step' && url.searchParams.get('sysparm_query').startsWith(`test_result=${id(4)}`)) { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'Synthetic ACL' } })); }
    if (url.pathname === '/api/now/table/sys_atf_test_result_step' && url.searchParams.get('sysparm_query').startsWith(`test_result=${id(3)}`)) return res.end(JSON.stringify({ result: {} }));
    if (url.pathname === `/api/sn_cicd/progress/${id(50)}`) return res.end(JSON.stringify({ result: { status: '1', percent_complete: 10, status_message: 'Running', links: {} } }));
    if (!url.pathname.startsWith('/api/now/table/')) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'Requested URI does not represent any resource' } })); }
    if (parts.length === 6) {
      const row = (tables[parts[4]] || []).find(r => r.sys_id.value === parts[5]);
      if (!row) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'No Record found' } })); }
      return res.end(JSON.stringify({ result: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.value])) }));
    }
    Promise.resolve(fixtureSdk().listStrict(parts[4], url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-atf-results-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['atf', 'results', id(1), '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, 'failure');
    assert.equal(envelope.data.table, 'sys_atf_test_result');
    assert.deepEqual(envelope.data.steps.records.map(s => s.status), ['success', 'failure', 'skipped']);
    assert.equal(envelope.data.steps.count, 3);
    const human = await run(['atf', 'results', id(1), '--logs', '--format', 'styled']);
    assert.match(human.stdout, /2 {2}failure {2}Run Server Side Script\n +00:43:13\.697 App:Synthetic x_synthetic: Assertion failed/);
    assert.match(human.stdout, /Log lines \(1\):/);
    const get = await run(['atf', 'results', id(10), '--get', 'data.failed_tests.count']);
    assert.equal(get.stdout.trim(), '2');
    const upper = await run(['atf', 'results', id(10).toUpperCase(), '--get', 'data.failed_tests.count']);
    assert.equal(upper.stdout.trim(), '2');
    const pending = JSON.parse((await run(['atf', 'results', id(50), '--json'])).stdout);
    assert.deepEqual([pending.data.status, pending.data.steps], ['running', undefined]);
    assert.match(pending.data.warnings[0], /^No step detail: no readable sys_atf_test_result or sys_atf_test_suite_result has sys_id 0+32\. A run still in progress has no result yet, or ACLs hide it\.$/);
    const denied = await run(['atf', 'results', id(4), '--json']);
    const deniedEnvelope = JSON.parse(denied.stdout);
    assert.deepEqual([deniedEnvelope.ok, deniedEnvelope.data.status, deniedEnvelope.data.steps], [true, 'error', undefined]);
    assert.deepEqual(deniedEnvelope.data.warnings, ['No step detail: the profile may not read sys_atf_test_result_step (HTTP 403).']);
    const malformed = await run(['atf', 'results', id(3), '--json']).catch(error => error);
    assert.deepEqual([malformed.code, malformed.stdout], [1, '']);
    assert.match(malformed.stderr, /Malformed table response for sys_atf_test_result_step/);
    const deniedHuman = await run(['atf', 'results', id(4)]);
    assert.match(deniedHuman.stdout + deniedHuman.stderr, /may not read sys_atf_test_result_step \(HTTP 403\)/);
    const none = await run(['atf', 'results', id(99), '--json']).catch(error => error);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /not_found/);
    const before = calls.length;
    for (const args of [['bad'], [`${id(1)}^NQ`], [id(1), '--typo']]) {
      await assert.rejects(run(['atf', 'results', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['atf', 'results', '--help']);
    assert.match(help.stdout, /--logs/);
    assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
