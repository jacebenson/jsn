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
  const state = {};
  const app = makeApp({
    sdk: {
      // Like the SDK: a malformed count is 0 unless strict, which throws.
      aggregateCount: async (table, query, opts) => {
        const count = Object.hasOwn(state, 'count') ? state.count : rows.length;
        if (Number.isSafeInteger(count) && count >= 0) return count;
        if (opts?.strict === true) throw new Error(`Invalid aggregate count response for ${table}`);
        return 0;
      },
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
  return { app, rows, writes, reads, state, get data() { return app.lastOk?.data; }, get summary() { return app.lastOk?.opts.summary; },
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
    f.state.count = count;
    await assert.rejects(f.run(), /Invalid aggregate count response for incident/);
    assert.deepEqual(f.writes, []);
  }
});

test('bulk pages the whole confirmed count in sys_id order, then reads back a sample', async () => {
  const f = fixture(1002);
  const code = await exitCodeOf(() => f.run({ limit: 1002 }));
  assert.equal(code, undefined);
  const pages = f.reads.filter(r => !r.sysparm_query.startsWith('sys_id='));
  assert.deepEqual(pages.map(r => [r.sysparm_query, r.sysparm_offset, r.sysparm_limit]),
    [['priority=1^ORDERBYsys_id', '0', '1000'], ['priority=1^ORDERBYsys_id', '1000', '3']]);
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
  short.state.count = 4;
  await assert.rejects(short.run(), /Enumeration differs from the 4 counted records.*No records updated/);
  assert.deepEqual(short.writes, []);

  const wider = fixture(4);
  wider.state.count = 3;
  await assert.rejects(wider.run(), /Enumeration differs from the 3 counted records.*No records updated/);
  assert.deepEqual(wider.writes, []);
});

test('bulk drops a lone trailing caret so the appended order cannot become a literal caret', async () => {
  for (const [query, ordered] of [['priority=1^', 'priority=1^ORDERBYsys_id'], ['priority=1^^', 'priority=1^^^ORDERBYsys_id']]) {
    const f = fixture(2);
    f.app.sdk.list = async (table, params, opts) => {
      const metadata = queryMetadataFixture(table, params, opts);
      if (metadata) return metadata;
      const q = params.get('sysparm_query');
      if (q.startsWith('sys_id=')) return f.rows.filter(r => r.sys_id === q.slice(7));
      f.reads.push(q);
      return q === ordered ? f.rows : [...f.rows, { sys_id: 'f'.repeat(32) }];
    };
    const code = await exitCodeOf(() => f.run({ query }));
    assert.equal(code, undefined);
    assert.deepEqual(f.reads, [ordered]);
    assert.equal(f.writes.length, 2);
  }
});

test('bulk skips journal fields in the read-back, since they return the rendered journal', async () => {
  const f = fixture(2);
  const update = f.app.sdk.update;
  f.app.sdk.update = async (table, id, body) => update(table, id, { ...body, ...(body.work_notes ? { work_notes: `2026-11-28 10:00:00 - System Administrator (Work notes)\n${body.work_notes}` } : {}) });
  const code = await exitCodeOf(() => f.run({ field: ['state=2', 'work_notes=checked'] }));
  assert.equal(code, undefined);
  assert.equal(f.data.read_back.sys_ids.length, 2);
  assert.deepEqual(f.data.read_back.mismatches, []);
  assert.equal(f.data.verified, true);

  const journalOnly = fixture(2);
  assert.equal(await exitCodeOf(() => journalOnly.run({ field: ['work_notes=checked'] })), undefined);
  assert.equal(journalOnly.writes.length, 2);
  assert.deepEqual(journalOnly.data.read_back.sys_ids, []);
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
  assert.match(f.summary, /read-back of 2 found 2 field\(s\) not persisted or unreadable/);
});
