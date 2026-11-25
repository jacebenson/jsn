import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';
import { collectCapabilities } from '../src/capabilities.js';

const id = n => n.toString(16).padStart(32, '0');
const ref = (value, display = value) => ({ value, display_value: display });
const entry = (n, extra = {}) => ({ sys_id: ref(id(0xa00 + n)), tablename: ref('incident'), documentkey: ref(id(n)), display_value: ref(`INC00${n}`),
  transaction: ref('', ''), delete_recovery: ref('', ''), sys_created_by: ref('admin'), sys_created_on: ref('2026-11-22 23:00:56', '2026-11-23 10:00:56'), ...extra });
const RECOVERY = id(0xb01);
const CONTEXT = id(0xc01);

function fixture({ entries = [entry(1)], present = [], denied = [], recoveries = [], contexts = [] } = {}) {
  const commands = [];
  recordsCmd(fn => fn).builder({ command(c) { commands.push(c); return this; } });
  const handler = commands.find(c => c.command === 'deleted').handler;
  const reads = [];
  let data, extras;
  const app = {
    config: {},
    sdk: {
      listStrict: async (table, params) => {
        reads.push({ table, ...Object.fromEntries(params) });
        if (denied.includes(table)) throw Object.assign(new Error(`403 Forbidden reading ${table}`), { status: 403 });
        if (table === 'sys_audit_delete') return typeof entries === 'function' ? entries() : entries;
        if (table === 'sys_delete_recovery') return recoveries;
        if (table === 'sys_rollback_context') return contexts;
        return present.map(sysId => ({ sys_id: ref(sysId) }));
      },
    },
    ok(value, more) { data = value; extras = more; },
  };
  return { reads, get data() { return data; }, get extras() { return extras; },
    run: (args = {}) => handler({ _: ['records', 'deleted'], limit: 20, ...args }, app) };
}

test('deleted refuses bad flags before any request', async () => {
  for (const args of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { table: 'incident^ORactive=true' }, { table: 'Incident' },
    { by: 'a b' }, { by: 'admin^ORsys_created_by=x' }, { since: '2026/11/22' }, { since: '22-11-2026' }, { since: 'yesterday' }]) {
    const f = fixture();
    await assert.rejects(f.run(args), /--limit|--table|--by|--since/);
    assert.deepEqual(f.reads, [], JSON.stringify(args));
    assert.equal(f.data, undefined);
  }
});

test('deleted reads sys_audit_delete with the exact filter, fields and one row of lookahead', async () => {
  const f = fixture();
  await f.run({ table: 'incident', by: 'admin', since: '2026-11-22', query: 'delete_recoveryISNOTEMPTY', limit: 2 });
  assert.deepEqual(f.reads[0], { table: 'sys_audit_delete',
    sysparm_query: 'tablename=incident^sys_created_by=admin^sys_created_on>=2026-11-22^delete_recoveryISNOTEMPTY^ORDERBYDESCsys_created_on',
    sysparm_fields: 'sys_id,tablename,documentkey,display_value,transaction,delete_recovery,sys_created_by,sys_created_on',
    sysparm_display_value: 'all', sysparm_limit: '3' });
  assert.equal(f.data.query, f.reads[0].sysparm_query);
  await fixture().run({ since: '2026-11-22 09:30' });
});

test('deleted keeps the page to --limit and says when more match', async () => {
  const more = fixture({ entries: [entry(1), entry(2), entry(3)] });
  await more.run({ limit: 2 });
  assert.equal(more.data.count, 2);
  assert.deepEqual(more.data.pagination, { limit: 2, has_more: true });
  assert.match(more.data._formatted, /More match; narrow with --table, --by or --since, or raise --limit \(now 2\)/);
  const exact = fixture({ entries: [entry(1), entry(2)] });
  await exact.run({ limit: 2 });
  assert.deepEqual(exact.data.pagination, { limit: 2, has_more: false });
});

test('deleted checks each table once by raw sys_id and says which records are back', async () => {
  const f = fixture({ entries: [entry(1), entry(2), entry(3, { tablename: ref('problem') })], present: [id(2)] });
  await f.run();
  const checks = f.reads.filter(r => r.table !== 'sys_audit_delete');
  assert.deepEqual(checks.map(r => [r.table, r.sysparm_query, r.sysparm_fields]), [
    ['incident', `sys_idIN${id(1)},${id(2)}`, 'sys_id'], ['problem', `sys_idIN${id(3)}`, 'sys_id']]);
  assert.deepEqual(f.data.records.map(r => [r.sys_id, r.back]), [[id(1), false], [id(2), true], [id(3), false]]);
  assert.deepEqual(f.data.records[0], { audit_delete: id(0xa01), table: 'incident', sys_id: id(1), display_value: 'INC001', deleted_by: 'admin',
    deleted_on: '2026-11-22 23:00:56', transaction: '', back: false, delete_recovery: null });
  assert.equal(f.extras.breadcrumbs[0].cmd, `jsn records undelete --table incident --sys-id ${id(1)}`);
});

test('deleted leaves "back" unknown, never "no", when the record\'s table cannot be read', async () => {
  const f = fixture({ denied: ['incident'] });
  await f.run();
  assert.equal(f.data.records[0].back, null);
  assert.match(f.data.records[0].back_error, /403/);
  assert.match(f.data._formatted, /back: unknown \(403 Forbidden reading incident\)/);
  assert.equal(f.extras.breadcrumbs[0].cmd, 'jsn records undelete --table <table> --sys-id <deleted sys_id>');
});

test('a denied or malformed sys_audit_delete read is an error, never an empty list', async () => {
  const denied = fixture({ denied: ['sys_audit_delete'] });
  await assert.rejects(denied.run(), /403/);
  assert.equal(denied.data, undefined);
  for (const entries of [{ result: [] }, [null], [{ tablename: ref('incident') }], [{ sys_id: ref('INC0010166') }]]) {
    const f = fixture({ entries });
    await assert.rejects(f.run(), /Malformed sys_audit_delete response/);
    assert.equal(f.data, undefined);
  }
});

test('deleted joins delete recoveries and rollback contexts by raw sys_id', async () => {
  const withRecovery = (n, recovery) => entry(n, { delete_recovery: ref(recovery, 'BAK0001284') });
  const f = fixture({ entries: [withRecovery(1, RECOVERY), withRecovery(2, RECOVERY), withRecovery(3, id(0xb99))],
    recoveries: [{ sys_id: ref(RECOVERY), state: ref('finished', 'Finished (Ready for Recovery)'), rollback_context: ref(CONTEXT, 'BAK0001284') }],
    contexts: [{ sys_id: ref(CONTEXT), number: ref('BAK0001284'), state: ref('recorded', 'Finished recording'), type: ref('delete') }] });
  await f.run();
  const recoveryRead = f.reads.find(r => r.table === 'sys_delete_recovery');
  assert.equal(recoveryRead.sysparm_query, `sys_idIN${RECOVERY},${id(0xb99)}`);
  assert.equal(f.reads.find(r => r.table === 'sys_rollback_context').sysparm_query, `sys_idIN${CONTEXT}`);
  assert.deepEqual(f.data.records[0].delete_recovery, { sys_id: RECOVERY, found: true, state: 'finished', state_label: 'Finished (Ready for Recovery)',
    rollback_context: { sys_id: CONTEXT, number: 'BAK0001284', state: 'recorded', state_label: 'Finished recording' }, recoverable: true });
  assert.deepEqual(f.data.records[2].delete_recovery, { sys_id: id(0xb99), found: false, state: null, state_label: null, rollback_context: null, recoverable: false });
  assert.match(f.data._formatted, /cascade recovery: BAK0001284, Finished \(Ready for Recovery\), context Finished recording\n/);
  assert.match(f.data._formatted, new RegExp(`cascade recovery: ${id(0xb99)}, no longer recorded`));
});

test('a recovery already used, or a context no longer recorded, is not recoverable', async () => {
  for (const [state, contextState] of [['recovered', 'recorded'], ['finished', 'rolled_back']]) {
    const f = fixture({ entries: [entry(1, { delete_recovery: ref(RECOVERY, 'x') })],
      recoveries: [{ sys_id: ref(RECOVERY), state: ref(state), rollback_context: ref(CONTEXT) }],
      contexts: [{ sys_id: ref(CONTEXT), number: ref('BAK1'), state: ref(contextState) }] });
    await f.run();
    assert.equal(f.data.records[0].delete_recovery.recoverable, false);
    assert.match(f.data._formatted, /, not recoverable\n/);
  }
});

test('deleted with no matches reads nothing else and says so', async () => {
  const f = fixture({ entries: [] });
  await f.run();
  assert.deepEqual(f.reads.map(r => r.table), ['sys_audit_delete']);
  assert.equal(f.data.count, 0);
  assert.match(f.data._formatted, /\(no deleted records match\)/);
});

test('deleted is a read, validates --query on sys_audit_delete, and its help lists its flags', () => {
  assert.equal(isMutationCommand({ _: ['records', 'deleted'] }), false);
  assert.equal(collectCapabilities().get('records').queryTable({ _: ['records', 'deleted'], table: 'incident' }), 'sys_audit_delete');
  assert.equal(collectCapabilities().get('records').queryTable({ _: ['records', 'list'], table: 'incident' }), 'incident');
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'deleted', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--table', '--by', '--since', '--query', '--limit']) assert.ok(result.stdout.includes(flag), flag);
  assert.match(result.stdout, /Read only/);
});
