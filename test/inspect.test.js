import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRecord, resolveIdentifier, formatInspectOutput } from '../src/records/inspect.js';

describe('record inspection', () => {
  it('uses a sys_id directly without looking up a record number', async () => {
    const id = 'a'.repeat(32);
    const app = { sdk: { list: async () => assert.fail('a sys_id needs no lookup') } };
    assert.equal(await resolveIdentifier(app, 'incident', id), id);
  });

  it('resolves a record number through a bounded lookup', async () => {
    const calls = [];
    const app = { sdk: { list: async (table, params) => {
      calls.push([table, Object.fromEntries(params)]);
      return [{ sys_id: 'resolved-id' }];
    } } };
    assert.equal(await resolveIdentifier(app, 'incident', 'INC0010001'), 'resolved-id');
    assert.deepEqual(calls, [['incident', {
      sysparm_query: 'number=INC0010001', sysparm_limit: '1', sysparm_fields: 'sys_id',
    }]]);
  });

  it('reports a missing record instead of inspecting an undefined identity', async () => {
    const app = { sdk: { list: async () => [] } };
    await assert.rejects(resolveIdentifier(app, 'incident', 'INC404'), /Record not found in incident: INC404/);
  });

  it('rejects encoded-query injection before any lookup', async () => {
    const app = { sdk: { list: async () => assert.fail('unsafe identifiers must never reach the SDK') } };
    await assert.rejects(resolveIdentifier(app, 'incident', 'INC001^ORactive=true'), /Unsafe identifier/);
  });

  it('assembles audit history, ordered business rules and unavailable flows for the selected record', async () => {
    const id = 'a'.repeat(32);
    const calls = [];
    const app = { sdk: { list: async (table, params) => {
      calls.push([table, Object.fromEntries(params)]);
      if (table === 'sys_audit') return [{ fieldname: 'short_description', oldvalue: { value: 'old' }, newvalue: { value: 'new' }, sys_created_on: 'today', sys_created_by: 'fixture' }];
      if (table === 'sys_script') return [
        { name: 'Later', order: '200', sys_scope: 'global', when: 'before' },
        { name: 'Earlier', order: '10', sys_scope: 'global', when: 'before' },
      ];
      if (table === 'sys_dictionary') return [];
      if (table === 'sys_flow_context') throw new Error('Flow Designer unavailable');
      assert.fail(`unexpected table ${table}`);
    } } };
    const result = await inspectRecord(app, 'incident', id);
    assert.deepEqual(result, {
      table: 'incident', sys_id: id,
      history: [{ field: 'short_description', oldValue: 'old', newValue: 'new', _oldRaw: 'old', _newRaw: 'new', changedOn: 'today', changedBy: 'fixture' }],
      businessRules: [
        { name: 'Earlier', order: '10', scope: 'global', when: 'before', condition: '' },
        { name: 'Later', order: '200', scope: 'global', when: 'before', condition: '' },
      ], flows: [],
    });
    assert.equal(calls.find(([table]) => table === 'sys_audit')[1].sysparm_query, `documentkey=${id}^tablename=incident`);
    assert.equal(calls.find(([table]) => table === 'sys_script')[1].sysparm_query, 'collection=incident^active=true');
  });

  it('formats empty inspection sections with an explicit absence of results', () => {
    const result = formatInspectOutput({ table: 'incident', sys_id: 'abc123', history: [], businessRules: [], flows: [] });
    for (const text of ['incident', 'abc123', 'HISTORY', 'BUSINESS RULES', 'RUNNING FLOWS', '(no audit history found)', '(no active business rules on this table)', '(no running flows for this record)']) assert.ok(result.includes(text), text);
  });
});
