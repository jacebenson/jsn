import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordMetadataReader } from '../src/metadata/records.js';
import { formatFormMetadata } from '../src/commands/forms.js';
import { errAuth } from '../src/errors.js';

const id = letter => letter.repeat(32);
const ref = value => ({ value, display_value: `display:${value}` });

function fixture({ batch = false, deny = '', malformed = '', custom = false, script = true, limitRows = false } = {}) {
  const calls = [];
  const batches = [];
  function respond(table, params) {
    calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields') });
    const query = params.get('sysparm_query');
    if (deny === table) throw Object.assign(new Error('Access denied'), { status: 403 });
    if (malformed === table) return { result: 'wrong' };
    switch (table) {
      case 'sys_db_object': return query === 'name=x_case'
        ? [{ sys_id: id('a'), name: 'x_case', super_class: ref(id('b')) }]
        : [{ sys_id: id('b'), name: 'task', super_class: '' }];
      case 'sys_ui_view': return [{ sys_id: id('c'), name: custom ? 'special' : '', title: custom ? 'Special' : 'Default view' }];
      case 'sys_dictionary': return [{ sys_id: id('d'), name: 'x_note', element: 'parent', reference: ref('task'), column_label: 'Notes' },
        ...(limitRows ? [{ sys_id: id('e'), name: 'x_work', element: 'case', reference: 'x_case' }] : [])];
      case 'sys_relationship':
        if (query.startsWith('sys_idIN')) return [{ sys_id: id('f'), name: 'Computed children', advanced: 'true', query_with: 'current.addQuery("value", parent.name)' }];
        return [{ sys_id: id('e'), name: 'Work', basic_apply_to: 'task', basic_query_from: 'x_work', reference_field: 'parent', simple_reference: 'true', advanced: 'false', query_with: script ? 'current.addQuery("active", true)' : '' }];
      case 'sys_ui_form': return [{ sys_id: id('1'), name: custom ? 'x_case' : 'task', view: ref(id('c')) }];
      case 'sys_ui_related_list': return [{ sys_id: id('2'), name: 'task', view: ref(id('c')) }];
      case 'sys_ui_form_section': return [
        { sys_ui_section: ref(id('3')), position: '20' },
        { sys_ui_section: ref(id('4')), position: '0' },
      ];
      case 'sys_ui_related_list_entry': return [
        { related_list: 'x_note.parent', position: '0', filter: 'active=true', order_by: 'sys_created_on' },
        { related_list: `REL:${id('e')}`, position: '1', filter: '' },
        { related_list: `REL:${id('f')}`, position: '2', filter: '' },
      ];
      case 'sys_ui_section': return [{ sys_id: id('3'), caption: 'Details' }, { sys_id: id('4'), caption: 'Header' }];
      case 'sys_ui_element': return [
        { sys_ui_section: ref(id('3')), element: 'description', position: '2' },
        { sys_ui_section: ref(id('4')), element: 'number', position: '0' },
        { sys_ui_section: ref(id('3')), element: 'short_description', position: '0' },
      ];
      default: throw new Error(`Unexpected metadata table ${table}`);
    }
  }
  const sdk = { list: async (table, params) => respond(table, params) };
  if (batch) sdk.batch = async requests => {
    batches.push(requests);
    return { results: requests.map(request => {
      const url = new URL(request.url, 'https://fixture.invalid');
      try { return { id: request.id, ok: true, status: 200, data: { result: respond(url.pathname.split('/').pop(), url.searchParams) } }; }
      catch (error) { return { id: request.id, ok: false, status: error.status, error: { message: error.message } }; }
    }).reverse() };
  };
  return { sdk, calls, batches };
}

test('discovers inherited shared forms, ordered elements, reference and custom lists without fetching child data', async () => {
  const { sdk, calls } = fixture();
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  assert.deepEqual(metadata.hierarchy.map(row => row.name), ['x_case', 'task']);
  assert.equal(metadata.form.inherited, true);
  assert.equal(metadata.form.table, 'task');
  assert.deepEqual(metadata.form.sections.map(section => section.caption), ['Header', 'Details']);
  assert.deepEqual(metadata.form.sections[1].elements.map(element => element.element), ['short_description', 'description']);
  const [implicit, scripted, advanced] = metadata.related_lists;
  assert.deepEqual([implicit.kind, implicit.table, implicit.reference_field, implicit.filter], ['reference', 'x_note', 'parent', 'active=true']);
  assert.equal(implicit.configured, true);
  assert.equal(scripted.query_status, 'platform_required');
  assert.equal(advanced.query_status, 'platform_required');
  assert.ok(!JSON.stringify(metadata).includes('current.addQuery'));
  assert.equal(metadata.coverage.state, 'observed');
  assert.ok(calls.every(call => call.table.startsWith('sys_')));
  assert.equal(calls.filter(call => call.table === 'sys_ui_element').length, 1, 'one bulk element read, not one per section');
  assert.equal(calls.length, 12);
  assert.ok(calls.find(call => call.table === 'sys_ui_form').query.includes('sys_userISEMPTY'));
  assert.match(formatFormMetadata(metadata), /Inherited layout: task/);
});

test('custom views prefer the child form and never silently fall back to default view', async () => {
  const { sdk, calls } = fixture({ custom: true });
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case', view: 'Special' });
  assert.equal(metadata.form.table, 'x_case');
  assert.equal(metadata.form.inherited, false);
  assert.match(calls.find(call => call.table === 'sys_ui_form').query, new RegExp(`view=${id('c')}`));
  assert.ok(!calls.find(call => call.table === 'sys_ui_form').query.includes('ORviewISEMPTY'));
});

test('cache deduplicates concurrent reads, clones results, clears explicitly and stays SDK/reader scoped', async () => {
  const first = fixture();
  const reader = createRecordMetadataReader(first.sdk);
  const [a, b] = await Promise.all([reader.read({ table: 'x_case' }), reader.read({ table: 'x_case' })]);
  assert.equal(first.calls.length, 12);
  a.form.sections[0].caption = 'changed';
  assert.equal(b.form.sections[0].caption, 'Header');
  reader.clear();
  await reader.read({ table: 'x_case' });
  assert.equal(first.calls.length, 24);
  const second = fixture();
  await createRecordMetadataReader(second.sdk).read({ table: 'x_case' });
  assert.equal(second.calls.length, 12);
});

test('optional batch groups independent reads, maps by id and preserves individual transport output', async () => {
  const individual = fixture();
  const batched = fixture({ batch: true });
  const a = await createRecordMetadataReader(individual.sdk).read({ table: 'x_case' });
  const b = await createRecordMetadataReader(batched.sdk).read({ table: 'x_case' });
  assert.deepEqual(b, a);
  assert.deepEqual(batched.batches.map(group => group.length), [4, 2, 3]);
  assert.ok(batched.batches.flat().every(request => request.method === 'GET' && request.url.startsWith('/api/now/table/sys_')));
});

test('ACL failures and malformed/truncated metadata remain explicit coverage gaps', async () => {
  for (const options of [{ deny: 'sys_dictionary' }, { malformed: 'sys_ui_element' }, { limitRows: true }]) {
    const { sdk } = fixture(options);
    const metadata = await createRecordMetadataReader(sdk, { limit: options.limitRows ? 2 : 1000 }).read({ table: 'x_case' });
    assert.equal(metadata.coverage.state, 'partial');
    assert.ok(metadata.coverage.warnings.length > 0);
    assert.match(formatFormMetadata(metadata), /metadata|denied|limit|array/i);
  }
});

test('unknown or ambiguous custom views never select a layout', async () => {
  for (const views of [[], [{}], [{ sys_id: id('1') }, { sys_id: id('2') }]]) {
    const f = fixture();
    const original = f.sdk.list;
    f.sdk.list = (table, params) => table === 'sys_ui_view' ? Promise.resolve(views) : original(table, params);
    const metadata = await createRecordMetadataReader(f.sdk).read({ table: 'x_case', view: 'Unknown' });
    assert.equal(metadata.form, null);
    assert.equal(metadata.coverage.state, 'partial');
    assert.ok(!f.calls.some(call => call.table === 'sys_ui_form'));
  }
});

test('simple custom references are queryable only when no platform script is required', async () => {
  const { sdk } = fixture({ script: false });
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  const custom = metadata.related_lists.find(item => item.id === `REL:${id('e')}`);
  assert.equal(custom.query_status, 'reference');
  assert.equal(custom.table, 'x_work');
  assert.equal(custom.reference_field, 'parent');
});

test('rejects encoded-query injection before transport and preserves fatal authentication failures', async () => {
  const { sdk, calls } = fixture();
  const reader = createRecordMetadataReader(sdk);
  await assert.rejects(reader.read({}), /table name/);
  await assert.rejects(reader.read({ table: null }), /table name/);
  await assert.rejects(reader.read({ table: 'task^ORname=incident' }), /table name/);
  await assert.rejects(reader.read({ table: 'task', view: 'default^NQ' }), /Unsafe identifier/);
  assert.equal(calls.length, 0);
  await assert.rejects(createRecordMetadataReader({ list: async () => { throw errAuth('Expired'); } }).read({ table: 'task' }), /Expired/);
});

test('inheritance cycles and depth caps terminate with explicit partial coverage', async () => {
  const { sdk } = fixture();
  const original = sdk.list;
  sdk.list = (table, params) => table === 'sys_db_object'
    ? Promise.resolve([{ name: 'x_case', sys_id: id('a'), super_class: id('a') }]) : original(table, params);
  const cycle = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  assert.equal(cycle.coverage.state, 'partial');
  assert.ok(cycle.coverage.warnings.some(warning => /cyclic/.test(warning.reason)));
  const depth = await createRecordMetadataReader(fixture().sdk, { maxDepth: 1 }).read({ table: 'x_case' });
  assert.ok(depth.coverage.warnings.some(warning => /depth limit/.test(warning.reason)));
});

test('batch item ACL failures stay partial without individual replay', async () => {
  const { sdk, calls } = fixture({ batch: true, deny: 'sys_dictionary' });
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  assert.equal(metadata.coverage.state, 'partial');
  assert.ok(metadata.coverage.warnings.some(warning => warning.source === 'sys_dictionary' && /denied/.test(warning.reason)));
  assert.equal(calls.filter(call => call.table === 'sys_dictionary').length, 1);
});

test('a hidden form id never produces an empty foreign-key query', async () => {
  const { sdk, calls } = fixture();
  const original = sdk.list;
  sdk.list = (table, params) => table === 'sys_ui_form'
    ? Promise.resolve([{ name: 'task', view: id('c') }]) : original(table, params);
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  assert.equal(metadata.form, null);
  assert.equal(metadata.coverage.state, 'partial');
  assert.ok(!calls.some(call => call.table === 'sys_ui_form_section'));
});

test('large forms use bounded bulk id queries instead of one request per section', async () => {
  const { sdk, calls } = fixture();
  const original = sdk.list;
  sdk.list = (table, params) => table === 'sys_ui_form_section'
    ? Promise.resolve(Array.from({ length: 105 }, (_, index) => ({ sys_ui_section: index.toString(16).padStart(32, '0'), position: index })))
    : original(table, params);
  await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  const elementReads = calls.filter(call => call.table === 'sys_ui_element');
  assert.equal(elementReads.length, 2);
  assert.ok(elementReads.every(call => call.query.split('^')[0].slice('sys_ui_sectionIN'.length).split(',').length <= 100));
});


test('canonical Default view wins over a distinct view literally named default', async () => {
  const { sdk } = fixture();
  const original = sdk.list;
  sdk.list = (table, params) => table === 'sys_ui_view' ? Promise.resolve([
    { sys_id: id('9'), name: 'default', title: 'Other default' },
    { sys_id: id('c'), name: '', title: 'Default view' },
  ]) : original(table, params);
  const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
  assert.equal(metadata.view_sys_id, id('c'));
  assert.ok(metadata.form);
  assert.equal(metadata.coverage.state, 'observed');
});


test('hidden or display-only configured filters remain unavailable rather than becoming an unfiltered relationship', async () => {
  for (const entry of [
    { related_list: 'x_note.parent', position: '0' },
    { related_list: 'x_note.parent', position: '0', filter: { display_value: 'Active is true' } },
    { related_list: 'x_note.parent', position: '0', filter: 42 },
    { related_list: 'x_note.parent', position: '0', filter: undefined },
  ]) {
    const { sdk } = fixture();
    const original = sdk.list;
    sdk.list = (table, params) => table === 'sys_ui_related_list_entry' ? Promise.resolve([entry]) : original(table, params);
    const metadata = await createRecordMetadataReader(sdk).read({ table: 'x_case' });
    assert.equal(metadata.related_lists.find(item => item.configured).filter_available, false);
    assert.equal(metadata.coverage.state, 'partial');
    assert.ok(metadata.coverage.warnings.some(warning => /configured filter/.test(warning.reason)));
  }
  const known = await createRecordMetadataReader(fixture().sdk).read({ table: 'x_case' });
  assert.ok(known.related_lists.filter(item => item.configured).every(item => item.filter_available));
});
