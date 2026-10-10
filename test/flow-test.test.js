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
