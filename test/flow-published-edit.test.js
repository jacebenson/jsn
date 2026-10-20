import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Published-flow editing contract: the lifecycle label is not the gate, the
// ProcessFlow definition's security.can_write is, and a published snapshot must
// survive the edit untouched.
const FLOW_ID = '30f3d26187e92300e0ef0cf888cb0b91';
const SNAPSHOT_ID = '973c1ee187e92300e0ef0cf888cb0b4a';
const VERSION_ID = 'dc91fe2d93885f1016c8fd18dd03d6c5';
const AUTOSAVE_ID = 'aa11bb22cc33dd44ee55ff6677889900';
const TRIGGER_ID = 'fa58fc5793ff87d087b0f14fdd03d699';
const ACTION_UI_ID = 'action-ui-published-1';

function wrapped(value) {
  return { schemaless: false, schemalessValue: '', value };
}

function baseDefinition() {
  return {
    id: FLOW_ID,
    scope: 'global',
    updated: '2026-06-12 22:14:52',
    security: { can_read: true, can_write: true, reason: '' },
    triggerInstances: [{
      sysId: TRIGGER_ID,
      type: 'record_create_or_update',
      triggerType: 'Record',
      metadata: JSON.stringify({ query_parse: { predicates: [], custom: 'preserve' } }),
      inputs: [
        { name: 'table', id: 'table-input', displayField: 'number', displayValue: wrapped('Task'), value: wrapped('ticket') },
        { name: 'condition', id: 'condition-input', displayValue: wrapped('short_descriptionSTARTSWITHjsn295'), value: wrapped('short_descriptionSTARTSWITHjsn295') },
        { name: 'run_flow_in', value: wrapped('any') },
      ],
    }],
    actionInstances: [{
      id: 'action-instance-1',
      uiUniqueIdentifier: ACTION_UI_ID,
      actionTypeSysId: 'action-type-123',
      actionType: { sys_id: 'action-type-123', name: 'Log' },
      order: '1',
      metadata: '{"keep":true}',
      inputs: [
        { id: 'input-1', name: 'log_level', parameter: { name: 'log_level', type: 'choice' }, value: wrapped('info'), displayValue: wrapped('info') },
        { id: 'input-2', name: 'log_message', parameter: { name: 'log_message', type: 'string' }, value: wrapped('original message'), displayValue: wrapped('original message') },
      ],
    }],
    flowVariables: [{ id: 'variable-1', name: 'keep-me' }],
  };
}

function snapshotDefinition() {
  // The frozen published copy: different instance ids and timestamp than the
  // working definition, which is exactly why a digest of it is meaningful.
  const copy = baseDefinition();
  copy.id = SNAPSHOT_ID;
  copy.parentFlow = FLOW_ID;
  copy.updated = '2026-01-06 06:39:39';
  copy.actionInstances = [{ ...copy.actionInstances[0], id: 'published-action-instance', uiUniqueIdentifier: 'published-ui-1' }];
  return copy;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function makePublishedSdk(overrides = {}) {
  const calls = [];
  const state = {
    canWrite: overrides.canWrite,
    securityField: overrides.securityField !== false,
    active: overrides.active ?? 'true',
    status: overrides.status ?? 'published',
    definition: baseDefinition(),
    snapshot: snapshotDefinition(),
    pointers: {
      active: overrides.active ?? 'true',
      status: overrides.status ?? 'published',
      master_snapshot: SNAPSHOT_ID,
      latest_snapshot: SNAPSHOT_ID,
      version_record: VERSION_ID,
    },
    versions: [{ sys_id: VERSION_ID, flow: FLOW_ID, type: 'update', sys_created_on: '2026-06-12 22:14:53' }],
    lease: false,
    leaseReads: 0,
    patched: false,
  };
  if (overrides.securityField === false) delete state.definition.security;
  else state.definition.security = { can_read: true, can_write: state.canWrite !== false, reason: '' };

  const record = () => ({
    sys_id: { value: FLOW_ID, display_value: FLOW_ID },
    name: { value: 'JSN-STUDY-295-PUB published fixture', display_value: 'JSN-STUDY-295-PUB published fixture' },
    sys_scope: { value: 'global', display_value: 'Global' },
    scope: { value: '', display_value: '' },
    active: { value: state.pointers.active, display_value: state.pointers.active },
    status: { value: state.pointers.status, display_value: state.pointers.status },
    master_snapshot: { value: state.pointers.master_snapshot, display_value: state.pointers.master_snapshot },
    latest_snapshot: { value: state.pointers.latest_snapshot, display_value: state.pointers.latest_snapshot },
    version_record: { value: state.pointers.version_record, display_value: state.pointers.version_record },
    // A publish moves the record timestamp, not the definition's.
    sys_updated_on: { value: overrides.recordUpdated ?? '2026-06-13 01:02:03', display_value: overrides.recordUpdated ?? '2026-06-13 01:02:03' },
  });

  const sdk = {
    calls,
    state,
    async list(table, params) {
      calls.push({ kind: 'list', table, params: String(params) });
      if (table === 'sys_hub_flow') return [record()];
      if (table === 'sys_hub_flow_version') return state.versions.map(row => ({
        sys_id: { value: row.sys_id }, flow: { value: row.flow }, type: { value: row.type }, sys_created_on: { value: row.sys_created_on },
      }));
      if (table === 'sys_hub_action_type_definition') return [{ sys_id: { value: 'action-type-123' }, name: { value: 'Log' }, active: { value: 'true' } }];
      if (table === 'sys_db_object') return [{ name: { value: 'ticket' }, label: { value: 'Ticket' }, super_class: { value: '' } }];
      if (table === 'sys_dictionary') return [];
      if (table === 'sys_update_xml') return [{ sys_id: 'xml-1', payload: FLOW_ID }];
      return [];
    },
    async request(endpoint, options = {}) {
      calls.push({ kind: 'request', endpoint, method: options.method || 'GET', body: options.body });
      const query = options.body ? JSON.parse(options.body).query : undefined;
      if (options.method === 'POST' && endpoint.endsWith('/api/now/graphql')) {
        if (query?.includes('safeEdit(')) {
          if (query.includes('upsert:')) {
            state.lease = true;
            return { data: { global: { snFlowDesigner: { safeEdit: { status: { canUserEdit: true, currentEditor: null, clientFlowStale: false } } } } } };
          }
          if (query.includes('delete:')) {
            state.lease = false;
            return { data: { global: { snFlowDesigner: { safeEdit: { deleteResult: { deleteSuccess: true, id: FLOW_ID } } } } } };
          }
          state.leaseReads += 1;
          // A provider that leaves a lease behind passes the release readback but
          // still reports the session on the caller's final absence check.
          const present = state.lease || (Boolean(overrides.leaseAfterRelease) && state.leaseReads >= 3);
          return { data: { global: { snFlowDesigner: { safeEdit: { status: { canUserEdit: present, currentEditor: present ? 'admin' : null } } } } } };
        }
        assert.match(query, /flowPatch:/);
        assert.ok(state.lease, 'a published content write must own the safe-edit lease');
        state.patched = true;
        // The provider applies only the requested value.
        state.definition.actionInstances[0].inputs[1] = { ...state.definition.actionInstances[0].inputs[1], value: wrapped('edited message'), displayValue: wrapped('edited message') };
        if (overrides.snapshotChanges) state.snapshot = { ...state.snapshot, annotation: 'changed by someone else' };
        return { data: { global: { snFlowDesigner: { flow: { triggerInstances: { updates: [] }, actions: { updates: [ACTION_UI_ID] } } } } } };
      }
      if (options.method === 'POST' && endpoint.includes('/versioning/create_version')) {
        state.versions = [...state.versions, { sys_id: AUTOSAVE_ID, flow: FLOW_ID, type: 'Autosave', sys_created_on: '2026-06-13 01:02:04' }];
        if (overrides.checkout) Object.assign(state.pointers, { status: 'draft', version_record: AUTOSAVE_ID });
        if (overrides.pointerDrift) Object.assign(state.pointers, overrides.pointerDrift);
        return { result: { sys_id: AUTOSAVE_ID, type: 'Autosave' } };
      }
      if (options.method === 'GET' && endpoint.includes(`/processflow/flow/${SNAPSHOT_ID}?`)) return { result: { data: state.snapshot } };
      if (options.method === 'GET' && endpoint.includes(`/processflow/flow/${encodeURIComponent(FLOW_ID)}?`)) return { result: { data: state.definition } };
      throw new Error(`unexpected request ${options.method || 'GET'} ${endpoint}`);
    },
  };
  // A snapshot that changes must also be observable through the frozen copy only.
  if (overrides.snapshotChanges) sdk.snapshotDigestChanges = true;
  sdk.helpers = { digest, snapshotDefinition };
  return sdk;
}

const editManifest = { actions: [{ order: 1, type: 'Log', inputs: { log_message: 'edited message' } }] };
const instance = 'https://example.service-now.com';
const readUpdateSet = async () => ({ name: 'JSN-STUDY-295-published', sys_id: 'update-set-1' });

function posts(sdk) {
  return sdk.calls.filter(call => call.kind === 'request' && call.method === 'POST');
}

function graphqlQueries(sdk) {
  return posts(sdk).filter(call => call.endpoint.endsWith('/api/now/graphql')).map(call => JSON.parse(call.body).query);
}

function patchQueries(sdk) {
  return graphqlQueries(sdk).filter(query => query.includes('flowPatch:'));
}

describe('published flow updates', () => {
  it('saves a published active flow whose definition reports can_write=true without touching its snapshot', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk();
    const result = await updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet });

    assert.equal(result.flow.id, FLOW_ID);
    assert.equal(result.flow.active, true);
    assert.equal(result.flow.status, 'published');
    assert.equal(result.version.type.value ?? result.version.type, 'Autosave');
    assert.equal(result.lifecycle.published, true);
    assert.equal(result.lifecycle.runtime_preserved, true);
    assert.equal(result.lifecycle.active, true);
    assert.equal(result.lifecycle.executed, false);
    assert.equal(result.lifecycle.safe_edit_lease, 'absent');
    assert.equal(result.runtime_preservation.verified, true);
    assert.equal(result.runtime_preservation.safe_edit_lease, 'absent');
    assert.equal(result.runtime_preservation.before.published_definition.snapshot_id, SNAPSHOT_ID);
    assert.equal(result.runtime_preservation.after.published_definition.digest, result.runtime_preservation.before.published_definition.digest);
    assert.equal(result.runtime_preservation.after.record.active, 'true');
    assert.equal(result.runtime_preservation.after.record.master_snapshot, SNAPSHOT_ID);
    assert.equal(result.runtime_preservation.after.record.version_record, VERSION_ID);

    // The published definition is read through the snapshot id, twice (baseline
    // and after the save), and never written.
    const snapshotReads = sdk.calls.filter(call => call.method === 'GET' && call.endpoint.includes(SNAPSHOT_ID));
    assert.equal(snapshotReads.length, 2);
    assert.equal(patchQueries(sdk).length, 1, 'exactly one content mutation');
    assert.ok(posts(sdk).some(call => call.endpoint.includes('/versioning/create_version')));
    // Lease lifecycle: read, upsert, patch, delete, release read, final absence read.
    const safeEditQueries = graphqlQueries(sdk);
    assert.match(safeEditQueries[0], /safeEdit.*read:/);
    assert.match(safeEditQueries[1], /safeEdit.*upsert:.*lastUpdated:"2026-06-12 22:14:52"/);
    assert.match(safeEditQueries[2], /flowPatch:/);
    assert.match(safeEditQueries[3], /safeEdit.*delete:/);
    assert.equal(safeEditQueries.filter(query => /safeEdit.*read:/.test(query)).length, 3);
  });

  it('refuses a published flow whose definition reports can_write=false before any content write', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ canWrite: false });
    await assert.rejects(
      updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }),
      error => /security\.can_write=false/.test(error.message)
        && /Insufficient access level for operation \[write\]/.test(error.message)
        && /content-permission problem, not a published-flow limitation/.test(error.message)
        && !/designer-only|checkout is not verified/i.test(error.message),
    );
    assert.equal(posts(sdk).length, 0, 'no edit session, content write or Autosave');
    assert.equal(sdk.calls.filter(call => call.kind === 'request' && call.method !== 'GET').length, 0);
    // The published snapshot is still read for the baseline only when the gate passes.
    assert.equal(sdk.calls.filter(call => call.method === 'GET' && call.endpoint.includes(SNAPSHOT_ID)).length, 0);
  });

  it('refuses a published flow whose definition omits security.can_write', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ securityField: false });
    await assert.rejects(updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }), /reports no security\.can_write/);
    assert.equal(posts(sdk).length, 0);
  });

  it('treats a published flow that is not active as a published target, not a draft', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const writable = makePublishedSdk({ active: 'false', status: 'published' });
    const result = await updateFlowFromManifest(writable, instance, FLOW_ID, editManifest, { readUpdateSet });
    assert.equal(result.flow.active, false);
    assert.equal(result.flow.status, 'published');
    assert.equal(result.lifecycle.published, true);

    const refused = makePublishedSdk({ active: 'false', status: 'published', canWrite: false });
    await assert.rejects(updateFlowFromManifest(refused, instance, FLOW_ID, editManifest, { readUpdateSet }), /inactive, status=published.*can_write=false/);
    assert.equal(posts(refused).length, 0);
  });

  it('fails loudly and reports the stage when the published snapshot changes during the edit', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ snapshotChanges: true });
    await assert.rejects(updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }), error => {
      assert.match(error.message, /published runtime state changed/);
      assert.match(error.message, /published_definition/);
      assert.match(error.message, /last completed stage: autosave_verified/);
      assert.match(error.message, /may have altered runtime/);
      assert.match(error.message, /No rollback, publish or execution attempted/);
      return true;
    });
    // No rollback, republish, unpublish or deactivate attempt.
    const endpoints = sdk.calls.filter(call => call.kind === 'request').map(call => call.endpoint);
    assert.ok(!endpoints.some(endpoint => /activate_flows|deactivate|unpublish/.test(endpoint)));
    assert.ok(!sdk.calls.some(call => call.kind === 'request' && call.method === 'DELETE'));
  });

  it('accepts and reports the platform checkout that saving a published flow performs', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ checkout: true });
    const result = await updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet });
    assert.equal(result.runtime_preservation.verified, true);
    const changes = result.runtime_preservation.design_time_changes;
    assert.deepEqual(changes.map(change => change.field).sort(), ['status', 'version_record']);
    const status = changes.find(change => change.field === 'status');
    assert.deepEqual({ before: status.before, after: status.after }, { before: 'published', after: 'draft' });
    const pointer = changes.find(change => change.field === 'version_record');
    assert.equal(pointer.after, AUTOSAVE_ID);
    // The runtime gates themselves never moved.
    assert.equal(result.runtime_preservation.after.record.active, 'true');
    assert.equal(result.runtime_preservation.after.record.master_snapshot, SNAPSHOT_ID);
    assert.equal(result.runtime_preservation.after.published_definition.digest, result.runtime_preservation.before.published_definition.digest);
    // The post-save record read is what the caller sees: active stays true, the
    // design-time status is now the draft working copy.
    assert.equal(result.flow.active, true);
    assert.equal(result.flow.status, 'draft');
    assert.equal(result.lifecycle.published, true);
  });

  it('fails loudly when a runtime pointer moves during the save', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ pointerDrift: { version_record: 'bbbbccccddddeeeeffff000011112222' } });
    await assert.rejects(updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }), error => {
      assert.match(error.message, /published runtime state changed/);
      assert.match(error.message, /version_record/);
      assert.match(error.message, new RegExp(VERSION_ID));
      return true;
    });
  });

  it('fails loudly when active or status move outside the checkout transition', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    for (const drift of [{ active: 'false' }, { status: 'retired' }]) {
      const sdk = makePublishedSdk({ pointerDrift: drift });
      await assert.rejects(updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }), error => {
        assert.match(error.message, /published runtime state changed/);
        assert.match(error.message, new RegExp(Object.keys(drift)[0]));
        return true;
      });
    }
  });

  it('previews a published writable flow with no mutations at all', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk();
    const result = await updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { preview: true, readUpdateSet });
    assert.equal(result.preview, true);
    assert.equal(result.flow.active, true);
    assert.equal(result.flow.status, 'published');
    assert.equal(result.lifecycle.published, true);
    assert.equal(result.lifecycle.lock_acquired, false);
    assert.deepEqual(result.changes, [{ component: 'action', order: 1, type: 'Log', input: 'log_message', before: 'original message', after: 'edited message' }]);
    assert.equal(sdk.calls.filter(call => call.kind === 'request' && call.method !== 'GET').length, 0);
    // Preview still refuses a non-writable published flow, read-only.
    const refused = makePublishedSdk({ canWrite: false });
    await assert.rejects(updateFlowFromManifest(refused, instance, FLOW_ID, editManifest, { preview: true, readUpdateSet }), /security\.can_write=false/);
    assert.equal(posts(refused).length, 0);
  });

  it('reports a safe-edit lease that survives the save instead of claiming success', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ leaseAfterRelease: true });
    await assert.rejects(updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet }), error => {
      assert.match(error.message, /update saved \(Autosave/);
      assert.match(error.message, /safe edit lease is still present/);
      assert.match(error.message, /No rollback or unpublish attempted/);
      return true;
    });
  });

  it('keeps the draft path unchanged: an inactive draft needs no can_write check', async () => {
    const { updateFlowFromManifest } = await import('../src/flow-create.js');
    const sdk = makePublishedSdk({ active: 'false', status: 'draft', securityField: false, recordUpdated: '2026-06-12 22:14:52' });
    sdk.state.pointers.master_snapshot = '';
    sdk.state.pointers.latest_snapshot = '';
    const result = await updateFlowFromManifest(sdk, instance, FLOW_ID, editManifest, { readUpdateSet });
    assert.equal(result.lifecycle.published, false);
    assert.equal(result.lifecycle.supported.includes('published working-definition edit'), false);
    assert.equal(result.runtime_preservation, undefined);
    assert.equal(result.version.type.value ?? result.version.type, 'Autosave');
    assert.equal(sdk.calls.filter(call => call.method === 'GET' && call.endpoint.includes(SNAPSHOT_ID)).length, 0);
  });
});

describe('published lifecycle fields', () => {
  it('classifies lifecycle from active and status, not from one field alone', async () => {
    const { flowLifecycleState } = await import('../src/flow-create.js');
    assert.deepEqual(flowLifecycleState({ active: 'true', status: 'published' }), { active: true, status: 'published', draft: false });
    assert.deepEqual(flowLifecycleState({ active: 'false', status: 'published' }), { active: false, status: 'published', draft: false });
    assert.deepEqual(flowLifecycleState({ active: 'false', status: 'draft' }), { active: false, status: 'draft', draft: true });
    assert.deepEqual(flowLifecycleState({ active: { value: 'true' }, status: { value: 'published' } }), { active: true, status: 'published', draft: false });
    assert.equal(flowLifecycleState({ active: 'true', status: 'draft' }).draft, false, 'an active flow is never a draft');
  });
});
