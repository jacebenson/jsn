import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { flowsCmd } from '../src/commands/flows.js';
import { setFlowSettings, formatFlowSettings } from '../src/flow-settings.js';
import { OutputWriter, FormatJSON } from '../src/output.js';
import { collectCapabilities, mutationPaths } from '../src/capabilities.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const FLOW = id(1), ROW = id(2), NEW = id(3);
const row = (reporting = '', logging = '', extra = {}) => ({ sys_id: ROW, source: FLOW, source_type: 'sys_hub_flow', reporting, logging, ...extra });

function settings() {
  const commands = [];
  const yargs = { command(definition) { commands.push(definition); return this; }, option() { return this; }, epilogue() { return this; } };
  flowsCmd(fn => fn).builder(yargs);
  return commands.find(command => command.command === 'settings [identifier]');
}

// The first setting read answers `rows`, every later one `after`.
function settingsSdk({ type = 'flow', rows = [], after = rows } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    async list(table, params) { calls.push({ op: 'list', table, query: params.get('sysparm_query') }); return [{ sys_id: field(FLOW), name: field('Approve laptops'), type: field(type, type[0].toUpperCase() + type.slice(1)) }]; },
    async listStrict(table, params) { calls.push({ op: 'read', table, query: params.get('sysparm_query'), limit: params.get('sysparm_limit') }); return reads++ ? after : rows; },
    async create(table, data) { calls.push({ op: 'create', table, data }); return { sys_id: NEW, ...data }; },
    async update(table, sysID, data) { calls.push({ op: 'update', table, sysID, data }); return { sys_id: sysID, ...data }; },
  };
}
const writes = sdk => sdk.calls.filter(call => call.op === 'create' || call.op === 'update');

async function run(argv, sdk) {
  let serialized = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { serialized += chunk.toString(); callback(); } });
  const app = { sdk, output: new OutputWriter({ format: FormatJSON, writer, verbose: true }), config: {}, requireInstance() {}, ok(data, opts) { this.output.ok(data, opts); } };
  const exitCode = process.exitCode;
  try {
    await settings().handler({ _: ['flows', 'settings'], ...argv }, app);
    return { ...JSON.parse(serialized), exitCode: process.exitCode };
  } finally { process.exitCode = exitCode; }
}

test('flows settings previews by default with one bounded read and no write', async () => {
  const sdk = settingsSdk({ rows: [row('OFF', '')] });
  const out = await run({ identifier: FLOW, reporting: 'full', logging: 'debug' }, sdk);
  assert.equal(writes(sdk).length, 0);
  assert.deepEqual(sdk.calls, [
    { op: 'list', table: 'sys_hub_flow', query: `sys_id=${FLOW}` },
    { op: 'read', table: 'sys_flow_execution_setting', query: `source=${FLOW}^source_type=sys_hub_flow`, limit: '2' },
  ]);
  assert.deepEqual(out.data.setting, { sys_id: ROW, reporting: 'OFF', logging: '' });
  assert.deepEqual(out.data.changes, { reporting: 'FULL', logging: 'DEBUG' });
  assert.equal(out.data.written, false);
  assert.equal(out.data.rerun, `jsn flows settings ${FLOW} --reporting FULL --logging DEBUG --yes`);
  assert.match(out.summary, /^Preview for flow "Approve laptops": reporting OFF -> FULL, logging not set -> DEBUG; nothing written$/);
  assert.equal(out.exitCode, undefined);
});

test('flows settings --yes creates the row when the flow has none and reads it back', async () => {
  const sdk = settingsSdk({ rows: [], after: [row('FULL', '', { sys_id: NEW })] });
  const out = await run({ identifier: FLOW, reporting: 'FULL', yes: true }, sdk);
  assert.deepEqual(writes(sdk), [{ op: 'create', table: 'sys_flow_execution_setting', data: { source: FLOW, source_type: 'sys_hub_flow', reporting: 'FULL' } }]);
  assert.equal(sdk.calls.at(-1).op, 'read');
  assert.equal(out.data.written, true);
  assert.equal(out.data.verified, true);
  assert.deepEqual(out.data.after, { sys_id: NEW, reporting: 'FULL', logging: '' });
  assert.match(out.summary, /^Set reporting FULL on flow "Approve laptops" in sys_flow_execution_setting 0+3; read back and verified$/);
  assert.equal(out.exitCode, undefined);
});

test('flows settings --yes updates only the fields that change on the existing row', async () => {
  const sdk = settingsSdk({ rows: [row('OFF', 'DEBUG')], after: [row('FULL', 'DEBUG')] });
  const out = await run({ identifier: FLOW, reporting: 'FULL', logging: 'DEBUG', yes: true }, sdk);
  assert.deepEqual(writes(sdk), [{ op: 'update', table: 'sys_flow_execution_setting', sysID: ROW, data: { reporting: 'FULL' } }]);
  assert.equal(out.data.verified, true);
});

test('flows settings writes nothing when the levels are already set or none are given', async () => {
  const already = settingsSdk({ rows: [row('FULL', '')] });
  const out = await run({ identifier: FLOW, reporting: 'FULL', yes: true }, already);
  assert.equal(writes(already).length, 0);
  assert.deepEqual(out.data.changes, {});
  assert.equal(out.data.written, false);
  assert.match(out.summary, /already has reporting FULL; nothing written/);
  const shown = settingsSdk({ rows: [] });
  const current = await run({ identifier: FLOW, yes: true }, shown);
  assert.equal(writes(shown).length, 0);
  assert.equal(current.data.setting, null);
  assert.match(current.summary, /no readable sys_flow_execution_setting row, so the instance-wide levels apply/);
});

test('flows settings prints the row it read back after a write, not the one before', async () => {
  const flow = { sys_id: FLOW, name: 'Approve laptops', type: 'flow', table: 'sys_hub_flow' };
  const created = formatFlowSettings(await setFlowSettings(settingsSdk({ rows: [], after: [row('FULL', 'INFO', { sys_id: NEW })] }), { flow, requested: { reporting: 'FULL' }, write: true }));
  assert.match(created, new RegExp(`^Approve laptops \\(flow ${FLOW}\\): sys_flow_execution_setting ${NEW}$`, 'm'));
  assert.match(created, /^ {2}Reporting: not set -> FULL$/m);
  assert.match(created, /^ {2}Logging: not set -> INFO$/m);
  assert.doesNotMatch(created, /instance-wide/);
  const refused = formatFlowSettings(await setFlowSettings(settingsSdk({ rows: [row('OFF')], after: [row('OFF')] }), { flow, requested: { reporting: 'TRACE' }, write: true }));
  assert.match(refused, /^ {2}Reporting: OFF$/m);
  assert.match(refused, /read-back does not show the requested levels/);
  const empty = formatFlowSettings(await setFlowSettings(settingsSdk({ rows: [] }), { flow, requested: {}, write: false }));
  assert.match(empty, /no readable sys_flow_execution_setting row, so the instance-wide levels apply/);
});

test('flows settings rejects bad levels before any request', async () => {
  for (const argv of [{ reporting: 'LOUD' }, { reporting: '' }, { logging: 'warning' }, { logging: 'DEBUG', reporting: 'ON' }]) {
    const sdk = settingsSdk();
    await assert.rejects(run({ identifier: FLOW, yes: true, ...argv }, sdk), /must be one of/);
    assert.equal(sdk.calls.length, 0, JSON.stringify(argv));
  }
});

test('flows settings refuses duplicate, foreign and malformed setting rows without writing', async () => {
  for (const [rows, pattern] of [
    [[row(), row('', '', { sys_id: id(4) })], /More than one sys_flow_execution_setting row/],
    [[row('', '', { source: id(9) })], /different source/],
    [[row('', '', { source_type: 'sys_hub_action_type_definition' })], /different source/],
    [[null], /Malformed/],
  ]) {
    const sdk = settingsSdk({ rows });
    await assert.rejects(run({ identifier: FLOW, reporting: 'FULL', yes: true }, sdk), pattern);
    assert.equal(writes(sdk).length, 0);
  }
});

test('flows settings reports an unconfirmed write and exits nonzero', async () => {
  for (const after of [[row('OFF')], [], [row(), row('', '', { sys_id: id(4) })]]) {
    const sdk = settingsSdk({ rows: [row('OFF')], after });
    const out = await run({ identifier: FLOW, reporting: 'TRACE', yes: true }, sdk);
    assert.equal(writes(sdk).length, 1);
    assert.equal(out.data.written, true);
    assert.equal(out.data.verified, false);
    assert.match(out.summary, /^Wrote reporting TRACE for flow "Approve laptops" but the read-back did not confirm it$/);
    assert.equal(out.exitCode, 1);
  }
});

test('flows settings tells a subflow or action that a calling flow\'s setting applies', async () => {
  const sub = await run({ identifier: FLOW, reporting: 'BASIC' }, settingsSdk({ type: 'subflow' }));
  assert.match(sub.data.note, /When this subflow runs from a flow, the parent flow's setting applies/);
  const sdk = settingsSdk({ after: [row('BASIC', '', { sys_id: NEW, source_type: 'sys_hub_action_type_definition' })] });
  const action = await run({ identifier: FLOW, action: true, reporting: 'BASIC', yes: true }, sdk);
  assert.equal(sdk.calls[0].table, 'sys_hub_action_type_definition');
  assert.equal(sdk.calls[1].query, `source=${FLOW}^source_type=sys_hub_action_type_definition`);
  assert.deepEqual(writes(sdk)[0].data, { source: FLOW, source_type: 'sys_hub_action_type_definition', reporting: 'BASIC' });
  assert.equal(action.data.verified, true);
  assert.match(action.data.note, /When this action runs from a flow, the parent flow's setting applies/);
});

test('flows settings is a guarded mutation that needs no capture context', () => {
  assert.ok(mutationPaths(collectCapabilities()).some(path => path.join(' ') === 'flows settings'));
  assert.equal(isMutationCommand({ _: ['flows', 'settings'] }), true);
  assert.equal(needsMutationContext({ _: ['flows', 'settings'] }), false);
});
