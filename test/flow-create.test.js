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
    let versionReads = 0;
    let processFlowReads = 0;
    const createdDefinition = {
      triggerInstances: [{
        sysId: 'trigger-123',
        triggerType: 'record_create_or_update',
        metadata: JSON.stringify({ predicates: [{ type: 'compound', subpredicates: [{ type: 'compound', subpredicates: [{ type: 'compound', subpredicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', term: 'JSN-STUDY-' }] }] }] }] }),
        inputs: [
          { name: 'table', value: { value: 'ticket' } },
          { name: 'condition', value: { value: 'short_descriptionSTARTSWITHJSN-STUDY-' } },
        ],
      }],
      actionInstances: [{
        id: 'action-123', uiUniqueIdentifier: 'generated-1', actionTypeSysId: 'action-type-123', order: '1',
        inputs: [
          { name: 'log_level', value: { value: 'info' } },
          { name: 'log_message', value: { value: manifest.actions[0].inputs.log_message } },
        ],
      }],
    };
    const sdk = {
      async list(table, params) {
        calls.push({ kind: 'list', table, params: String(params) });
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        if (table === 'sys_hub_flow_version') return versionReads++ === 0 ? [] : [{ sys_id: 'version-1', flow: 'flow-123', type: 'Autosave', payload: '{"flowId":"flow-123"}' }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-1', payload: 'flow-123' }];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ kind: 'request', endpoint, options });
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.includes('/processflow/flow/flow-123?sysparm_transaction_scope=')) {
          processFlowReads += 1;
          return { result: { data: processFlowReads === 1 ? { triggerInstances: [{ sysId: 'trigger-123' }] } : createdDefinition } };
        }
        if (options.method === 'GET' && endpoint.includes('/trigger/record/table')) return { result: { label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] } };
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [{ id: 'input-1', name: 'log_level', type: 'choice', default: 'info', choices: ['info', 'error'], parameter: { name: 'log_level', type: 'choice' } }, { id: 'input-2', name: 'log_message', type: 'string', mandatory: true, parameter: { name: 'log_message', type: 'string' } }] } };
        if (endpoint === 'https://example.service-now.com/api/now/graphql') return { data: { global: { snFlowDesigner: { flow: { actions: { inserts: [{ sysId: 'action-123', uiUniqueIdentifier: 'generated-1' }] } } } } } };
        if (options.method === 'POST' && endpoint.includes('/versioning/create_version?sysparm_transaction_scope=')) return { result: { sys_id: 'version-1', type: 'Autosave' } };
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
    assert.deepEqual(result.actions, [{ sysId: 'action-123', uiUniqueIdentifier: 'generated-1' }]);
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
    assert.ok(calls.some(call => call.kind === 'request' && call.options.method === 'GET' && call.endpoint.includes('/processflow/flow/flow-123?sysparm_transaction_scope=1169a246933f8f9087b0f14fdd03d627')));
    assert.ok(calls.some(call => call.kind === 'request' && call.endpoint.includes('/versioning/create_version?sysparm_transaction_scope=1169a246933f8f9087b0f14fdd03d627')));
    assert.ok(calls.every(call => !String(call.options?.body || '').includes('c215135293bf03d087b0f14fdd03d652')));
  });

  it('refuses to report creation success when saved Actions are missing', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    let versionReads = 0;
    let versionPosts = 0;
    let processFlowReads = 0;
    const initialDefinition = { triggerInstances: [{ sysId: 'trigger-created-1' }] };
    const savedDefinition = {
      triggerInstances: [{
        sysId: 'trigger-created-1',
        metadata: JSON.stringify({ predicates: [{ type: 'compound', subpredicates: [{ type: 'compound', subpredicates: [{ type: 'compound', subpredicates: [{ type: 'comparison', field: 'short_description', operator: 'STARTSWITH', term: 'JSN-STUDY-' }] }] }] }] }),
        inputs: [
          { name: 'table', value: { value: 'ticket' } },
          { name: 'condition', value: { value: 'short_descriptionSTARTSWITHJSN-STUDY-' } },
        ],
      }],
      actionInstances: [],
    };
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        if (table === 'sys_hub_flow_version') return versionReads++ === 0 ? [] : [{ sys_id: 'version-1', flow: 'flow-123', type: 'Autosave' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.includes('/processflow/flow/flow-123?')) {
          processFlowReads += 1;
          return { result: { data: processFlowReads === 1 ? initialDefinition : savedDefinition } };
        }
        if (options.method === 'GET' && endpoint.includes('/action/action_types/')) return { result: { inputs: [
          { id: 'input-1', name: 'log_level', type: 'choice', default: 'info', parameter: { name: 'log_level', type: 'choice' } },
          { id: 'input-2', name: 'log_message', type: 'string', mandatory: true, parameter: { name: 'log_message', type: 'string' } },
        ] } };
        if (endpoint.endsWith('/api/now/graphql')) return {
          data: {
            global: {
              snFlowDesigner: {
                flow: { actions: { inserts: [{ sysId: 'action-1', uiUniqueIdentifier: 'generated-2' }] } },
              },
            },
          },
        };
        if (options.method === 'POST' && endpoint.includes('/versioning/create_version')) {
          versionPosts += 1;
          return { result: { sys_id: 'version-1' } };
        }
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    await assert.rejects(createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, {
      readUpdateSet: async () => null,
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
      idFactory: () => 'generated-2',
    }), /Actions; expected 1/i);
    savedDefinition.triggerInstances[0].inputs[0].value.value = 'incident';
    processFlowReads = 0;
    await assert.rejects(createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, {
      readUpdateSet: async () => null,
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
      idFactory: () => 'generated-2',
    }), /trigger table did not match the requested value/i);
    savedDefinition.triggerInstances[0].inputs[0].value.value = 'ticket';
    savedDefinition.actionInstances = [{
      id: 'action-1', uiUniqueIdentifier: 'generated-2', actionTypeSysId: 'action-type-123', order: '1',
      inputs: [
        { name: 'log_level', value: { value: 'info' } },
        { name: 'log_message', value: { value: 'wrong value' } },
      ],
    }];
    processFlowReads = 0;
    await assert.rejects(createFlowFromManifest(sdk, 'https://example.service-now.com', manifest, {
      readUpdateSet: async () => null,
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
      idFactory: () => 'generated-2',
    }), /Action generated-2 input log_message did not match/i);
    assert.equal(versionPosts, 0);
  });

  it('surfaces a partial patch with the created Flow ID and does not retry', async () => {
    const { createFlowFromManifest } = await import('../src/flow-create.js');
    let patchAttempts = 0;
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: 'flow-123', name: manifest.name, scope: manifest.scope, active: false, status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'POST' && endpoint.includes('/processflow/flow?')) return { result: { sys_id: 'flow-123' } };
        if (options.method === 'GET' && endpoint.includes('/processflow/flow/flow-123?sysparm_transaction_scope=')) return { result: { data: { triggerInstances: [{ sysId: 'trigger-123', metadata: '{}' }] } } };
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
    triggerInstances: [{ sysId: triggerId, triggerType: 'record_create_or_update', metadata: '{"predicates": [], "order_by": ["short_description"], "group_by": [], "has_rlq_conditions": false, "custom": "preserve"}', inputs: [
      { name: 'table', id: 'table-input', marker: 'table-preserve', displayField: 'number', displayValue: { schemaless: false, schemalessValue: '', value: 'Ticket' }, value: { schemaless: false, schemalessValue: '', value: 'ticket' } },
      { name: 'condition', id: 'condition-input', extra: 'preserve', displayField: 'old', displayValue: { schemaless: false, schemalessValue: '', value: 'old' }, value: { schemaless: false, schemalessValue: '', value: 'old' } },
      { name: 'trigger_strategy', value: { value: 'after' } },
      { name: 'run_on_extended', value: { value: true } },
      { name: 'run_flow_in', value: { value: 'foreground' } },
    ], extraTriggerField: 'preserve' }],
    actionInstances: [{ id: actionId, uiUniqueIdentifier: 'action-ui-123', actionTypeSysId: 'action-type-123', actionType: { sys_id: 'action-type-123', name: 'Log' }, order: '1', metadata: '{"keep":true}', inputs: [
      { id: 'input-1', name: 'log_level', parameter: { name: 'log_level', type: 'choice', keep: true }, children: ['child-1'], value: { schemaless: false, schemalessValue: '', value: 'info' }, displayValue: { schemaless: false, schemalessValue: '', value: 'info' } },
      { id: 'input-2', name: 'log_message', parameter: { name: 'log_message', type: 'string', keep: true }, children: ['child-2'], value: { schemaless: false, schemalessValue: '', value: 'old message' }, displayValue: { schemaless: false, schemalessValue: '', value: 'old message' } },
    ] }],
  };

  it('updates only requested trigger/action values, preserves omitted fields, versions, and captures', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const calls = [];
    let versionReads = 0;
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].metadata = JSON.stringify({
      ...JSON.parse(baseDefinition.triggerInstances[0].metadata),
      predicates: [{ compound_type: 'or', subpredicates: [{ compound_type: 'and', subpredicates: [{ compound_type: 'and', subpredicates: [{ field: 'short_description', operator: 'STARTSWITH', term: 'new-', type: 'comparison' }], type: 'compound' }], type: 'compound' }], type: 'compound' }],
    });
    afterDefinition.triggerInstances[0].inputs[1] = { ...afterDefinition.triggerInstances[0].inputs[1], displayField: 'short_description', displayValue: { schemaless: false, schemalessValue: '', value: 'short_descriptionSTARTSWITHnew-' }, value: { schemaless: false, schemalessValue: '', value: 'short_descriptionSTARTSWITHnew-' } };
    afterDefinition.actionInstances[0].inputs[1] = { ...afterDefinition.actionInstances[0].inputs[1], value: { schemaless: false, schemalessValue: '', value: 'new message' }, displayValue: { schemaless: false, schemalessValue: '', value: 'new message' } };
    const sdk = {
      async list(table, params) {
        calls.push({ kind: 'list', table, params: String(params) });
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        if (table === 'sys_hub_flow_version') return versionReads++ === 0 ? [] : [{ sys_id: 'version-update-1', type: 'Autosave', flow: flowId }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-update-1', payload: flowId }];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ kind: 'request', endpoint, options });
        if (options.method === 'GET') return { result: { data: calls.some(call => call.kind === 'request' && call.options.method === 'POST') ? afterDefinition : baseDefinition } };
        if (endpoint.includes('/versioning/create_version?sysparm_transaction_scope=')) return { result: { sys_id: 'version-update-1', type: 'Autosave' } };
        return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [{ sysId: triggerId }] }, actions: { updates: [{ sysId: actionId }] } } } } } };
      },
    };
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, {
      trigger: { type: 'record_create_or_update', condition: 'short_descriptionSTARTSWITHnew-' },
      actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new message' } }],
    }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
      readTableDescriptor: async () => ({ label: 'Ticket', displayField: 'number', fields: [{ name: 'short_description', label: 'Short description', type: 'string' }] }),
    });
    assert.equal(result.flow.id, flowId);
    assert.equal(result.version.type, 'Autosave');
    assert.ok(calls.some(call => call.kind === 'request' && call.options.method === 'GET' && call.endpoint.includes(`/processflow/flow/${flowId}?sysparm_transaction_scope=scope-1`)));
    assert.ok(calls.some(call => call.kind === 'request' && call.endpoint.includes('/versioning/create_version?sysparm_transaction_scope=scope-1')));
    assert.deepEqual(result.update_set_mutations.map(snapshot => snapshot.label), ['trigger_and_actions_update', 'autosave_version']);
    assert.ok(result.update_set_mutations.every(snapshot => snapshot.capture_after.status === 'captured'));
    const patch = calls.find(call => call.kind === 'request' && call.endpoint.endsWith('/graphql'));
    const query = JSON.parse(patch.options.body).query;
    assert.match(query, /triggerInstances: \{update:/);
    assert.match(query, /actions: \{update:/);
    assert.match(query, /triggerInstances \{ updates \}/);
    assert.match(query, /actions \{ updates \}/);
    assert.doesNotMatch(query, /updates \{/);
    assert.match(query, /name: "condition"/);
    assert.match(query, /table-input/);
    assert.match(query, /condition-input/);
    assert.match(query, /trigger_strategy/);
    assert.match(query, /run_on_extended/);
    assert.match(query, /run_flow_in/);
    assert.match(query, /custom/);
    assert.match(query, /uiUniqueIdentifier: "action-ui-123"/);
    assert.match(query, /type: "action"/);
    assert.match(query, /new message/);
    assert.doesNotMatch(query, /id: "action-update-123"/);
    assert.doesNotMatch(query, /log_level/);
    assert.doesNotMatch(query, /parameter:/);
    assert.doesNotMatch(query, /actions: \{insert:/);
  });

  it('keeps trigger condition and metadata byte-for-byte when only the table changes', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const afterDefinition = structuredClone(baseDefinition);
    afterDefinition.triggerInstances[0].inputs[0] = {
      ...afterDefinition.triggerInstances[0].inputs[0],
      displayField: 'number',
      displayValue: { schemaless: false, schemalessValue: '', value: 'Task' },
      value: { schemaless: false, schemalessValue: '', value: 'task' },
    };
    const beforeMetadata = baseDefinition.triggerInstances[0].metadata;
    const beforeCondition = JSON.stringify(baseDefinition.triggerInstances[0].inputs[1]);
    let versionReads = 0;
    let wrote = false;
    const calls = [];
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_flow_version') return versionReads++ === 0 ? [] : [{ sys_id: 'table-version-1', type: 'Autosave', flow: flowId }];
        if (table === 'sys_update_xml') return [{ sys_id: 'xml-table-1', payload: flowId }];
        return [];
      },
      async request(endpoint, options = {}) {
        calls.push({ endpoint, options });
        if (options.method === 'GET') return { result: { data: wrote ? afterDefinition : baseDefinition } };
        if (endpoint.endsWith('/graphql')) {
          wrote = true;
          return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [{ sysId: triggerId }] } } } } } };
        }
        if (endpoint.includes('/versioning/create_version')) return { result: { sys_id: 'table-version-1' } };
        throw new Error(`unexpected request ${endpoint}`);
      },
    };
    const result = await updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { trigger: { table: 'task' } }, {
      readUpdateSet: async () => ({ name: 'Feature', sys_id: 'update-set-1' }),
      readTableDescriptor: async () => ({ label: 'Task', displayField: 'number', fields: [] }),
    });
    assert.equal(result.version.sys_id, 'table-version-1');
    const patch = calls.find(call => call.endpoint.endsWith('/graphql'));
    const query = JSON.parse(patch.options.body).query;
    assert.match(query, /trigger_strategy/);
    assert.match(query, /run_on_extended/);
    assert.match(query, /run_flow_in/);
    assert.match(query, /condition-input/);
    assert.match(query, /custom/);
    assert.ok(query.includes(`metadata: ${JSON.stringify(beforeMetadata)}`));
    assert.doesNotMatch(query, /short_descriptionSTARTSWITHnew-/);
    assert.equal(JSON.stringify(afterDefinition.triggerInstances[0].inputs[1]), beforeCondition);
    assert.equal(afterDefinition.triggerInstances[0].metadata, beforeMetadata);
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
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: baseDefinition } };
        throw new Error('must not write');
      },
    };
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ order: 9, type: 'Log', inputs: { x: 'y' } }] }), /did not match/);
    const ambiguousDefinition = structuredClone(baseDefinition);
    ambiguousDefinition.actionInstances.push(structuredClone(baseDefinition.actionInstances[0]));
    const ambiguousSdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        return [];
      },
      async request(_endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: ambiguousDefinition } };
        throw new Error('must not write');
      },
    };
    await assert.rejects(updateFlowFromManifest(ambiguousSdk, 'https://example.service-now.com', flowId, { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'x' } }] }), /multiple Action instances/);
    const protectedSdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: 'c215135293bf03d087b0f14fdd03d652', name: 'jace-test-flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        return [];
      },
      async request() { throw new Error('must not write'); },
    };
    await assert.rejects(updateFlowFromManifest(protectedSdk, 'https://example.service-now.com', 'c215135293bf03d087b0f14fdd03d652', { actions: [{ order: 1, type: 'Log', inputs: { x: 'y' } }] }), /Protected flow/);
  });

  it('retains target ID and does not retry after a partial GraphQL failure', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    let writes = 0;
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: flowId, name: 'Draft update flow', scope: 'scope-1', active: 'false', status: 'draft' }];
        if (table === 'sys_hub_action_type_definition') return [{ sys_id: 'action-type-123', name: 'Log', active: 'true' }];
        return [];
      },
      async request(endpoint, options = {}) {
        if (options.method === 'GET') return { result: { data: baseDefinition } };
        if (endpoint.endsWith('/graphql')) { writes += 1; throw new Error('GraphQL timeout'); }
        throw new Error(`unexpected ${endpoint}`);
      },
    };
    await assert.rejects(updateFlowFromManifest(sdk, 'https://example.service-now.com', flowId, { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'new' } }] }), error => /flow-update-123.*incomplete|GraphQL timeout/i.test(error.message) && /reconciliation/.test(error.message));
    assert.equal(writes, 1);
  });
});
