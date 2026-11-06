import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow, formatWorkflowOutline } from '../src/workflow-inspection.js';

const id = n => String(n).padStart(32, '0');
const field = (value, display_value = value) => ({ value, display_value });
function variable(element, value, type = 'reference', table = 'u_review_team', activity = 2) {
  return { document_key: id(activity), 'variable.element': element,
    'variable.internal_type': field(type), 'variable.reference': field(table), value };
}
async function inspect(rows, { dictionary, records, denied, failureStatus = 403, parents = {}, activityCount = 3 } = {}) {
  const requests = [];
  const tables = {
    wf_workflow: [{ sys_id: id(900), name: 'Content values' }],
    wf_workflow_version: [{ sys_id: id(901), workflow: id(900), name: 'Content values', start: id(1), published: 'true', active: 'true' }],
    wf_activity: Array.from({ length: activityCount }, (_, i) => ({ sys_id: id(i + 1), name: `Activity ${i + 1}` })),
    sys_variable_value: rows,
  };
  const sdk = { listStrict: async (table, params) => {
    requests.push({ table, params: Object.fromEntries(params) });
    assert.equal(params.get('sysparm_display_value'), 'all');
    if (table === denied) throw Object.assign(new Error('unreadable'), { status: failureStatus });
    if (table === 'sys_dictionary') return dictionary ? dictionary(params.get('sysparm_query')) : [{ element: field('u_title') }];
    if (table === 'sys_db_object') return parents[params.get('sysparm_query')] || [];
    if (table === 'u_review_team') return records || [{ sys_id: field(id(10)), u_title: field('Change Managers') }];
    return tables[table] || [];
  } };
  const data = JSON.parse(JSON.stringify(await inspectWorkflow(sdk, { identifier: id(900) })));
  const output = formatWorkflowOutline(data, { includeConfiguration: true });
  return { data, output, requests, activity: data.activities.find(activity => activity.sys_id === id(2)) };
}

test('reference variable follows its declared table and display column, retaining the raw id in JSON', async () => {
  const { activity, output, requests } = await inspect([variable('arbitrary_element', field(id(10)))]);
  assert.match(output, /^ {7}arbitrary_element: Change Managers$/m);
  assert.equal(activity.configuration.arbitrary_element, id(10));
  assert.deepEqual(activity.configuration_values.arbitrary_element, {
    raw_value: id(10), display_value: 'Change Managers', type: 'reference', reference_table: 'u_review_team', resolution: 'resolved',
  });
  assert.deepEqual(requests.filter(r => ['sys_dictionary', 'u_review_team'].includes(r.table)), [
    { table: 'sys_dictionary', params: { sysparm_query: 'name=u_review_team^display=true', sysparm_fields: 'element', sysparm_limit: '2', sysparm_display_value: 'all' } },
    { table: 'u_review_team', params: { sysparm_query: `sys_idIN${id(10)}`, sysparm_fields: 'sys_id,u_title', sysparm_limit: '100', sysparm_display_value: 'all' } },
  ]);
  assert.match(requests.find(r => r.table === 'sys_variable_value').params.sysparm_fields, /variable.internal_type,variable.reference/);
});

test('platform-resolved references take precedence and need no extra lookups', async () => {
  const { output, requests } = await inspect([variable('reviewers', field(id(10), 'Platform name'))]);
  assert.match(output, /^ {7}reviewers: Platform name$/m);
  assert.equal(requests.some(r => ['sys_dictionary', 'u_review_team'].includes(r.table)), false);
});

for (const denied of [undefined, 'u_review_team', 'sys_dictionary']) {
  test(`missing or unreadable reference falls back to an explicitly marked id (${denied || 'missing record'})`, async () => {
    const { activity, output } = await inspect([variable('reviewers', field(id(11), ''))], { records: [], denied });
    assert.match(output, new RegExp(`^       reviewers: ${id(11)} \\(unresolved reference\\)$`, 'm'));
    assert.equal(activity.configuration_values.reviewers.raw_value, id(11));
    assert.equal(activity.configuration_values.reviewers.resolution, 'unresolved');
    assert.doesNotMatch(output, /ID in --json/);
  });
}

test('GlideDuration epoch offsets render as durations; formatted durations and real dates stay intact', async () => {
  const { activity, output } = await inspect([
    variable('elapsed', field('1970-01-03 00:00:00'), 'glide_duration', ''),
    variable('minutes', field('1970-01-01 00:05:00'), 'glide_duration', ''),
    variable('zero', field('1970-01-01 00:00:00'), 'glide_duration', ''),
    variable('mixed', field('1970-01-02 01:02:03'), 'glide_duration', ''),
    variable('formatted', field('00:05:00'), 'glide_duration', ''),
    variable('duration', field('1970-01-03 00:00:00'), 'glide_date_time', ''),
    variable('unknown', field('1970-01-03 00:00:00'), '', ''),
    variable('invalid', field('1970-02-30 00:00:00'), 'glide_duration', ''),
  ]);
  for (const [name, expected] of Object.entries({ elapsed: '2 days', minutes: '5 minutes', zero: '0 seconds', mixed: '1 day 1 hour 2 minutes 3 seconds', formatted: '00:05:00', duration: '1970-01-03 00:00:00', invalid: '1970-02-30 00:00:00' })) {
    assert.equal(activity.configuration_values[name].display_value, expected, name);
    assert.ok(output.split('\n').some(line => line.trim().startsWith(`${name}:`) && line.endsWith(expected)), name);
  }
  assert.equal(activity.configuration.elapsed, '1970-01-03 00:00:00');
  assert.match(output, /unknown: +1970-01-03 00:00:00/);
});

test('reference lists batch and deduplicate distinct targets across activities and fields', async () => {
  const rows = Array.from({ length: 65 }, (_, i) => variable('reviewers', field(`${id(10)},${id(11)},${id(10)}`), 'glide_list', 'u_review_team', i + 1));
  const { data, requests } = await inspect(rows, { activityCount: 65 });
  assert.equal(requests.filter(r => r.table === 'sys_variable_value').length, 1);
  assert.equal(requests.filter(r => r.table === 'sys_dictionary').length, 1);
  assert.deepEqual(requests.filter(r => r.table === 'u_review_team').map(r => r.params.sysparm_query), [`sys_idIN${id(10)},${id(11)}`]);
  for (const activity of data.activities) {
    assert.equal(activity.configuration_values.reviewers.display_value, `Change Managers, ${id(11)} (unresolved reference), Change Managers`);
  }
});

test('distinct target batches are capped at 100, independent of activity count', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => id(1000 + i));
  const { requests } = await inspect([variable('reviewers', ids.join(','), 'glide_list')]);
  const lookups = requests.filter(r => r.table === 'u_review_team');
  assert.deepEqual(lookups.map(r => r.params.sysparm_query), [
    `sys_idIN${ids.slice(0, 100).join(',')}`, `sys_idIN${ids.slice(100, 200).join(',')}`, `sys_idIN${ids.slice(200).join(',')}`,
  ]);
  assert.ok(lookups.every(r => r.params.sysparm_limit === '100'));
});

test('inherited display metadata is cached and inheritance cycles are bounded', async () => {
  const rows = [variable('reviewers', id(10)), variable('owner', id(10))];
  const inherited = await inspect(rows, {
    dictionary: query => query === 'name=u_parent^display=true' ? [{ element: 'u_title' }] : [],
    parents: { 'name=u_review_team': [{ 'super_class.name': field('u_parent') }] },
  });
  assert.match(inherited.output, /reviewers: Change Managers/);
  assert.equal(inherited.requests.filter(r => r.table === 'sys_dictionary').length, 2);
  const cycle = await inspect(rows, {
    dictionary: () => [], parents: { 'name=u_review_team': [{ 'super_class.name': 'u_review_team' }] },
  });
  assert.deepEqual(cycle.requests.filter(r => r.table === 'sys_dictionary').map(r => r.params.sysparm_query), [
    'name=u_review_team^display=true', 'name=u_review_team^elementINname,number',
  ]);
  assert.match(cycle.output, /unresolved reference/);
});

test('target lookup transport/server failures preserve the marked raw id', async () => {
  for (const failureStatus of [0, 503]) {
    const { output } = await inspect([variable('reviewers', id(10))], { denied: 'u_review_team', failureStatus });
    assert.ok(output.includes(`${id(10)} (unresolved reference)`));
  }
});

test('tables without explicit display metadata use dictionary-declared name or number columns', async () => {
  const { requests, activity } = await inspect([variable('reviewers', id(10))], {
    dictionary: query => query === 'name=u_review_team^elementINname,number' ? [{ element: 'name' }] : [],
    records: [{ sys_id: id(10), name: 'Default display name' }],
  });
  assert.equal(activity.configuration_values.reviewers.display_value, 'Default display name');
  assert.deepEqual(requests.filter(r => ['sys_dictionary', 'sys_db_object', 'u_review_team'].includes(r.table)).map(r => [r.table, r.params.sysparm_query]), [
    ['sys_dictionary', 'name=u_review_team^display=true'], ['sys_db_object', 'name=u_review_team'],
    ['sys_dictionary', 'name=u_review_team^elementINname,number'], ['u_review_team', `sys_idIN${id(10)}`],
  ]);
});

test('unsafe target metadata never becomes an encoded query or table path', async () => {
  const { requests, output } = await inspect([variable('reviewers', id(10), 'reference', 'sys_user^ORactive=true')]);
  assert.equal(requests.some(r => ['sys_dictionary', 'sys_db_object'].includes(r.table)), false);
  assert.match(output, /unresolved reference/);
});
