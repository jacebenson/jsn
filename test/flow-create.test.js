import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const manifest = {
  name: 'JSN-STUDY-test',
  description: 'Study flow',
  scope: '1169a246933f8f9087b0f14fdd03d627',
  trigger: {
    type: 'record_create_or_update',
    table: 'ticket',
    condition: 'short_descriptionSTARTSWITHJSN-STUDY-',
  },
  actions: [{ type: 'Log', inputs: { log_level: 'info', log_message: 'hello "flow"\nnext' } }],
};

describe('flow creation manifest', () => {
  it('accepts the record trigger and schema-driven action shape', async () => {
    const { validateFlowManifest } = await import('../src/flow-create.js');
    assert.deepEqual(validateFlowManifest(manifest), manifest);
  });

  it('rejects unsupported flow features and malformed actions', async () => {
    const { validateFlowManifest } = await import('../src/flow-create.js');
    assert.throws(() => validateFlowManifest({ ...manifest, scope: undefined }), /requires scope/i);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, type: 'scheduled' } }), /record_create_or_update/);
    assert.throws(() => validateFlowManifest({ ...manifest, trigger: { ...manifest.trigger, condition: 'short_descriptionSTARTSWITHJSN^ORactive=true' } }), /condition.*subset|unsupported.*condition/i);
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
    const options = [];
    create.builder({ option(name) { options.push(name); return this; } });
    assert.deepEqual(options, ['data', 'data-file']);
  });

  it('escapes GraphQL strings and includes synthetic action identities', async () => {
    const { buildFlowPatchMutation } = await import('../src/flow-create.js');
    const mutation = buildFlowPatchMutation({
      flowId: 'flow-123',
      trigger: { id: 'trigger-123', metadata: '{"predicate":"record"}', inputs: [{ name: 'table', displayField: 'ticket', displayValue: { schemaless: false, schemalessValue: '', value: 'ticket' }, value: { schemaless: false, schemalessValue: '', value: 'ticket' } }] },
      actions: [{ actionTypeSysId: 'action-type-123', flowSysId: 'flow-123', generationSource: '', type: 'action', order: '1', parent: '', parentUiId: '', uiUniqueIdentifier: 'action-ui-123', metadata: '{}', inputs: [{ name: 'log_message', type: 'string', parameter: { name: 'log_message', type: 'string' }, value: { schemaless: false, schemalessValue: '', value: 'hello "flow"\nnext' }, displayValue: { schemaless: false, schemalessValue: '', value: 'hello "flow"\nnext' } }] }],
    });
    assert.match(mutation, /mutation/);
    assert.match(mutation, /flowId: "flow-123"/);
    assert.match(mutation, /actions: \{insert:/);
    assert.match(mutation, /actionTypeSysId: "action-type-123"/);
    assert.match(mutation, /flowSysId: "flow-123"/);
    assert.match(mutation, /generationSource: ""/);
    assert.match(mutation, /order: "1"/);
    assert.match(mutation, /parent: ""/);
    assert.match(mutation, /parentUiId: ""/);
    assert.match(mutation, /uiUniqueIdentifier: "action-ui-123"/);
    assert.match(mutation, /hello \\"flow\\"\\nnext/);
    assert.doesNotMatch(mutation, /jace-test-flow|c215135293bf03d087b0f14fdd03d652/);
  });

  it('creates, patches, versions, and verifies a flow without activation', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    const calls = [];
    const sdk = {
      async list(table, params) {
        calls.push({ kind: 'list', table, params: String(params) });
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        if (table === 'sys_hub_flow_version') return [{ sys_id: 'version-1', flow: 'flow-123', type: 'Autosave', payload: '{"flowId":"flow-123"}' }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-1', payload: 'flow-123' }];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ kind: 'request', endpoint, options });
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.endsWith('/processflow/flow/flow-123')) return { result: { data: { triggerInstances: [{ sysId: 'trigger-123', uiUniqueIdentifier: 'trigger-ui-123', metadata: '{}' }] } } };
        if (options.method === 'GET' && endpoint.includes('/trigger/record/table')) return { result: { label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] } };
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [{ id: 'input-1', name: 'log_level', type: 'choice', default: 'info', choices: ['info', 'error'], parameter: { name: 'log_level', type: 'choice' } }, { id: 'input-2', name: 'log_message', type: 'string', mandatory: true, parameter: { name: 'log_message', type: 'string' } }] } };
        if (endpoint === 'https://example.service-now.com/api/now/graphql') return { data: { global: { snFlowDesigner: { flow: { actions: { inserts: [{ sysId: 'action-123', uiUniqueIdentifier: 'action-ui-123' }] } } } } } };
        if (options.method === 'POST' && endpoint.endsWith('/versioning/create_version')) return { result: { sys_id: 'version-1', type: 'Autosave' } };
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    const result = await createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, {
      readUpdateSet: async () => ({ name: 'Default', sys_id: 'update-set-1' }),
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
      idFactory: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });
    assert.equal(result.flow.id, 'flow-123');
    assert.equal(result.trigger.id, 'trigger-123');
    assert.deepEqual(result.actions, [{ sysId: 'action-123', uiUniqueIdentifier: 'action-ui-123' }]);
    assert.deepEqual(result.definition_readback, { available: true, status: 'read_back', flow_id: 'flow-123' });
    assert.equal(result.version.type, 'Autosave');
    assert.equal(result.update_set_capture.available, true);
    assert.equal(result.update_set_capture.status, 'captured');
    assert.deepEqual(result.update_set_mutations.map(snapshot => snapshot.label), ['parent_create', 'trigger_and_actions_patch', 'autosave_version']);
    assert.ok(result.update_set_mutations.every(snapshot => snapshot.capture_after?.status === 'captured'));
    const patchCall = calls.find(call => call.kind === 'request' && call.endpoint === 'https://example.service-now.com/api/now/graphql');
    const patchBody = JSON.parse(patchCall.options.body);
    const parentCall = calls.find(call => call.kind === 'request' && call.endpoint.includes('/processflow/flow?'));
    const parentBody = JSON.parse(parentCall.options.body);
    assert.deepEqual(parentBody, {
      name: 'JSN-STUDY-test', description: 'Study flow', type: 'flow', status: 'draft', active: false,
      scope: manifest.scope, runAs: 'user', flowPriority: 'MEDIUM', access: 'public', protection: '',
      runWithRoles: { value: '', displayValue: '' }, deleted: false, security: { can_read: true, can_write: true },
    });
    assert.match(patchBody.query, /log_level/);
    assert.match(patchBody.query, /value: "info"/);
    assert.match(patchBody.query, /log_message/);
    assert.match(patchBody.query, /actionTypeSysId/);
    assert.match(patchBody.query, /flowSysId/);
    assert.match(patchBody.query, /generationSource: ""/);
    assert.match(patchBody.query, /order: "1"/);
    assert.match(patchBody.query, /parent: ""/);
    assert.match(patchBody.query, /parentUiId: ""/);
    assert.match(patchBody.query, /displayField: "number"/);
    assert.match(patchBody.query, /displayValue: \{schemaless: false, schemalessValue: "", value: "Ticket"\}/);
    assert.match(patchBody.query, /predicates/);
    assert.match(patchBody.query, /STARTSWITH/);
    assert.match(patchBody.query, /schemalessValue: ""/);
    assert.doesNotMatch(patchBody.query, /triggerType/);
    assert.equal(calls.filter(call => call.kind === 'request' && call.options.method === 'POST').length, 3);
    assert.ok(calls.some(call => call.kind === 'request' && call.endpoint.endsWith('/versioning/create_version')));
    assert.ok(calls.every(call => !String(call.options?.body || '').includes('c215135293bf03d087b0f14fdd03d652')));
  });

  it('surfaces a partial patch with the created Flow ID and does not retry', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    let patchAttempts = 0;
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: 'flow-123', name: manifest.name, active: false, status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.endsWith('/processflow/flow/flow-123')) return { result: { data: { triggerInstances: [{ sysId: 'trigger-123', metadata: '{}' }] } } };
        if (options.method === 'GET' && endpoint.includes('/trigger/record/table')) return { result: { label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] } };
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [{ id: 'input-1', name: 'log_level', type: 'choice', parameter: { name: 'log_level', type: 'choice' } }, { id: 'input-2', name: 'log_message', type: 'string', parameter: { name: 'log_message', type: 'string' } }] } };
        if (endpoint.endsWith('/api/now/graphql')) { patchAttempts += 1; throw new Error('GraphQL transport timeout'); }
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    await assert.rejects(
      createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, { readUpdateSet: async () => ({ name: 'Default', sys_id: 'update-set-1' }), readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }) }),
      error => /flow-123.*incomplete|GraphQL transport timeout/i.test(error.message) && /reconciliation/i.test(error.message) && /capture_after.*missing/i.test(error.message),
    );
    assert.equal(patchAttempts, 1);
  });
});

describe('flow update request shapes', () => {
  const flowId = 'flow-update-123';
  const actionId = 'action-update-123';
  const triggerId = 'trigger-update-123';
  const baseDefinition = {
    flowId,
    triggerInstances: [{ sysId: triggerId, triggerType: 'record_create_or_update', metadata: '{"old":"kept"}', inputs: [
      { name: 'table', id: 'table-input', displayField: 'number', displayValue: { schemaless: false, schemalessValue: '', value: 'Ticket' }, value: { schemaless: false, schemalessValue: '', value: 'ticket' } },
      { name: 'condition', id: 'condition-input', extra: 'preserve', displayField: 'old', displayValue: { schemaless: false, schemalessValue: '', value: 'old' }, value: { schemaless: false, schemalessValue: '', value: 'old' } },
    ], extraTriggerField: 'preserve' }],
    actionInstances: [{ id: actionId, uiUniqueIdentifier: 'action-ui-123', actionTypeSysId: 'action-type-123', order: '1', metadata: '{"keep":true}', inputs: [
      { id: 'input-1', name: 'log_level', parameter: { name: 'log_level', type: 'choice', keep: true }, children: ['child-1'], value: { schemaless: false, schemalessValue: '', value: 'info' }, displayValue: { schemaless: false, schemalessValue: '', value: 'info' } },
      { id: 'input-2', name: 'log_message', parameter: { name: 'log_message', type: 'string', keep: true }, children: ['child-2'], value: { schemaless: false, schemalessValue: '', value: 'old message' }, displayValue: { schemaless: false, schemalessValue: '', value: 'old message' } },
    ] }],
  };

  it('updates only requested trigger/action values, preserves omitted fields, versions, and captures', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const calls = [];
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({ predicates: [{ term: 'short_descriptionSTARTSWITHnew-' }], order_by: [], group_by: [], has_rlq_conditions: false });
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], displayField: 'short_description', displayValue: { schemaless: false, schemalessValue: '', value: 'short_descriptionSTARTSWITHnew-' }, value: { schemaless: false, schemalessValue: '', value: 'short_descriptionSTARTSWITHnew-' } };
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: { schemaless: false, schemalessValue: '', value: 'new message' }, displayValue: { schemaless: false, schemalessValue: '', value: 'new message' } };
    const sdk = {
      async list(table, params) {
        calls.push({ kind: 'list', table, params: String(params) });
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_flow_version') return [{ sys_id: 'version-update-1', type: 'Autosave', flow: flowId }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-update-1', payload: flowId }];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ kind: 'request', endpoint, options });
        if (options.method === 'GET') return { result: { data: calls.some(call => call.kind === 'request' && call.options.method === 'POST') ? afterDefinition : baseDefinition } };
        if (endpoint.endsWith('/versioning/create_version')) return { result: { sys_id: 'version-update-1', type: 'Autosave' } };
        return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [{ sysId: triggerId }] }, actions: { updates: [{ sysId: actionId }] } } } } } };
      },
    };
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      trigger: { type: 'record_create_or_update', condition: 'short_descriptionSTARTSWITHnew-' },
      actions: [{ id: actionId, inputs: { log_message: 'new message' } }],
    }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
    });
    assert.equal(result.flow.id, flowId);
    assert.equal(result.version.type, 'Autosave');
    assert.deepEqual(result.update_set_mutations.map(snapshot => snapshot.label), ['trigger_and_actions_update', 'autosave_version']);
    assert.ok(result.update_set_mutations.every(snapshot => snapshot.capture_after.status === 'captured'));
    const patch = calls.find(call => call.kind === 'request' && call.endpoint.endsWith('/graphql'));
    const query = JSON.parse(patch.options.body).query;
    assert.match(query, /triggerInstances: \{update:/);
    assert.match(query, /actions: \{update:/);
    assert.match(query, /condition-input/);
    assert.match(query, /action-update-123/);
    assert.match(query, /new message/);
    assert.match(query, /keep/);
    assert.doesNotMatch(query, /actions: \{insert:/);
  });

  it('rejects unsupported fields, ambiguous actions, and protected targets before mutation', async () => {
    const { validateFlowUpdateManifest, updateFlowFromManifest } = await import('../src/flow-create.js');
    assert.throws(() => validateFlowUpdateManifest({ logic: [] }), /unsupported/i);
    assert.throws(() => validateFlowUpdateManifest({ actions: [{ inputs: { x: 'y' } }] }), /exact id|uiUniqueIdentifier/i);
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: baseDefinition } };
        throw new Error('must not write');
      },
    };
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ id: 'missing-action', inputs: { x: 'y' } }] }), /did not match/);
    const ambiguousDefinition = structuredClone(baseDefinition);
    ambiguousDefinition.actionInstances.push(structuredClone(baseDefinition.actionInstances[0]));
    const ambiguousSdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        return [];
      },
      async request(_endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: ambiguousDefinition } };
        throw new Error('must not write');
      },
    };
    await assert.rejects(updateFlowFromManifest(ambiguousSdk, 'https://example.service-now.com', flowId, { actions: [{ id: actionId, inputs: { log_message: 'x' } }] }), /multiple Action instances/);
    const protectedSdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: 'c215135293bf03d087b0f14fdd03d652', name: 'jace-test-flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        return [];
      },
      async request() { throw new Error('must not write'); },
    };
    await assert.rejects(updateFlowFromManifest(protectedSdk, 'https://example.service-now.com', 'c215135293bf03d087b0f14fdd03d652', { actions: [{ id: actionId, inputs: { x: 'y' } }] }), /Protected flow/);
  });

  it('retains target ID and does not retry after a partial GraphQL failure', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    let writes = 0;
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: baseDefinition } };
        if (endpoint.endsWith('/graphql')) { writes += 1; throw new Error('GraphQL timeout'); }
        throw new Error(`unexpected ${endpoint}`);
      },
    };
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ id: actionId, inputs: { log_message: 'new' } }] }), error => /flow-update-123.*incomplete|GraphQL timeout/i.test(error.message) && /reconciliation/.test(error.message));
    assert.equal(writes, 1);
  });
});
