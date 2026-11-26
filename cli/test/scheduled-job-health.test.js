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
import { readSchedulerHealth, explainScheduledJob, formatSchedulerHealth, formatScheduledJobWhy } from '../src/scheduled-job-health.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = character => character.repeat(32);
const NOW = Date.parse('2026-11-26T10:00:00Z');
const NODE = 'app1.example.com:dev001';
const JOB = id('a');
const USER = id('b');
const TRIGGER_FIELDS = 'sys_id,name,state,next_action,system_id,claimed_by,trigger_type,document,document_key,job_classification,last_error,error_count,run_count,parent';
const JOB_FIELDS = 'sys_id,name,active,run_as,run_type,run_start,conditional,sys_class_name';
const both = (value, display_value = value) => ({ value, display_value });
const STATES = { 0: 'Ready', 1: 'Running', 2: 'Queued', '-1': 'Error', '-2': 'Permanent Error', '-1776': 'Paused' };
const TYPES = { 0: 'Run Once', 1: 'Repeat', 2: 'Disabled', 9: 'Run at System Startup', 11: 'Daily' };
const trigger = (sys_id, name, over = {}) => ({
  sys_id: both(sys_id), name: both(name), state: both(over.state ?? '0', STATES[over.state ?? '0']), next_action: both(over.next_action ?? '2026-11-27 00:00:00', 'shown in user zone'),
  system_id: both(over.system_id ?? ''), claimed_by: both(''), trigger_type: both(over.trigger_type ?? '11', TYPES[over.trigger_type ?? '11']),
  document: both(over.document ?? 'sysauto_script'), document_key: both(over.document_key ?? JOB), job_classification: both(over.job_classification ?? `Recurring.${name}`),
  last_error: both(over.last_error ?? ''), error_count: both(over.error_count ?? '0'), run_count: both('3'), parent: both(over.parent ?? ''),
});
const job = (over = {}) => ({ sys_id: both(JOB), name: both('Nightly sync'), active: both(over.active ?? 'true'), run_as: both(over.run_as ?? USER, 'sync.user'),
  run_type: both(over.run_type ?? 'daily'), run_start: both('2026-01-01 00:00:00'), conditional: both(over.conditional ?? 'false'), sys_class_name: both('sysauto_script') });
const node = (system_id, status = 'online') => ({ system_id: both(system_id), status: both(status) });

function fixtureSdk(tables) {
  const calls = [];
  return { calls, async listStrict(table, params) {
    calls.push({ table, params: Object.fromEntries(params) });
    const value = tables[table];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value ?? [];
  } };
}

function healthWorld(over = {}) {
  return {
    sys_cluster_state: [node(NODE), node('old.example.com:dev002', 'offline')],
    sys_trigger: params => {
      const query = params.get('sysparm_query');
      if (query.startsWith('stateIN0,2')) return [trigger(id('1'), 'Late job', { next_action: '2026-11-26 07:30:00' })];
      if (query.startsWith('stateIN-1,-2')) return [trigger(id('2'), 'PA Forecast', { error_count: '43', last_error: 'java.lang.NoSuchFieldError' })];
      if (query.startsWith('system_idISNOTEMPTY')) return [trigger(id('3'), 'Pinned job', { system_id: 'gone.example.com:dev009' }), trigger(id('4'), 'Offline job', { system_id: 'old.example.com:dev002' })];
      return [];
    },
    sysauto_script: [job({ run_as: USER })],
    syslog_transaction: [{ sys_id: both(id('5')), sys_created_on: both('2026-11-25 01:00:00'), url: both('JOB: Big import'), response_time: both('4000000', '4,000,000'), system_id: both(NODE) }],
    ...over,
  };
}

test('health reads the nodes and five bounded queries, and flags each class of trouble', async () => {
  const sdk = fixtureSdk(healthWorld());
  const data = await readSchedulerHealth(sdk, { limit: 10, now: NOW });
  assert.deepEqual(sdk.calls.map(call => call.table), ['sys_cluster_state', 'sys_trigger', 'sys_trigger', 'sys_trigger', 'sysauto_script', 'syslog_transaction']);
  const [nodes, overdue, erroring, dead, runAs, long] = sdk.calls.map(call => call.params);
  assert.deepEqual(nodes, { sysparm_query: 'ORDERBYsystem_id', sysparm_fields: 'system_id,status', sysparm_limit: '201', sysparm_display_value: 'all' });
  assert.deepEqual(overdue, { sysparm_query: 'stateIN0,2^next_action<javascript:gs.minutesAgoStart(60)^trigger_typeNOT IN2,9^system_idNOT INALL NODES,ACTIVE NODES,PRIMARY NODES^NQstateIN0,2^next_action<javascript:gs.minutesAgoStart(60)^trigger_typeNOT IN2,9^system_idISEMPTY^ORDERBYnext_action', sysparm_fields: TRIGGER_FIELDS, sysparm_limit: '11', sysparm_display_value: 'all' });
  // Each branch has to repeat the filters: a bare ^OR would start a new branch and
  // every trigger with no system_id would come back as overdue.
  const overdueBranches = overdue.sysparm_query.split('^NQ');
  assert.equal(overdueBranches.length, 2);
  assert.match(overdueBranches[0], /^stateIN0,2\^next_action</);
  assert.match(overdueBranches[1], /^stateIN0,2\^next_action</);
  assert.equal(erroring.sysparm_query, 'stateIN-1,-2^ORerror_count>0^ORDERBYDESCsys_updated_on');
  assert.equal(dead.sysparm_query, `system_idISNOTEMPTY^system_idNOT INALL NODES,ACTIVE NODES,PRIMARY NODES,${NODE}^parentISEMPTY^trigger_type!=9^ORDERBYsystem_id`);
  assert.deepEqual(runAs, { sysparm_query: 'active=true^run_as.active=false^ORDERBYname', sysparm_fields: JOB_FIELDS, sysparm_limit: '11', sysparm_display_value: 'all' });
  assert.deepEqual(long, { sysparm_query: 'type=scheduler^response_time>3600000^sys_created_on>=javascript:gs.daysAgoStart(7)^ORDERBYDESCsys_created_on', sysparm_fields: 'sys_id,sys_created_on,url,response_time,system_id', sysparm_limit: '11', sysparm_display_value: 'all' });

  assert.deepEqual(data.nodes, [{ system_id: NODE, status: 'online' }, { system_id: 'old.example.com:dev002', status: 'offline' }]);
  assert.equal(data.overdue.items[0].name, 'Late job');
  assert.equal(data.overdue.items[0].late_minutes, 150);
  assert.equal(data.erroring.items[0].error_count, 43);
  assert.deepEqual(data.dead_node.items.map(item => [item.name, item.node_status]), [['Pinned job', 'missing'], ['Offline job', 'offline']]);
  assert.deepEqual(data.inactive_run_as.items, [{ sys_id: JOB, name: 'Nightly sync', run_as: USER, run_as_name: 'sync.user', run_type: 'daily' }]);
  assert.deepEqual(data.long_running.items, [{ sys_id: id('5'), logged: '2026-11-25 01:00:00', job: 'Big import', response_time_ms: 4000000, system_id: NODE }]);
  assert.equal(data.flagged, 6);
  const text = formatSchedulerHealth(data);
  assert.match(text, /1 of 2 node\(s\) online/);
  assert.match(text, /Pinned to a dead node \(2\)[\s\S]*Pinned job +gone\.example\.com:dev009 \(missing\)/);
  assert.match(text, /Running as an inactive user \(1\)[\s\S]*Nightly sync +sync\.user/);
});

test('health drops a dead-node row the server returned for a node group or a live node', async () => {
  const sdk = fixtureSdk(healthWorld({ sys_trigger: params => params.get('sysparm_query').startsWith('system_idISNOTEMPTY')
    ? [trigger(id('3'), 'Group', { system_id: 'ALL NODES' }), trigger(id('4'), 'Live', { system_id: NODE }), trigger(id('6'), 'Gone', { system_id: 'gone:1' })] : [] }));
  const data = await readSchedulerHealth(sdk, { now: NOW });
  assert.deepEqual(data.dead_node.items.map(item => item.name), ['Gone']);
});

test('health counts a trigger flagged in several lists once', async () => {
  const stuck = trigger(id('3'), 'Stuck job', { system_id: 'gone:1', next_action: '2026-11-26 07:00:00', error_count: '2' });
  const data = await readSchedulerHealth(fixtureSdk(healthWorld({ sys_trigger: () => [stuck], sysauto_script: [], syslog_transaction: [] })), { now: NOW });
  assert.deepEqual([data.overdue.items.length, data.erroring.items.length, data.dead_node.items.length], [1, 1, 1]);
  assert.equal(data.flagged, 1);
  assert.match(formatSchedulerHealth(data), /^1 flagged\./m);
});

test('why says more long runs exist when the lookahead row arrives', async () => {
  const runs = [3700000, 9000000, 3800000, 3900000, 4000000, 99000000].map((ms, i) => ({ sys_id: both(id(String(i))), sys_created_on: both(`2026-11-2${5 - Math.floor(i / 2)} 0${i}:00:00`), url: both('JOB: Nightly sync'), response_time: both(String(ms)), system_id: both(NODE) }));
  const data = await explainScheduledJob(fixtureSdk(whyWorld({ syslog_transaction: runs })), 'Nightly sync', { now: NOW });
  assert.equal(data.long_runs.length, 5);
  assert.equal(data.long_runs_truncated, true);
  assert.equal(data.findings.find(f => f.code === 'long_run').message, 'More than 5 runs in the last 7 days took over an hour; the longest of the newest 5 took 150 minutes.');
  assert.match(formatScheduledJobWhy(data), /Runs over an hour, last 7 days \(5, more not shown\)/);
});

test('why refuses to judge a job when sys_cluster_state reads empty, before reading the job', async () => {
  const sdk = fixtureSdk(whyWorld({ sys_cluster_state: [] }));
  await assert.rejects(explainScheduledJob(sdk, 'Nightly sync', { now: NOW }), /No node rows were readable in sys_cluster_state/);
  assert.deepEqual(sdk.calls.map(call => call.table), ['sys_cluster_state']);
});

test('health marks a category truncated when the lookahead row arrives', async () => {
  const many = Array.from({ length: 3 }, (_, i) => trigger(id(String(i)), `Late ${i}`, { next_action: '2026-11-26 07:00:00' }));
  const data = await readSchedulerHealth(fixtureSdk(healthWorld({ sys_trigger: params => params.get('sysparm_query').startsWith('stateIN0,2') ? many : [] })), { limit: 2, now: NOW });
  assert.equal(data.overdue.items.length, 2);
  assert.equal(data.overdue.truncated, true);
  assert.equal(data.erroring.truncated, false);
  assert.match(formatSchedulerHealth(data), /Overdue[^\n]*\(2, more not shown\)/);
});

test('health refuses to judge nodes when sys_cluster_state reads empty, before reading triggers', async () => {
  const sdk = fixtureSdk(healthWorld({ sys_cluster_state: [] }));
  await assert.rejects(readSchedulerHealth(sdk, { now: NOW }), /No node rows were readable in sys_cluster_state/);
  assert.deepEqual(sdk.calls.map(call => call.table), ['sys_cluster_state']);
});

test('health rejects a bad limit without a request', async () => {
  for (const limit of [0, 501, 1.5, Number.NaN, '5']) {
    const sdk = fixtureSdk(healthWorld());
    await assert.rejects(readSchedulerHealth(sdk, { limit }), /--limit must be an integer from 1 to 500/);
    assert.equal(sdk.calls.length, 0);
  }
});

test('health never reports denied or malformed reads as healthy', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readSchedulerHealth(fixtureSdk(healthWorld({ sys_trigger: denied })), { now: NOW }), /Forbidden/);
  await assert.rejects(readSchedulerHealth(fixtureSdk(healthWorld({ syslog_transaction: denied })), { now: NOW }), /Forbidden/);
  await assert.rejects(readSchedulerHealth(fixtureSdk(healthWorld({ sysauto_script: [null] })), { now: NOW }), error => error.code === 'malformed_response');
  await assert.rejects(readSchedulerHealth(fixtureSdk(healthWorld({ sys_cluster_state: 'oops' })), { now: NOW }), error => error.code === 'malformed_response');
});

function whyWorld(over = {}) {
  return {
    sysauto_script: [job({ conditional: 'true' })],
    sys_trigger: [trigger(id('1'), 'Nightly sync', { system_id: 'gone.example.com:dev009', next_action: '2026-11-26 07:00:00' })],
    sys_user: [{ sys_id: both(USER), user_name: both('sync.user'), active: both('false') }],
    sys_cluster_state: [node(NODE)],
    sys_db_object: [{ name: both('sys_scheduler_job_history') }],
    sys_scheduler_job_history: [{ job_classification: both('Recurring.Nightly sync'), time_range_start: both('2026-11-25 00:00:00'), time_range_end: both('2026-11-25 00:15:00'), count: both('1'), average: both('120'), max_duration: both('120'), avg_lateness: both('30'), max_lateness: both('30') }],
    syslog_transaction: [{ sys_id: both(id('5')), sys_created_on: both('2026-11-24 00:00:00'), url: both('JOB: Nightly sync'), response_time: both('3700000'), system_id: both(NODE) }],
    ...over,
  };
}

test('why joins the job, its trigger, run-as user, nodes, history and long runs by raw values', async () => {
  const sdk = fixtureSdk(whyWorld());
  const data = await explainScheduledJob(sdk, 'Nightly sync', { now: NOW });
  assert.deepEqual(sdk.calls.map(call => [call.table, call.params.sysparm_query, call.params.sysparm_limit]), [
    ['sys_cluster_state', 'ORDERBYsystem_id', '201'],
    ['sysauto_script', 'name=Nightly sync', '21'],
    ['sys_trigger', `document_key=${JOB}^ORDERBYparent`, '21'],
    ['sys_user', `sys_id=${USER}`, '1'],
    ['sys_db_object', 'name=sys_scheduler_job_history', '1'],
    ['sys_scheduler_job_history', 'job_classification=Recurring.Nightly sync^ORDERBYDESCtime_range_start', '8'],
    ['syslog_transaction', `type=scheduler^url=JOB: Nightly sync^response_time>3600000^sys_created_on>=javascript:gs.daysAgoStart(7)^ORDERBYDESCsys_created_on`, '6'],
  ]);
  assert.equal(data.job.sys_id, JOB);
  assert.deepEqual(data.run_as, { sys_id: USER, user_name: 'sync.user', active: false });
  assert.equal(data.history.available, true);
  assert.deepEqual(data.history.windows[0], { start: '2026-11-25 00:00:00', end: '2026-11-25 00:15:00', runs: 1, average_ms: 120, max_ms: 120, average_wait_ms: 30, max_wait_ms: 30 });
  assert.deepEqual(data.findings.map(finding => finding.code), ['overdue', 'dead_node', 'inactive_run_as', 'conditional', 'long_run']);
  assert.match(data.findings.find(f => f.code === 'dead_node').message, /gone\.example\.com:dev009, which is not in sys_cluster_state/);
  assert.match(data.findings.find(f => f.code === 'overdue').message, /180 minutes past/);
  assert.match(data.findings.find(f => f.code === 'long_run').message, /^1 run\(s\) in the last 7 days took over an hour; the longest took 62 minutes\.$/);
  const text = formatScheduledJobWhy(data);
  assert.match(text, /Scheduled job: Nightly sync/);
  assert.match(text, /Run as +sync\.user \(inactive\)/);
  assert.match(text, /- dead_node: /);
});

test('why explains an inactive job, an untriggered job, an on-demand job and a spent run-once job', async () => {
  const codes = async (over, extra = {}) => (await explainScheduledJob(fixtureSdk(whyWorld({ sysauto_script: [job(over)], sys_trigger: [], ...extra })), JOB, { now: NOW })).findings.map(f => f.code);
  assert.deepEqual(await codes({ active: 'false' }), ['job_inactive']);
  assert.deepEqual(await codes({}), ['no_trigger']);
  assert.deepEqual(await codes({ run_type: 'on_demand' }), ['on_demand']);
  assert.deepEqual(await codes({ run_type: 'once' }), ['ran_once']);
});

test('why reads trigger state: disabled, paused, error states and recorded errors', async () => {
  const codes = async over => (await explainScheduledJob(fixtureSdk(whyWorld({ sysauto_script: [job({ run_as: '' })], sys_trigger: [trigger(id('1'), 'Nightly sync', over)], syslog_transaction: [] })), JOB, { now: NOW })).findings.map(f => f.code);
  assert.deepEqual(await codes({ trigger_type: '2', next_action: '2020-01-01 00:00:00' }), ['trigger_disabled']);
  assert.deepEqual(await codes({ state: '-1776' }), ['paused']);
  assert.deepEqual(await codes({ state: '-2', last_error: 'boom' }), ['error_state']);
  assert.deepEqual(await codes({ error_count: '4', last_error: 'boom' }), ['errors_recorded']);
  assert.deepEqual(await codes({ system_id: 'ALL NODES', next_action: '2020-01-01 00:00:00' }), [], 'a node-group template row keeps a stale next action by design');
  assert.deepEqual(await codes({ trigger_type: '9', system_id: 'gone:1', next_action: '2020-01-01 00:00:00' }), [], 'startup triggers are never stuck');
  assert.deepEqual(await codes({ system_id: NODE }), []);
});

test('why falls back to a sys_trigger row by name when no job definition has it', async () => {
  const sdk = fixtureSdk(whyWorld({ sysauto_script: [], sys_trigger: [trigger(id('1'), 'events process 0', { document: '', document_key: '' })], sys_scheduler_job_history: [], syslog_transaction: [] }));
  const data = await explainScheduledJob(sdk, 'events process 0', { now: NOW });
  assert.deepEqual(sdk.calls.slice(1, 3).map(call => [call.table, call.params.sysparm_query]), [['sysauto_script', 'name=events process 0'], ['sys_trigger', 'name=events process 0^ORDERBYparent']]);
  assert.equal(data.job, null);
  assert.equal(data.triggers[0].name, 'events process 0');
  assert.ok(!sdk.calls.some(call => call.table === 'sys_user'));
});

test('why: an ambiguous name, an unknown name and a missing history table', async () => {
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sysauto_script: [job(), { ...job(), sys_id: both(id('c')) }] })), 'Nightly sync', { now: NOW }), /More than one scheduled job is named "Nightly sync": a{32}, c{32}\. Pass a sys_id/);
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sysauto_script: [], sys_trigger: [] })), 'Nope', { now: NOW }), error => error.code === 'not_found' || /No scheduled job or sys_trigger row/.test(error.message));
  const sdk = fixtureSdk(whyWorld({ sys_db_object: [] }));
  const data = await explainScheduledJob(sdk, 'Nightly sync', { now: NOW });
  assert.deepEqual(data.history, { available: false, classification: 'Recurring.Nightly sync', windows: [] });
  assert.ok(!sdk.calls.some(call => call.table === 'sys_scheduler_job_history'));
});

test('why rejects bad input without a request, and never trusts mismatched rows', async () => {
  for (const name of ['', '   ', 'a^ORname=b', 'a\nb', undefined, 'x'.repeat(201)]) {
    const sdk = fixtureSdk(whyWorld());
    await assert.rejects(explainScheduledJob(sdk, name, { now: NOW }), /Provide a scheduled job name or sys_id/, JSON.stringify(name));
    assert.equal(sdk.calls.length, 0);
  }
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sys_trigger: [trigger(id('1'), 'Other', { document_key: id('d') })] })), 'Nightly sync', { now: NOW }), /sys_trigger returned a row for another job/);
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sysauto_script: [{ ...job(), sys_id: both(id('e')) }] })), JOB, { now: NOW }), /different record identity/);
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sys_user: [{ sys_id: both(id('f')), user_name: both('x'), active: both('true') }] })), JOB, { now: NOW }), /different record identity/);
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sys_scheduler_job_history: [{ job_classification: both('Recurring.Other') }] })), JOB, { now: NOW }), /another job classification/);
  await assert.rejects(explainScheduledJob(fixtureSdk(whyWorld({ sys_trigger: Object.assign(new Error('Forbidden'), { status: 403 }) })), JOB, { now: NOW }), /Forbidden/);
});

test('real CLI: read-only profile, JSON, --get, styled output, strict validation, GET only', async () => {
  const calls = [];
  const tables = healthWorld();
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-scheduler-health-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'scheduledjobs', ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['health', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data._formatted, undefined);
    assert.equal(envelope.data.dead_node.items[0].name, 'Pinned job');
    assert.equal(JSON.parse((await run(['health', '--get', 'data.flagged'])).stdout), 6);
    const piped = JSON.parse((await run(['health'])).stdout);
    assert.equal(piped.data.flagged, 6);
    assert.ok(!('_formatted' in piped.data), 'piped auto output carries no view');
    const styled = (await run(['health', '--styled'])).stdout;
    assert.match(styled, /Scheduler health/);
    assert.match(styled, /Erroring \(1\)[\s\S]*PA Forecast/);
    const why = JSON.parse((await run(['why', 'Nightly sync', '--json'])).stdout);
    assert.equal(why.data.job.name, 'Nightly sync');
    const tableCalls = () => calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    const before = tableCalls().length;
    for (const args of [['health', '--typo'], ['health', '--limit', '0'], ['why'], ['why', 'a^b'], ['why', 'a', 'b']]) {
      await assert.rejects(run(args), undefined, JSON.stringify(args));
    }
    assert.equal(tableCalls().length, before, 'rejected input reads nothing');
    assert.match((await run(['health', '--help'])).stdout, /never runs, recovers or changes a job/);
    assert.match((await run(['why', '--help'])).stdout, /never runs, recovers or changes a job/);
    assert.ok(tableCalls().length && tableCalls().every(call => call.method === 'GET'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
