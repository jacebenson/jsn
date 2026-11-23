import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yargs from '../src/cli-adapter.js';
import { scanCmd } from '../src/commands/scan.js';
import { CHECK_TABLES, prepareScan, startScan, scanResults, scanStatus, cancelScan } from '../src/scan.js';
import { OutputWriter, FormatJSON } from '../src/output.js';
import { contextArgs, contextResponse } from './helpers/intended-context.js';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';

const cliJsn = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const execFileAsync = promisify(execFile);

const ID = 'a'.repeat(32), RESULT = 'b'.repeat(32), SUITE = 'c'.repeat(32), CHECK = 'd'.repeat(32), TARGET = 'e'.repeat(32);

function fixture() {
  const tables = new Map(), writes = [], requests = [], output = [];
  let serial = 1;
  const rows = table => { if (!tables.has(table)) tables.set(table, []); return tables.get(table); };
  const list = async (table, params) => {
    const query = params.get('sysparm_query') || '';
    if (table === 'sys_user') return [{ sys_id: 'user' }];
    if (table === 'sys_user_preference') return [{ value: 'global' }];
    return rows(table).filter(row => query.split('^').filter(Boolean).every(clause => {
      if (clause.startsWith('ORDERBY')) return true;
      const i = clause.indexOf('=');
      if (i < 0) return true;
      return String(row[clause.slice(0, i)] ?? '') === clause.slice(i + 1);
    })).slice(Number(params.get('sysparm_offset') || 0), Number(params.get('sysparm_offset') || 0) + Number(params.get('sysparm_limit') || 50));
  };
  const sdk = {
    baseURL: 'https://example.invalid', list, listStrict: list,
    get: async (table, id) => rows(table).find(row => row.sys_id === id) || null,
    create: async (table, data) => {
      const row = { ...data, sys_id: (serial++).toString(16).padStart(32, '0'), sys_scope: 'global', sys_class_name: table };
      rows(table).push(row);
      if (Object.values(CHECK_TABLES).includes(table)) rows('scan_check').push(row);
      writes.push({ table, data }); return row;
    },
    update: async (table, id, data) => { const row = rows(table).find(row => row.sys_id === id); Object.assign(row, data); writes.push({ table, id, data }); return row; },
    delete: async (table, id) => { tables.set(table, rows(table).filter(row => row.sys_id !== id)); writes.push({ table, id, deleted: true }); },
    request: async (url, opts) => { requests.push({ url, ...opts }); return { result: { status: '0', error: '', links: { progress: { id: ID } } } }; },
    rawRequest: async (url, opts) => { requests.push({ url, ...opts }); return `<xml answer="{&quot;status&quot;:0,&quot;progressId&quot;:&quot;${ID}&quot;}"/>`; },
  };
  const app = { sdk, config: { profiles: {} }, ok: (data, meta) => output.push({ data, meta }) };
  const run = args => yargs(['scan', ...args]).option('profile', { type: 'string' }).option('instance', { type: 'string' })
    .option('force', { type: 'boolean' }).command(scanCmd(fn => argv => fn(argv, app))).parse();
  rows('sys_update_set').push({ sys_id: TARGET, name: 'Test set' });
  rows('sys_scope').push({ sys_id: TARGET, scope: 'x_test', name: 'Test app' });
  rows('sys_script_include').push({ sys_id: TARGET, name: 'Fixture', active: false });
  rows('scan_check_suite').push({ sys_id: SUITE, name: 'Suite', active: true, sys_scope: 'global' });
  rows('sys_execution_tracker').push({ sys_id: ID, type: 'instance_scan', state: '2', result: JSON.stringify({ result_id: RESULT }) });
  rows('scan_result').push({ sys_id: RESULT, finding_count: '1', number: 'SR1' });
  rows('scan_check_execution').push({ sys_id: '1', result: RESULT, check: CHECK, message: '' });
  rows('scan_finding').push({ sys_id: '2', result: RESULT, check: CHECK, count: '1' });
  return { sdk, rows, writes, requests, output, run };
}

for (const [type, details] of [
  ['table', { table: 'sys_script_include', conditions: 'active=true' }],
  ['column', { column_type: 'script', script: '(function(engine) {})(engine);' }],
  ['linter', { script: '(function(engine) {})(engine);' }],
  ['script', { script: '(function(finding) {})(finding);' }],
]) test(`${type} check creation, activation and deactivation preserve fields and never start scans`, async () => {
  const f = fixture();
  await f.run(['checks', 'create', '--type', type, '--data', JSON.stringify({ name: 'Test', ...details }), '--profile', 'pdi']);
  const created = f.output[0].data;
  assert.equal(created.active, false);
  assert.equal(f.writes[0].table, CHECK_TABLES[type]);
  assert.ok(f.output[0].meta.breadcrumbs.every(h => h.cmd.includes('--profile')));
  await f.run(['checks', 'activate', created.sys_id]);
  assert.equal(created.active, true);
  await f.run(['checks', 'deactivate', created.sys_id]);
  assert.equal(created.active, false);
  assert.deepEqual(f.requests, []);
});

test('suite membership is idempotent and removing a member retains its check', async () => {
  const f = fixture();
  f.rows('scan_check').push({ sys_id: CHECK, name: 'Check' });
  await f.run(['suites', 'add-check', SUITE, '--check', CHECK]);
  await f.run(['suites', 'add-check', SUITE, '--check', CHECK]);
  assert.equal(f.rows('scan_check_suite_check').length, 1);
  assert.equal(f.output.at(-1).data.changed, false);
  await assert.rejects(f.run(['suites', 'remove-check', SUITE, '--check', CHECK]), error => error.code === 'confirmation_required');
  await f.run(['suites', 'remove-check', SUITE, '--check', CHECK, '--force']);
  assert.equal(f.rows('scan_check_suite_check').length, 0);
  assert.equal(f.rows('scan_check').length, 1);
});

test('invalid creation payloads fail before writes', async () => {
  for (const [type, data] of [['script', { name: 'Missing script' }], ['table', { name: 'Missing table' }],
    ['table', { name: 'Advanced', table: 'sys_script', advanced: true }],
    ['column', { name: 'Invalid', column_type: 'made-up', script: 'x' }],
    ['linter', { name: 'Bad class', script: 'x', sys_class_name: 'sys_user' }]]) {
    const f = fixture();
    await assert.rejects(f.run(['checks', 'create', '--type', type, '--data', JSON.stringify(data)]));
    assert.deepEqual(f.writes, []);
  }
});

test('clearing a required script and changing a foreign scope are refused before writes', async () => {
  const f = fixture();
  const record = { sys_id: CHECK, name: 'Script', sys_class_name: 'scan_script_only_check', sys_scope: 'other', script: 'original' };
  f.rows('scan_check').push(record);
  f.rows('scan_script_only_check').push(record);
  await assert.rejects(f.run(['checks', 'update', CHECK, '--data', '{"script":""}']), /script/);
  await assert.rejects(f.run(['checks', 'update', CHECK, '--data', '{"description":"new"}']), /scope/);
  assert.deepEqual(f.writes, []);
});

test('ambiguous names cannot choose a check to mutate', async () => {
  const f = fixture();
  f.rows('scan_check').push({ sys_id: CHECK, name: 'Duplicate' }, { sys_id: ID, name: 'Duplicate' });
  await assert.rejects(f.run(['checks', 'activate', 'Duplicate']), error => error.code === 'ambiguous');
  assert.deepEqual(f.writes, []);
});

test('base check reads hydrate subtype fields before activation and show', async () => {
  const f = fixture();
  f.rows('scan_check').push({ sys_id: CHECK, name: 'Typed', sys_class_name: 'scan_table_check', sys_scope: 'global' });
  f.rows('scan_table_check').push({ sys_id: CHECK, name: 'Typed', sys_class_name: 'scan_table_check', sys_scope: 'global', table: 'sys_script_include', advanced: false, active: false });
  await f.run(['checks', 'show', CHECK]);
  assert.equal(f.output.at(-1).data.table, 'sys_script_include');
  await f.run(['checks', 'activate', CHECK]);
  assert.equal(f.rows('scan_table_check')[0].active, true);
});

test('write-back drops report partial failure instead of success', async () => {
  const f = fixture(), create = f.sdk.create;
  f.sdk.create = async (table, data) => { const record = await create(table, data); delete record.script; return record; };
  await assert.rejects(f.run(['checks', 'create', '--type', 'script', '--data', '{"name":"Dropped","script":"original"}']), /Write-back/);
  assert.equal(f.output.length, 0);
});

test('targets are mandatory, mutually exclusive, and inactive suites cannot dispatch', async () => {
  const f = fixture();
  for (const argv of [{}, { previous: '' }, { full: true, suite: '' }, { full: true, scope: 'x_test' }, { record: TARGET }, { table: 'sys_script' }, { record: TARGET, table: 'bad^table' }]) {
    await assert.rejects(prepareScan(f.sdk, argv));
  }
  f.rows('scan_check_suite')[0].active = false;
  await assert.rejects(prepareScan(f.sdk, { full: true, suite: SUITE }), /inactive/);
  assert.deepEqual(f.requests, []);
});

for (const [argv, method] of [
  [{ updateSet: 'Test set' }, 'executeUpdateSetScan'],
  [{ scope: 'x_test' }, 'executeAppScan'],
  [{ record: TARGET, table: 'sys_script_include' }, 'executePointScan'],
  [{ record: TARGET, table: 'sys_script_include', suite: SUITE }, 'executeSuiteScanWithTargets'],
  [{ full: true, suite: SUITE }, 'executeSuiteScan'],
  [{ full: true }, 'executeFullScan'],
]) test(`explicit scan dispatch uses ${method} once and validates its execution id`, async () => {
  const f = fixture();
  const plan = await prepareScan(f.sdk, argv);
  const scheduled = await startScan(f.sdk, plan);
  assert.equal(scheduled.execution_id, ID);
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url).searchParams.get('sysparm_name'), method);
  if (argv.record && !argv.suite) assert.equal(plan.target.inactive, true);
});

test('suite-targeted REST calls send resolved ids and never retry rejected mutations', async () => {
  const f = fixture();
  await startScan(f.sdk, await prepareScan(f.sdk, { updateSet: 'Test set', suite: SUITE }));
  assert.deepEqual(JSON.parse(f.requests[0].body), { update_set_sys_ids: [TARGET] });
  assert.match(f.requests[0].url, /suite_scan\/.+\/update_sets$/);
  const error = Object.assign(new Error('forbidden'), { status: 403 });
  f.sdk.request = async () => { throw error; };
  await assert.rejects(startScan(f.sdk, await prepareScan(f.sdk, { scope: 'x_test', suite: SUITE })), error);
  assert.equal(f.requests.length, 1);
});

test('failed or malformed AJAX answers never look like successful dispatch', async () => {
  const f = fixture();
  for (const body of ['<html>sign in</html>', '<xml answer="{&quot;status&quot;:1}"/>', '<xml answer="not JSON"/>', '<!DOCTYPE xml><xml/>']) {
    f.sdk.rawRequest = async () => body;
    await assert.rejects(startScan(f.sdk, { target: { kind: 'full' }, suite_id: null }));
  }
});

test('run confirmation precedes scheduling and completed output includes real counts and pinned hints', async () => {
  const f = fixture();
  await assert.rejects(f.run(['run', '--record', TARGET, '--table', 'sys_script_include']), error => error.code === 'confirmation_required');
  assert.deepEqual(f.requests, []);
  await f.run(['run', '--record', TARGET, '--table', 'sys_script_include', '--wait', '--force', '--profile', 'pdi']);
  const { data, meta } = f.output.at(-1);
  assert.equal(data.status, 'successful');
  assert.equal(data.findings_count, 1);
  assert.equal(data.checks_executed, 1);
  assert.ok(meta.breadcrumbs.every(h => h.cmd.endsWith('--profile pdi')));
});

test('result errors, missing counts and truncation remain distinct from zero findings', async () => {
  const f = fixture();
  f.rows('scan_result')[0].finding_count = null;
  const list = f.sdk.listStrict;
  f.sdk.listStrict = async (table, params) => { if (table === 'scan_finding') throw new Error('denied'); return list(table, params); };
  let result = await scanResults(f.sdk, ID);
  assert.equal(result.findings_count, null);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.unavailable, ['scan_result.finding_count', 'scan_finding']);
  f.sdk.listStrict = list;
  f.rows('scan_check_execution').push({ sys_id: '3', result: RESULT, check: ID });
  result = await scanResults(f.sdk, ID, 1);
  assert.equal(result.checks_executed, null);
  assert.equal(result.truncated.checks, true);
});

test('an expired wait preserves the execution id without cancellation or resubmission', async () => {
  const f = fixture();
  f.rows('sys_execution_tracker')[0].state = '1';
  await f.run(['run', '--record', TARGET, '--table', 'sys_script_include', '--wait', '--timeout', '1', '--force']);
  assert.equal(f.output.at(-1).data.execution_id, ID);
  assert.equal(f.output.at(-1).data.wait_timed_out, true);
  assert.equal(f.output.at(-1).data.terminal, false);
  assert.equal(f.requests.length, 1);
});

test('initializing trackers are tolerated only when waiting for a dispatched scan', async () => {
  const f = fixture();
  f.rows('sys_execution_tracker')[0].type = '';
  assert.equal((await scanStatus(f.sdk, ID, { allowInitializing: true })).status, 'pending');
  await assert.rejects(scanStatus(f.sdk, ID), /not an Instance Scan/);
  await assert.rejects(cancelScan(f.sdk, ID), /not an Instance Scan/);
  f.rows('sys_execution_tracker')[0].type = 'sys.instance_scan.queue';
  assert.equal((await scanStatus(f.sdk, ID)).status, 'pending');
  f.rows('sys_execution_tracker')[0].type = 'unrelated_job';
  await assert.rejects(scanStatus(f.sdk, ID, { allowInitializing: true }), /not an Instance Scan/);
});

test('a post-dispatch read failure retains the execution id and does not submit twice', async () => {
  const f = fixture(), get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'sys_execution_tracker') throw new Error('offline'); return get(table, id); };
  await assert.rejects(f.run(['run', '--full', '--wait', '--force']), error => error.message.includes(ID) && error.message.includes('do not resubmit'));
  assert.equal(f.requests.length, 1);
});

test('only Instance Scan executions can be inspected or cancelled, and terminal cancellation is a no-op', async () => {
  const f = fixture();
  assert.equal((await cancelScan(f.sdk, ID)).cancellation_requested, false);
  assert.deepEqual(f.requests, []);
  f.rows('sys_execution_tracker')[0].type = 'unrelated_job';
  await assert.rejects(cancelScan(f.sdk, ID), /not an Instance Scan/);
  await assert.rejects(scanStatus(f.sdk, 'bad^id'), /32-character/);
  assert.deepEqual(f.requests, []);
});

test('cancellation preserves provider state and confirms the requested execution', async () => {
  const f = fixture(), tracker = f.rows('sys_execution_tracker')[0];
  tracker.state = '1';
  f.sdk.rawRequest = async url => {
    assert.equal(new URL(url).searchParams.get('sysparm_progress_id'), ID);
    tracker.state = '4';
    return '<xml answer="Scan transaction cancelled successfully."/>';
  };
  const result = await cancelScan(f.sdk, ID);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellation_requested, true);
});

test('rerun preserves the previous combo and requires explicit breadth for instance-wide targets', async () => {
  const f = fixture();
  f.rows('scan_result')[0].combo = CHECK;
  f.rows('scan_combo').push({ sys_id: CHECK, targets: '' });
  await assert.rejects(prepareScan(f.sdk, { previous: ID }), /--full/);
  const plan = await prepareScan(f.sdk, { previous: ID, full: true });
  await startScan(f.sdk, plan);
  const params = new URL(f.requests[0].url).searchParams;
  assert.equal(params.get('sysparm_name'), 'executeScanFromCombo');
  assert.equal(params.get('sysparm_combo_id'), CHECK);
});

test('real CLI guards nested writes before authentication and exposes scan help and discovery', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-scan-ro-'));
  fs.mkdirSync(path.join(home, 'servicenow'));
  fs.writeFileSync(path.join(home, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'ro', profiles: {
    ro: { instance_url: 'https://example.invalid', auth_method: 'oauth', read_only: true },
  } }));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: home, JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_DATA_HOME: path.join(home, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
    for (const args of [['checks', 'activate', CHECK], ['suites', 'add-check', SUITE, '--check', CHECK], ['run', '--full'], ['cancel', ID]]) {
      const result = spawnSync(process.execPath, ['bin/jsn.js', 'scan', ...args, '--profile', 'ro', '--json'], { encoding: 'utf8', env, timeout: 15000 });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /read.only/i);
    }
    const help = spawnSync(process.execPath, ['bin/jsn.js', 'scan', '--help'], { encoding: 'utf8', env });
    assert.ifError(help.error);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /checks/);
    assert.match(help.stdout, /results/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- Issue 551: point scans must read as Instance Scan executions without
// claiming a verified result, and partial/unretrieved findings must never read
// as a clean zero. Fixtures below are synthetic; no live instance is involved.

function pointScan(f, { tracker = {}, result = {} } = {}) {
  Object.assign(f.rows('sys_execution_tracker')[0], { type: 'point_scan', state: '2', percent_complete: '100',
    message: 'Scan completed with 0 warning(s), 0 error(s), and 1 finding(s)' }, tracker);
  Object.assign(f.rows('scan_result')[0], { scan_type: 'Point Scan', state: 'Complete', finding_count: '1', progress_id: ID }, result);
  f.rows('scan_finding').length = 0;
  return f;
}

test('point_scan executions are accepted for status and results with a linked result', async () => {
  const f = pointScan(fixture());
  const status = await scanStatus(f.sdk, ID);
  assert.equal(status.execution_type, 'point_scan');
  assert.equal(status.status, 'successful');
  assert.equal(status.result_id, RESULT);
  assert.equal(status.result_link, 'linked');
  assert.equal(status.phase, 'dispatched');
  assert.ok(!Object.hasOwn(status, 'result_verified'), 'status reports only a parsed reference, never verification');
  const results = await scanResults(f.sdk, ID);
  assert.equal(results.execution_type, 'point_scan');
  assert.equal(results.result_verified, true);
  assert.equal(results.back_reference, 'matched');
  assert.equal(results.scan_number, 'SR1');
  assert.equal(results.findings_count, 1);
  assert.equal(results.findings_state, 'unretrieved');
  assert.equal(results.incomplete, true);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('queued and initializing point scans stay distinct from terminal executions', async () => {
  const f = pointScan(fixture());
  const tracker = f.rows('sys_execution_tracker')[0];
  const result = tracker.result;
  Object.assign(tracker, { type: '', state: '', result: '' });
  let status = await scanStatus(f.sdk, ID, { allowInitializing: true });
  assert.equal(status.status, 'pending');
  assert.equal(status.phase, 'initializing');
  assert.equal(status.terminal, false);
  assert.equal(status.execution_type, '');
  await assert.rejects(scanStatus(f.sdk, ID), /not an Instance Scan/);
  tracker.type = 'sys.instance_scan.queue';
  status = await scanStatus(f.sdk, ID);
  assert.equal(status.status, 'pending');
  assert.equal(status.phase, 'queued');
  assert.equal(status.result_id, null);
  assert.equal(status.result_link, 'missing');
  Object.assign(tracker, { type: 'point_scan', state: '1', result });
  status = await scanStatus(f.sdk, ID);
  assert.equal(status.status, 'running');
  assert.equal(status.terminal, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('unrelated tracker types are rejected for status, results and cancellation', async () => {
  const f = pointScan(fixture());
  f.rows('sys_execution_tracker')[0].type = 'sys_scan_queue_item';
  for (const call of [() => scanStatus(f.sdk, ID, { allowInitializing: true }), () => scanResults(f.sdk, ID), () => cancelScan(f.sdk, ID)]) {
    await assert.rejects(call, error => error.message === 'This execution tracker is not an Instance Scan.');
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('missing, denied or malformed tracker metadata never verifies success', async () => {
  const f = pointScan(fixture());
  const tracker = f.rows('sys_execution_tracker')[0];
  delete tracker.result;
  let status = await scanStatus(f.sdk, ID);
  assert.equal(status.result_link, 'missing');
  assert.equal(status.result_id, null);
  let results = await scanResults(f.sdk, ID);
  assert.equal(results.result_verified, false);
  assert.equal(results.incomplete, true);
  assert.deepEqual(results.unavailable, ['scan_result']);
  assert.equal(results.findings_state, 'unknown');
  for (const body of ['not json', '{}', JSON.stringify({ result_id: 'short' }), JSON.stringify({ result_id: null })]) {
    tracker.result = body;
    status = await scanStatus(f.sdk, ID);
    assert.equal(status.result_link, 'malformed');
    assert.equal(status.result_id, null);
    await f.run(['results', ID]);
    assert.equal(f.output.at(-1).data.result_link, 'malformed');
    assert.equal(f.output.at(-1).data.result_verified, false);
    assert.equal(f.output.at(-1).data.findings_count, null);
    assert.equal(f.output.at(-1).data.findings_state, 'unknown');
  }
  tracker.result = JSON.stringify({ result_id: RESULT });
  const get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'sys_execution_tracker') throw new Error('denied'); return get(table, id); };
  await assert.rejects(scanStatus(f.sdk, ID), /denied/);
  await assert.rejects(scanResults(f.sdk, ID), /denied/);
});

test('a denied or missing scan result is reported and never counted', async () => {
  const f = pointScan(fixture());
  const get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'scan_result') throw new Error('denied'); return get(table, id); };
  let results = await scanResults(f.sdk, ID);
  assert.equal(results.result_verified, false);
  assert.equal(results.findings_count, null);
  assert.equal(results.findings_state, 'unknown');
  assert.equal(results.incomplete, true);
  assert.ok(results.unavailable.includes('scan_result'));
  f.sdk.get = async (table, id) => (table === 'scan_result' ? null : get(table, id));
  results = await scanResults(f.sdk, ID);
  assert.equal(results.result_verified, false);
  assert.equal(results.findings_count, null);
  assert.deepEqual(results.unavailable, ['scan_result']);
  assert.equal(results.findings_state, 'unknown');
});

test('a foreign or absent result back-reference makes a point scan result unusable', async () => {
  const f = pointScan(fixture(), { result: { progress_id: SUITE } });
  let results = await scanResults(f.sdk, ID);
  assert.equal(results.findings_count, null);
  assert.equal(results.scan_number, undefined);
  assert.ok(results.unavailable.includes('scan_result.back_reference'));
  assert.equal(results.incomplete, true);
  pointScan(f, { result: { progress_id: '' } });
  results = await scanResults(f.sdk, ID);
  assert.ok(results.unavailable.includes('scan_result.back_reference'));
  assert.equal(results.incomplete, true);
  f.rows('sys_execution_tracker')[0].type = 'instance_scan';
  results = await scanResults(f.sdk, ID);
  assert.equal(results.findings_count, 1);
  assert.ok(!results.unavailable.includes('scan_result.back_reference'));
});

test('findings reconciliation separates unretrieved, verified zero and truncation', async () => {
  const f = pointScan(fixture());
  let results = await scanResults(f.sdk, ID);
  assert.equal(results.findings_state, 'unretrieved');
  assert.equal(results.incomplete, true);
  assert.equal(results.checks_state, 'verified');
  pointScan(f, { result: { finding_count: '0' } });
  results = await scanResults(f.sdk, ID);
  assert.equal(results.findings_state, 'verified');
  assert.equal(results.findings_count, 0);
  assert.equal(results.incomplete, false);
  pointScan(f, { result: { finding_count: '2' } });
  f.rows('scan_finding').push({ sys_id: '3', result: RESULT, check: CHECK, count: '1' },
    { sys_id: '4', result: RESULT, check: CHECK, count: '1' });
  results = await scanResults(f.sdk, ID, 1);
  assert.equal(results.findings_state, 'truncated');
  assert.equal(results.truncated.findings, true);
  f.rows('scan_check_execution').length = 0;
  results = await scanResults(f.sdk, ID);
  assert.equal(results.checks_state, 'empty');
  const list = f.sdk.listStrict;
  f.sdk.listStrict = async (table, params) => { if (table === 'scan_check_execution') throw new Error('denied'); return list(table, params); };
  results = await scanResults(f.sdk, ID);
  assert.equal(results.checks_state, 'unknown');
});

test('results output states an unretrieved findings set instead of a bare count', async () => {
  const f = pointScan(fixture());
  await f.run(['results', ID]);
  assert.match(f.output.at(-1).meta.summary, /findings unretrieved \(1 reported, 0 rows returned\)/);
  assert.equal(f.output.at(-1).data.findings_state, 'unretrieved');
});

test('post-dispatch progress failures keep a structured recovery with one dispatch and no cancel', async () => {
  const f = fixture(), get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'sys_execution_tracker') throw new Error('offline'); return get(table, id); };
  let error;
  await assert.rejects(f.run(['run', '--full', '--wait', '--force']), caught => {
    error = caught;
    return caught.message.includes(ID) && caught.message.includes('do not resubmit automatically');
  });
  assert.equal(error.recovery.execution_id, ID);
  assert.equal(error.recovery.via, 'ScanAjaxProcessor');
  assert.equal(error.recovery.phase, 'progress');
  assert.deepEqual(error.recovery.target, { kind: 'full' });
  assert.equal(error.recovery.suite_id, null);
  assert.equal(error.recovery.status, 'unverified');
  assert.equal(error.recovery.status_command, `jsn scan status ${ID}`);
  assert.equal(error.recovery.results_command, `jsn scan results ${ID}`);
  assert.equal(error.recovery.resubmit, 'forbidden');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests.filter(request => /cancel/i.test(request.url)), []);
  assert.deepEqual(f.writes, []);
});

test('a failure reading results after a terminal status reports phase results', async () => {
  const f = pointScan(fixture()), get = f.sdk.get;
  let trackerReads = 0;
  f.sdk.get = async (table, id) => {
    if (table === 'sys_execution_tracker' && ++trackerReads > 1) throw new Error('denied after terminal');
    return get(table, id);
  };
  let error;
  await assert.rejects(f.run(['run', '--record', TARGET, '--table', 'sys_script_include', '--wait', '--force']), caught => { error = caught; return true; });
  assert.equal(error.recovery.phase, 'results');
  assert.equal(error.recovery.execution_id, ID);
  assert.match(error.message, /results could not be read/);
  assert.match(error.message, /do not resubmit automatically/);
  assert.deepEqual(error.recovery.target, { kind: 'record', sys_id: TARGET, table: 'sys_script_include' });
  assert.equal(error.recovery.resubmit, 'forbidden');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.writes, []);
});

test('the JSON error envelope carries the structured recovery object', async () => {
  const f = fixture(), get = f.sdk.get;
  f.sdk.get = async (table, id) => { if (table === 'sys_execution_tracker') throw new Error('offline'); return get(table, id); };
  let error;
  try { await f.run(['run', '--update-set', 'Test set', '--wait', '--force']); } catch (caught) { error = caught; }
  assert.ok(error?.recovery, 'expected a recovery object');
  const chunks = [];
  new OutputWriter({ format: FormatJSON, writer: { write: text => chunks.push(text) } }).err(error);
  const envelope = JSON.parse(chunks.join(''));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, error.code);
  assert.equal(envelope.recovery.execution_id, ID);
  assert.equal(envelope.recovery.phase, 'progress');
  assert.deepEqual(envelope.recovery.target, { kind: 'update_set', sys_id: TARGET, name: 'Test set' });
  assert.equal(envelope.recovery.status, 'unverified');
  assert.equal(envelope.recovery.resubmit, 'forbidden');
});

test('registered CLI reports a point scan read without writes or dispatch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-scan-point-'));
  const tracker = { sys_id: ID, type: 'point_scan', state: '2', percent_complete: '100',
    message: 'Scan completed with 0 warning(s), 0 error(s), and 1 finding(s)',
    result: JSON.stringify({ result_id: RESULT }) };
  const result = { sys_id: RESULT, number: 'SR1', scan_type: 'Point Scan', state: 'Complete', finding_count: '0', progress_id: ID };
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    seen.push(`${request.method} ${url.pathname}`);
    const body = url.pathname === `/api/now/table/sys_execution_tracker/${ID}` ? { result: tracker }
      : url.pathname === `/api/now/table/scan_result/${RESULT}` ? { result }
        : contextResponse(url) || { result: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const configDir = path.join(home, 'config');
    fs.mkdirSync(path.join(configDir, 'servicenow'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'fixture',
      profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_|XDG_)/i.test(key)));
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: configDir,
      JSN_DATA_HOME: path.join(home, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
      JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', TMPDIR: process.env.TMPDIR || os.tmpdir(),
      SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' });
    const runCli = async args => {
      try {
        const { stdout } = await execFileAsync(process.execPath,
          [...credentialFixtureArgs, cliJsn, 'scan', ...args, '--json', ...contextArgs], { env, timeout: 20000 });
        return { code: 0, stdout, stderr: '' };
      } catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
    };
    const status = await runCli(['status', ID]);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    const statusEnvelope = JSON.parse(status.stdout);
    assert.equal(statusEnvelope.data.execution_type, 'point_scan');
    assert.equal(statusEnvelope.data.result_link, 'linked');
    const results = await runCli(['results', ID]);
    assert.equal(results.code, 0, results.stderr || results.stdout);
    const resultsEnvelope = JSON.parse(results.stdout);
    assert.equal(resultsEnvelope.data.findings_state, 'verified');
    assert.equal(resultsEnvelope.data.findings_count, 0);
    // /angular.do is the read-only context probe; table mutations are the concern.
    assert.ok(seen.every(line => !/^(POST|PUT|DELETE|PATCH) .*\/api\/now\/table\//.test(line)), `unexpected writes: ${seen.join(', ')}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a tracker returned under a different sys_id is refused, not reported', async () => {
  const f = pointScan(fixture()), get = f.sdk.get, tracker = f.rows('sys_execution_tracker')[0];
  f.sdk.get = async (table, id) => (table === 'sys_execution_tracker' ? { ...tracker, sys_id: SUITE } : get(table, id));
  await assert.rejects(scanStatus(f.sdk, ID), /identity does not match/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('a result filed under a different sys_id is unusable and never verified', async () => {
  const f = pointScan(fixture()), get = f.sdk.get, result = f.rows('scan_result')[0];
  f.sdk.get = async (table, id) => (table === 'scan_result' ? { ...result, sys_id: SUITE } : get(table, id));
  const data = await scanResults(f.sdk, ID);
  assert.equal(data.result_verified, false);
  assert.equal(data.findings_count, null);
  assert.equal(data.scan_number, undefined);
  assert.ok(data.unavailable.includes('scan_result.identity'));
  assert.equal(data.incomplete, true);
  assert.equal(data.findings_state, 'unknown');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('any reported/retrieved finding disagreement is a mismatch, not a verified total', async () => {
  const f = pointScan(fixture(), { result: { finding_count: '3' } });
  f.rows('scan_finding').push({ sys_id: '3', result: RESULT, check: CHECK, count: '1' });
  let data = await scanResults(f.sdk, ID);
  assert.equal(data.findings_count, 3);
  assert.equal(data.findings_retrieved, 1);
  assert.equal(data.findings_state, 'mismatch');
  assert.equal(data.incomplete, true);
  pointScan(f, { result: { finding_count: '0' } });
  f.rows('scan_finding').push({ sys_id: '4', result: RESULT, check: CHECK, count: '1' });
  data = await scanResults(f.sdk, ID);
  assert.equal(data.findings_count, 0);
  assert.equal(data.findings_retrieved, 1);
  assert.equal(data.findings_state, 'mismatch');
  assert.equal(data.incomplete, true);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('truncated findings cannot be reconciled and stay incomplete', async () => {
  const f = pointScan(fixture(), { result: { finding_count: '2' } });
  f.rows('scan_finding').push({ sys_id: '5', result: RESULT, check: CHECK, count: '1' },
    { sys_id: '6', result: RESULT, check: CHECK, count: '1' });
  const data = await scanResults(f.sdk, ID, 1);
  assert.equal(data.truncated.findings, true);
  assert.equal(data.findings_state, 'truncated');
  assert.equal(data.incomplete, true);
});

test('initializing, queued and dispatched phases stay structurally distinct', async () => {
  const f = pointScan(fixture()), tracker = f.rows('sys_execution_tracker')[0], saved = tracker.result;
  Object.assign(tracker, { type: '', state: '', result: '' });
  assert.equal((await scanStatus(f.sdk, ID, { allowInitializing: true })).phase, 'initializing');
  tracker.type = 'sys.instance_scan.queue';
  assert.equal((await scanStatus(f.sdk, ID)).phase, 'queued');
  Object.assign(tracker, { type: 'point_scan', result: saved });
  assert.equal((await scanStatus(f.sdk, ID)).phase, 'dispatched');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
});

test('post-dispatch authorization failures keep the id and profile in hint and recovery', async () => {
  const f = fixture(), get = f.sdk.get;
  f.sdk.get = async (table, id) => {
    if (table === 'sys_execution_tracker') throw Object.assign(new Error('forbidden'), { status: 403 });
    return get(table, id);
  };
  let error;
  await assert.rejects(f.run(['run', '--full', '--wait', '--force', '--profile', 'pdi']), caught => { error = caught; return true; });
  assert.equal(error.code, 'forbidden');
  assert.match(error.hint, new RegExp(ID));
  assert.match(error.hint, /do not resubmit automatically/);
  assert.equal(error.recovery.execution_id, ID);
  assert.equal(error.recovery.status_command, `jsn scan status ${ID} --profile pdi`);
  assert.equal(error.recovery.results_command, `jsn scan results ${ID} --profile pdi`);
  const chunks = [];
  new OutputWriter({ format: FormatJSON, writer: { write: text => chunks.push(text) } }).err(error);
  const envelope = JSON.parse(chunks.join(''));
  assert.equal(envelope.ok, false);
  assert.match(envelope.hint, new RegExp(ID));
  assert.equal(envelope.recovery.execution_id, ID);
  assert.equal(envelope.recovery.status_command, `jsn scan status ${ID} --profile pdi`);
  assert.equal(envelope.recovery.resubmit, 'forbidden');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.writes, []);
});

test('post-dispatch transport failures retain the id, recovery and no-resubmit warning', async () => {
  const f = fixture(), get = f.sdk.get;
  f.sdk.get = async (table, id) => {
    if (table === 'sys_execution_tracker') throw Object.assign(new Error('socket hang up'), { code: 'network_error' });
    return get(table, id);
  };
  let error;
  await assert.rejects(f.run(['run', '--full', '--wait', '--force', '--instance', 'dev.example.invalid']), caught => { error = caught; return true; });
  assert.match(error.message, new RegExp(ID));
  assert.match(error.message, /do not resubmit automatically/);
  assert.equal(error.recovery.phase, 'progress');
  assert.equal(error.recovery.status_command, `jsn scan status ${ID} --instance dev.example.invalid`);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.writes, []);
});

test('missing or denied tracker identities are refused before reads can authorize mutation', async () => {
  for (const sys_id of [undefined, null, '', {}, { display_value: ID }]) {
    const f = pointScan(fixture()), get = f.sdk.get, tracker = f.rows('sys_execution_tracker')[0];
    f.sdk.get = async (table, id) => table === 'sys_execution_tracker' ? { ...tracker, sys_id } : get(table, id);
    await assert.rejects(scanStatus(f.sdk, ID, { allowInitializing: true }), /identity does not match/);
    await assert.rejects(scanResults(f.sdk, ID), /identity does not match/);
    await assert.rejects(cancelScan(f.sdk, ID), /identity does not match/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.requests, []);
  }
});

test('missing or denied result identities cannot verify clean point scans', async () => {
  for (const sys_id of [undefined, null, '', {}, { display_value: RESULT }]) {
    const f = pointScan(fixture(), { result: { finding_count: '0' } }), get = f.sdk.get, result = f.rows('scan_result')[0];
    f.sdk.get = async (table, id) => table === 'scan_result' ? { ...result, sys_id } : get(table, id);
    const data = await scanResults(f.sdk, ID);
    assert.equal(data.result_verified, false);
    assert.equal(data.findings_count, null);
    assert.equal(data.findings_state, 'unknown');
    assert.equal(data.incomplete, true);
    assert.ok(data.unavailable.includes('scan_result.identity'));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.requests, []);
  }
});

test('malformed findings and check lists remain unavailable, never verified empty', async () => {
  for (const payload of ['', {}, null, [null], ['not a row'], [[]]]) {
    const f = pointScan(fixture(), { result: { finding_count: '0' } });
    f.sdk.listStrict = async () => payload;
    const data = await scanResults(f.sdk, ID);
    assert.equal(data.incomplete, true);
    assert.equal(data.findings_state, 'unknown');
    assert.equal(data.checks_state, 'unknown');
    assert.equal(data.findings_retrieved, null);
    assert.equal(data.checks_executed, null);
    assert.ok(data.unavailable.includes('scan_finding'));
    assert.ok(data.unavailable.includes('scan_check_execution'));
  }
});

test('denied or malformed mandatory result counts cannot claim verified zero', async () => {
  for (const finding_count of [undefined, null, '', {}, { display_value: '0' }, 'NaN', '-1']) {
    const f = pointScan(fixture(), { result: { finding_count } });
    const data = await scanResults(f.sdk, ID);
    assert.equal(data.findings_count, null);
    assert.equal(data.findings_state, 'unknown');
    assert.equal(data.incomplete, true);
    assert.ok(data.unavailable.includes('scan_result.finding_count'));
  }
});

test('human recovery pins the same shell-quoted connection as structured commands', async () => {
  for (const selector of [['--profile', 'approved profile'], ['--instance', 'https://fixture.invalid/path with spaces']]) {
    const f = fixture();
    f.sdk.get = async () => { throw new Error('provider-secret-must-not-appear'); };
    let error;
    await assert.rejects(f.run(['run', '--full', '--wait', '--force', ...selector]), caught => { error = caught; return true; });
    assert.ok(error.hint.includes(error.recovery.status_command));
    assert.ok(error.recovery.status_command.endsWith(`${selector[0]} '${selector[1]}'`));
    assert.ok(!`${error.message} ${error.hint}`.includes('provider-secret-must-not-appear'));
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.writes, []);
  }
});

test('public CLI JSON and human 401/403 failures preserve pinned recovery without provider secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-scan-recovery-'));
  const selected = 'approved profile', seen = [];
  let deniedStatus = 403;
  const secret = 'synthetic-provider-secret-never-render';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    seen.push({ method: request.method, path: url.pathname, action: url.searchParams.get('sysparm_name') });
    if (url.pathname === '/xmlhttp.do') {
      response.writeHead(200, { 'Content-Type': 'text/xml' });
      response.end(`<xml answer="{&quot;status&quot;:0,&quot;progressId&quot;:&quot;${ID}&quot;}"/>`);
    } else if (url.pathname === `/api/now/table/sys_execution_tracker/${ID}`) {
      response.writeHead(deniedStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: secret, detail: secret } }));
    } else {
      const body = contextResponse(url);
      response.writeHead(200, { 'Content-Type': body ? 'application/json' : 'text/html' });
      response.end(body ? JSON.stringify(body) : '<html>Fixture</html>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const configDir = path.join(home, 'config');
    fs.mkdirSync(path.join(configDir, 'servicenow'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'servicenow', 'config.json'), JSON.stringify({ default_profile: selected,
      profiles: { [selected]: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: false } } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_|XDG_)/i.test(key)));
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: configDir,
      JSN_DATA_HOME: path.join(home, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
      JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', TMPDIR: process.env.TMPDIR || os.tmpdir(),
      SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' });
    for (deniedStatus of [401, 403]) for (const format of ['json', 'styled']) {
      const before = seen.length;
      let failure;
      try {
        await execFileAsync(process.execPath, [...credentialFixtureArgs, cliJsn, 'scan', 'run', '--full', '--wait', '--force',
          '--profile', selected, '--format', format, ...contextArgs], { env, timeout: 20000 });
      } catch (error) { failure = error; }
      assert.ok(failure, `expected HTTP ${deniedStatus} ${format} failure`);
      assert.equal(failure.code, 1, failure.stdout || failure.stderr);
      const text = `${failure.stdout}${failure.stderr}`;
      assert.ok(!text.includes(secret));
      assert.match(text, new RegExp(ID));
      assert.match(text, /do not resubmit automatically/i);
      const command = `jsn scan status ${ID} --profile 'approved profile'`;
      if (format === 'json') {
        const envelope = JSON.parse(failure.stdout);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.code, deniedStatus === 401 ? 'auth_error' : 'forbidden');
        assert.equal(envelope.recovery.execution_id, ID);
        assert.equal(envelope.recovery.status_command, command);
        assert.equal(envelope.recovery.results_command, `jsn scan results ${ID} --profile 'approved profile'`);
        assert.equal(envelope.recovery.resubmit, 'forbidden');
        assert.ok(envelope.hint.includes(command));
      } else assert.ok(failure.stderr.includes(command), failure.stderr);
      const requests = seen.slice(before);
      assert.equal(requests.filter(r => r.action === 'executeFullScan').length, 1);
      assert.ok(!requests.some(r => /cancel/i.test(r.action || '')));
      assert.ok(!requests.some(r => /^(POST|PUT|PATCH|DELETE)$/.test(r.method) && r.path.includes('/api/now/table/')));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
