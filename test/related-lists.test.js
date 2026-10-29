import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelatedListReader, safeRelatedFilter, enrichRelatedLists } from '../src/related-lists.js';
const reference = (id, extra = {}) => ({ id, label: id, table: 'task', reference_field: 'parent', query_status: 'reference', configured: true, ...extra });
function fixture(lists, { state = 'observed', batch, response = { result: { stats: { count: '2' } } } } = {}) {
  const calls = [], metadataCalls = [];
  const sdk = { baseURL: 'https://fixture.invalid', request: async (url, options) => { calls.push({ url, options }); return response; } };
  if (batch) sdk.batch = async (...args) => { calls.push(args); return batch(...args); };
  const metadataReader = { read: async args => { metadataCalls.push(args); return { related_lists: lists, coverage: { state, warnings: [] } }; } };
  return { reader: createRelatedListReader(sdk, { metadataReader }), calls, metadataCalls };
}
it('counts references by aggregate, preserves real zero, suggests only nonempty lists and never fetches records', async () => {
  const f = fixture([reference('children')]);
  const result = await f.reader.read({ table: 'incident', recordId: 'record-id', profile: 'selected', instance: 'https://fixture.invalid' });
  assert.equal(result.nonempty[0].count, 2);
  assert.match(result.nonempty[0].command, /jsn records list --table task --query parent=record-id --profile selected --instance https:\/\/fixture.invalid/);
  assert.equal(result.coverage.scope, 'aggregate_api_access');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/api\/now\/stats\/task\?/);
  assert.equal(new URL(f.calls[0].url).searchParams.get('sysparm_query'), 'parent=record-id');
  assert.equal(f.calls[0].options.readOnly, true);
  const zero = fixture([reference('empty')], { response: { result: { stats: { count: '0' } } } });
  const empty = await zero.reader.read({ table: 'incident', recordId: 'record-id' });
  assert.equal(empty.lists[0].count, 0); assert.equal(empty.lists[0].status, 'available'); assert.deepEqual(empty.nonempty, []);
});
it('batches independent aggregates, correlates by ID and marks denied/unserviced counts unavailable', async () => {
  const f = fixture([reference('first'), reference('second', { table: 'task_sla', reference_field: 'task' }), reference('third', { table: 'sys_attachment', reference_field: 'table_sys_id' })], { batch: async requests => ({ results: [
    { id: requests[1].id, ok: false, status: 403, error: { message: 'ACL denied' } },
    { id: requests[2].id, ok: false, status: null, serviced: false, error: { message: 'Unserviced' } },
    { id: requests[0].id, ok: true, status: 200, data: { result: { stats: { count: '4' } } } },
  ] }) });
  const result = await f.reader.read({ table: 'incident', recordId: 'record' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].length, 3);
  assert.equal(result.lists[0].count, 4); assert.equal(result.lists[1].count, null); assert.equal(result.lists[1].http_status, 403);
  assert.equal(result.lists[2].count, null); assert.equal(result.coverage.state, 'partial');
  assert.deepEqual(result.nonempty.map(list => list.id), ['first']);
});
it('does not replay a failed aggregate batch via individual requests', async () => {
  const f = fixture([reference('one'), reference('two', { table: 'task_sla' })], { batch: async () => { throw Object.assign(new Error('Batch ACL denied'), { status: 403 }); } });
  const result = await f.reader.read({ table: 'incident', recordId: 'record' });
  assert.equal(f.calls.length, 1); assert.ok(result.lists.every(list => list.count === null));
  assert.ok(result.coverage.warnings.every(warning => warning.status === 403));
});
it('does not interpret malformed or partial aggregate bodies as empty lists', async () => {
  for (const response of [{}, { result: { stats: {} } }, { result: { stats: { count: '2oops' } } }, { result: { stats: { count: -1 } } }]) {
    const f = fixture([reference('children')], { response });
    const result = await f.reader.read({ table: 'incident', recordId: 'record' });
    assert.equal(result.lists[0].count, null); assert.equal(result.coverage.state, 'partial'); assert.deepEqual(result.nonempty, []);
  }
});
it('combines only safe literal AND filters without widening the record relationship', async () => {
  const f = fixture([reference('active', { filter: 'active=true^priorityIN1,2^EQ' })]);
  const result = await f.reader.read({ table: 'incident', recordId: 'record' });
  const query = new URL(f.calls[0].url).searchParams.get('sysparm_query');
  assert.equal(query, 'parent=record^active=true^priorityIN1,2'); assert.equal(result.lists[0].count, 2);
  for (const filter of ['active=true^NQactive=false', 'active=true^ORactive=false', 'sys_id=javascript:gs.getUserID()', 'active=true^^state=1', 'parentDYNAMICabcdef', 'ORDERBYname']) {
    assert.equal(safeRelatedFilter(filter), null, filter);
    const skipped = fixture([reference('unsafe', { filter })]);
    const output = await skipped.reader.read({ table: 'incident', recordId: 'record' });
    assert.equal(skipped.calls.length, 0); assert.equal(output.lists[0].count, null); assert.equal(output.coverage.state, 'partial');
  }
});
it('custom scripted relationships and unavailable metadata stay unknown without executing platform logic', async () => {
  const f = fixture([{ id: 'REL:script', kind: 'relationship', query_status: 'platform_required', reason: 'Platform query logic required' }]);
  const result = await f.reader.read({ table: 'incident', recordId: 'record' });
  assert.equal(f.calls.length, 0); assert.equal(result.lists[0].count, null); assert.match(result.lists[0].reason, /Platform/);
});
it('deduplicates counts and caches per invocation and record, while retaining list-specific hints', async () => {
  const f = fixture([reference('first'), reference('duplicate')]);
  const [first, second] = await Promise.all([
    f.reader.read({ table: 'incident', recordId: 'record', profile: 'one' }),
    f.reader.read({ table: 'incident', recordId: 'record', profile: 'two' }),
  ]);
  assert.equal(f.calls.length, 1); assert.equal(first.lists.length, 2);
  assert.match(first.lists[0].command, /--profile one/); assert.match(second.lists[0].command, /--profile two/);
  await f.reader.read({ table: 'incident', recordId: 'other' }); assert.equal(f.calls.length, 2);
  f.reader.clear(); await f.reader.read({ table: 'incident', recordId: 'record' }); assert.equal(f.calls.length, 3);
});
it('keeps count request limits and metadata coverage explicit', async () => {
  let calls = 0;
  const reader = createRelatedListReader({ baseURL: 'https://fixture.invalid', request: async () => { calls++; return { result: { stats: { count: 0 } } }; } }, {
    maxLists: 1, metadataReader: { read: async () => ({ related_lists: [reference('one'), reference('two', { table: 'task_sla' })], coverage: { state: 'partial', warnings: [{ source: 'metadata', reason: 'ACL limited metadata' }] } }) },
  });
  const result = await reader.read({ table: 'incident', recordId: 'record' });
  assert.equal(calls, 1); assert.equal(result.lists[1].count, null); assert.match(result.lists[1].reason, /limit/);
  assert.equal(result.coverage.state, 'partial'); assert.ok(result.coverage.warnings.some(item => item.source === 'metadata'));
});
it('specialized enrichment stays opt-in and uses resolved raw IDs and selected connection', async () => {
  const record = { sys_id: { value: 'record', display_value: 'A record' } }; let calls = [];
  const app = { session: { profileName: 'selected' }, getEffectiveInstance: () => 'https://fixture.invalid',
    relatedListReader: { read: async options => { calls.push(options); return { nonempty: [] }; } } };
  await enrichRelatedLists(record, { table: 'incident', app }); assert.equal(calls.length, 0); assert.equal(record._related, undefined);
  await enrichRelatedLists(record, { table: 'incident', app, argv: { related: true, view: 'Custom' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].view, 'Custom'); assert.equal(calls[0].profile, 'selected'); assert.deepEqual(record._related, { nonempty: [] });
});
it('rejects unsafe record identities and field/table metadata before aggregate requests', async () => {
  const f = fixture([reference('bad', { reference_field: 'parent^ORactive' })]);
  await assert.rejects(f.reader.read({ table: 'incident', recordId: 'record^NQactive=true' }), { code: 'usage_error' });
  const result = await f.reader.read({ table: 'incident', recordId: 'record' });
  assert.equal(f.calls.length, 0); assert.equal(result.lists[0].count, null);
});

it('accepts an ungrouped single aggregate row but refuses grouped or ambiguous rows', async () => {
  for (const [response, expected] of [
    [{ result: [{ stats: { count: '3' } }] }, 3],
    [{ result: [{ stats: { count: '3' }, groupby_fields: [{ field: 'state', value: '1' }] }] }, null],
    [{ result: [{ stats: { count: '3' } }, { stats: { count: '4' } }] }, null],
  ]) {
    const f = fixture([reference('children')], { response });
    const result = await f.reader.read({ table: 'incident', recordId: 'record' });
    assert.equal(result.lists[0].count, expected);
  }
});
