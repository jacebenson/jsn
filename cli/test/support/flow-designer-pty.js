// Disposable in-memory provider for real terminal prompts. Never contacts an instance.
//
// The flow side mirrors the LIVE contract established against dev354702:
//   * POST /api/now/processflow/flow returns a flow whose triggerInstances is
//     EMPTY — there is no default trigger to patch,
//   * the trigger is INSERTED by the same snFlowDesigner flowPatch as the actions,
//   * the instance (not the CLI) derives predicate metadata from the condition
//     input, so the fake derives it here too and the read-back check proves it.
import assert from 'node:assert/strict';
import { SDKClient } from '../../src/sdk.js';
import cliAdapter from '../../src/cli-adapter.js';
import { actionsCmd } from '../../src/commands/actions.js';
import { flowsCmd } from '../../src/commands/flows.js';
import { OutputWriter } from '../../src/output.js';
const ID = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const STEP = 'c'.repeat(32);
const LOG_ID = '9'.repeat(32);
const FLOW_ID = 'e'.repeat(32);
const TRIGGER_ID = 'f'.repeat(32);
const TRIGGER_DEFINITION = '1'.repeat(32);
const CATEGORY = '2'.repeat(32);
const TABLE_INPUT = '3'.repeat(32);
const CONDITION_INPUT = '4'.repeat(32);
const DAILY_TIME_INPUT = '5'.repeat(32);
const DAILY_DEFINITION = '6'.repeat(32);
const SCHEDULED_CATEGORY = '7'.repeat(32);
const mutations = [];
const sdk = new SDKClient('https://example.invalid', null);
let action = { id: ID, scope: SCOPE, name: 'Disposable action', description: '', state: 'draft', master_snapshot: '', latest_snapshot: '',
  action_status_metadata: { sysId: 'd'.repeat(32), actionTypeId: ID }, inputs: [{ name: 'request', type: 'string', mandatory: true }], outputs: [],
  steps: [{ cid: 'synthetic', action: ID, step_type: 'SCRIPT', step_type_id: STEP, order: 1,
    inputs: [{ name: 'script', type: 'script', value: 'old script' }], outputs: [], extended_inputs: [], extended_outputs: [] }] };
let version;
// The published Log action, with the real input schema AND a step, so the flow
// wizard and the action editor can both be driven from the same picker row.
const logAction = { id: LOG_ID, scope: SCOPE, name: 'Log', description: '', state: 'draft', master_snapshot: '', latest_snapshot: '',
  action_status_metadata: { sysId: 'd'.repeat(32), actionTypeId: LOG_ID },
  inputs: [
    { id: 'log-level', name: 'log_level', label: 'Level', type: 'choice', defaultValue: 'info', choices: [{ label: 'Info', value: 'info' }, { label: 'Warning', value: 'warn' }], mandatory: false, attributes: { element_mapping_provider: 'x' } },
    { id: 'log-message', name: 'log_message', label: 'Message', type: 'string', mandatory: true, attributes: { element_mapping_provider: 'x' } },
  ], outputs: [],
  steps: [{ cid: 'log-step', action: LOG_ID, step_type: 'SCRIPT', step_type_id: STEP, order: 1,
    inputs: [{ name: 'script', type: 'script', value: 'old log script' }], outputs: [], extended_inputs: [], extended_outputs: [] }] };
let currentSteps = action.steps;
const value = v => ({ schemaless: false, schemalessValue: '', value: v });
// An already-saved draft, used by `flow edit` / `flows test`. Shape the live
// ProcessFlow read-back returns: the family in `type`, the picker category in
// `triggerType`.
let flow = { flowId: ID, scope: SCOPE, updated: '2020-01-01 00:00:00', triggerInstances: [{
  id: TRIGGER_ID, type: 'record_create_or_update', triggerType: 'Record', triggerDefinitionId: TRIGGER_DEFINITION,
  metadata: { query_parse: { predicates: [], order_by: [], group_by: [], has_rlq_conditions: false } },
  inputs: [{ name: 'table', value: value('incident') }, { name: 'condition', value: value('') }],
}], actionInstances: [] };

function write(method, path, body) { mutations.push({ method, path, body }); process.stdout.write('\nFAKE_WRITE\n'); }

// The instance parses the condition input into predicate metadata; the CLI sends
// {} and verifies the result by read-back.
function derivedMetadata(condition) {
  const match = String(condition || '').match(/^([A-Za-z_][A-Za-z0-9_.]*)(STARTSWITH|ENDSWITH|LIKE|NOT LIKE|=|!=|IN|ISEMPTY|ISNOTEMPTY)([^,^]*)$/);
  if (!match) return { query_parse: { order_by: [], group_by: [], predicates: [], has_rlq_conditions: false } };
  return {
    query_parse: {
      order_by: [], group_by: [], has_rlq_conditions: false,
      predicates: [{ compound_type: 'or', subpredicates: [{ type: 'comparison', field: match[1], operator: match[2], term: `${match[1]}${match[2]}${match[3]}`, value: match[3], field_type: 'string', column_type: 'element' }] }],
    },
  };
}

function gqlString(query, field) {
  const match = query.match(new RegExp(`${field}: "((?:\\\\.|[^"\\\\])*)"`));
  return match ? JSON.parse(`"${match[1]}"`) : '';
}

function inputEntries(segment) {
  const entries = [];
  for (const match of segment.matchAll(/\{name: "([^"]+)", value: \{schemaless: false, schemalessValue: "", value: (""|"(?:\\.|[^"\\])*")\}/g)) {
    entries.push({ name: match[1], value: value(JSON.parse(match[2])) });
  }
  return entries;
}
function actionInputEntries(segment) {
  const entries = [];
  for (const match of segment.matchAll(/name: "([^"]+)", children: \[\], displayField: "[^"]*", scriptActive: false, parameter: \{[\s\S]*?\}, value: \{schemaless: false, schemalessValue: "", value: (""|"(?:\\.|[^"\\])*")\}/g)) {
    entries.push({ name: match[1], value: value(JSON.parse(match[2])) });
  }
  return entries;
}

sdk.request = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const method = options.method || 'GET';
  const body = options.body && JSON.parse(options.body);
  if (['POST', 'PUT', 'DELETE'].includes(method)) write(method, path, body);
  if (path === `/api/now/table/sys_scope/${SCOPE}`) return { result: { sys_id: SCOPE } };
  if (path === '/api/now/table/sys_hub_action_type_definition' && method === 'POST') return { result: { sys_id: ID } };
  if (path.startsWith('/api/now/table/sys_hub_action_type_definition/')) {
    const sysId = path.split('/').pop();
    return { result: { sys_id: sysId, name: sysId === LOG_ID ? 'Log' : action.name, sys_scope: SCOPE } };
  }
  if (path === '/api/now/processflow/action/step_types') return { result: [{ id: STEP, type: 'SCRIPT', name: 'Script', inputs: [{ name: 'script', type: 'script' }], outputs: [] }] };
  if (path.endsWith('/step_instances')) return { result: { steps: currentSteps } };
  if (path.endsWith(`/action_types/${ID}`)) {
    if (method === 'PUT') { action = structuredClone(body); return { result: action }; }
    currentSteps = action.steps;
    const { steps: _steps, ...definition } = action; return { result: definition };
  }
  // The Log action's real published schema, read through the action_types route.
  if (path.endsWith(`/action_types/${LOG_ID}`)) {
    currentSteps = logAction.steps;
    const { steps: _logSteps, ...logDefinition } = logAction;
    return { result: logDefinition };
  }
  if (path === '/api/now/processflow/flow' && method === 'POST') {
    // A newly created ProcessFlow has no trigger: there is nothing to patch.
    flow = { flowId: FLOW_ID, scope: SCOPE, triggerInstances: [], actionInstances: [], name: body?.name };
    return { result: { data: { id: FLOW_ID } } };
  }
  if (path === `/api/now/processflow/flow/${FLOW_ID}` || path === `/api/now/processflow/flow/${ID}`) return { result: { data: { ...flow, flowId: flow.flowId } } };
  if (path === '/api/now/graphql') {
    const query = body.query;
    if (query.includes('safeEdit(')) {
      const safeEdit = query.includes('upsert:') ? { status: { canUserEdit: true, currentEditor: null, clientFlowStale: null } }
        : query.includes('delete:') ? { deleteResult: { deleteSuccess: true, id: FLOW_ID } }
          : { status: { canUserEdit: false, currentEditor: null } };
      return { data: { global: { snFlowDesigner: { safeEdit } } } };
    }
    if (query.includes('triggerInstances: {update:')) {
      const metadata = query.match(/metadata: ("(?:\\.|[^"\\])*")/);
      if (metadata) flow.triggerInstances[0].metadata = JSON.parse(metadata[1]);
      const condition = flow.triggerInstances[0].inputs.find(field => field.name === 'condition');
      condition.value = value('');
      condition.displayValue = value('');
      return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [TRIGGER_ID] }, actions: { updates: [] } } } } } };
    }
    if (query.includes('triggerInstances: {insert:')) {
      const insert = query.slice(query.indexOf('triggerInstances: {insert:'), query.indexOf('}, actions: {insert:'));
      const declared = inputEntries(insert).map(entry => ({ ...entry, parameter: { id: entry.name } }));
      flow.triggerInstances = [{
        id: TRIGGER_ID,
        flowSysId: FLOW_ID,
        name: gqlString(insert, 'name'),
        type: gqlString(insert, 'type'),
        triggerType: gqlString(insert, 'triggerType'),
        triggerDefinitionId: gqlString(insert, 'triggerDefinitionId'),
        metadata: derivedMetadata((declared.find(entry => entry.name === 'condition') || {}).value?.value || ''),
        inputs: declared,
      }];
    }
    if (query.includes('actions: {insert:')) {
      const insert = query.slice(query.indexOf('actions: {insert:'));
      const entries = [];
      for (const chunk of insert.split('uiUniqueIdentifier: "').slice(1)) entries.push(chunk.slice(0, chunk.indexOf('"')));
      const requested = gqlString(insert, 'actionTypeSysId');
      flow.actionInstances = entries.map((uiId, index) => ({
        id: `${index + 1}`.repeat(32),
        uiUniqueIdentifier: uiId,
        actionTypeSysId: requested,
        order: String(index + 1),
        inputs: actionInputEntries(insert.split('uiUniqueIdentifier: "').slice(1)[index].split('inputs: [').slice(1).join('inputs: [')),
      }));
    }
    return { data: { global: { snFlowDesigner: { flow: {
      triggerInstances: { inserts: flow.triggerInstances.length ? [{ sysId: TRIGGER_ID }] : [], updates: [] },
      actions: { inserts: flow.actionInstances.map(instance => ({ sysId: instance.id, uiUniqueIdentifier: instance.uiUniqueIdentifier })) },
    } } } } };
  }
  if (path === '/api/now/processflow/versioning/create_version') {
    version = { sys_id: STEP, flow: FLOW_ID, type: body.type, payload: JSON.stringify(flow) };
    return { result: version };
  }
  throw new Error(`Unsupported fake provider request ${method} ${path}`);
};
sdk.aggregateCount = async () => 1;
const disp = (value_, display = value_) => ({ value: value_, display_value: display });
sdk.list = async (table, params) => {
  const query = decodeURIComponent(String(params));
  if (table === 'sys_user') return [];
  if (table === 'sys_hub_flow_version') return version ? [version] : [];
  if (table === 'sys_hub_flow') return [{ sys_id: FLOW_ID, name: 'Disposable flow', scope: SCOPE, active: false, status: 'draft' }];
  if (table === 'sys_db_object') {
    if (query.includes('name=incident')) return [{ name: disp('incident'), label: disp('Incident'), super_class: disp('') }];
    return [{ sys_id: STEP, name: disp('incident'), label: disp('Incident'), super_class: disp('') }];
  }
  if (table === 'sys_dictionary') return [{ element: disp('number') }];
  if (table === 'sys_scope') return [{ sys_id: SCOPE, name: 'Disposable scope' }];
  if (table === 'sys_hub_action_type_definition') return [
    { sys_id: disp(ID), name: disp('Disposable action'), active: disp('true'), published: disp('true') },
    { sys_id: disp(LOG_ID), name: disp('Log'), active: disp('true'), published: disp('true') },
  ];
  if (table === 'sys_hub_trigger_category') return [
    { sys_id: disp(CATEGORY), name: disp('Record') },
    { sys_id: disp(SCHEDULED_CATEGORY), name: disp('Scheduled') },
  ];
  if (table === 'sys_hub_trigger_definition') {
    const rows = [
      { sys_id: disp(TRIGGER_DEFINITION), name: disp('Created or Updated'), type: disp('record_create_or_update'), category: disp(CATEGORY, 'Record'), active: disp('true'), description: disp('') },
      { sys_id: disp(DAILY_DEFINITION), name: disp('Daily'), type: disp('daily'), category: disp(SCHEDULED_CATEGORY, 'Scheduled'), active: disp('true'), description: disp('') },
    ];
    const match = query.match(/type=([a-z_]+)/);
    return match ? rows.filter(row => row.type.value === match[1]) : rows;
  }
  if (table === 'sys_hub_trigger_input') {
    if (query.includes(DAILY_DEFINITION)) return [
      { sys_id: disp(DAILY_TIME_INPUT), element: disp('time'), label: disp('Time'), internal_type: disp('glide_time', 'Time'), mandatory: disp('true'), order: disp('100'), max_length: disp('100'), default_value: disp(''), attributes: disp(''), choice: disp(''), reference: disp(''), use_dependent_field: disp('false'), dependent_on_field: disp(''), read_only: disp('false'), hint: disp('') },
    ];
    if (query.includes(TRIGGER_DEFINITION)) return [
      { sys_id: disp(TABLE_INPUT), element: disp('table'), label: disp('Table'), internal_type: disp('table_name', 'Table Name'), mandatory: disp('true'), order: disp('1'), max_length: disp('80'), default_value: disp(''), attributes: disp('filter_table_source=RECORD_WATCHER_RESTRICTED'), choice: disp(''), reference: disp(''), use_dependent_field: disp('false'), dependent_on_field: disp(''), read_only: disp('false'), hint: disp('') },
      { sys_id: disp(CONDITION_INPUT), element: disp('condition'), label: disp('Condition'), internal_type: disp('conditions', 'Conditions'), mandatory: disp('false'), order: disp('100'), max_length: disp('4000'), default_value: disp(''), attributes: disp(''), choice: disp(''), reference: disp(''), use_dependent_field: disp('true'), dependent_on_field: disp('table'), read_only: disp('false'), hint: disp('') },
      { sys_id: disp('8'.repeat(32)), element: disp('run_when_user_list'), label: disp('Run When User List'), internal_type: disp('glide_list', 'List'), mandatory: disp('false'), order: disp('100'), max_length: disp('4000'), default_value: disp(''), attributes: disp('advanced=true'), choice: disp(''), reference: disp('User'), use_dependent_field: disp('false'), dependent_on_field: disp(''), read_only: disp('false'), hint: disp('') },
    ];
    return [];
  }
  return [{ sys_id: ID, name: 'Disposable action', sys_scope: SCOPE }];
};
const get = sdk.get.bind(sdk);
sdk.get = async (table, id) => table === 'sys_db_object' ? { sys_id: STEP, name: 'incident' } : get(table, id);
const output = new OutputWriter({ format: 'auto' });
const app = { sdk, output, config: { profiles: {} }, requireInstance() {}, getEffectiveInstance: () => sdk.baseURL,
  ok: (data, options) => output.ok(data, options), err: error => output.err(error) };
try {
  await cliAdapter(process.argv.slice(2)).command(actionsCmd(handler => argv => handler(argv, app)))
    .command(flowsCmd(handler => argv => handler(argv, app))).parse();
  assert.ok(mutations.every(mutation => !mutation.path.includes('/test') && !mutation.path.includes('/snapshot')));
  process.stdout.write(`\nPTY_RESULT=${JSON.stringify({ mutations, action, flow, version })}\n`);
} catch (error) {
  process.stdout.write(`\nPTY_ERROR=${JSON.stringify({ code: error.code, message: error.message, mutations })}\n`);
  process.exitCode = 1;
}
