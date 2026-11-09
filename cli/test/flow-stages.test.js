// Stage placement, derived from a captured Flow Designer session
// (PUT /processflow/flow/{id}/stages and the stages{insert|update} patch).
//
// Contract under test:
//   * an insert builds the stage object Flow Designer sends: UUID stageId,
//     display label, machine value, order, system flag, componentIndexes and the
//     standard states map
//   * placement onto an existing stage is a `stages.update` with
//     `componentIndexes`, which is how the UI moves steps onto a stage
//   * a stage manifest that changes nothing, or names an unknown field, is
//     refused before any request
//
// Offline: builders and validators only, no instance.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildStageInserts, buildStageUpdates, buildFlowStageMutation, buildFlowUpdateMutation, validateStages, validateFlowUpdateManifest, validateFlowManifest } = await import('../src/flow-create.js');

const STAGE_UUID = '07d8521a-1759-4260-8d2a-62ac163218d8';

describe('flow stages', () => {
  it('builds an insert in the shape Flow Designer sends', () => {
    const ids = ['stage-uuid-1', 'stage-uuid-2'];
    let next = 0;
    const inserts = buildStageInserts([
      { label: 'Waiting for Approval', componentIndexes: [2, 3] },
      { label: 'Fulfillment', componentIndexes: [4] },
    ], () => ids[next++]);

    assert.deepEqual(inserts.map(stage => ({
      stageId: stage.stageId, label: stage.label, value: stage.value,
      order: stage.order, system: stage.system, componentIndexes: stage.componentIndexes,
      duration: stage.duration,
    })), [
      { stageId: 'stage-uuid-1', label: 'Waiting for Approval', value: 'waiting_for_approval', order: 0, system: false, componentIndexes: [2, 3], duration: '1970-01-01 00:00:00' },
      { stageId: 'stage-uuid-2', label: 'Fulfillment', value: 'fulfillment', order: 1, system: false, componentIndexes: [4], duration: '1970-01-01 00:00:00' },
    ]);
    assert.deepEqual(inserts[0].states, {
      pending: 'Pending - has not started', in_progress: 'In progress',
      skipped: 'Skipped', complete: 'Completed', error: 'Error',
    });
  });

  it('orders inserts by the manifest order field', () => {
    const inserts = buildStageInserts([{ label: 'Second', order: 5 }, { label: 'First', order: 1 }], () => 'id');
    assert.deepEqual(inserts.map(stage => [stage.label, stage.order]), [['First', 1], ['Second', 5]]);
  });

  it('places steps on an existing stage through stages.update', () => {
    const updates = buildStageUpdates([{ stageId: STAGE_UUID, componentIndexes: [3] }]);
    assert.deepEqual(updates, [{ stageId: STAGE_UUID, componentIndexes: [3] }]);

    const mutation = buildFlowUpdateMutation({ flowId: 'flow-1', stageUpdates: updates });
    assert.match(mutation, /stages: \{update: \[\{stageId: "07d8521a-1759-4260-8d2a-62ac163218d8", componentIndexes: \[3\]\}\]\}/);
    // The response selection has to name stages, or a placement failure reads as success.
    assert.match(mutation, /stages \{ inserts \{ sysId \} \}/);
    // A stage-only patch must not carry a trigger or action update.
    assert.doesNotMatch(mutation, /flowPatch: \{flowId: "flow-1", triggerInstances/);
  });

  it('creates stages through their own patch after the actions exist', () => {
    const mutation = buildFlowStageMutation({
      flowId: 'flow-1',
      inserts: buildStageInserts([{ label: 'Delivery', componentIndexes: [1] }], () => 'inserted-uuid'),
    });
    assert.match(mutation, /flowId: "flow-1", stages: \{insert: \[\{stageId: "inserted-uuid"/);
    assert.match(mutation, /componentIndexes: \[1\]/);
    assert.match(mutation, /stages \{ inserts \{ sysId \} \}/);
  });

  it('refuses a stage entry that would change nothing', () => {
    assert.throws(() => validateStages([{ stageId: STAGE_UUID }], { update: true }), /must change label, value, order or componentIndexes/);
    assert.throws(() => validateStages([{ label: 'x', stageId: STAGE_UUID }]), /stageId is only accepted when updating/);
    assert.throws(() => validateStages([{ label: 'x', componentIndexes: [0] }]), /componentIndexes must be an array of flow-step orders/);
    assert.throws(() => validateStages([{ label: 'x', order: -1 }]), /order must be a non-negative integer/);
    assert.throws(() => validateStages([{ label: 'x', colour: 'red' }]), /field "colour" is unsupported/);
    assert.throws(() => validateStages([{ componentIndexes: [1] }]), /requires a label/);
  });

  it('accepts stages alone as an update and in a create manifest', () => {
    assert.doesNotThrow(() => validateFlowUpdateManifest({ stages: [{ label: 'Delivery' }] }));
    assert.doesNotThrow(() => validateFlowUpdateManifest({ stages: [{ stageId: STAGE_UUID, componentIndexes: [2] }] }));
    assert.throws(() => validateFlowUpdateManifest({}), /must specify trigger, actions and\/or stages/);

    assert.doesNotThrow(() => validateFlowManifest({
      name: 'Flow', scope: 'global',
      trigger: { type: 'record_create_or_update', table: 'incident' },
      actions: [{ type: 'Log', inputs: {} }],
      stages: [{ label: 'Fulfillment', componentIndexes: [1] }],
    }));
    assert.throws(() => validateFlowManifest({
      name: 'Flow', scope: 'global',
      trigger: { type: 'record_create_or_update', table: 'incident' },
      actions: [{ type: 'Log', inputs: {} }],
      stages: [{ stageId: STAGE_UUID, componentIndexes: [1] }],
    }), /stageId is only accepted when updating/);
  });

  it('reads a catalog item\'s variables and builds the trigger input value', async () => {
    const { readCatalogItemVariables } = await import('../src/flow-create.js');
    const calls = [];
    const sdk = {
      async request(url, options) {
        calls.push({ url, method: options.method, body: JSON.parse(options.body) });
        return { result: { data: { availableList: [
          { id: '036bca7793b7431016c8fd18dd03d61b', name: 'hotel', label: 'Hotel needed?', type: 'boolean', mandatory: 'true', readonly: 'false' },
          { id: '5b6bca7793b7431016c8fd18dd03d65b', name: 'car', label: 'Rental car needed?', type: 'boolean', mandatory: 'true', readonly: 'false' },
        ] } } };
      },
    };
    const result = await readCatalogItemVariables(sdk, 'https://example.service-now.com', 'flow-1', '5fccb54093a45f5016c8fd18dd03d63d', { scope: 'global' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/api\/now\/processflow\/flow\/flow-1\/service_get_catalog_variables\?sysparm_transaction_scope=global$/);
    assert.deepEqual(calls[0].body, { flow_catalog_model: '5fccb54093a45f5016c8fd18dd03d63d', includeMultiRowVariableSets: true, selectedVariables: '' });

    assert.equal(result.count, 2);
    assert.deepEqual(result.variables[0], { id: '036bca7793b7431016c8fd18dd03d61b', name: 'hotel', label: 'Hotel needed?', type: 'boolean', mandatory: true, readonly: false });
    // The value a manifest pastes into the trigger's catalog_variables input.
    assert.equal(result.catalog_variables_input, '036bca7793b7431016c8fd18dd03d61b,5b6bca7793b7431016c8fd18dd03d65b');
  });

  it('refuses a catalog lookup without an item or with an unusable response', async () => {
    const { readCatalogItemVariables } = await import('../src/flow-create.js');
    await assert.rejects(readCatalogItemVariables({ request: async () => ({}) }, 'https://example.service-now.com', 'flow-1', ''),
      /requires a catalog item sys_id/);
    await assert.rejects(readCatalogItemVariables({ request: async () => ({ result: {} }) }, 'https://example.service-now.com', 'flow-1', '5fccb54093a45f5016c8fd18dd03d63d'),
      /returned no availableList/);
  });
});
