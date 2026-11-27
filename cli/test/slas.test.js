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
import { listSlas, showSla, taskSlas, formatSlas, SLA_FIELDS } from '../src/slas.js';
import { isMutationCommand } from '../src/mutations.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';
import '../src/command-families.js';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const INC = id(1), CASE = id(2), P1 = id(10), P2 = id(11), OLD = id(12);
const sla = (n, name, extra = {}) => ({ sys_id: field(id(n)), name: field(name), collection: field('incident'), type: field('SLA'), target: field('resolution', 'Resolution'),
  duration_type: field(''), duration: field('1970-01-01 08:00:00', '8 Hours'), schedule_source: field('sla_definition', 'SLA definition'), schedule: field(id(40), '8-5 weekdays'),
  schedule_source_field: field(''), active: field('true'), sys_scope: field('global', 'Global'), relative_duration_works_on: field('Task record'),
  timezone_source: field('task.caller_id.time_zone', 'The caller\'s time zone'), timezone: field(''), retroactive: field('true'), set_start_to: field('sys_created_on'), retroactive_pause: field('true'),
  start_condition: field('active=true^priority=2^EQ', 'Active = true .and. Priority = 2 - High'), pause_condition: field('state=3^EQ', 'State = On Hold'), when_to_resume: field('no_match'), resume_condition: field(''),
  stop_condition: field('state=7^EQ', 'State = Closed'), reset_condition: field(''), reset_action: field('cancel'), cancel_condition: field(''), when_to_cancel: field('no_match'),
  condition_class: field(''), flow: field(id(50), 'SLA notification and escalation flow'), workflow: field(''), ...extra });
const taskSla = (n, def, name, extra = {}) => ({ sys_id: field(id(n)), task: field(INC, 'Wrong label, not a join key'), sla: field(def, name), stage: field('in_progress', 'In progress'), has_breached: field('false'), active: field('true'),
  start_time: field('2026-11-24 23:14:50', '2026-11-25 10:14:50'), end_time: field(''), planned_end_time: field('2026-12-02 11:00:00', '2026-12-02 22:00:00'),
  business_duration: field('1970-01-01 18:00:00', '18 Hours'), business_percentage: field('37.5'), business_time_left: field('1970-01-02 06:00:00', '1 Day 6 Hours'), ...extra });
const tables = {
  contract_sla: [sla(10, 'Priority 1 resolution (1 hour)'), sla(11, 'Priority 2 resolution (8 hour)', { duration_type: field(id(60), 'End of next business day'), duration: field('') }),
    sla(12, 'Old case SLA', { collection: field('sn_customerservice_case'), active: field('false'), schedule_source: field('no_schedule', 'No schedule'), schedule: field('') })],
  task: [{ sys_id: field(INC), number: field('INC0010001'), sys_class_name: field('incident', 'Incident') }, { sys_id: field(CASE), number: field('CS0001001'), sys_class_name: field('sn_customerservice_case', 'Case') }],
  task_sla: [taskSla(20, P1, 'Priority 1 resolution (1 hour)', { has_breached: field('true'), business_percentage: field('4886.12'), business_time_left: field('1970-01-01 00:00:00', '0 Seconds') }),
    taskSla(21, P2, 'Priority 2 resolution (8 hour)', { stage: field('completed', 'Completed'), active: field('false'), end_time: field('2026-11-25 01:00:00') }),
    taskSla(22, OLD, 'Old engine', { stage: field('breached', 'Breached') })],
};
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    const terms = params.get('sysparm_query').split('^').filter(term => !term.startsWith('ORDERBY'));
    for (const term of terms) {
      const [name, value] = term.split('=');
      rows = rows.filter(row => name === 'number' ? row.number.value.toLowerCase() === value.toLowerCase() : name === 'collection' || name === 'active' || name === 'sys_id' || name === 'name' ? row[name].value === value : true);
    }
    const fields = params.get('sysparm_fields')?.split(',');
    if (fields) rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))));
    const offset = Number(params.get('sysparm_offset') || 0);
    return rows.slice(offset, offset + Number(params.get('sysparm_limit')));
  } };
}
const query = call => call.params.get('sysparm_query');

test('list reads definitions with an explicit field list, filters by table and active, and pages with lookahead', async () => {
  const sdk = fixtureSdk();
  const data = await listSlas(sdk, { table: 'incident', active: true, limit: 1 });
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].table, 'contract_sla');
  assert.equal(query(sdk.calls[0]), 'collection=incident^active=true^ORDERBYname^ORDERBYsys_id');
  assert.equal(sdk.calls[0].params.get('sysparm_fields'), SLA_FIELDS.list);
  assert.equal(sdk.calls[0].params.get('sysparm_display_value'), 'all');
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '2');
  assert.deepEqual(data.pagination, { limit: 1, offset: 0, has_more: true, next_offset: 1 });
  assert.deepEqual(data.records, [{ sys_id: P1, name: 'Priority 1 resolution (1 hour)', table: 'incident', type: 'SLA', target: 'resolution', duration: '8 Hours', relative_duration: null,
    schedule_source: 'sla_definition', schedule: { sys_id: id(40), name: '8-5 weekdays' }, schedule_source_field: null, active: true, scope: { sys_id: 'global', name: 'Global' } }]);
  const all = await listSlas(fixtureSdk(), { active: false });
  assert.deepEqual(all.records.map(row => [row.name, row.table, row.active]), [['Old case SLA', 'sn_customerservice_case', false]]);
  const relative = (await listSlas(fixtureSdk(), {})).records[1];
  assert.deepEqual([relative.duration, relative.relative_duration], [null, { sys_id: id(60), name: 'End of next business day' }]);
  const human = formatSlas(await listSlas(fixtureSdk(), {}), 'list');
  assert.match(human, /Priority 2 resolution \(8 hour\) \[0+b\]: incident, SLA \(resolution\), relative duration End of next business day on schedule 8-5 weekdays; scope Global/);
  assert.match(human, /Old case SLA \[0+c\] \(inactive\): sn_customerservice_case, SLA \(resolution\), 8 Hours on no schedule \(24x7\)/);
  assert.match(human, /Page: 3 definition\(s\), offset 0; no further readable rows\./);
  assert.equal('visibility' in data, false);
  const none = await listSlas(fixtureSdk({ contract_sla: [] }), { table: 'incident' });
  assert.match(none.visibility, /ACLs can hide rows, so an empty page does not prove there are none/, 'an empty page says why in the data, for JSON readers');
});

test('show gives one definition with its conditions, schedule, time zone source, retroactive start and flow', async () => {
  const sdk = fixtureSdk();
  const data = await showSla(sdk, 'Priority 1 resolution (1 hour)');
  assert.equal(query(sdk.calls[0]), 'name=Priority 1 resolution (1 hour)^ORDERBYsys_id');
  assert.equal(sdk.calls[0].params.get('sysparm_fields'), SLA_FIELDS.show);
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '2');
  assert.deepEqual(data.conditions, { start: { query: 'active=true^priority=2^EQ', text: 'Active = true .and. Priority = 2 - High' }, pause: { query: 'state=3^EQ', text: 'State = On Hold' },
    resume: null, stop: { query: 'state=7^EQ', text: 'State = Closed' }, reset: null, cancel: null });
  assert.deepEqual([data.timezone_source, data.retroactive_start, data.condition_class, data.flow, data.workflow],
    ['task.caller_id.time_zone', { set_start_to: 'sys_created_on', retroactive_pause: true }, null, { sys_id: id(50), name: 'SLA notification and escalation flow' }, null]);
  const human = formatSlas(data, 'show');
  for (const line of ['  Start: Active = true .and. Priority = 2 - High (active=true^priority=2^EQ)', '  Cancels when the start condition stops matching', '  Pause: State = On Hold (state=3^EQ)',
    '  Resumes when the pause condition stops matching', '  Stop: State = Closed (state=7^EQ)', '  Reset: (none)', '  Retroactive start: yes, from sys_created_on, with retroactive pause time',
    '  Condition class: default (com.snc.sla.default_conditionclass)', `  Flow: SLA notification and escalation flow [${id(50)}]`]) assert.ok(human.split('\n').includes(line), line);

  const custom = await showSla(fixtureSdk({ contract_sla: [sla(10, 'X', { when_to_cancel: field('on_condition'), cancel_condition: field('state=8^EQ', 'State = Canceled'), reset_condition: field('assigned_toVALCHANGES^EQ', 'Assigned to changes'), reset_action: field('complete'), condition_class: field(id(70), 'Simple') })] }), id(10));
  const lines = formatSlas(custom, 'show').split('\n');
  assert.ok(lines.includes('  Cancel: State = Canceled (state=8^EQ)'));
  assert.ok(lines.includes('  Reset: Assigned to changes (assigned_toVALCHANGES^EQ); completes the running task SLA and attaches a new one'));
  assert.ok(lines.includes(`  Condition class: Simple [${id(70)}]`));
});

test('task resolves the record through task by number or sys_id and reads its task SLAs by the raw sys_id', async () => {
  const sdk = fixtureSdk();
  const data = await taskSlas(sdk, 'inc0010001');
  assert.deepEqual(sdk.calls.map(call => [call.table, query(call), call.params.get('sysparm_fields'), call.params.get('sysparm_limit')]), [
    ['task', 'number=inc0010001^ORDERBYsys_id', SLA_FIELDS.task, '2'],
    ['task_sla', `task=${INC}^ORDERBYstart_time^ORDERBYsys_id`, SLA_FIELDS.task_sla, '101']]);
  assert.deepEqual(data.task, { sys_id: INC, number: 'INC0010001', table: 'incident' });
  assert.deepEqual(data.records[0], { sys_id: id(20), definition: { sys_id: P1, name: 'Priority 1 resolution (1 hour)' }, stage: 'in_progress', has_breached: true, active: true,
    start_time: '2026-11-24 23:14:50', end_time: null, planned_end_time: '2026-12-02 11:00:00', business_elapsed: '18 Hours', business_percentage: 4886.12, business_time_left: '0 Seconds' });
  assert.equal(data.records[2].has_breached, true, 'the 2010 engine\'s breached stage counts as breached');
  assert.deepEqual([data.count, data.breached, data.breach_unknown, data.more, 'visibility' in data], [3, 2, 0, false, false]);
  const human = formatSlas(data, 'task');
  assert.match(human, /^Task SLAs on INC0010001 \(incident\) \[0+1\] \(read-only; times in UTC\)/);
  assert.match(human, /Priority 1 resolution \(1 hour\) \[0+a\]: in progress, breached\n {4}started 2026-11-24 23:14:50, breach 2026-12-02 11:00:00; business elapsed 18 Hours \(4886\.12%\), 0 Seconds left/);
  assert.match(human, /Old engine \[[0-9a-f]{32}\]: breached\n/, 'the breached stage is not said twice');
  assert.match(human, /Priority 2 resolution \(8 hour\) \[0+b\]: completed, not breached, inactive\n {4}started [^\n]*, stopped 2026-11-25 01:00:00;/);
  const bySysId = fixtureSdk({ task_sla: [] });
  const empty = await taskSlas(bySysId, CASE);
  assert.equal(query(bySysId.calls[0]), `sys_id=${CASE}^ORDERBYsys_id`);
  assert.equal(query(bySysId.calls[1]), `task=${CASE}^ORDERBYstart_time^ORDERBYsys_id`);
  assert.deepEqual([empty.task.table, empty.count], ['sn_customerservice_case', 0]);
  assert.match(empty.visibility, /ACLs can hide rows, so an empty list does not prove there are none/, 'an empty result says why in the data, for JSON readers');
  assert.match(formatSlas(empty, 'task'), /No readable task SLAs\. ACLs can hide rows, so an empty list does not prove there are none\./);
  const many = await taskSlas(fixtureSdk({ task_sla: Array.from({ length: 101 }, (_, n) => taskSla(100 + n, P1, 'P1')) }), 'INC0010001');
  assert.deepEqual([many.count, many.more], [100, true]);
  assert.match(formatSlas(many, 'task'), /More than 100 task SLAs; only the first 100 by start time are shown\./);
  const { has_breached: _hidden, ...denied } = taskSla(23, P1, 'P1');
  const unknown = await taskSlas(fixtureSdk({ task_sla: [denied] }), 'INC0010001');
  assert.deepEqual([unknown.records[0].has_breached, unknown.breached, unknown.breach_unknown], [null, 0, 1], 'an unreadable breach flag is unknown, never false');
  assert.match(formatSlas(unknown, 'task'), /P1 \[0+a\]: in progress, breach unknown\n/);
});

test('invalid input is refused before any request', async () => {
  const sdk = fixtureSdk();
  for (const options of [{ table: 'inc^ident' }, { table: 'Incident' }, { table: '' }, { active: 'yes' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }]) {
    await assert.rejects(listSlas(sdk, options), { code: 'usage_error' }, JSON.stringify(options));
  }
  for (const bad of ['', '  ', 'P1^ORactive=true', 'P1\nx', undefined]) {
    await assert.rejects(showSla(sdk, bad), { code: 'usage_error' }, JSON.stringify(bad));
    await assert.rejects(taskSlas(sdk, bad), { code: 'usage_error' }, JSON.stringify(bad));
  }
  assert.equal(sdk.calls.length, 0);
});

test('missing, ambiguous, denied, malformed and mismatched answers are never reported as SLAs', async () => {
  await assert.rejects(showSla(fixtureSdk(), 'No such SLA'), { code: 'not_found' });
  await assert.rejects(showSla(fixtureSdk({ contract_sla: [sla(10, 'Twin'), sla(11, 'Twin')] }), 'Twin'), /More than one SLA definition is named Twin/);
  await assert.rejects(showSla({ listStrict: async () => [sla(11, 'Other')] }, id(10)), { code: 'malformed_response' });
  await assert.rejects(taskSlas(fixtureSdk(), 'INC9999999'), { code: 'not_found' });
  await assert.rejects(taskSlas(fixtureSdk({ task: [tables.task[0], { ...tables.task[1], number: field('INC0010001') }] }), 'INC0010001'), /More than one task is numbered INC0010001/);
  for (const asked of ['INC0010001', INC]) await assert.rejects(taskSlas({ listStrict: async () => [tables.task[1]] }, asked), /task returned a different record/);
  await assert.rejects(taskSlas(fixtureSdk({ task_sla: [taskSla(20, P1, 'P1', { task: field(CASE) })] }), 'INC0010001'), /belongs to another task/);
  const denied = Object.assign(new Error('Forbidden'), { code: 'forbidden', status: 403 });
  for (const call of [sdk => listSlas(sdk), sdk => showSla(sdk, 'P1'), sdk => taskSlas(sdk, 'INC0010001')]) {
    await assert.rejects(call({ listStrict: async () => { throw denied; } }), denied);
    for (const rows of [null, {}, [null], [[]], [{ name: field('no sys_id') }], [{ sys_id: field('not-a-sys-id') }]]) {
      await assert.rejects(call({ listStrict: async () => rows }), { code: 'malformed_response' }, JSON.stringify(rows));
    }
  }
  const empty = await listSlas(fixtureSdk({ contract_sla: [] }));
  assert.match(formatSlas(empty, 'list'), /does not prove there are none/);
  for (const verb of ['list', 'show', 'task']) assert.equal(isMutationCommand({ _: ['slas', verb] }), false, verb);
});

test('real CLI runs on a read-only profile with JSON, --get, human output and strict validation', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    Promise.resolve(fixtureSdk().listStrict(url.pathname.split('/').pop(), url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-slas-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const listed = JSON.parse((await run(['slas', 'list', '--table', 'incident', '--active', '--json'])).stdout);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.data.records.map(row => row.name), ['Priority 1 resolution (1 hour)', 'Priority 2 resolution (8 hour)']);
    assert.equal(JSON.parse((await run(['slas', 'show', id(10), '--get', 'data.conditions.start.query'])).stdout), 'active=true^priority=2^EQ');
    const task = JSON.parse((await run(['slas', 'task', 'INC0010001', '--json'])).stdout);
    assert.deepEqual([task.data.count, task.data.breached], [3, 2]);
    assert.match((await run(['slas', 'task', 'INC0010001', '--format', 'markdown'])).stdout, /^INC0010001: 3 task SLA\(s\), 2 breached\n\n\| sys_id \| definition \| stage \| has_breached \|/);
    const csv = (await run(['slas', 'task', 'INC0010001', '--format', 'csv'])).stdout.split('\n');
    assert.match(csv[0], /^sys_id,definition,stage,has_breached,active,/, 'CSV tabulates the task SLA rows');
    assert.equal(csv.filter(Boolean).length, 4);
    const human = await run(['slas', 'task', 'INC0010001', '--format', 'styled']);
    assert.match(human.stdout, /Task SLAs on INC0010001 \(incident\)[\s\S]*Priority 1 resolution \(1 hour\) \[0+a\]: in progress, breached/);
    const shown = await run(['slas', 'show', 'Priority 1 resolution (1 hour)', '--format', 'styled']);
    assert.match(shown.stdout, /SLA definition \(read-only\)[\s\S]*Stop: State = Closed \(state=7\^EQ\)/);
    const before = calls.length;
    for (const args of [['show', 'bad^name'], ['show'], ['task'], ['list', '--table', 'BAD'], ['list', '--limit', '0'], ['list', '--typo'], ['why']]) {
      await assert.rejects(run(['slas', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['slas', '--help']);
    for (const name of ['list', 'show', 'task']) assert.ok(help.stdout.includes(name));
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
