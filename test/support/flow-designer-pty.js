// Disposable in-memory provider for real terminal prompts. Never contacts an instance.
import assert from 'node:assert/strict';
import { SDKClient } from '../../src/sdk.js';
import cliAdapter from '../../src/cli-adapter.js';
import { actionsCmd } from '../../src/commands/actions.js';
import { flowsCmd } from '../../src/commands/flows.js';
import { OutputWriter } from '../../src/output.js';
const ID = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const STEP = 'c'.repeat(32);
const mutations = [];
const sdk = new SDKClient('https://example.invalid', null);
let action = { id: ID, scope: SCOPE, name: 'Disposable action', description: '', state: 'draft', master_snapshot: '', latest_snapshot: '',
  action_status_metadata: { sysId: 'd'.repeat(32), actionTypeId: ID }, inputs: [{ name: 'request', type: 'string', mandatory: true }], outputs: [],
  steps: [{ cid: 'synthetic', action: ID, step_type: 'SCRIPT', step_type_id: STEP, order: 1,
    inputs: [{ name: 'script', type: 'script', value: 'old script' }], outputs: [], extended_inputs: [], extended_outputs: [] }] };
let flow = { flowId: ID, scope: SCOPE, triggerInstances: [{ sysId: STEP, triggerType: 'record_create_or_update', inputs: [
  { name: 'table', value: { value: 'incident' } }, { name: 'condition', value: { value: '' } },
] }], actionInstances: [] };
let version;
function write(method, path, body) { mutations.push({ method, path, body }); process.stdout.write('\nFAKE_WRITE\n'); }
sdk.request = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const method = options.method || 'GET';
  const body = options.body && JSON.parse(options.body);
  if (['POST', 'PUT', 'DELETE'].includes(method)) write(method, path, body);
  if (path === `/api/now/table/sys_scope/${SCOPE}`) return { result: { sys_id: SCOPE } };
  if (path === '/api/now/table/sys_hub_action_type_definition' && method === 'POST') return { result: { sys_id: ID } };
  if (path === `/api/now/table/sys_hub_action_type_definition/${ID}`) return { result: { sys_id: ID, name: action.name, sys_scope: SCOPE } };
  if (path === '/api/now/processflow/action/step_types') return { result: [{ id: STEP, type: 'SCRIPT', name: 'Script', inputs: [{ name: 'script', type: 'script' }], outputs: [] }] };
  if (path.endsWith('/step_instances')) return { result: { steps: action.steps } };
  if (path.endsWith(`/action_types/${ID}`)) {
    if (method === 'PUT') { action = structuredClone(body); return { result: action }; }
    const { steps: _steps, ...definition } = action; return { result: definition };
  }
  if (path === '/api/now/processflow/flow' && method === 'POST') return { result: { sys_id: ID } };
  if (path === `/api/now/processflow/flow/${ID}`) return { result: { data: flow } };
  if (path === '/api/now/processflow/trigger/record/table') return { result: { label: 'Incident', displayField: 'number', fields: [] } };
  if (path === '/api/now/graphql') {
    const metadata = body.query.match(/metadata: ("(?:\\.|[^"\\])*")/);
    if (metadata) flow.triggerInstances[0].metadata = JSON.parse(metadata[1]);
    if (body.query.includes('actions: {update:') || body.query.includes('triggerInstances: {update:') && !body.query.includes('actions: {insert:')) {
      const condition = flow.triggerInstances[0].inputs.find(field => field.name === 'condition');
      condition.value = { schemaless: false, schemalessValue: '', value: '' };
      condition.displayValue = { schemaless: false, schemalessValue: '', value: '' };
    } else flow.triggerInstances[0].inputs = [
      { name: 'table', displayField: 'number', displayValue: { schemaless: false, schemalessValue: '', value: 'Incident' }, value: { schemaless: false, schemalessValue: '', value: 'incident' } },
      { name: 'condition', displayField: '', displayValue: { schemaless: false, schemalessValue: '', value: '' }, value: { schemaless: false, schemalessValue: '', value: '' } },
    ];
    return { data: { global: { snFlowDesigner: { flow: { actions: { inserts: [] } } } } } };
  }
  if (path === '/api/now/processflow/versioning/create_version') {
    version = { sys_id: STEP, flow: ID, type: body.type, payload: JSON.stringify(flow) };
    return { result: version };
  }
  throw new Error(`Unsupported fake provider request ${method} ${path}`);
};
sdk.aggregateCount = async () => 1;
sdk.list = async (table, _params) => {
  if (table === 'sys_user') return [];
  if (table === 'sys_hub_flow_version') return version ? [version] : [];
  if (table === 'sys_hub_flow') return [{ sys_id: ID, name: 'Disposable flow', scope: SCOPE, active: false, status: 'draft' }];
  if (table === 'sys_db_object') return [{ sys_id: STEP, name: 'incident' }];
  if (table === 'sys_scope') return [{ sys_id: SCOPE, name: 'Disposable scope' }];
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
  process.stdout.write(`\nPTY_RESULT=${JSON.stringify({ mutations, action, flow })}\n`);
} catch (error) {
  process.stdout.write(`\nPTY_ERROR=${JSON.stringify({ code: error.code, message: error.message, mutations })}\n`);
  process.exitCode = 1;
}
