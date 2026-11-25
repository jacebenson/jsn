import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordJournal, formatJournal, JOURNAL_ELEMENTS,
} from '../src/records/journal.js';

const SYS_ID = 'a'.repeat(32);
const TASK_NOTE = 'b'.repeat(32);

// Fixture SDK: resolveRecord lists the record's own table, the journal module
// lists sys_journal_field. Queries are captured so the element filter and the
// element_id key are observable.
function fixture({ record = {}, rows = [] } = {}) {
  const calls = [];
  const sdk = {
    async list(table, params) {
      calls.push({ table, query: params.get('sysparm_query'), limit: params.get('sysparm_limit'), fields: params.get('sysparm_fields') });
      if (table === 'sys_journal_field') return rows;
      return [{ sys_id: SYS_ID, sys_class_name: 'incident', ...record }];
    },
    async listStrict(table, params) { return this.list(table, params); },
  };
  return { sdk, calls };
}

function entry({ id, element = 'work_notes', value = 'note', created = '2026-11-24 14:30:00', author = { value: 'u1', display_value: 'Alex Chen' }, name = 'incident', elementId = SYS_ID } = {}) {
  return {
    sys_id: id,
    element_id: { value: elementId, display_value: elementId },
    name,
    element,
    value,
    sys_created_on: created,
    sys_created_by: author,
  };
}

test('reads journal entries by element_id and keeps entries stored under another name', async () => {
  const { sdk, calls } = fixture({ rows: [entry({ id: '1', value: 'first line\nsecond line' }), entry({ id: '2', name: 'task', element: 'comments', created: '2026-11-23 09:00:00' })] });
  const data = await recordJournal(sdk, { table: 'incident', identifier: 'INC0010001' });
  assert.equal(data.record.sys_id, SYS_ID);
  assert.equal(data.count, 2);
  // element_id is the key: name is not always the record's own table.
  assert.equal(data.entries[1].table, 'task');
  assert.equal(data.entries[0].created_on, '2026-11-24 14:30:00');
  assert.equal(data.entries[0].created_by, 'Alex Chen');
  assert.equal(data.entries[0].value, 'first line\nsecond line');
  const journal = calls.find(call => call.table === 'sys_journal_field');
  assert.match(journal.query, new RegExp(`element_id=${SYS_ID}`));
  assert.match(journal.query, /ORDERBYDESCsys_created_on/);
  assert.equal(journal.limit, '21');
  assert.match(formatJournal(data), /first line\n {2}second line/);
});

test('filters one journal element and validates the flag combination', async () => {
  const { sdk, calls } = fixture({ rows: [entry({ id: '1', element: 'comments' })] });
  await recordJournal(sdk, { table: 'incident', identifier: 'INC0010001', element: 'comments' });
  assert.match(calls.find(call => call.table === 'sys_journal_field').query, /element=comments/);
  await assert.rejects(recordJournal(sdk, { table: 'incident', identifier: 'INC0010001', element: 'bad^element' }), /Unsafe identifier/);
  await assert.rejects(recordJournal(sdk, { table: 'incident', identifier: 'INC0010001', limit: 0 }), /--limit must be an integer from 1 to 200/);
  assert.deepEqual(JOURNAL_ELEMENTS, ['comments', 'work_notes']);
});

test('reports entries hidden by ACLs instead of claiming the record has none', async () => {
  const hidden = fixture({ record: { comments_and_work_notes: '2026-11-24 14:30:00 - Alex Chen (Work notes)\nlooks fine' }, rows: [] });
  const hiddenData = await recordJournal(hidden.sdk, { table: 'incident', identifier: 'INC0010001' });
  assert.equal(hiddenData.count, 0);
  assert.match(hiddenData.notes.join(' '), /hidden by ACLs on sys_journal_field, not absent/);

  const empty = fixture({ rows: [] });
  const emptyData = await recordJournal(empty.sdk, { table: 'incident', identifier: 'INC0010001' });
  assert.match(emptyData.notes.join(' '), /No journal entries found/);
  assert.doesNotMatch(emptyData.notes.join(' '), /hidden by ACLs/);
});

test('a row for another record is a malformed response, not a different record\'s journal', async () => {
  const { sdk } = fixture({ rows: [entry({ id: '1', elementId: TASK_NOTE })] });
  await assert.rejects(recordJournal(sdk, { table: 'incident', identifier: 'INC0010001' }), /another record/);
});

test('lookahead reports more entries than the limit without claiming a total', async () => {
  const { sdk } = fixture({ rows: [entry({ id: '1' }), entry({ id: '2' }), entry({ id: '3' })] });
  const data = await recordJournal(sdk, { table: 'incident', identifier: 'INC0010001', limit: 2 });
  assert.equal(data.count, 2);
  assert.equal(data.pagination.has_more, true);
  assert.match(data.notes.join(' '), /More entries exist/);
});
