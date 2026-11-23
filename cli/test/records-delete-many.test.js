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
    ok(value) { data = value; },
  };
  return { app, deletes, reads, get data() { return data; },
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
  for (const flag of ['--query', '--expect-count', '--yes', '--dry-run', '--limit']) assert.ok(result.stdout.includes(flag));
});
