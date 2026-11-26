import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { flowsCmd } from '../src/commands/flows.js';
import { recordsCmd } from '../src/commands/records.js';
import { columnsCmd } from '../src/commands/columns.js';
import { captureCommands } from './support/command-test-helpers.js';
import { analyzeCondition, probeCondition, referenceComparisonFlags } from '../src/why-checks.js';

const ID = '1'.repeat(32);
const FLOW = '2'.repeat(32);
const TASK = '3'.repeat(32);

function encodedTrigger(inputs) {
  return gzipSync(Buffer.from(JSON.stringify(Object.entries(inputs).map(([name, value]) => ({ name, value }))), 'utf8')).toString('base64');
}

function dictionaryRows(query) {
  const match = /name(?:IN|=)([^^]+)/.exec(query);
  const names = match ? match[1].split(',') : [];
  return names.flatMap(name => (DICTIONARY[name] || []).map(row => ({ name, ...row })));
}

const DICTIONARY = {
  incident: [
    { sys_id: 'd1', element: 'sys_id', internal_type: 'GUID' },
    { sys_id: 'd2', element: 'number', internal_type: 'String' },
    { sys_id: 'd3', element: 'short_description', internal_type: 'String' },
    { sys_id: 'd4', element: 'caller_id', internal_type: 'Reference', reference: 'User', read_only: 'true', mandatory: 'false' },
    { sys_id: 'd5', element: 'state', internal_type: 'Integer', read_only: 'false', mandatory: 'false' },
  ],
  task: [
    { sys_id: 'd6', element: 'number', internal_type: 'String' },
    { sys_id: 'd7', element: 'short_description', internal_type: 'String' },
  ],
  sys_script: [{ element: 'when' }, { element: 'order' }, { element: 'name' }, { element: 'active' }, { element: 'collection' }, { element: 'condition' }, { element: 'filter_condition' }, { element: 'advanced' }, { element: 'action_insert' }, { element: 'action_update' }, { element: 'action_delete' }, { element: 'script' }],
  sys_data_policy2: [{ element: 'conditions' }, { element: 'name' }, { element: 'active' }, { element: 'model_table' }, { element: 'inherit' }, { element: 'order' }],
  sys_flow_record_trigger: [{ element: 'table' }, { element: 'condition' }, { element: 'active' }, { element: 'name' }, { element: 'on_insert' }, { element: 'on_update' }, { element: 'on_delete' }, { element: 'run_flow_in' }, { element: 'run_on_extended' }],
  sysevent_email_action: [{ element: 'condition' }, { element: 'advanced_condition' }, { element: 'name' }, { element: 'active' }, { element: 'collection' }, { element: 'event_name' }],
  sys_ui_policy: [{ element: 'conditions' }, { element: 'name' }, { element: 'active' }, { element: 'table' }, { element: 'on_load' }, { element: 'inherit' }],
  sys_ui_policy_action: [{ element: 'field' }, { element: 'mandatory' }, { element: 'disabled' }, { element: 'visible' }, { element: 'ui_policy' }],
  sys_data_policy_rule: [{ element: 'field' }, { element: 'mandatory' }, { element: 'disabled' }, { element: 'sys_data_policy' }],
  sys_security_acl: [{ element: 'name' }, { element: 'operation' }, { element: 'type' }, { element: 'condition' }, { element: 'script' }, { element: 'active' }],
  sys_script_client: [{ element: 'name' }, { element: 'table' }, { element: 'type' }, { element: 'field' }, { element: 'script' }, { element: 'active' }, { element: 'applies_extended' }],
  sys_dictionary_override: [{ element: 'element' }, { element: 'name' }, { element: 'read_only' }, { element: 'read_only_override' }, { element: 'mandatory' }, { element: 'mandatory_override' }, { element: 'active' }],
};

function fakeSdk({ probes = [], tables = {}, flow = null, contexts = [] } = {}) {
  const calls = [];
  const isProbe = query => query.startsWith(`sys_id=${ID}^`);
  const rows = (table, query) => {
    calls.push([table, query]);
    if (table === 'sys_db_object') {
      if (query === `sys_id=${TASK}`) return [{ sys_id: TASK, name: 'task', label: 'Task', super_class: '' }];
      if (query === `sys_id=${ID}`) return [{ sys_id: ID, name: 'incident', label: 'Incident', super_class: TASK }];
      const name = /name=([^^]+)/.exec(query)?.[1];
      if (name === 'incident') return [{ sys_id: ID, name: 'incident', label: 'Incident', super_class: TASK }];
      if (name === 'task') return [{ sys_id: TASK, name: 'task', label: 'Task', super_class: '' }];
      return [];
    }
    if (table === 'sys_dictionary') return dictionaryRows(query);
    if (table === 'incident' && query === `sys_id=${ID}`) return [{ sys_id: ID, number: 'INC0010001', short_description: 'fixture', sys_class_name: 'incident' }];
    if (table === 'incident' && isProbe(query)) {
      return probes.some(probe => query.includes(probe)) ? [{ sys_id: ID }] : [];
    }
    if (table === 'sys_flow_context') return contexts;
    return tables[table] || [];
  };
  const sdk = {
    calls,
    async list(table, params) { return rows(table, params.get('sysparm_query') || ''); },
    async listStrict(table, params) { return rows(table, params.get('sysparm_query') || ''); },
    async get(table, identifier) {
      calls.push([`get:${table}`, identifier]);
      if (table === 'sys_hub_flow' && flow) return flow;
      throw new Error(`unexpected get ${table}`);
    },
    async aggregateCount(table, query) {
      calls.push([`count:${table}`, query]);
      return table === 'sys_flow_context' ? contexts.length : 0;
    },
  };
  for (const method of ['create', 'update', 'delete', 'request', 'executeScript']) {
    sdk[method] = async () => { throw new Error(`unexpected mutation ${method}`); };
  }
  return sdk;
}

function jsonApp(sdk) {
  let last;
  return {
    app: {
      sdk,
      output: { getFormat: () => 'json' },
      requireInstance() {},
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok(data, opts) { last = { data, opts }; },
    },
    envelope: () => last,
  };
}

function styledApp(sdk) {
  let last;
  return {
    app: {
      sdk,
      output: { getFormat: () => 'styled' },
      requireInstance() {},
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok(data, opts) { last = { data, opts }; },
    },
    envelope: () => last,
  };
}

test('condition analysis keeps ^NQ groups, rejects change operators and inline javascript', () => {
  assert.equal(analyzeCondition('').empty, true);
  assert.equal(analyzeCondition('^EQ').empty, true);
  const groups = analyzeCondition('state=1^NQstate=2^EQ');
  assert.equal(groups.groups.length, 2);
  assert.equal(groups.groups[1].query, 'state=2');
  const change = analyzeCondition('stateCHANGESTO6');
  assert.equal(change.groups.length, 0);
  assert.match(change.untested[0].reason, /CHANGESTO/);
  const script = analyzeCondition('caller_id=javascript:gs.getUserID()');
  assert.equal(script.groups.length, 0);
  assert.match(script.untested[0].reason, /script/);
});

test('probeCondition asks the Table API per group and reports tri-state matches', async () => {
  const calls = [];
  const sdk = { async listStrict(table, params) { calls.push([table, params.get('sysparm_query')]); return calls.length === 1 ? [{ sys_id: ID }] : []; } };
  const result = await probeCondition(sdk, { table: 'incident', sysId: ID, condition: 'state=1^NQstate=2' });
  assert.deepEqual(calls, [['incident', `sys_id=${ID}^state=1`], ['incident', `sys_id=${ID}^state=2`]]);
  assert.equal(result.tested, true);
  assert.equal(result.matched, true, 'any ^NQ group matching means the condition matches');
});

test('referenceComparisonFlags flags a display value compared with a reference field', () => {
  const catalog = { fields: new Map([['caller_id', { reference: 'User' }]]) };
  const flags = referenceComparisonFlags(catalog, 'caller_id=Beth Anglin');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].reference_table, 'User');
  assert.equal(referenceComparisonFlags(catalog, `caller_id=${'a'.repeat(32)}`).length, 0);
});

function flowFixture() {
  return fakeSdk({
    flow: { sys_id: FLOW, name: 'Facilities flow', type: 'Flow', active: 'true', status: 'Published', master_snapshot: 'snap', version: '2' },
    tables: {
      sys_hub_flow: [{ sys_id: FLOW, name: 'Facilities flow' }],
      sys_hub_trigger_instance_v2: [{ trigger_type: 'record_update', trigger_inputs: encodedTrigger({ table: 'incident', condition: 'state=6', run_on_extended: 'false' }) }],
      sys_flow_record_trigger: [{ sys_id: 't1', table: 'incident', condition: 'state=6', active: 'true', on_update: 'true' }],
    },
    probes: [],
  });
}

test('flows why handler emits data-only JSON and explains a non-matching condition', async () => {
  const sdk = flowFixture();
  const { app, envelope } = jsonApp(sdk);
  const why = captureCommands(flowsCmd(fn => fn)).find(command => command.command === 'why <identifier>');
  await why.handler({ identifier: FLOW, record: [`incident:${ID}`] }, app);
  const { data } = envelope();
  assert.equal(data.flow.sys_id, FLOW);
  assert.equal(data.record.sys_id, ID);
  assert.equal(data.trigger.condition, 'state=6');
  assert.equal(data.condition.matched, false);
  assert.equal(data.verdict, 'would_not_run');
  assert.equal('_formatted' in data, false);
  assert.deepEqual(sdk.calls.filter(([table]) => ['create', 'update', 'delete'].includes(table)), []);
});

test('flows why human output is rendered only for terminal formats', async () => {
  const sdk = flowFixture();
  const { app, envelope } = styledApp(sdk);
  const why = captureCommands(flowsCmd(fn => fn)).find(command => command.command === 'why <identifier>');
  await why.handler({ identifier: FLOW, record: [`incident:${ID}`] }, app);
  assert.match(envelope().data._formatted, /FLOW WHY/);
});

function pipelineFixture() {
  return fakeSdk({
    tables: {
      sys_script: [
        { sys_id: 'b1', name: 'Before one', collection: 'incident', active: 'true', when: 'before', order: '10', action_update: 'true', filter_condition: 'state=1', advanced: 'false' },
        { sys_id: 'b2', name: 'Before two', collection: 'incident', active: 'true', when: 'before', order: '20', action_update: 'true', filter_condition: 'state=9', advanced: 'false' },
        { sys_id: 'a1', name: 'After one', collection: 'incident', active: 'true', when: 'after', order: '10', action_update: 'true', filter_condition: 'state=1', advanced: 'false' },
        { sys_id: 's1', name: 'Async one', collection: 'incident', active: 'true', when: 'async', order: '10', action_update: 'true', filter_condition: 'state=1', advanced: 'false' },
      ],
      sys_flow_record_trigger: [{ sys_id: 'f1', name: 'record trigger f1', table: 'incident', active: 'true', on_update: 'true', condition: 'state=1' }],
    },
    probes: ['state=1'],
  });
}

test('records pipeline orders stages and tests each condition, data-only in JSON', async () => {
  const sdk = pipelineFixture();
  const { app, envelope } = jsonApp(sdk);
  const pipeline = captureCommands(recordsCmd(fn => fn)).find(command => command.command === 'pipeline <table> <identifier>');
  await pipeline.handler({ table: 'incident', identifier: ID, op: 'update' }, app);
  const { data } = envelope();
  assert.deepEqual(data.stages.map(stage => stage.id), ['before_rules', 'engines', 'after_rules', 'flow_triggers', 'notifications', 'async_rules']);
  assert.deepEqual(data.stages[0].items.map(item => [item.name, item.condition.matched]), [['Before one', true], ['Before two', false]]);
  assert.equal(data.stages[2].items[0].condition.matched, true);
  assert.equal(data.stages[3].items[0].condition.matched, true);
  assert.equal(data.stages[5].items[0].condition.matched, true);
  assert.equal(data.summary.matching_now, 4);
  assert.equal('_formatted' in data, false);
});

test('records pipeline rejects an invalid operation before any instance read', async () => {
  const { app } = jsonApp(fakeSdk());
  const pipeline = captureCommands(recordsCmd(fn => fn)).find(command => command.command === 'pipeline <table> <identifier>');
  await assert.rejects(pipeline.handler({ table: 'incident', identifier: ID, op: 'merge' }, app), error => error.code === 'usage_error');
});

function columnFixture() {
  return fakeSdk({
    tables: {
      sys_dictionary_override: [{ sys_id: 'o1', name: 'incident', element: 'caller_id', read_only: 'false', read_only_override: 'true', mandatory: 'false', mandatory_override: 'false', active: 'true' }],
      sys_ui_policy: [{ sys_id: 'p1', name: 'Caller required', table: 'incident', active: 'true', conditions: 'state=1', on_load: 'true' }],
      sys_ui_policy_action: [{ sys_id: 'pa1', ui_policy: 'p1', field: 'caller_id', mandatory: 'true', disabled: 'leave alone', visible: 'leave alone' }],
      sys_data_policy2: [{ sys_id: 'dp1', name: 'Caller locked', model_table: 'incident', active: 'true', conditions: 'state=1' }],
      sys_data_policy_rule: [{ sys_id: 'dpr1', sys_data_policy: 'dp1', field: 'caller_id', disabled: 'true', mandatory: 'false' }],
      sys_security_acl: [{ sys_id: 'acl1', name: 'incident.caller_id', operation: 'write', type: 'record', active: 'true', condition: 'state=9' }],
      sys_script_client: [{ sys_id: 'cs1', name: 'Caller helper', table: 'incident', type: 'onChange', field: 'caller_id', script: 'function onChange() { g_form.setValue("caller_id", ""); }', active: 'true' }],
    },
    probes: ['state=1'],
  });
}

test('columns why separates dictionary, policy and script evidence without writing', async () => {
  const sdk = columnFixture();
  const { app, envelope } = jsonApp(sdk);
  const why = captureCommands(columnsCmd(fn => fn)).find(command => command.command === 'why <column>');
  await why.handler({ column: 'incident.caller_id', record: ID }, app);
  const { data } = envelope();
  assert.equal(data.dictionary.base.read_only, true);
  assert.equal(data.summary.read_only, true, 'override clears the dictionary flag before the data policy is considered');
  assert.equal(data.summary.mandatory, true);
  assert.equal(data.summary.hidden, false);
  assert.equal(data.summary.reasons.read_only.some(reason => reason.source === 'dictionary'), false);
  assert.equal(data.ui_policies[0].actions[0].mandatory, 'true');
  assert.equal(data.acls.length, 1);
  assert.equal(data.client_scripts[0].matched_by, 'field');
  assert.equal('_formatted' in data, false);
  assert.deepEqual(sdk.calls.filter(([table]) => ['create', 'update', 'delete'].includes(table)), []);
});

test('columns why requires --record before touching the instance', async () => {
  const { app } = jsonApp(fakeSdk());
  const why = captureCommands(columnsCmd(fn => fn)).find(command => command.command === 'why <column>');
  await assert.rejects(why.handler({ column: 'incident.caller_id' }, app), error => error.code === 'usage_error');
});
