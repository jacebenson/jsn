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
import { showFlowExecution, formatFlowExecution } from '../src/flow-execution.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const trace = `Encountered error executing instruction: OpInstruction{id=3, opClass=com.snc.process_flow.operation.IntegrationConnectionDataResolverOperation, io={input={base_url='http://synthetic.invalid'}}}
com.snc.process_flow.exception.OpException: Unable to load connection with alias ID: ${id(90)} <a href="/sys_alias.do?sys_id=${id(90)}" target="blank">Open Connection Alias</a>
${'\tat com.snc.synthetic.Frame.run(Frame.java:1)\n'.repeat(40)}`;
const actionContext = {
  sys_id: field(id(1)), name: field('Synthetic Lookup'), flow: field(id(2)), snapshot: field(id(3)), state: field('ERROR', 'Error'), error_state: field(''),
  error_message: field(`Unable to load connection with alias ID: ${id(90)} <a href="/sys_alias.do?sys_id=${id(90)}" target="blank">Open Connection Alias</a>`),
  reporting: field('OFF', 'Off'), run_time: field('121'), sys_created_on: field('2026-11-21 19:11:19'), source_table: field('sys_script_vtable'), source_record: field(id(4), 'Remote Table: Synthetic'),
  is_test_run: field('false'), attributes: field(JSON.stringify({ type: 'ACTION', reporting: 'OFF', stack: [id(2)] })),
};
const flowContext = {
  ...actionContext, sys_id: field(id(10)), name: field('Synthetic Request'), flow: field(id(11)), snapshot: field(id(12)), state: field('COMPLETE', 'Complete'), error_message: field(''),
  reporting: field('ON', 'On'), attributes: field(JSON.stringify({ type: 'FLOW', reporting: 'FULL' })),
};
const logs = [
  { sys_id: field(id(20)), context: field(id(1), 'Not a join key'), level: field('2', 'Error'), action: field(`Synthetic Lookup.${id(30)}`), operation: field(''), message: field(trace), sys_created_on: field('2026-11-21 19:11:19') },
  { sys_id: field(id(21)), context: field(id(1), 'Not a join key'), level: field('2', 'Error'), action: field('Synthetic Lookup'), operation: field(''), message: field('Encountered error executing instruction: ActionErrorEvalInstruction{id=22}, errorMessage:Unable to load connection'), sys_created_on: field('2026-11-21 19:11:19') },
  { sys_id: field(id(22)), context: field(id(10)), level: field('2', 'Error'), action: field(`Synthetic Request.${id(40)}.${id(41)}.${id(42)}`), operation: field(''), message: field('java.lang.IllegalArgumentException: ID may not contain colons\n\tat com.snc.Frame'), sys_created_on: field('2026-11-22 02:38:31') },
];
const tables = {
  sys_flow_context: [actionContext, flowContext],
  sys_hub_action_type_definition: [{ sys_id: field(id(2)), name: field('Synthetic Lookup'), latest_snapshot: field(id(3)) }],
  sys_hub_flow: [{ sys_id: field(id(11)), name: field('Synthetic Request'), latest_snapshot: field(id(13)) }],
  sys_flow_log: logs,
  sys_hub_step_instance: [{ sys_id: field(id(30)), label: field('Synthetic Lookup'), order: field('2'), step_type: field(id(60), 'REST') }, { sys_id: field(id(42)), label: field('Synthetic step '), order: field('1'), step_type: field(id(61), 'Update Record') }],
  sys_hub_action_instance_v2: [{ sys_id: field(id(41), 'Wrong label'), action_type: field(id(50), 'Update Record'), order: field('4'), comment: field('Set the approval to approved') }],
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

test('an action run with reporting off shows its version, failed step and that no step data was kept', async () => {
  const sdk = fixtureSdk();
  const data = await showFlowExecution(sdk, id(1));
  assert.deepEqual(sdk.calls.map(call => [call.table, call.params.get('sysparm_query'), call.params.get('sysparm_limit')]), [
    ['sys_flow_context', `sys_idIN${id(1)}`, '1'],
    ['sys_hub_action_type_definition', `sys_idIN${id(2)}`, '1'],
    ['sys_flow_log', `context=${id(1)}^level=2^ORDERBYorder^ORDERBYsys_id`, '21'],
    ['sys_hub_action_instance_v2', `sys_idIN${id(30)}`, '1'],
    ['sys_hub_step_instance', `sys_idIN${id(30)}`, '1'],
  ]);
  assert.ok(sdk.calls.every(call => call.params.get('sysparm_display_value') === 'all'));
  assert.deepEqual(data.version, { definition_table: 'sys_hub_action_type_definition', definition: id(2), snapshot: id(3), latest_snapshot: id(3), is_latest: true });
  assert.deepEqual(data.step_data, { recorded: false, reporting: 'OFF' });
  assert.equal(data.execution.type, 'ACTION');
  assert.equal(data.failed_steps.length, 1);
  assert.deepEqual({ ...data.failed_steps[0], message: undefined }, { log: id(20), path: `Synthetic Lookup.${id(30)}`, instances: [id(30)], action: null, step: { sys_id: id(30), order: '2', name: 'Synthetic Lookup', step_type: 'REST' }, message: undefined, message_length: trace.length, truncated: false });
  assert.equal(data.failed_steps[0].message, trace);
  assert.equal(data.log.count, 2);
  const human = formatFlowExecution(data);
  assert.match(human, /Synthetic Lookup \(action\): Error/);
  assert.match(human, /the action's latest snapshot/);
  assert.match(human, /Reporting was OFF for this run, so no step statuses, inputs or outputs were kept/);
  assert.match(human, /Step 2 Synthetic Lookup \(REST\)/);
  assert.match(human, /OpException: Unable to load connection with alias ID: 0+5a Open Connection Alias/);
  assert.match(human, /\+\d+ chars, --json for all/);
  assert.doesNotMatch(human, /<a href/);
});

test('a flow run joins its failed action on the raw sys_id, flags an older snapshot and reports recorded step data', async () => {
  const sdk = fixtureSdk();
  const data = await showFlowExecution(sdk, id(10));
  assert.equal(sdk.calls[1].table, 'sys_hub_flow');
  assert.deepEqual(sdk.calls.slice(3).map(call => [call.table, call.params.get('sysparm_query'), call.params.get('sysparm_limit')]), ['sys_hub_action_instance_v2', 'sys_hub_step_instance'].map(table => [table, `sys_idIN${id(40)},${id(41)},${id(42)}`, '3']));
  assert.equal(data.version.is_latest, false);
  assert.deepEqual(data.step_data, { recorded: true, reporting: 'FULL' });
  assert.deepEqual(data.failed_steps[0].action, { sys_id: id(41), order: '4', name: 'Update Record', comment: 'Set the approval to approved' });
  assert.deepEqual(data.failed_steps[0].step, { sys_id: id(42), order: '1', name: 'Synthetic step', step_type: 'Update Record' });
  const human = formatFlowExecution(data);
  assert.match(human, /Synthetic Request \(flow\): Complete/);
  assert.match(human, /not the flow's latest snapshot/);
  assert.match(human, /Reporting was FULL for this run/);
  assert.match(human, /Step 4 Update Record: Set the approval to approved, at its step 1 Synthetic step \(Update Record\)/);
  assert.match(human, /IllegalArgumentException: ID may not contain colons/);
});

test('invalid context IDs reject before any request', async () => {
  const sdk = fixtureSdk();
  for (const invalid of ['', 'bad', ` ${id(1)}`, `${id(1)}^NQ`, `${id(1)},${id(2)}`, 123, undefined]) await assert.rejects(showFlowExecution(sdk, invalid), /sys_id/);
  assert.equal(sdk.calls.length, 0);
});

function answering(table, rows) {
  const sdk = fixtureSdk();
  const base = sdk.listStrict;
  sdk.listStrict = async (name, params) => name === table ? (sdk.calls.push({ table: name, params }), rows) : base(name, params);
  return sdk;
}

test('missing, mismatched, denied and malformed reads are never reported as a run', async () => {
  await assert.rejects(showFlowExecution(fixtureSdk(), id(99)), /not found/);
  await assert.rejects(showFlowExecution(answering('sys_flow_context', [{ ...actionContext, sys_id: field(id(98), id(1)) }]), id(1)), /different record/);
  await assert.rejects(showFlowExecution(answering('sys_hub_action_type_definition', [{ sys_id: field(id(77), id(2)), latest_snapshot: field(id(3)) }]), id(1)), /different record/);
  await assert.rejects(showFlowExecution(answering('sys_flow_log', [{ ...logs[0], context: field(id(99), id(1)) }]), id(1)), /mismatched context/);
  await assert.rejects(showFlowExecution(answering('sys_hub_step_instance', [{ sys_id: field(id(77), id(30)), label: field('Other') }]), id(1)), /different record/);
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(showFlowExecution({ listStrict: async () => { throw error; } }, id(1)), e => e === error);
  }
  await assert.rejects(showFlowExecution({ listStrict: async () => [null] }, id(1)), /Malformed/);
  await assert.rejects(showFlowExecution(answering('sys_flow_log', [[]]), id(1)), /Malformed/);
});

test('an unreadable definition or step keeps the raw IDs and says so', async () => {
  const data = await showFlowExecution(fixtureSdk({ sys_hub_action_type_definition: [], sys_hub_step_instance: [] }), id(1));
  assert.equal(data.version.is_latest, null);
  assert.deepEqual(data.failed_steps[0].instances, [id(30)]);
  assert.equal(data.failed_steps[0].step, null);
  const human = formatFlowExecution(data);
  assert.match(human, /definition is not readable/);
  assert.ok(human.includes(id(30)));
  const broken = await showFlowExecution(answering('sys_flow_context', [{ ...actionContext, attributes: field('{broken') }]), id(1));
  assert.equal(broken.execution.type, null);
  assert.deepEqual(broken.step_data, { recorded: false, reporting: 'OFF' });
});

test('a run with no error rows says the log names no failed step, and JSON caps long messages at 16 KB', async () => {
  const quiet = await showFlowExecution(fixtureSdk({ sys_flow_log: [] }), id(1));
  assert.equal(quiet.failed_steps.length, 0);
  assert.match(formatFlowExecution(quiet), /The flow log names no failed step/);
  const long = 'x'.repeat(20000);
  const data = await showFlowExecution(fixtureSdk({ sys_flow_log: [{ ...logs[0], message: field(long) }] }), id(1));
  assert.equal(data.failed_steps[0].message.length, 16384);
  assert.equal(data.failed_steps[0].message_length, 20000);
  assert.equal(data.failed_steps[0].truncated, true);
  const many = Array.from({ length: 25 }, (_, index) => ({ ...logs[1], sys_id: field(id(200 + index)) }));
  const capped = await showFlowExecution(fixtureSdk({ sys_flow_log: many }), id(1));
  assert.equal(capped.log.count, 20);
  assert.equal(capped.log.has_more, true);
  assert.match(formatFlowExecution(capped), /More error rows exist/);
});

test('real CLI shows one execution on a read-only profile, keeps the list, and rejects bad input before any request', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, table: url.pathname.split('/').pop() });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    Promise.resolve(fixtureSdk().listStrict(url.pathname.split('/').pop(), url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-flow-execution-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['flows', 'executions', 'show', id(1), '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.step_data.recorded, false);
    assert.equal(envelope.data.failed_steps[0].step.name, 'Synthetic Lookup');
    const human = await run(['flows', 'executions', 'show', id(1), '--format', 'styled']);
    assert.match(human.stdout, /no step statuses, inputs or outputs were kept/);
    const get = await run(['flows', 'executions', 'show', id(1), '--get', 'data.version.snapshot']);
    assert.ok(get.stdout.includes(id(3)));
    const list = JSON.parse((await run(['flows', 'executions', '--json'])).stdout);
    assert.equal(list.data.table, 'sys_flow_context');
    assert.ok(Array.isArray(list.data.executions));
    const before = calls.length;
    for (const args of [['show', 'bad'], ['show'], ['show', id(1), '--typo']]) {
      await assert.rejects(run(['flows', 'executions', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['flows', 'executions', '--help']);
    assert.match(help.stdout, /show <context>/);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    assert.ok(calls.every(call => call.pathname.startsWith('/api/now/table/') || call.pathname === '/angular.do'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
