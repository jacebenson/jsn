import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedFlowVersion } from '../src/flow-versioning.js';

const INSTANCE = 'https://example.service-now.com';
const FLOW = 'fedcba9876543210fedcba9876543210';
const OLD = { sys_id: 'old-version', flow: { value: FLOW, display_value: 'Test flow' }, type: { value: '0', display_value: 'Autosave' } };
const NEW = { sys_id: 'new-version', flow: { value: FLOW, display_value: 'Test flow' }, type: { value: '0', display_value: 'Autosave' } };

function sdkWithVersions(before, after, response = { result: { sys_id: 'new-version' } }) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    sdk: {
      async list(table, params) {
        calls.push({ kind: 'list', table, params: Object.fromEntries(params) });
        if (table !== 'sys_hub_flow_version') return [];
        return reads++ === 0 ? before : after;
      },
      async request(endpoint, options) {
        calls.push({ kind: 'request', endpoint, options });
        return response;
      },
    },
  };
}

test('createVerifiedFlowVersion requires a new exact-flow version and scopes the request', async () => {
  const { sdk, calls } = sdkWithVersions([OLD], [NEW, OLD]);
  const result = await createVerifiedFlowVersion(sdk, {
    instance: INSTANCE, flowId: FLOW, scope: 'scope-1', type: 'Autosave', annotation: 'JSN test',
  });
  assert.deepEqual(result.version, NEW);
  assert.equal(calls[0].params.sysparm_query, `flow=${FLOW}^ORDERBYDESCsys_updated_on`);
  const request = calls.find(call => call.kind === 'request');
  assert.equal(request.endpoint, `${INSTANCE}/api/now/processflow/versioning/create_version?sysparm_transaction_scope=scope-1`);
  assert.deepEqual(JSON.parse(request.options.body), {
    item_sys_id: FLOW, type: 'Autosave', annotation: 'JSN test', favorite: false,
  });
});

test('createVerifiedFlowVersion rejects a stale response or a version that was not read back', async () => {
  const staleResponse = sdkWithVersions([OLD], [OLD], { result: { sys_id: 'old-version' } });
  await assert.rejects(createVerifiedFlowVersion(staleResponse.sdk, {
    instance: INSTANCE, flowId: FLOW, scope: 'scope-1', type: 'Autosave', annotation: 'JSN test',
  }), /new Autosave version.*read back/i);
  const missingResponse = sdkWithVersions([OLD], [OLD], { result: { accepted: true } });
  await assert.rejects(createVerifiedFlowVersion(missingResponse.sdk, {
    instance: INSTANCE, flowId: FLOW, scope: 'scope-1', type: 'Autosave', annotation: 'JSN test',
  }), /new Autosave version.*read back/i);
});

test('createVerifiedFlowVersion rejects multiple concurrent new versions without guessing', async () => {
  const { sdk } = sdkWithVersions([], [NEW, { sys_id: 'other-version', flow: FLOW, type: 'Autosave' }], { result: {} });
  await assert.rejects(createVerifiedFlowVersion(sdk, {
    instance: INSTANCE, flowId: FLOW, scope: 'scope-1', type: 'Autosave', annotation: 'JSN test',
  }), /ambiguous.*new Autosave versions/i);
});
