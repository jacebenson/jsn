import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yargs from '../src/cli-adapter.js';
import { scanCmd } from '../src/commands/scan.js';
import { CHECK_TABLES, prepareScan, startScan, scanResults, scanStatus, cancelScan } from '../src/scan.js';

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
