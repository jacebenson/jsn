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
      actions: [{ actionTypeSysId: 'action-type-123', flowSysId: 'flow-123', generationSource: 'manual', type: 'action', order: '1', parent: '', parentUiId: '', uiUniqueIdentifier: 'action-ui-123', metadata: '{}', inputs: [{ name: 'log_message', type: 'string', parameter: { name: 'log_message', type: 'string' }, value: { schemaless: false, schemalessValue: '', value: 'hello "flow"\nnext' }, displayValue: { schemaless: false, schemalessValue: '', value: 'hello "flow"\nnext' } }] }],
    });
    assert.match(mutation, /mutation/);
    assert.match(mutation, /flowId: "flow-123"/);
    assert.match(mutation, /actions: \{insert:/);
    assert.match(mutation, /actionTypeSysId: "action-type-123"/);
    assert.match(mutation, /flowSysId: "flow-123"/);
    assert.match(mutation, /generationSource: "manual"/);
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
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ kind: 'request', endpoint, options });
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.endsWith('/processflow/flow/flow-123')) return { result: { data: { triggerInstances: [{ sysId: 'trigger-123', uiUniqueIdentifier: 'trigger-ui-123', metadata: '{}' }] } } };
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [{ name: 'log_level', type: 'choice', default: 'info', choices: ['info', 'error'] }, { name: 'log_message', type: 'string', mandatory: true }] } };
        if (endpoint === 'https://example.service-now.com/api/now/graphql') return { data: { global: { snFlowDesigner: { flow: { actions: { inserts: [{ sysId: 'action-123', uiUniqueIdentifier: 'action-ui-123' }] } } } } } };
        if (options.method === 'POST' && endpoint.endsWith('/versioning/create_version')) return { result: { sys_id: 'version-1', type: 'Autosave' } };
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    const result = await createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, {
      readUpdateSet: async () => ({ name: 'Default', sys_id: 'update-set-1' }),
      idFactory: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });
    assert.equal(result.flow.id, 'flow-123');
    assert.equal(result.trigger.id, 'trigger-123');
    assert.deepEqual(result.actions, [{ sysId: 'action-123', uiUniqueIdentifier: 'action-ui-123' }]);
    assert.equal(result.version.type, 'Autosave');
    assert.equal(result.update_set_capture.available, true);
    const patchCall = calls.find(call => call.kind === 'request' && call.endpoint === 'https://example.service-now.com/api/now/graphql');
    const patchBody = JSON.parse(patchCall.options.body);
    const parentCall = calls.find(call => call.kind === 'request' && call.endpoint.includes('/processflow/flow?'));
    const parentBody = JSON.parse(parentCall.options.body);
    assert.deepEqual(parentBody, {
      name: 'JSN-STUDY-test', description: 'Study flow', type: 'flow', status: 'draft', active: false,
      scope: manifest.scope, runAs: 'user', flowPriority: 'MEDIUM', access: 'public', protection: '',
      runWithRoles: { read: [], write: [] }, deleted: false, security: { can_read: true, can_write: true },
    });
    assert.match(patchBody.query, /log_level/);
    assert.match(patchBody.query, /value: "info"/);
    assert.match(patchBody.query, /log_message/);
    assert.match(patchBody.query, /actionTypeSysId/);
    assert.match(patchBody.query, /flowSysId/);
    assert.match(patchBody.query, /generationSource: "manual"/);
    assert.match(patchBody.query, /order: "1"/);
    assert.match(patchBody.query, /parent: ""/);
    assert.match(patchBody.query, /parentUiId: ""/);
    assert.match(patchBody.query, /displayField: "ticket"/);
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
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [{ name: 'log_level', type: 'choice' }, { name: 'log_message', type: 'string' }] } };
        if (endpoint.endsWith('/api/now/graphql')) { patchAttempts += 1; throw new Error('GraphQL transport timeout'); }
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    await assert.rejects(
      createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, { readUpdateSet: async () => ({ name: 'Default', sys_id: 'update-set-1' }) }),
      error => /flow-123.*incomplete|GraphQL transport timeout/i.test(error.message) && /reconciliation/i.test(error.message),
    );
    assert.equal(patchAttempts, 1);
  });
});
