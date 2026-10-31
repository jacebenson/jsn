import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionTableCRUD, parseDecisionTablePayload } from '../src/decision-table-crud.js';
import { AppError } from '../src/errors.js';

describe('decision table CRUD payload parsing', () => {
  const DT = '0123456789abcdef0123456789abcdef';
  it('requires real sys_ids everywhere identifiers are sent to ServiceNow', async () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [{ sys_id: 'i1', label: 'X' }], questions: [] }, { operation: 'update' }), /32-character hexadecimal/);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], removals: { inputs: ['i1'] } }, { operation: 'update' }), /32-character hexadecimal/);
    await assert.rejects(() => new DecisionTableCRUD({}).update('not-a-sys-id', { parent: {}, inputs: [], questions: [] }), /intentionally unsupported over REST/);
    assert.doesNotThrow(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [{ sys_id: DT, label: 'X' }], questions: [] }, { operation: 'update' }));
  });

  it('accepts independently optional answer name and value fields', () => {
    const payload = parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [{ active: true, defaultAnswer: false, order: 1, answer: [{ name: 'result' }, { value: 'yes' }, {}] }] });
    assert.deepEqual(payload.questions[0].answer, [{ name: 'result' }, { value: 'yes' }, {}]);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [{ answer: [{ name: 4 }] }] }), /name must be a string/);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [{ answer: [{ value: 4 }] }] }), /value must be a string/);
  });

  it('matches the documented question create schema and rejects unknown top-level fields', () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [{ active: true, defaultAnswer: false, order: 1, label: 'not documented' }] }), /questions\[0\]\.label/);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], unexpected: true }), /unexpected/);
  });
  it('accepts partial updates and rejects fields outside the documented allowlist', () => {
    const payload = parseDecisionTablePayload({ parent: { name: 'Renamed', accessibleFrom: 'public' }, inputs: [{ sys_id: '11111111111111111111111111111111', label: 'New' }], questions: [] }, { operation: 'update' });
    assert.equal(payload.parent.accessibleFrom, 'public');
    assert.equal(payload.inputs[0].label, 'New');
    assert.throws(() => parseDecisionTablePayload({ parent: { description: 'nope' }, inputs: [], questions: [] }, { operation: 'update' }), /description/);
  });

  it('only accepts maxsize for String elements', () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [{ label: 'X', type: 'Integer', maxsize: 4 }], questions: [] }), /maxsize/);
  });
  it('accepts a complete parent, inputs, and questions payload', () => {
    const payload = parseDecisionTablePayload(JSON.stringify({
      parent: { name: 'Approval', accessibleFrom: 'public', scope: 'global' },
      inputs: [{ label: 'Priority', maxsize: 20, order: 100, type: 'String' }],
      questions: [{ active: true, answer: [{ name: 'result', value: 'yes' }], condition: 'priority=1^EQ', defaultAnswer: false, order: 100 }],
    }));
    assert.equal(payload.parent.name, 'Approval');
    assert.equal(payload.inputs[0].type, 'String');
  });

  it('accepts the complete table graph and defaults omitted collections', () => {
    const payload = parseDecisionTablePayload({
      parent: { name: 'Approval' }, inputs: [{ label: 'Priority', type: 'Integer', _key: 'in-1' }], questions: [],
      answerElements: [{ label: 'Outcome', type: 'Choice', _key: 'out-1' }],
      inputChoices: [{ input: 'in-1', label: 'High', value: '1' }],
      answerElementChoices: [{ answerElement: 'out-1', label: 'Approved', value: 'yes' }],
      conditions: [{ decisionInput: 'in-1', defaultOperator: 'is', label: 'Priority' }],
    });
    assert.equal(payload.answerElements[0].type, 'Choice');
    assert.equal(payload.inputChoices[0].input, 'in-1');
    assert.deepEqual(payload.removals, { inputs: [], answerElements: [], inputChoices: [], answerElementChoices: [], conditions: [], questions: [] });
  });
  it('rejects undocumented answer element types', () => {
    assert.throws(() => parseDecisionTablePayload({
      parent: { name: 'Approval' }, inputs: [], questions: [],
      answerElements: [{ label: 'Outcome', type: 'NotAType' }],
    }), /answerElements/);
  });

  it('rejects incomplete or malformed payloads', () => {
    assert.throws(() => parseDecisionTablePayload('{}'), /parent/);
    assert.throws(() => parseDecisionTablePayload(JSON.stringify({ parent: {}, inputs: [], questions: [] })), /name/);
    assert.throws(() => parseDecisionTablePayload(JSON.stringify({
      parent: { name: 'x' }, inputs: [{ label: 'x', type: 'Reference' }], questions: [],
    })), /reference/);
  });

  it('requires condition decisionInput to be a sys_id or declared input key', () => {
    assert.doesNotThrow(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [{ label: 'Priority', type: 'Integer', _key: 'priority' }], questions: [], conditions: [{ decisionInput: 'priority', label: 'Priority' }] }));
    assert.doesNotThrow(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], conditions: [{ decisionInput: DT, label: 'Priority' }] }));
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], conditions: [{ decisionInput: 'not-a-sys-id', label: 'Priority' }] }), /decisionInput/);
  });

  it('allows optional condition defaultOperator while requiring the other create fields', () => {
    const payload = parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], conditions: [{ decisionInput: DT, label: 'Priority' }] });
    assert.equal(payload.conditions[0].decisionInput, DT);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], conditions: [{ label: 'Priority' }] }), /decisionInput/);
  });

  it('rejects answer-element name because REST create cannot persist it', () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], answerElements: [{ name: 'result', label: 'Result', type: 'String' }] }), /answerElements\[0\]\.name/);
  });

  it('rejects arbitrary update-only fields on create', () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], answerElements: [{ label: 'Result', type: 'String', active: true }] }), /active/);
  });

  it('uses create-only fields from the documented create schemas', () => {
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [{ label: 'X', type: 'String', active: true }], questions: [] }), /inputs\[0\]\.active/);
    assert.throws(() => parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], answerElements: [{ label: 'X', type: 'String', comments: 'nope' }] }), /answerElements\[0\]\.comments/);
    const payload = parseDecisionTablePayload({ parent: { name: 'A' }, inputs: [], questions: [], answerElements: [{ label: 'X', type: 'String', order: 10 }] });
    assert.equal(payload.answerElements[0].order, 10);
  });

  it('rejects type and reference on existing input and answer-element updates', () => {
    for (const row of [
      { inputs: [{ sys_id: '11111111111111111111111111111111', type: 'String' }] },
      { inputs: [{ sys_id: '11111111111111111111111111111111', reference: 'task' }] },
      { answerElements: [{ sys_id: '22222222222222222222222222222222', type: 'String' }] },
      { answerElements: [{ sys_id: '22222222222222222222222222222222', reference: 'task' }] },
    ]) assert.throws(() => parseDecisionTablePayload({ parent: {}, questions: [], ...row }, { operation: 'update' }), /not documented/);
  });

  it('accepts runtime lowercase input and answer type spellings', () => {
    const payload = parseDecisionTablePayload({
      parent: { name: 'A' },
      inputs: [{ label: 'Integer', type: 'integer' }, { label: 'Boolean', type: 'true/false' }, { label: 'Text', type: 'string' }, { label: 'Ref', type: 'reference', reference: 'task' }],
      answerElements: [{ label: 'Choice', type: 'choice' }, { label: 'Text', type: 'string' }, { label: 'Ref', type: 'reference', reference: 'task' }],
      questions: [],
    });
    assert.deepEqual(payload.inputs.map(({ type }) => type), ['integer', 'true/false', 'string', 'reference']);
    assert.deepEqual(payload.answerElements.map(({ type }) => type), ['choice', 'string', 'reference']);
  });
});

describe('decision table CRUD REST adapter', () => {
  const parentId = '0123456789abcdef0123456789abcdef';
  const inputId = '11111111111111111111111111111111';
  const answerId = '22222222222222222222222222222222';
  const choiceId = '33333333333333333333333333333333';
  const conditionId = '44444444444444444444444444444444';

  function restDouble({ failInputReadback = false } = {}) {
    const records = new Map(); let inputReadbackFailures = failInputReadback ? 1 : 0;
    const calls = [];
    return { calls, sdk: {
      async create(table, body) {
        const id = { sys_decision: parentId, sys_decision_input: inputId, sys_decision_multi_result_element: answerId, sys_choice: choiceId, sn_decision_table_decision_condition: conditionId }[table];
        records.set(`${table}/${id}`, { sys_id: id, ...body }); calls.push(['create', table, body]); return { sys_id: id };
      },
      async get(table, id) {
        calls.push(['get', table, id]);
        if (table === 'sys_decision_input' && inputReadbackFailures-- > 0) throw new Error('readback failed');
        const row = records.get(`${table}/${id}`); if (!row) throw new AppError('api_error', 'not found', '', 404);
        if (table === 'sys_decision_input') return { ...row, name: 'input_name', element: 'u_input' };
        if (table === 'sys_decision_multi_result_element') return { ...row, name: 'answer_name', element: 'u_answer' };
        return row;
      },
      async delete(table, id) { calls.push(['delete', table, id]); records.delete(`${table}/${id}`); },
    } };
  }

  it('creates a REST graph and verifies exact persisted readback fields', async () => {
    const { sdk, calls } = restDouble();
    const result = await new DecisionTableCRUD(sdk, { scope: 'scope-id' }).create({ parent: { name: 'A', accessibleFrom: 'public' }, inputs: [{ label: 'Priority', type: 'Integer', order: 100 }] });
    assert.equal(result.status, 'Success'); assert.equal(result.parent.sys_id, parentId); assert.equal(result.inputs[0].sys_id, inputId);
    assert.deepEqual(calls.map(([method, table]) => `${method}:${table}`), ['create:sys_decision', 'get:sys_decision', 'create:sys_decision_input', 'get:sys_decision_input']);
    assert.deepEqual(calls[0][2], { name: 'A', access: 'public', sys_scope: 'scope-id' });
    assert.deepEqual(calls[2][2], { model: parentId, label: 'Priority', internal_type: 'integer', order: 100 });
  });

  it('maps answer elements, choices, and conditions through persisted REST metadata', async () => {
    const { sdk, calls } = restDouble();
    const result = await new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [{ label: 'Time', type: 'Choice', _key: 'time' }], inputChoices: [{ input: 'time', label: 'Morning', value: 'morning', order: 10 }], conditions: [{ decisionInput: 'time', defaultOperator: 'is', label: 'When', order: 20 }], answerElements: [{ label: 'Outcome', type: 'Choice', _key: 'outcome' }], answerElementChoices: [{ answerElement: 'outcome', label: 'Approved', value: 'yes' }] });
    assert.equal(result.inputChoices[0].sys_id, choiceId); assert.equal(result.conditions[0].sys_id, conditionId); assert.equal(result.answerElements[0].sys_id, answerId); assert.equal(calls.filter(([method]) => method === 'get').length, 6);
  });

  it('fails closed for unknown condition input keys and malformed identifiers', async () => {
    const { sdk } = restDouble();
    await assert.rejects(() => new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [{ label: 'Priority', type: 'Integer', _key: 'priority' }], conditions: [{ decisionInput: 'unknown', label: 'Priority' }] }), /unknown key|sys_id/);
    await assert.rejects(() => new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [], conditions: [{ decisionInput: 'not-a-sys-id', label: 'Priority' }] }), /sys_id/);
  });

  it('normalizes all non-word answer-element label characters for fallback fields', async () => {
    const { sdk } = restDouble();
    const originalGet = sdk.get;
    sdk.get = async (table, id) => {
      const row = await originalGet(table, id);
      if (table === 'sys_decision_multi_result_element' && row) return { ...row, name: 'generated', element: '' };
      return row;
    };
    const result = await new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, answerElements: [{ label: 'Result / Value', type: 'Choice' }] });
    assert.equal(result.answerElements[0].element, 'u_result_value');
  });
  it('fails closed when answer-element readback cannot produce a safe fallback field', async () => {
    const { sdk } = restDouble(); const originalGet = sdk.get;
    sdk.get = async (table, id) => { let row; try { row = await originalGet(table, id); } catch (error) { if (error.status === 404) return null; throw error; } return table === 'sys_decision_multi_result_element' ? { ...row, name: 'generated', element: '' } : row; };
    await assert.rejects(() => new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [], answerElements: [{ label: '!!!', type: 'Choice', _key: 'bad' }] }), (error) => error.cause?.message?.includes('label is unusable for fallback mapping'));
  });

  it('rolls back exact created IDs and verifies each deletion', async () => {
    const { sdk, calls } = restDouble({ failInputReadback: true });
    await assert.rejects(() => new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [{ label: 'X', type: 'String' }] }), /rolled back by exact sys_id/);
    assert.deepEqual(calls.filter(([method]) => method === 'delete').map(([, table, id]) => [table, id]), [['sys_decision_input', inputId], ['sys_decision', parentId]]);
    assert.equal(calls.filter(([method]) => method === 'get').length >= 4, true);
  });

  it('attempts every rollback deletion before reporting verification failure', async () => {
    const { sdk, calls } = restDouble({ failInputReadback: true });
    const originalDelete = sdk.delete;
    sdk.delete = async (table, id) => { calls.push(['delete-fail', table, id]); await originalDelete(table, id); if (table === 'sys_decision_input') throw new Error('cleanup failed'); };
    await assert.rejects(() => new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [{ label: 'X', type: 'String' }] }), /rollback could not be verified/);
    assert.deepEqual(calls.filter(([method]) => method === 'delete-fail').map(([, table, id]) => [table, id]), [['sys_decision_input', inputId], ['sys_decision', parentId]]);
  });
  it('fails closed for updates and explicitly rejects questions over REST', async () => {
    const sdk = { async create() { throw new Error('must not create'); }, async get() { throw new Error('must not get'); } };
    await assert.rejects(() => new DecisionTableCRUD(sdk).update(parentId, { parent: {}, inputs: [], questions: [] }), /intentionally unsupported over REST/);
    await assert.rejects(() => new DecisionTableCRUD(sdk).update(parentId, { parent: {}, inputs: [], questions: [{ active: true, defaultAnswer: false, order: 1 }] }), /does not support questions/);
  });

  it('deletes the exact parent via REST and treats SDK 404 readback as absence', async () => {
    const calls = []; const sdk = { async delete(table, id) { calls.push(['delete', table, id]); }, async get(table, id) { calls.push(['get', table, id]); throw new AppError('api_error', 'not found', '', 404); } };
    assert.deepEqual(await new DecisionTableCRUD(sdk).delete(parentId), { status: 'Success', sys_id: parentId }); assert.deepEqual(calls, [['delete', 'sys_decision', parentId], ['get', 'sys_decision', parentId]]);
  });

  it('preserves the REST error boundary and never falls back to scripts', async () => {
    const sdk = { executeScript: async () => { throw new Error('script transport must not be used'); } };
    await assert.rejects(() => new DecisionTableCRUD(sdk).delete(parentId), /Table API delete and readback support/);
  });

  it('does not invoke background script execution for REST create', async () => {
    const { sdk, calls } = restDouble(); sdk.executeScript = async () => { throw new Error('executeScript must not be called'); };
    await new DecisionTableCRUD(sdk).create({ parent: { name: 'A' }, inputs: [] }); assert.equal(calls.some(([method]) => method === 'executeScript'), false);
  });
});
