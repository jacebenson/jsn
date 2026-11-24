import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';

function fixture(size = 2) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'delete-many').handler;
  let rows = Array.from({ length: size }, (_, i) => ({ sys_id: String(i).padStart(32, '0'), number: `INC${i}` }));
  const deletes = [];
  const reads = [];
  let data;
  let meta = {};
  const app = {
    sdk: {
      aggregateCount: async () => rows.length,
      list: async (table, params, opts = {}) => {
        if (opts.responseMetadata) opts.responseMetadata.total = 1;
        if (table === 'sys_db_object') return [{ sys_id: 'f'.repeat(32), name: 'incident', super_class: '' }];
        if (table === 'sys_dictionary') return [{ sys_id: 'e'.repeat(32), name: 'incident', element: 'active', internal_type: 'boolean', reference: '' }];
        reads.push(Object.fromEntries(params));
        return rows.slice(Number(params.get('sysparm_offset')), Number(params.get('sysparm_offset')) + Number(params.get('sysparm_limit')));
      },
      delete: async (table, id) => { deletes.push(id); rows = rows.filter(r => r.sys_id !== id); },
    },
    ok(value, options = {}) { data = value; meta = options; },
  };
  return { app, deletes, reads, get data() { return data; }, get summary() { return meta.summary; }, get breadcrumbs() { return meta.breadcrumbs; },
    run: (args = {}) => handler({ table: 'incident', query: 'active=false', limit: 200, ...args }, app) };
}

test('delete-many dry-run reports count and bounded sample without writes, even with --yes', async () => {
  for (const args of [{}, { yes: true, 'dry-run': true }]) {
    const f = fixture(12);
    await f.run(args);
    assert.equal(f.data.count, 12);
    assert.equal(f.data.sample.length, 10);
    assert.equal(f.data.dry_run, true);
    assert.match(f.data.rerun, /--expect-count 12/);
    assert.deepEqual(f.deletes, []);
  }
});

test('delete-many refuses expected-count mismatch before any delete request', async () => {
  const f = fixture();
  await assert.rejects(f.run({ yes: true, 'expect-count': 3 }), /expect-count 3, live count 2/);
  assert.deepEqual(f.deletes, []);
  assert.deepEqual(f.reads, []);
});

test('delete-many happy path deletes expected records and verifies zero remaining', async () => {
  const f = fixture(1002);
  await f.run({ yes: true, 'expect-count': 1002, limit: 1002 });
  assert.equal(f.deletes.length, 1002);
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads[1].sysparm_offset, '1000');
  assert.equal(f.data.remaining, 0);
  assert.equal(f.data.verified, true);
  assert.deepEqual(f.data.failed, []);
});

test('delete-many refuses empty or missing query without requests', async () => {
  for (const query of [undefined, '', '   ']) {
    const f = fixture();
    f.app.sdk.aggregateCount = () => assert.fail('must not request a count');
    await assert.rejects(f.run({ query }), /Use records delete for a single record/);
    assert.deepEqual(f.deletes, []);
  }
});

test('delete-many requires expected count and enforces safety cap before writes', async () => {
  for (const args of [{ yes: true }, { yes: true, 'expect-count': 2, limit: 1 }, { limit: 0 }]) {
    const f = fixture();
    await assert.rejects(f.run(args));
    assert.deepEqual(f.deletes, []);
  }
});

test('delete-many reports partial failures and nonzero remaining without claiming verification', async () => {
  const f = fixture();
  f.app.sdk.delete = async (table, id) => { throw new Error(`Denied ${id}`); };
  const previous = process.exitCode;
  try {
    await f.run({ yes: true, 'expect-count': 2 });
    assert.equal(process.exitCode, 1);
    assert.equal(f.data.verified, false);
    assert.equal(f.data.remaining, 2);
    assert.deepEqual(f.data.failed.map(r => r.sys_id), ['0'.repeat(32), '0'.repeat(31) + '1']);
  } finally { process.exitCode = previous; }
});

test('delete-many refuses incomplete enumeration before any delete request', async () => {
  const f = fixture();
  f.app.sdk.list = async (table, params, opts = {}) => {
    if (opts.responseMetadata) opts.responseMetadata.total = 1;
    if (table === 'sys_db_object') return [{ sys_id: 'f'.repeat(32), name: 'incident', super_class: '' }];
    if (table === 'sys_dictionary') return [{ sys_id: 'e'.repeat(32), name: 'incident', element: 'active', internal_type: 'boolean', reference: '' }];
    return [];
  };
  await assert.rejects(f.run({ yes: true, 'expect-count': 2 }), /Enumeration differs/);
  assert.deepEqual(f.deletes, []);
});

test('delete-many is registered as a mutation and CLI help exposes noninteractive guards', () => {
  assert.equal(isMutationCommand({ _: ['records', 'delete-many'] }), true);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'delete-many', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--query', '--expect-count', '--yes', '--dry-run', '--limit', '--preview-cascade', '--keep-job']) assert.ok(result.stdout.includes(flag));
});

function cascade(size = 2, { broker = true, counts = [['incident', size], ['task_sla', 3], ['task_time_worked', 5]], messages = ['lag'], output, jobDelete } = {}) {
  const f = fixture(size);
  const sdk = f.app.sdk;
  const { list, delete: del } = sdk;
  const calls = [];
  let job = null;
  const missing = () => Object.assign(new Error('No Record found'), { status: 404 });
  Object.assign(sdk, {
    baseURL: 'https://x.test',
    get: async (table, id) => {
      calls.push(['get', table]);
      if (table === 'sys_ux_data_broker_transform' ? broker : job?.sys_id === id) return { sys_id: id };
      throw missing();
    },
    create: async (table, data) => { calls.push(['create', table, data]); return (job = { sys_id: 'a'.repeat(32), number: 'DM0001001', ...data }); },
    request: async (url, opts) => {
      calls.push(['broker', url, JSON.parse(opts.body)]);
      return output ?? { result: [{ status: 200, errors: [], executionResult: { output: { rowCount: counts.length,
        rows: counts.map(([t, n]) => ({ table: `Label [${t}]`, preview_record_count: String(n) })), messages } } }] };
    },
    list: async (table, params, opts) => {
      if (table !== 'sys_dm_delete_count') return list(table, params, opts);
      calls.push(['counts', params.get('sysparm_query'), params.get('sysparm_display_value')]);
      return counts.map(([t, n]) => ({ table: t, preview_record_count: String(n) }));
    },
    delete: async (table, id) => {
      if (table !== 'sys_dm_delete') return del(table, id);
      calls.push(['delete', table, id]);
      if (jobDelete) return jobDelete();
      job = null;
    },
  });
  const { run } = f;
  return Object.assign(f, { calls, run: (args = {}) => run({ 'preview-cascade': true, ...args }) });
}

test('delete-many --preview-cascade previews through one delete job, deletes no target and removes the job', async () => {
  const f = cascade();
  await f.run();
  assert.deepEqual(f.deletes, []);
  assert.deepEqual(f.calls.filter(c => c[0] === 'create'), [['create', 'sys_dm_delete', { table: 'incident', condition: 'active=false',
    name: 'jsn cascade preview: incident', description: f.calls.find(c => c[0] === 'create')[2].description }]]);
  const broker = f.calls.find(c => c[0] === 'broker');
  assert.equal(broker[1], 'https://x.test/api/now/uxf/databroker/exec');
  assert.deepEqual(broker[2], [{ definitionSysId: '2a397460ff603210755cffffffffffab', inputValues: { ruleId: { type: 'JSON_LITERAL', value: 'a'.repeat(32) } } }]);
  assert.deepEqual(f.calls.find(c => c[0] === 'counts'), ['counts', `dm_delete=${'a'.repeat(32)}`, 'false']);
  assert.deepEqual(f.data.cascade.tables, [{ table: 'task_time_worked', count: 5 }, { table: 'task_sla', count: 3 }, { table: 'incident', count: 2 }]);
  assert.equal(f.data.cascade.more_levels, false);
  assert.deepEqual(f.data.cascade.job, { number: 'DM0001001', sys_id: 'a'.repeat(32), status: 'deleted' });
  assert.deepEqual(f.calls.slice(-2).map(c => c.slice(0, 2)), [['delete', 'sys_dm_delete'], ['get', 'sys_dm_delete']]);
  assert.match(f.data.rerun, /--expect-count 2/);
});

test('delete-many --preview-cascade --keep-job keeps the job and reports more levels', async () => {
  const f = cascade(2, { messages: ['more levels', 'lag'] });
  await f.run({ 'keep-job': true });
  assert.equal(f.data.cascade.job.status, 'kept');
  assert.equal(f.data.cascade.more_levels, true);
  assert.equal(f.calls.some(c => c[0] === 'delete'), false);
});

test('delete-many cascade flags are refused before any request', async () => {
  for (const args of [{ yes: true, 'expect-count': 2 }, { yes: true, 'dry-run': true }, { 'preview-cascade': false, 'keep-job': true }]) {
    const f = cascade();
    f.app.sdk.aggregateCount = () => assert.fail('must not request a count');
    await assert.rejects(f.run(args), /--preview-cascade/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.deletes, []);
  }
});

test('delete-many --preview-cascade writes nothing without the console broker or with nothing matching', async () => {
  const f = cascade(2, { broker: false });
  await assert.rejects(f.run(), /no Data Management cascade preview/);
  assert.deepEqual(f.calls.map(c => c[0]), ['get']);
  const empty = cascade(0);
  await empty.run();
  assert.deepEqual(empty.calls, []);
  assert.equal(empty.data.count, 0);
});

test('delete-many --preview-cascade never reports an empty, failed or mismatched preview, and still removes the job', async () => {
  const bad = [
    [{ output: { result: [{ status: 200, errors: [], executionResult: { output: { rowCount: 0, rows: [], messages: [] } } }] } }, /returned no result/],
    [{ output: { result: [] } }, /returned no result/],
    [{ output: { result: [{ status: 500, errors: [{ message: 'boom' }] }] } }, /boom/],
    [{ counts: [['incident', 1], ['task_sla', 3]] }, /did not count 2 record\(s\) in incident/],
    [{ output: { result: [{ status: 200, errors: [], executionResult: { output: { rowCount: 2, rows: [{}, {}], messages: ['lag'] } } }] } }, /listed 2 table\(s\)/],
    [{ counts: [['incident', 2], ['', 3]] }, /unreadable/],
  ];
  for (const [options, message] of bad) {
    const f = cascade(2, options);
    await assert.rejects(f.run(), (error) => message.test(error.message) && /preview job was deleted/.test(error.message));
    assert.equal(f.data, undefined);
    assert.deepEqual(f.deletes, []);
    assert.ok(f.calls.some(c => c[0] === 'delete' && c[1] === 'sys_dm_delete'));
  }
});

test('delete-many --preview-cascade exits nonzero when the job cannot be removed', async () => {
  const f = cascade(2, { jobDelete: () => { throw new Error('Denied'); } });
  const previous = process.exitCode;
  try {
    await f.run();
    assert.equal(f.data.cascade.job.status, 'delete failed: Denied');
    assert.equal(process.exitCode, 1);
    assert.match(f.summary, /delete job DM0001001 \(a{32}\) left in sys_dm_delete: delete failed: Denied/);
    assert.match(f.breadcrumbs.at(-1).cmd, /records get --table sys_dm_delete --sys-id a{32}/);
  } finally { process.exitCode = previous; }
});
