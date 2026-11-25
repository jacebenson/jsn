import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { columnsCmd, CHOICE_LIMIT } from '../src/commands/columns.js';
import { OutputWriter } from '../src/output.js';

const TASK = 'a'.repeat(32), INCIDENT = 'b'.repeat(32), PRIORITY = 'c'.repeat(32), STATE = 'd'.repeat(32), NUMBER = 'e'.repeat(32), USED_FOR = 'f'.repeat(32);
const ref = (value, display_value = value) => ({ value, display_value });
const column = (sys_id, name, element, choice, extra = {}) => ({ sys_id: ref(sys_id), sys_class_name: ref('sys_dictionary', 'Dictionary Entry'),
  name: ref(name), element: ref(element), choice: ref(choice, choice === '0' ? null : 'Dropdown'), choice_table: ref(''), choice_field: ref(''), ...extra });
const DICTIONARY = { [PRIORITY]: column(PRIORITY, 'task', 'priority', '1'), [STATE]: column(STATE, 'task', 'state', '3'), [NUMBER]: column(NUMBER, 'task', 'number', '0'),
  [USED_FOR]: column(USED_FOR, 'task', 'used_for', '3', { choice_table: ref('cmdb_ci_service'), choice_field: ref('used_for') }) };
const choice = (name, element, value, sequence, extra = {}) => ({ name, element, value, label: `Label ${value}`, sequence: String(sequence), dependent_value: '', inactive: 'false', ...extra });
const choiceQuery = (name, element) => `name=${name}^element=${element}^language=en^ORDERBYdependent_value^ORDERBYsequence`;
const HIERARCHY = {
  'sys_db_object?name=incident': [{ sys_id: ref(INCIDENT), name: ref('incident'), label: ref('Incident'), super_class: ref(TASK, 'Task'), sys_scope: ref('global') }],
  [`sys_db_object?sys_id=${TASK}`]: [{ sys_id: ref(TASK), name: ref('task'), label: ref('Task'), super_class: ref(''), sys_scope: ref('global') }],
  'sys_db_object?name=task': [{ sys_id: ref(TASK), name: ref('task'), label: ref('Task'), super_class: ref(''), sys_scope: ref('global') }],
  'sys_dictionary?nameINincident,task^element=priority': [{ sys_id: PRIORITY, name: 'task', element: 'priority' }],
  'sys_dictionary?nameINincident,task^element=state': [{ sys_id: STATE, name: 'task', element: 'state' }],
  'sys_dictionary?nameINincident,task^element=number': [{ sys_id: NUMBER, name: 'task', element: 'number' }],
};

function fixture(rows = {}, { deny = () => false } = {}) {
  const calls = [];
  const read = async (table, params) => {
    const query = params.get('sysparm_query');
    calls.push({ table, query, limit: params.get('sysparm_limit'), fields: params.get('sysparm_fields') });
    if (deny(table)) throw Object.assign(new Error('Forbidden: sys_choice'), { status: 403 });
    if (table === 'sys_dictionary' && query.startsWith('sys_id=')) return DICTIONARY[query.slice(7)] ? [structuredClone(DICTIONARY[query.slice(7)])] : [];
    return structuredClone({ ...HIERARCHY, ...rows }[`${table}?${query}`] || []);
  };
  return { calls, sdk: { list: read, listStrict: read } };
}

function commands() {
  const list = [];
  const yargs = { command: (definition) => { list.push(definition); return yargs; }, epilogue: () => yargs };
  columnsCmd((handler) => handler).builder(yargs);
  return list;
}

async function show(identifier, rows, options) {
  const { calls, sdk } = fixture(rows, options);
  const okCalls = [];
  const app = { sdk, getEffectiveInstance: () => 'https://example.service-now.com', ok: (data, opts) => okCalls.push({ data, opts }) };
  await commands().find((c) => c.command === 'show <identifier>').handler({ identifier }, app);
  return { calls, data: okCalls[0]?.data, opts: okCalls[0]?.opts };
}

function styled(data) {
  let out = '';
  new OutputWriter({ format: 'styled', writer: { write: (text) => { out += text; } } }).ok(data, {});
  return out;
}

describe('columns show choices', () => {
  it('resolves table.column through the hierarchy and inherits the parent list when the child has none', async () => {
    const { calls, data } = await show('incident.priority', {
      [`sys_choice?${choiceQuery('task', 'priority')}`]: [choice('task', 'priority', '1', 1), choice('task', 'priority', '5', 5, { inactive: 'true', dependent_value: 'x' })],
    });
    assert.equal(data.sys_id.value, PRIORITY);
    assert.deepEqual(data._choices, { table: 'incident', element: 'priority', source: 'task', searched: ['incident', 'task'], limit: CHOICE_LIMIT, truncated: false, choices: [
      { value: '1', label: 'Label 1', sequence: '1', dependent_value: '', inactive: false },
      { value: '5', label: 'Label 5', sequence: '5', dependent_value: 'x', inactive: true }] });
    const choiceReads = calls.filter((c) => c.table === 'sys_choice');
    assert.deepEqual(choiceReads.map((c) => c.query), [choiceQuery('incident', 'priority'), choiceQuery('task', 'priority')]);
    assert.ok(choiceReads.every((c) => c.limit === String(CHOICE_LIMIT + 1) && c.fields === 'name,element,value,label,sequence,dependent_value,inactive'));
    assert.equal(calls.filter((c) => c.table === 'sys_db_object').length, 2, 'the hierarchy read for resolution is reused');
    assert.match(styled(data), /─ Choices \(2 inherited from task; none active on incident\) ─\n {2}value: 1 \| label: Label 1 \| sequence: 1\n {2}value: 5 \| label: Label 5 \| sequence: 5 \| dependent_value: x \| inactive: true\n/);
  });

  it('uses the child list whole and never reads or merges the parent list', async () => {
    const { calls, data } = await show('incident.state', {
      [`sys_choice?${choiceQuery('incident', 'state')}`]: [choice('incident', 'state', '1', 1)],
      [`sys_choice?${choiceQuery('task', 'state')}`]: [choice('task', 'state', '-5', -5)],
    });
    assert.equal(data._choices.source, 'incident');
    assert.deepEqual(data._choices.searched, ['incident']);
    assert.deepEqual(data._choices.choices.map((c) => c.value), ['1']);
    assert.ok(!calls.some((c) => c.query === choiceQuery('task', 'state')));
    assert.match(styled(data), /─ Choices \(1 on incident\) ─\n/);
  });

  it('passes over a table whose choices are all inactive', async () => {
    const { data } = await show('incident.state', {
      [`sys_choice?${choiceQuery('incident', 'state')}`]: [choice('incident', 'state', '9', 1, { inactive: 'true' })],
      [`sys_choice?${choiceQuery('task', 'state')}`]: [choice('task', 'state', '1', 1)],
    });
    assert.equal(data._choices.source, 'task');
    assert.deepEqual(data._choices.choices.map((c) => c.value), ['1']);
  });

  it('reads the defining table by sys_id and says when no table has choices', async () => {
    const { data } = await show(STATE, {});
    assert.deepEqual(data._choices, { table: 'task', element: 'state', source: null, searched: ['task'], limit: CHOICE_LIMIT, truncated: false, choices: [] });
    assert.match(styled(data), /─ Choices \(none active found on task\) ─\n {2}Row ACLs can hide sys_choice rows, so this does not prove the field has none\.\n/);
  });

  it('bounds the read and says the list is truncated', async () => {
    const many = Array.from({ length: CHOICE_LIMIT + 1 }, (_, i) => choice('task', 'state', String(i), i));
    const { data } = await show(STATE, { [`sys_choice?${choiceQuery('task', 'state')}`]: many });
    assert.equal(data._choices.choices.length, CHOICE_LIMIT);
    assert.equal(data._choices.truncated, true);
    assert.match(styled(data), new RegExp(`─ Choices \\(first ${CHOICE_LIMIT} on task\\) ─[\\s\\S]*All: jsn records list --table sys_choice --query "name=task\\^element=state\\^language=en" --limit 1000\\n`));
  });

  it('names a choice table instead of reading sys_choice for the column itself', async () => {
    const { calls, data } = await show(USED_FOR, {});
    assert.deepEqual(data._choices, { table: 'task', element: 'used_for', choice_table: 'cmdb_ci_service', choice_field: 'used_for' });
    assert.ok(!calls.some((c) => c.table === 'sys_choice' || c.table === 'sys_db_object'));
    assert.match(styled(data), /─ Choices ─\n {2}Defined by the choice table cmdb_ci_service\.used_for: jsn columns show cmdb_ci_service\.used_for\n/);
  });

  it('reports a denied or malformed choice read as unavailable, never as no choices', async () => {
    const denied = await show(STATE, {}, { deny: (table) => table === 'sys_choice' });
    assert.equal(denied.data._choices.error, 'Forbidden: sys_choice');
    assert.equal(denied.data._choices.source, null);
    assert.match(styled(denied.data), /─ Choices ─\n {2}Unavailable: Forbidden: sys_choice\n/);
    const malformed = await show(STATE, { [`sys_choice?${choiceQuery('task', 'state')}`]: [choice('incident', 'state', '1', 1)] });
    assert.match(malformed.data._choices.error, /Malformed sys_choice rows for task\.state/);
  });

  it('leaves a non-choice column untouched with no extra reads', async () => {
    const { calls, data } = await show(NUMBER, {});
    assert.deepEqual(calls.map((c) => c.table), ['sys_dictionary']);
    assert.deepEqual(Object.keys(data).filter((key) => key.startsWith('_')), ['_context']);
    assert.doesNotMatch(styled(data), /Choices/);
  });

  it('refuses an unknown column or table before reading choices', async () => {
    await assert.rejects(show('incident.nope', {}), (err) => err.code === 'not_found' && /column not found: incident\.nope/.test(err.message));
    await assert.rejects(show('incidnt.state', {}), (err) => err.code === 'not_found' && /Table hierarchy not found or not accessible: incidnt/.test(err.hint));
    await assert.rejects(show('incident.state.x', {}), (err) => err.code === 'not_found');
    const other = await show('incident.state', { 'sys_dictionary?nameINincident,task^element=state': [{ sys_id: PRIORITY, name: 'task', element: 'priority' }] }).catch((err) => err);
    assert.equal(other.code, 'not_found', 'a row for another element is never shown as the column asked for');
  });

  it('resolves a mixed-case table.column and says so in the show help', async () => {
    const { data } = await show('Incident.Priority', {});
    assert.equal(data.sys_id.value, PRIORITY);
    assert.equal(commands().find((c) => c.command === 'show <identifier>').describe, 'Show a column by <table>.<column> or sys_id, with a choice field\'s choices');
  });
});
