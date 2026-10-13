import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TRIGGER_DEFINITION = 'a45d9180c32222002841b63b12d3aea7';
const FLOW_ID = '4748b85793ff87d087b0f14fdd03d6bd';
const TRIGGER_ID = 'fa58fc5793ff87d087b0f14fdd03d699';
const ACTION_ID = '0e0ae8c2531003003bf1d9109ec587c8';

const manifest = {
  name: 'JSN-STUDY-test',
  description: 'Study flow',
  scope: '1169a246933f8f9087b0f14fdd03d627',
  trigger: {
    type: 'record_create_or_update',
    table: 'ticket',
    condition: 'short_descriptionSTARTSWITHjacetest',
  },
  actions: [{ type: 'Log', inputs: { log_level: 'info', log_message: 'hello "flow"\nnext' } }],
};

// Declared inputs exactly as sys_hub_trigger_input reports them for
// "Created or Updated": element + raw internal_type + defaults.
const DECLARED_INPUTS = [
  { sys_id: 'cf1e1980c32222002841b63b12d3aea0', element: 'table', label: 'Table', internal_type: 'table_name', mandatory: 'true', order: '1', max_length: '80', default_value: '', attributes: 'filter_table_source=RECORD_WATCHER_RESTRICTED', choice: '' },
  { sys_id: '1c4203b6072200103bf10705afd300b8', element: 'run_on_extended', label: 'Run On Extended Tables', internal_type: 'choice', mandatory: 'false', order: '100', max_length: '40', default_value: 'false', attributes: 'advanced=true', choice: '3' },
  { sys_id: '231e76460f103300b599bca2ff767e11', element: 'run_flow_in', label: 'Run flow In', internal_type: 'choice', mandatory: 'false', order: '100', max_length: '40', default_value: 'any', attributes: 'advanced=true', choice: '3' },
  { sys_id: '707dd180c32222002841b63b12d3aecb', element: 'condition', label: 'Condition', internal_type: 'conditions', mandatory: 'false', order: '100', max_length: '4000', default_value: '', attributes: 'modelDependent=trigger_inputs', choice: '' },
];

const actionSchema = [
  { id: 'i1', name: 'log_level', type: 'choice', defaultValue: 'info', choices: ['info', 'warn', 'error'], mandatory: false },
  { id: 'i2', name: 'log_message', type: 'string', mandatory: true },
];

function displayListMap() {
  return {
    sys_hub_trigger_definition: [{
      sys_id: { value: TRIGGER_DEFINITION, display_value: TRIGGER_DEFINITION },
      name: { value: 'Created or Updated', display_value: 'Created or Updated' },
      type: { value: 'record_create_or_update', display_value: 'record_create_or_update' },
      category: { value: '8886dd64c3d322002841b63b12d3aed4', display_value: 'Record' },
    }],
    sys_hub_trigger_input: DECLARED_INPUTS.map(row => {
      const out = {};
      for (const [key, value] of Object.entries(row)) out[key] = { value, display_value: key === 'internal_type' ? value : value };
      return out;
    }),
    sys_db_object: [{ name: { value: 'ticket', display_value: 'ticket' }, label: { value: 'Ticket', display_value: 'Ticket' }, super_class: { value: '1521b6f78c5103100a22deb6dd2b4e61', display_value: 'Task' } }],
    sys_dictionary: [{ element: { value: 'number', display_value: 'number' } }],
    sys_hub_action_type_definition: [{ sys_id: { value: ACTION_ID }, name: { value: 'Log', display_value: 'Log' }, active: { value: 'true' } }],
  };
}

function makeSdk(overrides = {}) {
  const calls = [];
  const tables = displayListMap();
  const state = { flowReads: 0, versionReads: 0 };
  const sdk = {
    calls,
    state,
    async list(table, params) {
      calls.push({ kind: 'list', table, params: String(params) });
      if (table === 'sys_hub_flow') return [];
      if (table === 'sys_hub_flow_version') return state.versionReads++ === 0 ? [] : [{ sys_id: 'version-1', flow: FLOW_ID, type: 'Autosave', payload: JSON.stringify({ flowId: FLOW_ID }) }];
      if (table === 'sys_update_xml') return [{ sys_id: 'xml-1', payload: FLOW_ID }];
      return tables[table] || [];
    },
    async request(endpoint, options = {}) {
      calls.push({ kind: 'request', endpoint, options });
      if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { data: { id: FLOW_ID } } };
      if (options.method === 'GET' && endpoint.includes(`/processflow/flow/${FLOW_ID}?`)) {
        state.flowReads += 1;
        return { result: { data: overrides.readback || createdDefinition() } };
      }
      if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: actionSchema } };
      if (endpoint === 'https://example.service-now.com/api/now/graphql') {
        if (overrides.graphql) return overrides.graphql;
        return { data: { global: { snFlowDesigner: { flow: {
          triggerInstances: { inserts: [{ sysId: TRIGGER_ID }], updates: [] },
          actions: { inserts: [{ sysId: 'action-123', uiUniqueIdentifier: 'generated-1' }] },
        } } } } };
      }
      if (options.method === 'POST' && endpoint.includes('/versioning/create_version?')) return { result: { sys_id: 'version-1', type: 'Autosave' } };
      throw new Error(`unexpected request ${endpoint}`);
    },
  };
  return sdk;
}

function wrapped(value) {
  return { schemaless: false, schemalessValue: '', value };
}

function createdDefinition() {
  return {
    flowId: FLOW_ID,
    triggerInstances: [{
      id: TRIGGER_ID,
      type: 'record_create_or_update',
      triggerType: 'Record',
      triggerDefinitionId: TRIGGER_DEFINITION,
      // Shape the instance actually stores: `term` is the whole encoded
      // condition and `value` is the extracted term.
      metadata: JSON.stringify({ query_parse: { predicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', term: 'short_descriptionSTARTSWITHjacetest', value: 'jacetest' }] } }),
      inputs: [
        { name: 'table', value: wrapped('ticket') },
        { name: 'condition', value: wrapped('short_descriptionSTARTSWITHjacetest') },
        { name: 'run_on_extended', value: wrapped('false') },
        { name: 'run_flow_in', value: wrapped('any') },
      ],
    }],
    actionInstances: [{
      id: 'action-123', uiUniqueIdentifier: 'generated-1', actionTypeSysId: ACTION_ID, order: '1',
      inputs: [
        { name: 'log_level', value: wrapped('info') },
        { name: 'log_message', value: wrapped(manifest.actions[0].inputs.log_message) },
      ],
    }],
  };
}

const options = {
  readUpdateSet: async () => ({ name: 'Default', sys_id: 'update-set-1' }),
  idFactory: (() => { let n = 0; return () => `generated-${++n}`; })(),
};

describe('flow creation manifest', () => {
  it('accepts the record trigger and schema-driven action shape', async () => {
    const { validateFlowManifest } = await import('../src/flow-create.js');
    assert.deepEqual(validateFlowManifest(manifest), manifest);
  });

  it('rejects unsupported flow features, triggers, and malformed actions', async () => {
    const { validateFlowManifest } = await import('../src/flow-create.js');
    assert.throws(() => validateFlowManifest({ ...manifest, scope: undefined }), /requires scope/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, type: 'scheduled' } }), /unsupported trigger\.type/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, type: 'analytics' } }), /unsupported trigger\.type/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, condition: 'short_descriptionSTARTSWITHJSN^ORactive=true' } }), /condition.*subset|unsupported.*condition/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, table: '  ' } }), /table must not be empty/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, inputs: [] } }), /inputs must be an object/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, unexpected: 1 } }), /trigger field "unexpected" is unsupported/i);
    assert.throws(() => validateFlowManifest({ ...manifest, logic: [] }), /Flow Logic.*unsupported/i);
    assert.throws(() => validateFlowManifest({ ...manifest, actions: [{ type: 'Log', inputs: 'bad' }] }), /inputs.*object/i);
  });
});

describe('flow creation request shapes', () => {
  it('registers flows create with inline and file manifest inputs', async () => {
    const { flowsCmd } = await import('../src/commands/flows.js');
    const commands = [];
    const root = flowsCmd((handler) => handler);
    root.builder({ command(definition) { commands.push(definition); return this; } });
    const create = commands.find(command => command.command === 'create');
    assert.ok(create);
    const options2 = [];
    create.builder({ option(name) { options2.push(name); return this; } });
    assert.deepEqual(options2, ['data', 'data-file', 'scope']);
  });

  it('inserts the trigger and escapes GraphQL strings for actions', async () => {
    const { buildFlowPatchMutation } = await import('../src/flow-create.js');
    const mutation = buildFlowPatchMutation({
      flowId: 'flow-123',
      trigger: {
        flowSysId: 'flow-123', name: 'Created or Updated', type: 'record_create_or_update',
        triggerType: 'Record', triggerDefinitionId: TRIGGER_DEFINITION, metadata: '{}',
        inputs: [{ name: 'table', displayField: 'number', displayValue: wrapped('Ticket'), value: wrapped('ticket') }],
      },
      actions: [{ actionTypeSysId: 'action-type-123', flowSysId: 'flow-123', generationSource: '', type: 'action', order: '1', parent: '', parentUiId: '', uiUniqueIdentifier: 'action-ui-123', metadata: '{}', inputs: [{ name: 'log_message', type: 'string', parameter: { name: 'log_message', type: 'string' }, value: wrapped('hello "flow"\nnext'), displayValue: wrapped('hello "flow"\nnext') }] }],
    });
    assert.match(mutation, /mutation/);
    assert.match(mutation, /flowId: "flow-123"/);
    // The trigger is INSERTED, never patched onto a trigger that does not exist.
    assert.match(mutation, /triggerInstances: \{insert:/);
    assert.doesNotMatch(mutation, /triggerInstances: \{update:/);
    assert.match(mutation, /actions: \{insert:/);
    assert.match(mutation, /triggerDefinitionId: "a45d9180c32222002841b63b12d3aea7"/);
    assert.match(mutation, /actionTypeSysId: "action-type-123"/);
    assert.match(mutation, /order: "1"/);
    assert.match(mutation, /hello \\"flow\\"\\nnext/);
    assert.doesNotMatch(mutation, /jace-test-flow|c215135293bf03d087b0f14fdd03d652/);
  });

  it('creates, inserts the trigger, patches actions, versions, and verifies without activation', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makeSdk();
    const result = await createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, options);

    assert.equal(result.flow.id, FLOW_ID);
    assert.equal(result.flow.active, false);
    assert.equal(result.flow.status, 'draft');
    assert.equal(result.trigger.id, TRIGGER_ID);
    assert.equal(result.trigger.triggerDefinitionId, TRIGGER_DEFINITION);
    assert.equal(result.trigger.type, 'record_create_or_update');
    assert.deepEqual(result.actions, [{ sysId: 'action-123', uiUniqueIdentifier: 'generated-1' }]);
    assert.deepEqual(result.definition_readback, { available: true, status: 'read_back', flow_id: FLOW_ID });
    assert.equal(result.version.type, 'Autosave');
    assert.deepEqual(result.update_set_mutations.map(snapshot => snapshot.label), ['parent_create', 'trigger_and_actions_patch', 'autosave_version']);
    // Update-set capture covers the parent POST, the trigger/action patch and the Autosave.
    assert.equal(result.update_set_capture.available, true);
    assert.equal(result.update_set_capture.status, 'captured');
    assert.ok(result.update_set_mutations.every(snapshot => snapshot.capture_after?.status === 'captured'));
    // Every read and write carries the flow's transaction scope.
    assert.ok(sdk.calls.some(call => call.kind === 'request' && call.options.method === 'GET' && call.endpoint.includes(`/processflow/flow/${FLOW_ID}?sysparm_transaction_scope=${manifest.scope}`)));
    assert.ok(sdk.calls.some(call => call.kind === 'request' && call.endpoint.includes(`/versioning/create_version?sysparm_transaction_scope=${manifest.scope}`)));

    // The parent POST body is unchanged and carries no trigger.
    const parentCall = sdk.calls.find(call => call.kind === 'request' && call.endpoint.includes('/processflow/flow?'));
    assert.deepEqual(JSON.parse(parentCall.options.body), {
      name: 'JSN-STUDY-test', description: 'Study flow', type: 'flow', status: 'draft', active: false,
      scope: manifest.scope, runAs: 'user', flowPriority: 'MEDIUM', access: 'public', protection: '',
      runWithRoles: { value: '', displayValue: '' }, deleted: false, security: { can_read: true, can_write: true },
    });

    // The declared inputs come from the instance, not from a hardcoded list.
    const inputCall = sdk.calls.find(call => call.kind === 'list' && call.table === 'sys_hub_trigger_input');
    assert.ok(inputCall, 'declared trigger inputs must be read from the instance');
    assert.equal(decodeURIComponent(inputCall.params).includes(`sysparm_query=name=var__m_sys_hub_trigger_input_${TRIGGER_DEFINITION}`), true);
    const patch = JSON.parse(sdk.calls.find(call => call.kind === 'request' && call.endpoint.endsWith('/graphql')).options.body).query;
    assert.match(patch, /triggerInstances: \{insert:/);
    assert.match(patch, /name: "table"/);
    assert.match(patch, /value: "ticket"/);
    assert.match(patch, /displayField: "number"/);
    assert.match(patch, /displayValue: \{schemaless: false, schemalessValue: "", value: "Ticket"\}/);
    assert.match(patch, /name: "condition"/);
    assert.match(patch, /value: "short_descriptionSTARTSWITHjacetest"/);
    // Instance defaults are written too, exactly as Flow Designer stores them.
    assert.match(patch, /name: "run_on_extended"/);
    assert.match(patch, /name: "run_flow_in"/);
    assert.match(patch, /value: "any"/);
    assert.match(patch, /parameter: \{id: "cf1e1980c32222002841b63b12d3aea0"/);
    assert.match(patch, /log_message/);
    assert.doesNotMatch(patch, /default: /);
    assert.match(patch, /triggerType: "Record"/);
    assert.equal(sdk.calls.filter(call => call.kind === 'request' && call.options.method === 'POST').length, 3);
  });

  it('refuses to report creation success when the trigger or saved actions are missing', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    const missingTrigger = createdDefinition();
    missingTrigger.triggerInstances = [];
    await assert.rejects(createFlowFromManifest(makeSdk({ readback: missingTrigger }), 'https://example.service-now.com', manifest, options), /0 trigger instances; expected one/i);

    const wrongDefinition = createdDefinition();
    wrongDefinition.triggerInstances[0].triggerDefinitionId = 'f'.repeat(32);
    await assert.rejects(createFlowFromManifest(makeSdk({ readback: wrongDefinition }), 'https://example.service-now.com', manifest, options), /trigger definition did not match/i);

    const wrongValue = createdDefinition();
    wrongValue.triggerInstances[0].inputs[0].value = wrapped('incident');
    await assert.rejects(createFlowFromManifest(makeSdk({ readback: wrongValue }), 'https://example.service-now.com', manifest, options), /trigger table did not match the requested value/i);

    const wrongMetadata = createdDefinition();
    wrongMetadata.triggerInstances[0].metadata = JSON.stringify({ query_parse: { predicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', value: 'somethingelse' }] } });
    await assert.rejects(createFlowFromManifest(makeSdk({ readback: wrongMetadata }), 'https://example.service-now.com', manifest, options), /predicate metadata did not match/i);

    const missingAction = createdDefinition();
    missingAction.actionInstances = [];
    await assert.rejects(createFlowFromManifest(makeSdk({ readback: missingAction }), 'https://example.service-now.com', manifest, options), /Actions; expected 1/i);
  });

  it('names the orphan draft flow and does not retry after a partial trigger/action patch', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    let patchAttempts = 0;
    const sdk = makeSdk({ get graphql() { patchAttempts += 1; throw new Error('GraphQL transport timeout'); } });
    const error = await assert.rejects(createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, options), error => {
      assert.match(error.message, /left orphan draft flow/i);
      assert.ok(error.message.includes(FLOW_ID), 'orphan sys_id must be named');
      assert.match(error.message, /reconciliation/i);
      return true;
    });
    assert.equal(patchAttempts, 1);
    assert.ok(error === undefined);
  });

  it('rejects an unknown trigger type before any write', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makeSdk();
    await assert.rejects(createFlowFromManifest(sdk, 'https://example.service-now.com', { ...manifest, trigger: { type: 'rest', table: 'ticket' } }, options), /unsupported trigger\.type/i);
    assert.equal(sdk.calls.filter(call => call.kind === 'request').length, 0);
  });
});

describe('flow update request shapes', () => {
  const flowId = 'flow-update-123';
  const actionId = 'action-update-123';
  const triggerId = 'trigger-update-123';
  // Provider trigger inputs EXACTLY as the live ProcessFlow read-back returns
  // them: `value`/`displayValue` are BARE scalars and `parameter.attributes` is
  // an object (an empty attribute map arrives as {"": ""}). The mutation input
  // type only accepts the wrapped FlowDesign shape, so echoing this verbatim
  // produced WrongType on `inputs[0].value`; the serializer under test must turn
  // each CHANGED input into the accepted shape instead.
  const providerInput = (name, value, extra = {}) => ({
    name,
    value,
    displayValue: value,
    parameter: { id: `${name}-param`, name, type: 'choice', label: name, order: 100, mandatory: false, attributes: { '': '' }, reference: '', ref_qual: '', defaultValue: '' },
    displayField: '',
    scriptActive: false,
    label: name,
    internalType: 'choice',
    fromTemplate: false,
    order: 100,
    valueSysId: '',
    mandatory: false,
    ...extra,
  });
  const baseDefinition = {
    flowId,
    triggerInstances: [{ sysId: triggerId, type: 'record_create_or_update', triggerType: 'Record', metadata: '{"query_parse":{"predicates": [], "order_by": ["short_description"], "group_by": [], "has_rlq_conditions": false, "custom": "preserve"}}', inputs: [
      providerInput('table', 'ticket', { displayField: 'number', displayValue: 'Ticket', parameter: { id: 'table-input', name: 'table', type: 'table_name', order: 1, mandatory: true, attributes: { filter_table_source: 'RECORD_WATCHER_RESTRICTED' } } }),
      providerInput('condition', 'short_descriptionSTARTSWITHold-', { parameter: { id: 'condition-input', name: 'condition', type: 'conditions', order: 100, mandatory: false, attributes: { modelDependent: 'trigger_inputs' }, defaultValue: '' } }),
      providerInput('trigger_strategy', 'once', { parameter: { id: 'strategy-input', name: 'trigger_strategy', type: 'choice', order: 200, mandatory: false, defaultValue: 'once' } }),
      providerInput('run_on_extended', 'false'),
      providerInput('run_flow_in', 'any'),
    ], extraTriggerField: 'preserve' }],
    actionInstances: [{ id: actionId, uiUniqueIdentifier: 'action-ui-123', actionTypeSysId: 'action-type-123', actionType: { sys_id: 'action-type-123', name: 'Log' }, order: '1', metadata: '{"keep":true}', inputs: [
      { id: 'input-1', name: 'log_level', parameter: { name: 'log_level', type: 'choice', keep: true }, children: ['child-1'], value: wrapped('info'), displayValue: wrapped('info') },
      { id: 'input-2', name: 'log_message', parameter: { name: 'log_message', type: 'string', keep: true }, children: ['child-2'], value: wrapped('old message'), displayValue: wrapped('old message') },
    ] }],
  };

  function updateSdk(afterDefinition, baseDefinitionForRead = baseDefinition, flowRecord = { sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }) {
    const calls = [];
    const listCalls = [];
    let versionReads = 0;
    return {
      calls,
      listCalls,
      async list(table, params) {
        listCalls.push({ table, fields: params?.get('sysparm_fields'), displayValue: params?.get('sysparm_display_value') });
        if (table === 'sys_hub_flow') return [flowRecord];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        if (table === 'sys_hub_flow_version') return versionReads++ === 0 ? [] : [{ sys_id: 'version-update-1', type: 'Autosave', flow: flowId }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-update-1', payload: flowId }];
        if (table === 'sys_db_object') return [{ name: { value: 'ticket' }, label: { value: 'Ticket' }, super_class: { value: '' } }];
        if (table === 'sys_dictionary') return [];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ endpoint, options });
        if (options.method === 'GET') return { result: { data: calls.some(call => call.options?.method === 'POST') ? afterDefinition : baseDefinitionForRead } };
        if (endpoint.includes('/versioning/create_version')) return { result: { sys_id: 'version-update-1' } };
        return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [triggerId] }, actions: { updates: [actionId] } } } } } };
      },
    };
  }

  it('updates only requested trigger/action values, preserves omitted fields, versions, and captures', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({
      ...JSON.parse(baseDefinition.triggerInstances[0].metadata),
      query_parse: { order_by: ['short_description'], group_by: [], has_rlq_conditions: false, custom: 'preserve', predicates: [{ compound_type: 'or', subpredicates: [{ field: 'short_description', operator: 'STARTSWITH', value: 'new-', term: 'short_descriptionSTARTSWITHnew-', type: 'comparison' }] }] },
    });
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], displayField: 'short_description', displayValue: 'short_descriptionSTARTSWITHnew-', value: 'short_descriptionSTARTSWITHnew-' };
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: wrapped('new message'), displayValue: wrapped('new message') };
    const sdk = updateSdk(afterDefinition);
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      trigger: { condition: 'short_descriptionSTARTSWITHnew-' },
      actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new message' } }],
    }, { readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }) });

    assert.equal(result.flow.id, flowId);
    assert.deepEqual(result.update_set_mutations.map(snapshot => snapshot.label), ['trigger_and_actions_update', 'autosave_version']);
    assert.equal(result.version.type, 'Autosave');
    assert.ok(result.update_set_mutations.every(snapshot => snapshot.capture_after.status === 'captured'));
    // The read and the Autosave both carry the flow's transaction scope.
    assert.ok(sdk.calls.some(call => call.options.method === 'GET' && call.endpoint.includes(`/processflow/flow/${flowId}?sysparm_transaction_scope=scope-1`)));
    assert.ok(sdk.calls.some(call => call.endpoint.includes('/versioning/create_version?sysparm_transaction_scope=scope-1')));
    const patch = sdk.calls.find(call => call.endpoint.endsWith('/graphql'));
    const query = JSON.parse(patch.options.body).query;
    assert.match(query, /triggerInstances: \{update:/);
    assert.match(query, /actions: \{update:/);
    // The mutation selects only the leaves this schema exposes.
    assert.match(query, /triggerInstances \{ updates \}/);
    assert.match(query, /actions \{ updates \}/);
    assert.doesNotMatch(query, /updates \{/);
    // Predicate metadata is re-derived by the instance, so the CLI sends {}.
    assert.match(query, /metadata: "\{\}"/);
    assert.doesNotMatch(query, /predicates/);
    // ONLY the changed trigger input is sent, in the shape the update input type
    // validates: the provider's bare scalar is serialized into the wrapped
    // FlowDesign value, and `parameter` is narrowed with attributes as a string.
    assert.match(query, /name: "condition"/);
    assert.match(query, /value: \{schemaless: false, schemalessValue: "", value: "short_descriptionSTARTSWITHnew-"\}/);
    assert.match(query, /displayValue: \{schemaless: false, schemalessValue: "", value: "short_descriptionSTARTSWITHnew-"\}/);
    assert.match(query, /attributes: "modelDependent=trigger_inputs"/);
    assert.doesNotMatch(query, /attributes: \{/);
    assert.doesNotMatch(query, /name: "table"/);
    // Omitted trigger inputs are never re-sent, so the instance cannot rewrite them.
    assert.doesNotMatch(query, /trigger_strategy/);
    assert.doesNotMatch(query, /run_on_extended/);
    assert.doesNotMatch(query, /run_flow_in/);
    assert.doesNotMatch(query, /uiDisplayTypeLabel/);
    assert.match(query, /uiUniqueIdentifier: "action-ui-123"/);
    assert.match(query, /new message/);
    // Action updates are name+value only; the trigger input carries its own
    // provider parameter block, never the action shape.
    assert.doesNotMatch(query, /actions: \{update: \[\{[^\]]*parameter:/);
    assert.doesNotMatch(query, /actions: \{insert:/);
  });

  it('refuses a readback whose predicate metadata does not match the requested condition', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], value: 'short_descriptionSTARTSWITHnew-', displayValue: 'short_descriptionSTARTSWITHnew-' };
    // Condition moved but the instance kept the OLD derived predicate: the
    // instance re-derives predicate metadata from the condition input, so this
    // must never pass as success.
    const sdk = updateSdk(afterDefinition);
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { condition: 'short_descriptionSTARTSWITHnew-' } }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
    }), /predicate metadata did not match/i);
    assert.ok(sdk.calls.every(call => !call.endpoint.includes('/versioning/')), 'no Autosave version after a failed readback');
  });

  it('sends only the changed table input and proves the omitted condition and metadata survive', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].inputs[0] = {
      ...afterDefinition.triggerInstances[0].inputs[0],
      displayField: 'number',
      displayValue: 'Task',
      value: 'task',
    };
    const beforeMetadata = baseDefinition.triggerInstances[0].metadata;
    const beforeCondition = JSON.stringify(baseDefinition.triggerInstances[0].inputs[1]);
    const sdk = updateSdk(afterDefinition);
    await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { table: 'task' } }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
      readTableDescriptor: async () => ({ table: 'task', label: 'Task', displayField: 'number' }),
    });
    const patch = sdk.calls.find(call => call.endpoint.endsWith('/graphql'));
    const query = JSON.parse(patch.options.body).query;
    assert.match(query, /name: "table"/);
    assert.match(query, /value: \{schemaless: false, schemalessValue: "", value: "task"\}/);
    assert.match(query, /displayValue: \{schemaless: false, schemalessValue: "", value: "Task"\}/);
    assert.match(query, /attributes: "filter_table_source=RECORD_WATCHER_RESTRICTED"/);
    // The condition is not re-sent at all, so a table-only change cannot rewrite it.
    assert.doesNotMatch(query, /name: "condition"/);
    assert.doesNotMatch(query, /short_descriptionSTARTSWITHold-/);
    assert.doesNotMatch(query, /trigger_strategy/);
    // The stored metadata is a real value, not schema display: it still travels.
    assert.match(query, /custom/);
    assert.ok(query.includes(`metadata: ${JSON.stringify(beforeMetadata)}`));
    assert.equal(JSON.stringify(afterDefinition.triggerInstances[0].inputs[1]), beforeCondition);
    assert.equal(afterDefinition.triggerInstances[0].metadata, beforeMetadata);
  });

  it('refuses a readback that really changed an omitted trigger input and writes no version', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], value: 'short_descriptionSTARTSWITHnew-', displayValue: 'short_descriptionSTARTSWITHnew-' };
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({
      ...JSON.parse(baseDefinition.triggerInstances[0].metadata),
      query_parse: { order_by: ['short_description'], group_by: [], has_rlq_conditions: false, custom: 'preserve', predicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', value: 'new-', term: 'short_descriptionSTARTSWITHnew-' }] },
    });
    // The instance rewrote trigger_strategy, an input the manifest never asked
    // to change. Representation tolerance must never hide a real value change.
    afterDefinition.triggerInstances[0].inputs[2] = { ...afterDefinition.triggerInstances[0].inputs[2], value: 'always', displayValue: 'always' };
    const sdk = updateSdk(afterDefinition);
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { condition: 'short_descriptionSTARTSWITHnew-' } }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
    }), /changed omitted input trigger_strategy/);
    assert.ok(sdk.calls.every(call => !call.endpoint.includes('/versioning/')), 'no Autosave version after a failed readback');
  });

  it('tolerates a re-represented omitted input while still comparing its meaning', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], value: 'short_descriptionSTARTSWITHnew-', displayValue: 'short_descriptionSTARTSWITHnew-' };
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({
      ...JSON.parse(baseDefinition.triggerInstances[0].metadata),
      query_parse: { order_by: ['short_description'], group_by: [], has_rlq_conditions: false, custom: 'preserve', predicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', value: 'new-', term: 'short_descriptionSTARTSWITHnew-' }] },
    });
    // Same stored meaning, different representation: the instance handed the
    // input back as a wrapped value and a stringified (empty) attribute map.
    afterDefinition.triggerInstances[0].inputs[2] = {
      ...afterDefinition.triggerInstances[0].inputs[2],
      value: wrapped('once'),
      displayValue: wrapped('once'),
      parameter: { ...afterDefinition.triggerInstances[0].inputs[2].parameter, attributes: '=' },
    };
    const sdk = updateSdk(afterDefinition);
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { condition: 'short_descriptionSTARTSWITHnew-' } }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
    });
    assert.equal(result.version.type, 'Autosave');
  });

  it('rejects unsafe flow-name query characters before lookup', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    let lookups = 0;
    const sdk = {
      async list() { lookups += 1; return []; },
      async request() { throw new Error('must not request'); },
    };
    for (const identifier of ['Flow*', 'Flow^name', 'Flow=name', 'Flow,name', 'Flow!', 'Flow<', 'Flow>', 'Flow~', 'Flow\\name']) {
      await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', identifier, {
        actions: [{ order: 1, type: 'Log', inputs: { log_message: 'x' } }],
      }), /unsafe identifier.*(wildcard|query characters)/i);
    }
    assert.equal(lookups, 0);
  });

  it('rejects unsupported fields, ambiguous actions, and protected targets before mutation', async () => {
    const { validateFlowUpdateManifest, updateFlowFromManifest } = await import('../src/flow-create.js');
    assert.throws(() => validateFlowUpdateManifest({ logic: [] }), /unsupported/i);
    assert.throws(() => validateFlowUpdateManifest({ actions: [{ inputs: { x: 'y' } }] }), /order and type/i);
    assert.throws(() => validateFlowUpdateManifest({ actions: [{ order: 1, type: 'Log', uiUniqueIdentifier: 'caller-id', inputs: { x: 'y' } }] }), /unsupported.*field|caller-supplied identities/i);
    const ambiguousDefinition = structuredClone(baseDefinition);
    ambiguousDefinition.actionInstances.push(structuredClone(baseDefinition.actionInstances[0]));
    const ambiguousSdk = makeSdk();
    ambiguousSdk.list = async (table) => {
      if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
      if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
      return [];
    };
    ambiguousSdk.request = async (_endpoint, options = {}) => {
      if (options.method === 'GET') return { result: { data: ambiguousDefinition } };
      throw new Error('must not write');
    };
    await assert.rejects(updateFlowFromManifest(ambiguousSdk, 'https://example.service-now.com', flowId, { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'x' } }] }), /multiple Action instances/);
    const protectedSdk = makeSdk();
    protectedSdk.list = async (table) => (table === 'sys_hub_flow'
      ? [{ sys_id: 'c215135293bf03d087b0f14fdd03d652', name: 'jace-test-flow', scope: 'scope-1', active: 'false', status: 'draft' }]
      : []);
    protectedSdk.request = async () => { throw new Error('must not write'); };
    await assert.rejects(updateFlowFromManifest(protectedSdk, 'https://example.service-now.com', 'c215135293bf03d087b0f14fdd03d652', { actions: [{ order: 1, type: 'Log', inputs: { x: 'y' } }] }), /Protected flow/);
  });

  it('retains target ID and does not retry after a partial GraphQL failure', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    let writes = 0;
    const sdk = makeSdk();
    sdk.list = async (table) => {
      if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
      if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
      return [];
    };
    sdk.request = async (endpoint, options = {}) => {
      if (options.method === 'GET') return { result: { data: baseDefinition } };
      if (endpoint.endsWith('/graphql')) { writes += 1; throw new Error('GraphQL timeout'); }
      throw new Error(`unexpected ${endpoint}`);
    };
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new' } }] }), error => /flow-update-123.*incomplete|GraphQL timeout/i.test(error.message) && /reconciliation/.test(error.message));
    assert.equal(writes, 1);
  });

  // The saved instance keeps the family in `type`; older read-backs only had it
  // in `triggerType`. Either way the record family must resolve.
  it('resolves the legacy triggerType family when the read-back has no type', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const legacy = structuredClone(baseDefinition);
    delete legacy.triggerInstances[0].type;
    legacy.triggerInstances[0].triggerType = 'record_create_or_update';
    const afterDefinition = structuredClone(legacy);
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({
      ...JSON.parse(legacy.triggerInstances[0].metadata),
      query_parse: { order_by: ['short_description'], group_by: [], has_rlq_conditions: false, custom: 'preserve', predicates: [{ compound_type: 'or', subpredicates: [{ field: 'short_description', operator: 'STARTSWITH', value: 'legacy-', term: 'short_descriptionSTARTSWITHlegacy-', type: 'comparison' }] }] },
    });
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], displayField: 'short_description', displayValue: wrapped('short_descriptionSTARTSWITHlegacy-'), value: wrapped('short_descriptionSTARTSWITHlegacy-') };
    const sdk = updateSdk(afterDefinition, legacy);
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { condition: 'short_descriptionSTARTSWITHlegacy-' } }, { readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }) });
    assert.equal(result.flow.id, flowId);
    assert.equal(result.version.type, 'Autosave');
  });

  it('refuses a saved trigger whose family is not a record trigger', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const scheduled = structuredClone(baseDefinition);
    scheduled.triggerInstances[0].type = 'daily';
    scheduled.triggerInstances[0].triggerType = 'Scheduled';
    const sdk = updateSdk(scheduled, scheduled);
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { condition: 'short_descriptionSTARTSWITHnew-' } }), /Only record_create_or_update trigger updates are supported; found daily/);
    assert.equal(sdk.calls.filter(call => call.options?.method === 'POST').length, 0, 'an unsupported family must not be written');
  });

  // A read-back that does not carry the requested value is a failure: no Autosave.
  it('refuses a wrong saved action input and writes no Autosave version', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: wrapped('something else'), displayValue: wrapped('something else') };
    const sdk = updateSdk(afterDefinition);
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new message' } }] }, { readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }) }), /log_message did not match the requested value/);
    assert.equal(sdk.calls.filter(call => call.endpoint.includes('/versioning/create_version')).length, 0, 'no Autosave after a failed read-back');
    assert.equal(sdk.calls.filter(call => call.options?.method === 'POST' && call.endpoint.endsWith('/graphql')).length, 1);
  });

  // sys_hub_flow has no populated scope column on current instances: the raw
  // transaction scope rides on the sys_scope reference, and the display name is
  // a label that must never be sent as sysparm_transaction_scope.
  it('reads the transaction scope from the sys_scope reference when scope is empty', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const SCOPE_ID = '1169a246933f8f9087b0f14fdd03d627';
    const SCOPE_NAME = 'JSN-STUDY-SCOPE-20261009-1137';
    const providerRecord = {
      sys_id: flowId,
      name: 'Draft update flow',
      scope: '',
      sys_scope: { display_value: SCOPE_NAME, value: SCOPE_ID, link: `https://example.service-now.com/api/now/table/sys_scope/${SCOPE_ID}` },
      active: 'false',
      status: 'draft',
    };
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: wrapped('new message'), displayValue: wrapped('new message') };
    const sdk = updateSdk(afterDefinition, baseDefinition, providerRecord);
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new message' } }],
    }, { readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }) });

    assert.equal(result.flow.id, flowId);
    assert.equal(result.version.sys_id, 'version-update-1');
    const flowRead = sdk.listCalls.find(call => call.table === 'sys_hub_flow');
    assert.match(flowRead.fields, /sys_scope/);
    assert.match(flowRead.fields, /scope/);
    assert.equal(flowRead.displayValue, 'all');
    assert.ok(sdk.calls.some(call => call.options?.method === 'GET' && call.endpoint.includes(`/processflow/flow/${flowId}?sysparm_transaction_scope=${SCOPE_ID}`)), 'the read must carry the raw sys_id');
    assert.ok(sdk.calls.some(call => call.endpoint.includes(`/versioning/create_version?sysparm_transaction_scope=${SCOPE_ID}`)), 'the Autosave must carry the raw sys_id');
    assert.ok(!JSON.stringify(sdk.calls).includes(SCOPE_NAME), 'the scope display name must never be sent');
  });

  it('keeps the legacy scope field as the fallback when sys_scope is absent', async () => {
    const { resolveFlowScope, updateFlowFromManifest } = await import('../src/flow-create.js');
    assert.equal(resolveFlowScope({ scope: 'scope-1' }), 'scope-1');
    assert.equal(resolveFlowScope({ scope: { value: 'wrapped-scope' } }), 'wrapped-scope');
    assert.equal(resolveFlowScope({ scope: '', sys_scope: { display_value: 'Some App', value: 'scope-2' } }), 'scope-2');
    assert.equal(resolveFlowScope({ scope: '', sys_scope: { display_value: 'Some App', value: '' } }), '');
    assert.equal(resolveFlowScope({ scope: 'scope-1', sys_scope: { display_value: 'Some App', value: 'scope-2' } }), 'scope-2');

    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: wrapped('legacy message'), displayValue: wrapped('legacy message') };
    const sdk = updateSdk(afterDefinition, baseDefinition, { sys_id: flowId, name: 'Draft update flow', scope: 'scope-legacy', active: 'false', status: 'draft' });
    await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      actions: [{ order: 1, type: 'Log', inputs: { log_message: 'legacy message' } }],
    }, { readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }) });
    assert.ok(sdk.calls.some(call => call.options?.method === 'GET' && call.endpoint.includes(`/processflow/flow/${flowId}?sysparm_transaction_scope=scope-legacy`)));
    assert.ok(sdk.calls.some(call => call.endpoint.includes('/versioning/create_version?sysparm_transaction_scope=scope-legacy')));
  });

  it('refuses a flow update when neither sys_scope nor scope carries a scope', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = updateSdk(baseDefinition, baseDefinition, { sys_id: flowId, name: 'Draft update flow', scope: '', sys_scope: { display_value: 'Some App', value: '' }, active: 'false', status: 'draft' });
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      actions: [{ order: 1, type: 'Log', inputs: { log_message: 'x' } }],
    }), /flow-update-123 has no transaction scope/);
    assert.equal(sdk.calls.filter(call => call.options?.method === 'POST').length, 0, 'no write without a resolved scope');
  });

  // The provider returns empty attribute maps as {"": ""}. An empty key is not a
  // GraphQL Name, so the mutation was rejected with "Invalid syntax with
  // offending token ':'" and the guided record-trigger edit could never finish.
  it('never emits an empty GraphQL field name from provider attribute maps', async () => {
    const { buildFlowUpdateMutation } = await import('../src/flow-create.js');
    const query = buildFlowUpdateMutation({
      flowId,
      triggerUpdates: [{
        id: triggerId,
        metadata: '{}',
        inputs: [
          { id: 'run-flow-in', value: { value: 'foreground' }, attributes: { '': '' }, label: 'Run Trigger' },
          { id: 'condition-input', value: { value: 'short_descriptionSTARTSWITHnew-' }, attributes: { '': '' } },
        ],
      }],
      actionUpdates: [],
    });
    assert.doesNotMatch(query, /\{:\s*"/);
    assert.match(query, /attributes: \{\}/);
    assert.match(query, /label: "Run Trigger"/);
    assert.match(query, /short_descriptionSTARTSWITHnew-/);
  });
});
