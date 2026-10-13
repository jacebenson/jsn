import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testFlow, deriveRecordTrigger } from '../src/flow-test.js';

const INSTANCE = 'https://example.service-now.com';
const RECORD = '0123456789abcdef0123456789abcdef';
const FLOW = 'fedcba9876543210fedcba9876543210';
const definition = {
  flowId: FLOW,
  scope: 'scope-1',
  triggerInstances: [{ triggerType: 'record_create_or_update', inputs: [{ name: 'table', value: { value: 'ticket' } }] }],
  actionInstances: [{ id: 'action-1', type: 'action' }],
};

test('deriveRecordTrigger rejects unsupported and incomplete definitions', () => {
  assert.deepEqual(deriveRecordTrigger(definition), {
    trigger: definition.triggerInstances[0], type: 'record_create_or_update', table: 'ticket',
  });
  assert.throws(() => deriveRecordTrigger({ triggerInstances: [{ triggerType: 'scheduled' }] }), /only record_create_or_update/i);
  assert.throws(() => deriveRecordTrigger({ triggerInstances: [{ triggerType: 'record_create_or_update', inputs: [] }] }), /no table/i);
});

// The saved instance carries the FAMILY in `type` and the picker CATEGORY in
// `triggerType` ("Record"). Reading the category as the family rejected every
// flow this CLI creates. Legacy instances that only have triggerType keep working.
test('deriveRecordTrigger reads the family from type with a legacy triggerType fallback', () => {
  const providerShape = {
    triggerInstances: [{ type: 'record_create_or_update', triggerType: 'Record', inputs: [{ name: 'table', value: { value: 'ticket' } }] }],
  };
  assert.deepEqual(deriveRecordTrigger(providerShape), {
    trigger: providerShape.triggerInstances[0], type: 'record_create_or_update', table: 'ticket',
  });
  const legacy = { triggerInstances: [{ triggerType: 'record_create_or_update', inputs: [{ name: 'table', value: { value: 'ticket' } }] }] };
  assert.equal(deriveRecordTrigger(legacy).type, 'record_create_or_update');
  assert.throws(() => deriveRecordTrigger({ triggerInstances: [{ type: 'daily', triggerType: 'Scheduled' }] }), /found daily/);
  assert.throws(() => deriveRecordTrigger({ triggerInstances: [{ type: { value: 'record_create' }, triggerType: 'Record' }] }), /found record_create/);
});

test('testFlow validates record before dispatch and posts exact saved definition', async () => {
  const calls = [];
  const sdk = {
    async list(table, params) {
      calls.push(['list', table, Object.fromEntries(params)]);
      if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: 'scope-1' }];
      if (table === 'ticket') return [{ sys_id: RECORD }];
      return [];
    },
    async request(url, options = {}) {
      calls.push(['request', url, options]);
      if (options.method === 'GET') return { result: { data: definition } };
      assert.equal(url, `${INSTANCE}/api/now/processflow/flow/${FLOW}/test?sysparm_transaction_scope=scope-1`);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.flowId, FLOW);
      assert.deepEqual(body.actionInstances, definition.actionInstances);
      assert.deepEqual(body.outputMap, { current: RECORD, table_name: 'ticket' });
      assert.equal(body.runOnThread, true);
      assert.equal(body.tracingEnabled, false);
      return { result: { context_id: 'context-1' } };
    },
  };
  const result = await testFlow(sdk, INSTANCE, FLOW, RECORD);
  assert.equal(calls[0][1], 'sys_hub_flow');
  assert.equal(calls[0][2].sysparm_query, `sys_id=${FLOW}`);
  assert.ok(calls.some(call => call[0] === 'request' && call[1] === `${INSTANCE}/api/now/processflow/flow/${FLOW}?sysparm_transaction_scope=scope-1`));
  assert.equal(result.status, 'accepted');
  assert.equal(result.context_id, 'context-1');
  assert.equal(calls.filter(call => call[0] === 'request' && call[2]?.method === 'POST').length, 1);
});

test('testFlow rejects encoded-query operators in flow names before lookup', async () => {
  let lists = 0;
  const sdk = {
    async list() { lists += 1; return []; },
    async request() { throw new Error('must not request'); },
  };
  await assert.rejects(testFlow(sdk, INSTANCE, 'flow^ORactive=true', RECORD), /unsafe.*exact-match|query characters/i);
  assert.equal(lists, 0);
});

test('testFlow honors explicit failure and does not treat string false as completed', async () => {
  const run = async (dispatchResponse) => {
    const sdk = {
      async list(table) {
        if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: 'scope-1' }];
        if (table === 'ticket') return [{ sys_id: RECORD }];
        return [];
      },
      async request(_url, options = {}) {
        if (options.method === 'GET') return { result: { data: definition } };
        return dispatchResponse;
      },
    };
    return testFlow(sdk, INSTANCE, FLOW, RECORD);
  };

  const explicitFailure = await run({ result: { completed: true, success: false } });
  assert.equal(explicitFailure.status, 'completed');
  assert.equal(explicitFailure.success, false);

  const stringFalse = await run({ result: { completed: 'false' } });
  assert.equal(stringFalse.status, 'accepted');
  assert.equal(stringFalse.success, undefined);
});

test('testFlow never dispatches for a missing record or transport failure', async () => {
  let posts = 0;
  const sdk = {
    async list(table) {
      if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: 'scope-1' }];
      if (table === 'ticket') return [];
      return [];
    },
    async request(_url, options = {}) {
      if (options.method === 'POST') posts += 1;
      return { result: { data: definition } };
    },
  };
  await assert.rejects(testFlow(sdk, INSTANCE, FLOW, 'record-1'), /32-character sys_id/);
  assert.equal(posts, 0);
  await assert.rejects(testFlow(sdk, INSTANCE, FLOW, RECORD), /was not found.*not dispatched/i);
  assert.equal(posts, 0);

  const timeoutSdk = {
    async list(table) {
      if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: 'scope-1' }];
      return [{ sys_id: RECORD }];
    },
    async request(_url, options = {}) {
      if (options.method === 'POST') throw new Error('timeout');
      return { result: { data: definition } };
    },
  };
  await assert.rejects(testFlow(timeoutSdk, INSTANCE, FLOW, RECORD), /dispatch failed.*timeout/i);
});

// sys_hub_flow has no populated scope column on current instances: the raw
// transaction scope rides on the sys_scope reference, and the display name is a
// label that must never be sent as sysparm_transaction_scope.
test('testFlow reads the transaction scope from the sys_scope reference with a legacy scope fallback', async () => {
  const SCOPE_ID = '1169a246933f8f9087b0f14fdd03d627';
  const SCOPE_NAME = 'JSN-STUDY-SCOPE-20261009-1137';
  const urls = [];
  const listFields = [];
  const providerSdk = {
    async list(table, params) {
      if (table === 'sys_hub_flow') {
        listFields.push(params.get('sysparm_fields'));
        return [{ sys_id: FLOW, name: 'Draft flow', scope: '', active: 'false', status: 'draft',
          sys_scope: { display_value: SCOPE_NAME, value: SCOPE_ID, link: `${INSTANCE}/api/now/table/sys_scope/${SCOPE_ID}` } }];
      }
      if (table === 'ticket') return [{ sys_id: RECORD }];
      return [];
    },
    async request(url, options = {}) {
      urls.push(url);
      if (options.method === 'GET') return { result: { data: { ...definition, scope: SCOPE_ID } } };
      return { result: { data: { state: 'success' } } };
    },
  };
  const result = await testFlow(providerSdk, INSTANCE, FLOW, RECORD);
  assert.equal(result.status, 'completed');
  assert.equal(urls[0], `${INSTANCE}/api/now/processflow/flow/${FLOW}?sysparm_transaction_scope=${SCOPE_ID}`);
  assert.ok(urls.some(url => url === `${INSTANCE}/api/now/processflow/flow/${FLOW}/test?sysparm_transaction_scope=${SCOPE_ID}`), 'the dispatch must carry the raw sys_id');
  assert.ok(urls.every(url => !url.includes(SCOPE_NAME)), 'the scope display name must never be sent');
  assert.ok(listFields.some(fields => fields.includes('sys_scope')), 'the flow read must ask for sys_scope');
  assert.ok(listFields.every(fields => fields.includes('scope')), 'the legacy scope field stays in the read');

  const legacyUrls = [];
  const legacySdk = {
    async list(table) {
      if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: 'scope-1' }];
      if (table === 'ticket') return [{ sys_id: RECORD }];
      return [];
    },
    async request(url, options = {}) {
      legacyUrls.push(url);
      if (options.method === 'GET') return { result: { data: definition } };
      return { result: { data: { state: 'success' } } };
    },
  };
  await testFlow(legacySdk, INSTANCE, FLOW, RECORD);
  assert.equal(legacyUrls[0], `${INSTANCE}/api/now/processflow/flow/${FLOW}?sysparm_transaction_scope=scope-1`);
});

test('testFlow refuses a flow record that carries neither sys_scope nor scope', async () => {
  let posts = 0;
  const sdk = {
    async list(table) {
      if (table === 'sys_hub_flow') return [{ sys_id: FLOW, name: 'Draft flow', scope: '', sys_scope: { display_value: '', value: '' } }];
      return [];
    },
    async request(_url, options = {}) {
      if (options.method === 'POST') posts += 1;
      return { result: {} };
    },
  };
  await assert.rejects(testFlow(sdk, INSTANCE, FLOW, RECORD), /no transaction scope; flow was not dispatched/);
  assert.equal(posts, 0);
});
