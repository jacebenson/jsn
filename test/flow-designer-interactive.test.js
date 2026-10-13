import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionsCmd } from '../src/commands/actions.js';
import { flowsCmd } from '../src/commands/flows.js';
import { SDKClient } from '../src/sdk.js';
import { OutputWriter } from '../src/output.js';
import { interactiveDesigner, cancelled, pickDesignerRecord, designerScope, promptSchemaValue, guidedActionCreate, guidedActionEdit, guidedFlowCreate, guidedFlowEdit, guidedFlowTestRecord, confirmDesignerMutation, stepTypeSchemas } from '../src/flow-designer-interactive.js';

const ID = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const STEP = 'c'.repeat(32);
const STATUS = 'd'.repeat(32);
const RECORD = 'e'.repeat(32);
const SCRIPT_FILE = new URL('./fixtures/interactive-action-script.js', import.meta.url).pathname;
const script = readFileSync(SCRIPT_FILE, 'utf8');
const schema = () => ({ id: STEP, type: 'SCRIPT', name: 'Script', customMetadata: { preserve: true },
  inputs: [{ name: 'runtime', type: 'choice', choices: [{ label: 'Instance', value: 'instance' }], defaultValue: 'instance' }, { name: 'script', type: 'script' }],
  outputs: [{ name: 'response', type: 'string', children: [], attributes: { schema: { maxLength: 9000 } } }],
});
function definition() {
  return { id: ID, scope: SCOPE, name: 'Synthetic action', description: '', state: 'draft', master_snapshot: '', latest_snapshot: '',
    action_status_metadata: { sysId: STATUS, actionTypeId: ID }, unknown: { deeply: { preserved: true } },
    inputs: [{ name: 'request', type: 'string', mandatory: true, attributes: { schema: { maxLength: 99 } } }],
    outputs: [{ name: 'response', type: 'string', value: '{{step[synthetic].response}}' }],
    steps: [{ cid: 'synthetic', action: ID, step_type: 'SCRIPT', step_type_id: STEP, order: 1, unknownStepField: { keep: true },
      inputs: [{ name: 'script', type: 'script', value: 'old script', attributes: { retain: true } }],
      outputs: [], extended_inputs: [{ name: 'request', type: 'string', value: '{{inputs.request}}' }], extended_outputs: [] }],
  };
}
function fakeApp({ answers = {}, selected = {} } = {}) {
  const calls = [];
  const promptCalls = [];
  let saved = definition();
  let rendered = '';
  const sdk = new SDKClient('https://example.invalid', null);
  sdk.request = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    calls.push({ pathname, method: options.method, body });
    if (pathname === `/api/now/table/sys_scope/${SCOPE}`) return { result: { sys_id: SCOPE } };
    if (pathname === '/api/now/table/sys_hub_action_type_definition' && options.method === 'POST') return { result: { sys_id: ID } };
    if (pathname === `/api/now/table/sys_hub_action_type_definition/${ID}`) return { result: { sys_id: ID, sys_scope: SCOPE } };
    if (pathname.endsWith('/step_types')) return { result: [schema()] };
    if (pathname.endsWith('/step_instances')) return { result: { steps: saved.steps } };
    if (pathname.endsWith(`/action_types/${ID}`)) {
      if (options.method === 'PUT') { saved = structuredClone(body); return { result: saved }; }
      const { steps: _steps, ...metadata } = saved;
      return { result: metadata };
    }
    throw new Error(`Unexpected request ${options.method} ${pathname}`);
  };
  sdk.aggregateCount = async () => 1;
  sdk.list = async (table, params) => {
    calls.push({ table, method: 'LIST', query: params.get('sysparm_query') });
    if (table === 'sys_user') return [];
    if (table === 'sys_db_object') return [{ sys_id: STEP, name: 'incident' }];
    if (table === 'sys_scope') return [{ sys_id: { value: SCOPE, display_value: 'Do not use this name' }, name: 'Synthetic scope' }];
    if (table === 'sys_hub_flow') return [{ sys_id: ID, name: 'Synthetic flow', scope: SCOPE, active: false, status: 'draft' }];
    return [{ sys_id: ID, name: 'Synthetic action', sys_scope: SCOPE }];
  };
  const p = {};
  for (const method of ['input', 'select', 'confirm', 'editor']) p[method] = async config => {
    promptCalls.push({ method, config });
    if (config.message in answers) return typeof answers[config.message] === 'function' ? answers[config.message](config) : answers[config.message];
    if (method === 'confirm') return config.message.startsWith('Create ') || config.message.startsWith('Save ') || config.message.startsWith('Update ');
    if (method === 'select') {
      if (config.message in selected) return config.choices.find(choice => choice.value === selected[config.message]).value;
      return config.choices[0].value;
    }
    if (config.message === 'Script file path') return SCRIPT_FILE;
    return config.default ?? (config.message.endsWith('name') ? 'Synthetic name' : '');
  };
  const output = new OutputWriter({ format: 'auto', writer: { write(text) { rendered += text; } } });
  const app = { sdk, calls, promptCalls, output, flowDesignerPrompts: p,
    config: { active_profile: 'test', profiles: { test: { skip_confirmations: false } } },
    requireInstance() {}, getEffectiveInstance: () => sdk.baseURL,
    ok: (data, options) => output.ok(data, options), err: error => output.err(error),
    promptFn: async config => (await config.source('', 0))[0],
  };
  return { app, calls, promptCalls, saved: () => saved, rendered: () => rendered };
}
function commands(factory) {
  const definitions = [];
  factory(fn => fn).builder({ command(command) { definitions.push(command); return this; } });
  return new Map(definitions.map(command => [command.command.split(' ')[0], command]));
}
async function human(operation) {
  const markers = ['JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT', 'TERM'];
  const env = Object.fromEntries(markers.map(key => [key, process.env[key]]));
  const descriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  for (const key of markers) delete process.env[key];
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  try { return await operation(); }
  finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    [process.stdin, process.stdout].forEach((stream, index) => { if (descriptors[index]) Object.defineProperty(stream, 'isTTY', descriptors[index]); else delete stream.isTTY; });
  }
}

test('guided action create uses discovered schema, script file, fresh parent allocation, PUT and SDK readback', async () => human(async () => {
  const { app, calls, saved } = fakeApp();
  let confirmed = false;
  app.flowDesignerPrompts.confirm = async config => {
    assert.equal(calls.some(call => ['POST', 'PUT'].includes(call.method)), false, 'no allocation or save before final confirmation');
    if (config.message.startsWith('Create ')) { confirmed = true; return true; }
    return false;
  };
  await commands(actionsCmd).get('create').handler({ scope: SCOPE }, app);
  assert.equal(confirmed, true);
  assert.deepEqual(calls.filter(call => ['POST', 'PUT'].includes(call.method)).map(call => call.method), ['POST', 'PUT']);
  assert.equal(saved().steps[0].inputs.find(field => field.name === 'script').value, script);
  assert.deepEqual(saved().steps[0].customMetadata, schema().customMetadata);
  assert.deepEqual(saved().steps[0].outputs, schema().outputs);
  assert.equal(saved().steps[0].action, ID);
  assert.equal(saved().state, 'draft');
  assert.ok(calls.every(call => !/snapshot|\/test|versioning/.test(call.pathname || '')));
}));

test('action creation refusal, Ctrl+C, missing schema, incomplete schema and unsupported fields never allocate', async () => human(async () => {
  for (const failure of ['refuse', 'cancel', 'empty-schema', 'incomplete-schema', 'unsupported-type']) {
    const { app, calls } = fakeApp();
    if (failure === 'refuse') app.flowDesignerPrompts.confirm = async () => false;
    if (failure === 'cancel') app.flowDesignerPrompts.input = async () => { const error = new Error(); error.name = 'ExitPromptError'; throw error; };
    if (failure === 'empty-schema') app.sdk.getProcessFlowStepTypes = async () => ({});
    if (failure === 'incomplete-schema') app.sdk.getProcessFlowStepTypes = async () => [{ type: 'SCRIPT' }];
    if (failure === 'unsupported-type') app.sdk.getProcessFlowStepTypes = async () => [{ ...schema(), inputs: [{ name: 'secret', type: 'unsupported-provider-type' }] }];
    const run = () => commands(actionsCmd).get('create').handler({ scope: SCOPE }, app);
    if (['refuse', 'cancel'].includes(failure)) await run(); else await assert.rejects(run, error => error.code === 'usage_error');
    assert.equal(calls.some(call => ['POST', 'PUT'].includes(call.method)), false, failure);
  }
}));

test('guided action edit loads actual full definition and preserves unknown nested fields and lifecycle identities', async () => human(async () => {
  const { app, saved } = fakeApp({ selected: { 'Edit action': 'steps' } });
  app.flowDesignerPrompts.confirm = async config => config.message.includes('change script') || config.message.startsWith('Save ');
  await commands(actionsCmd).get('update').handler({ identifier: ID }, app);
  const expected = definition();
  expected.steps[0].inputs[0].value = script;
  assert.deepEqual(saved(), expected);
}));

test('action edit cancellation never sends PUT and does not mutate the read document', async () => human(async () => {
  const { app, calls } = fakeApp();
  const source = definition();
  app.flowDesignerPrompts.confirm = async () => false;
  assert.equal(await cancelled(() => guidedActionEdit({ identifier: ID }, app, source)), undefined);
  assert.deepEqual(source, definition());
  assert.ok(calls.every(call => call.method !== 'PUT'));
}));

test('schema prompts keep typed zero/false, raw pills, object fields, unknown siblings and wrapped values', async () => {
  const { app } = fakeApp({ answers: { 'count [integer] (raw pills accepted)': '0', 'flag [boolean]': false } });
  assert.equal(await promptSchemaValue(app, { name: 'count', type: 'integer' }), 0);
  assert.equal(await promptSchemaValue(app, { name: 'flag', type: 'boolean' }), false);
  app.flowDesignerPrompts.input = async config => config.default;
  assert.equal(await promptSchemaValue(app, { name: 'count', type: 'integer' }, '{{inputs.raw}}'), '{{inputs.raw}}');
  assert.equal(await promptSchemaValue(app, { name: 'obj', type: 'object', children: [{ name: 'text', type: 'string' }] }, '{{inputs.object}}'), '{{inputs.object}}');
  assert.deepEqual(await promptSchemaValue(app, { name: 'obj', type: 'object', children: [{ name: 'text', type: 'string' }] }, { text: 'hello', unknown: { keep: true } }), { text: 'hello', unknown: { keep: true } });
  assert.deepEqual(await promptSchemaValue(app, { name: 'obj', type: 'object', children: [{ name: 'value', type: 'string' }] }, { value: 'literal member', other: 'keep' }), { value: 'literal member', other: 'keep' });
  assert.equal(await promptSchemaValue(app, { name: 'flag', type: 'boolean' }, '{{inputs.bool}}'), '{{inputs.bool}}');
  await assert.rejects(promptSchemaValue(app, { name: 'secret', type: 'password2' }), /unsupported type password2/);
});

test('guided scope picker keeps raw ID and cancelled record selection returns no identifier', async () => human(async () => {
  const { app } = fakeApp();
  assert.equal(await designerScope({}, app), SCOPE);
  app.promptFn = async () => undefined;
  assert.equal(await pickDesignerRecord({}, app, 'sys_hub_flow', 'flow'), undefined);
  app.sdk.aggregateCount = async () => 0;
  await assert.rejects(pickDesignerRecord({}, app, 'sys_hub_flow', 'flow'), /No readable flow/);
}));

test('JSON, explicit data/file, pipes, CI and JSN_NO_PROMPTS fail fast without prompts or provider calls', async () => human(async () => {
  const { app, calls, promptCalls } = fakeApp();
  for (const argv of [{ data: '{}' }, { 'data-file': 'definition.json' }, { dataFile: 'definition.json' }, { 'output-map': '{}' }]) {
    assert.equal(interactiveDesigner(argv, app), false);
    await assert.rejects(pickDesignerRecord(argv, app, 'sys_hub_flow', 'flow'), error => error.code === 'usage_error');
  }
  app.output.getFormat = () => 'json';
  assert.equal(interactiveDesigner({}, app), false);
  await assert.rejects(guidedActionCreate({}, app), /noninteractive mode/);
  await assert.rejects(guidedFlowCreate({}, app), /noninteractive mode/);
  app.output.getFormat = () => 'auto';
  for (const [key, value] of [['CI', '1'], ['JSN_NO_PROMPTS', '1'], ['NONINTERACTIVE', 'true'], ['TERM', 'dumb']]) {
    process.env[key] = value;
    await assert.rejects(designerScope({}, app), /noninteractive mode/);
    delete process.env[key];
  }
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  await assert.rejects(pickDesignerRecord({}, app, 'sys_hub_flow', 'flow'), /noninteractive mode/);
  assert.equal(calls.length, 0);
  assert.equal(promptCalls.length, 0);
}));

test('interactive confirmation is explicit, cancellation is no-op and JSON never prompts even in a TTY', async () => human(async () => {
  const { app, promptCalls } = fakeApp();
  app.flowDesignerPrompts.confirm = async () => false;
  assert.equal(await cancelled(() => confirmDesignerMutation({}, app, 'Execute saved script?')), undefined);
  app.output.getFormat = () => 'json';
  await assert.rejects(confirmDesignerMutation({}, app, 'Execute saved script?'), error => error.code === 'confirmation_required');
  await confirmDesignerMutation({ force: true }, app, 'Execute saved script?');
  assert.equal(promptCalls.length, 0);
}));

function flowDefinition() {
  return { flowId: ID, scope: SCOPE,
    triggerInstances: [{ id: STEP, triggerType: 'record_create_or_update', unknown: { retain: true }, inputs: [{ name: 'table', value: { value: 'incident' } }, { name: 'condition', value: { value: 'active=true' } }] }],
    actionInstances: [{ actionTypeSysId: ID, order: '1', uiUniqueIdentifier: 'saved-ui-id', inputs: [{ name: 'request', type: 'string', value: { value: '{{trigger.current}}', untouched: true }, unknown: { keep: true } }] }],
  };
}
function flowReads(app) {
  const originalGet = app.sdk.get.bind(app.sdk);
  app.sdk.get = async (table, id) => table === 'sys_db_object' ? { sys_id: STEP, name: 'incident' } : originalGet(table, id);
  const request = app.sdk.request.bind(app.sdk);
  app.sdk.request = async (url, options) => {
    if (url.includes('/processflow/flow/')) return { result: { data: flowDefinition() } };
    if (url.includes('/trigger/record/table')) return { result: { label: 'Incident', displayField: 'number', fields: [] } };
    if (url.includes('/action_types/')) return { result: { inputs: [{ name: 'request', type: 'string', id: RECORD, parameter: { type: 'string' }, mandatory: true }] } };
    return request(url, options);
  };
}
test('guided flow creation builds validated existing manifest from table and published action schemas without writes', async () => human(async () => {
  const { app, calls } = fakeApp();
  flowReads(app);
  let add = true;
  app.flowDesignerPrompts.confirm = async config => {
    if (config.message === 'Add a published action?') { const answer = add; add = false; return answer; }
    return config.message.startsWith('Create ');
  };
  app.flowDesignerPrompts.input = async config => config.message.startsWith('Action input:') ? '{{trigger.current}}' : config.message === 'Flow name' ? 'Synthetic flow' : '';
  const manifest = await guidedFlowCreate({ scope: SCOPE }, app);
  assert.deepEqual(manifest, { name: 'Synthetic flow', description: '', scope: SCOPE, trigger: { type: 'record_create_or_update', table: 'incident', condition: '' }, actions: [{ type: ID, inputs: { request: '{{trigger.current}}' } }] });
  assert.ok(calls.some(call => call.table === 'sys_hub_action_type_definition' && call.query.includes('published=true')));
  assert.ok(calls.every(call => !['POST', 'PUT'].includes(call.method)));
}));

test('guided flow edit reads saved definition and builds only requested trigger or existing action input patch', async () => human(async () => {
  for (const choice of ['trigger', 'actions']) {
    const { app, calls } = fakeApp({ selected: { 'Edit supported draft flow fields': choice } });
    flowReads(app);
    app.flowDesignerPrompts.input = async () => choice === 'trigger' ? 'active=false' : '{{inputs.raw}}';
    const manifest = await guidedFlowEdit({ identifier: ID }, app);
    assert.deepEqual(manifest, choice === 'trigger' ? { trigger: { condition: 'active=false' } } : { actions: [{ order: 1, type: ID, inputs: { request: '{{inputs.raw}}' } }] });
    assert.deepEqual(flowDefinition().actionInstances[0].inputs[0].unknown, { keep: true });
    assert.ok(calls.every(call => !['POST', 'PUT'].includes(call.method)));
  }
}));

test('flow test record picker uses actual trigger table and never guesses a table or dispatches', async () => human(async () => {
  const { app, calls } = fakeApp();
  flowReads(app);
  const id = await guidedFlowTestRecord({ identifier: ID }, app);
  assert.equal(id, ID);
  assert.ok(calls.some(call => call.table === 'incident'));
  assert.ok(calls.every(call => !['POST', 'PUT'].includes(call.method)));
}));

test('every target command accepts omitted identifiers and rejects noninteractive omission before provider calls', async () => {
  const { app, calls } = fakeApp();
  app.output.getFormat = () => 'json';
  for (const [factory, names] of [[actionsCmd, ['show', 'definition', 'update', 'test', 'delete']], [flowsCmd, ['show', 'status', 'publish', 'update', 'test', 'delete']]]) {
    for (const name of names) {
      const command = commands(factory).get(name);
      assert.equal(command.command, `${name} [identifier]`);
      await assert.rejects(command.handler({}, app), error => error.code === 'usage_error', `${name} fail-fast`);
    }
  }
  assert.equal(calls.length, 0);
});

test('action wizard declares inputs, script outputs and output mappings using provider templates', async () => human(async () => {
  const { app, saved } = fakeApp();
  const counts = new Map();
  app.flowDesignerPrompts.confirm = async config => {
    if (['Add an action input?', 'Declare a script step output?', 'Map a step output to an action output?'].includes(config.message)) {
      const n = counts.get(config.message) || 0;
      counts.set(config.message, n + 1);
      return n === 0;
    }
    return config.message.endsWith(': required?') || config.message.startsWith('Create ');
  };
  const input = app.flowDesignerPrompts.input;
  app.flowDesignerPrompts.input = async config => config.message === 'Action input: variable name' ? 'request'
    : config.message === 'Script output: variable name' ? 'result' : config.message === 'Action output name' ? 'result' : input(config);
  const select = app.flowDesignerPrompts.select;
  app.flowDesignerPrompts.select = async config => config.message === 'Select output'
    ? config.choices.find(choice => choice.value.field.name === 'result').value : select(config);
  await commands(actionsCmd).get('create').handler({ scope: SCOPE }, app);
  const document = saved();
  assert.equal(document.inputs[0].name, 'request');
  assert.equal(document.inputs[0].mandatory, true);
  assert.deepEqual(document.inputs[0].attributes, schema().outputs[0].attributes);
  assert.equal(document.steps[0].extended_inputs[0].value, '{{inputs.request}}');
  assert.equal(document.steps[0].extended_inputs[0].extended, true);
  assert.notEqual(document.inputs[0].id, document.steps[0].extended_inputs[0].id);
  assert.equal(document.steps[0].extended_outputs[0].name, 'result');
  assert.equal(document.steps[0].extended_outputs[0].extended, true);
  assert.equal(document.outputs[0].value, `{{step[${document.steps[0].cid}].result}}`);
  assert.equal(document.outputs[0].extended, false);
}));

test('every target picker cancellation returns without any mutation or fallback selection', async () => human(async () => {
  for (const [factory, names] of [[actionsCmd, ['show', 'definition', 'update', 'test', 'delete']], [flowsCmd, ['show', 'status', 'publish', 'update', 'test', 'delete']]]) {
    for (const name of names) {
      const { app, calls } = fakeApp();
      app.promptFn = async () => undefined;
      await commands(factory).get(name).handler({}, app);
      assert.equal(calls.length, 0, `${name} must not resolve or mutate after cancellation`);
    }
  }
}));

test('action test prompts required inputs from the saved definition and confirms before dispatch', async () => human(async () => {
  for (const consent of [false, true]) {
    const { app, promptCalls } = fakeApp({ answers: { 'Test input: request [string] (raw pills accepted)': 'actual input' } });
    let dispatch;
    app.sdk.testProcessFlowAction = async (...args) => { dispatch = args; return { status: 'complete', context: RECORD, outputs: {} }; };
    app.flowDesignerPrompts.confirm = async () => consent;
    await commands(actionsCmd).get('test').handler({ identifier: ID, wait: true, timeout: 5 }, app);
    assert.ok(promptCalls.some(call => call.config.message.startsWith('Test input: request')));
    if (consent) {
      assert.deepEqual(dispatch.slice(0, 4), [ID, undefined, definition(), { request: 'actual input' }]);
      assert.equal(dispatch[4].wait, true);
    } else assert.equal(dispatch, undefined);
  }
}));

test('guided action input defaults and wrapped step values preserve unspecified schema fields', async () => human(async () => {
  const source = definition();
  source.inputs[0].defaultValue = 'old default';
  const { app } = fakeApp({ selected: { 'Edit action': 'inputs' } });
  app.flowDesignerPrompts.confirm = async () => true;
  app.flowDesignerPrompts.input = async () => 'new default';
  const edited = await guidedActionEdit({ identifier: ID }, app, source);
  assert.equal(edited.inputs[0].defaultValue, 'new default');
  assert.deepEqual(edited.inputs[0].attributes, source.inputs[0].attributes);
  assert.equal(source.inputs[0].defaultValue, 'old default');
  source.steps[0].inputs[0] = { name: 'raw', type: 'string', value: { value: 'before', unknown: { keep: true } } };
  app.flowDesignerPrompts.select = async config => config.message === 'Edit action' ? 'steps' : config.choices[0].value;
  const wrapped = await guidedActionEdit({ identifier: ID }, app, source);
  assert.deepEqual(wrapped.steps[0].inputs[0].value, { value: 'new default', unknown: { keep: true } });
}));

test('active scope preference is offered by raw ID and validated without selecting a guessed scope name', async () => human(async () => {
  const { app } = fakeApp();
  app.sdk.list = async table => table === 'sys_user' ? [{ sys_id: ID, name: 'Fake user' }]
    : table === 'sys_user_preference' ? [{ value: SCOPE }] : [];
  app.flowDesignerPrompts.confirm = async config => { assert.ok(config.message.includes(SCOPE)); return true; };
  app.promptFn = async () => { throw new Error('Active scope should not open a picker'); };
  assert.equal(await designerScope({}, app), SCOPE);
}));

test('guided flow refuses guessed input types and can load an actual type when saved inputs omit it', async () => human(async () => {
  const { app } = fakeApp({ selected: { 'Edit supported draft flow fields': 'actions' } });
  flowReads(app);
  const request = app.sdk.request;
  app.sdk.request = async (url, options) => {
    if (url.includes('/processflow/flow/')) {
      const data = flowDefinition();
      delete data.actionInstances[0].inputs[0].type;
      return { result: { data } };
    }
    return request(url, options);
  };
  app.flowDesignerPrompts.input = async () => '{{trigger.raw}}';
  assert.deepEqual(await guidedFlowEdit({ identifier: ID }, app), { actions: [{ order: 1, type: ID, inputs: { request: '{{trigger.raw}}' } }] });
  app.sdk.request = async (url, options) => url.includes('/action_types/') ? { result: { inputs: [{ name: 'request', id: RECORD, parameter: {} }] } } : request(url, options);
  await assert.rejects(guidedFlowCreate({ scope: SCOPE }, { ...app, flowDesignerPrompts: { ...app.flowDesignerPrompts, confirm: async () => true } }), /no provider type/);
}));

test('schema discovery never accepts missing arrays or fabricated templates', () => {
  for (const result of [{}, { step_types: [] }, null]) assert.throws(() => stepTypeSchemas(result), /no supported/);
});
