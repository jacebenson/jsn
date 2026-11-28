import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsCmd } from '../src/commands/records.js';
import { queryMetadataFixture } from './support/query-metadata-fixture.js';
import { makeApp } from './support/app-test-helpers.js';

function fixture(size = 2) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'bulk').handler;
  const rows = Array.from({ length: size }, (_, i) => ({ sys_id: String(i).padStart(32, '0'), state: '1' }));
  const writes = [];
  const reads = [];
  const app = makeApp({
    sdk: {
      aggregateCount: async () => rows.length,
      list: async (table, params, opts) => {
        const metadata = queryMetadataFixture(table, params, opts);
        if (metadata) return metadata;
        reads.push(Object.fromEntries(params));
        const query = params.get('sysparm_query');
        if (query.startsWith('sys_id=')) return rows.filter(r => r.sys_id === query.slice(7));
        const offset = Number(params.get('sysparm_offset') || 0);
        return rows.slice(offset, offset + Number(params.get('sysparm_limit')));
      },
      update: async (table, id, body) => { writes.push(id); Object.assign(rows.find(r => r.sys_id === id), body); return { sys_id: id }; },
    },
  });
  return { app, rows, writes, reads, get data() { return app.lastOk?.data; }, get summary() { return app.lastOk?.opts.summary; },
    run: (args = {}) => handler({ table: 'incident', query: 'priority=1', field: ['state=2'], 'dry-run': false, execute: true, force: true, limit: 200, ...args }, app) };
}

async function exitCodeOf(fn) {
  const previous = process.exitCode;
  try { await fn(); return process.exitCode; } finally { process.exitCode = previous; }
}

test('bulk refuses a match count over --limit before confirmation, reads or any write', async () => {
  const f = fixture(250);
  await assert.rejects(f.run({ force: false }), /Matched 250 records, exceeding --limit 200.*No records updated/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
});

test('bulk dry run still previews a count over --limit without writing', async () => {
  const f = fixture(250);
  await f.run({ 'dry-run': true, execute: false });
  assert.equal(f.data.count, 250);
  assert.equal(f.data.dry_run, true);
  assert.deepEqual(f.writes, []);
});

test('bulk refuses an invalid --limit or unreadable count with zero writes', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    const f = fixture();
    await assert.rejects(f.run({ limit }), /--limit must be a positive safe integer/);
    assert.deepEqual(f.writes, []);
  }
  for (const count of [null, undefined, -1, 'many']) {
    const f = fixture();
    f.app.sdk.aggregateCount = async () => count;
    await assert.rejects(f.run(), /Cannot verify the matching count/);
    assert.deepEqual(f.writes, []);
  }
});

test('bulk pages the whole confirmed count in sys_id order, then reads back a sample', async () => {
  const f = fixture(1002);
  const code = await exitCodeOf(() => f.run({ limit: 1002 }));
  assert.equal(code, undefined);
  const pages = f.reads.filter(r => !r.sysparm_query.startsWith('sys_id='));
  assert.deepEqual(pages.map(r => [r.sysparm_query, r.sysparm_offset, r.sysparm_limit]),
    [['priority=1^ORDERBYsys_id', '0', '1000'], ['priority=1^ORDERBYsys_id', '1000', '2']]);
  assert.equal(f.writes.length, 1002);
  assert.equal(new Set(f.writes).size, 1002);
  assert.equal(f.data.updated, 1002);
  assert.deepEqual(f.data.failed, []);
  assert.equal(f.data.read_back.sys_ids.length, 5);
  assert.deepEqual(f.data.read_back.mismatches, []);
  assert.equal(f.data.verified, true);
  assert.match(f.summary, /Updated 1002 of 1002 .*read back 5/);
});

test('bulk refuses a failed or short enumeration page with zero writes', async () => {
  const failing = fixture(3);
  failing.app.sdk.list = async (table, params, opts) => {
    const metadata = queryMetadataFixture(table, params, opts);
    if (metadata) return metadata;
    throw new Error('HTTP 500');
  };
  await assert.rejects(failing.run(), /HTTP 500/);
  assert.deepEqual(failing.writes, []);

  const short = fixture(3);
  short.app.sdk.aggregateCount = async () => 4;
  await assert.rejects(short.run(), /Enumeration differs from the 4 counted records.*No records updated/);
  assert.deepEqual(short.writes, []);
});

test('bulk counts each failed write and exits nonzero', async () => {
  const f = fixture(3);
  const update = f.app.sdk.update;
  f.app.sdk.update = async (table, id, body) => {
    if (id.endsWith('1')) throw new Error('ACL denied');
    return update(table, id, body);
  };
  const code = await exitCodeOf(() => f.run());
  assert.equal(code, 1);
  assert.equal(f.data.updated, 2);
  assert.deepEqual(f.data.failed, [{ sys_id: '0'.repeat(31) + '1', error: 'ACL denied' }]);
  assert.equal(f.data.verified, false);
  assert.match(f.summary, /incomplete.*2 updated, 1 failed of 3/);
});

test('bulk read-back reports a field the instance ignored and exits nonzero', async () => {
  const f = fixture(2);
  f.app.sdk.update = async (table, id) => { f.writes.push(id); return { sys_id: id }; };
  const code = await exitCodeOf(() => f.run());
  assert.equal(code, 1);
  assert.equal(f.data.updated, 2);
  assert.deepEqual(f.data.read_back.mismatches.map(m => [m.sys_id, m.field, m.sent, m.got]),
    [['0'.repeat(32), 'state', '2', '1'], ['0'.repeat(31) + '1', 'state', '2', '1']]);
  assert.equal(f.data.verified, false);
  assert.match(f.summary, /2 field\(s\) not persisted/);
});
