import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recordsCmd } from '../src/commands/records.js';
import { runRelatedUndelete } from '../src/record-undelete.js';
import { isMutationCommand } from '../src/mutations.js';

const ID = '5d87aa94c3b8131068353eec0501319d';
const AUDIT = 'dd87ea94c3b8131068353eec050131c7';
const RECOVERY = '9987ea94c3b8131068353eec050131c5';
const CTX = '1987ea94c3b8131068353eec050131c6';
const PROGRESS = '4f1b2c3d4e5f60718293a4b5c6d7e8f9';
const pair = (value, display_value = value) => ({ value, display_value });
const entry = (extra = {}) => ({ sys_id: AUDIT, tablename: 'incident', documentkey: ID, display_value: 'INC0010166', sys_created_on: '2026-11-22 23:00:56',
  sys_created_by: 'admin', delete_recovery: RECOVERY, payload: '<incident><number>INC0010166</number></incident>', ...extra });
const recoveryRow = (extra = {}) => ({ sys_id: pair(RECOVERY), state: pair('finished', 'Finished (Ready for Recovery)'), rollback_context: pair(CTX, 'BAK0001284'), ...extra });
const contextRow = (extra = {}) => ({ sys_id: pair(CTX), number: pair('BAK0001284'), state: pair('recorded', 'Finished recording'), ...extra });
const group = (table, operation, count) => ({ stats: { count: String(count) }, groupby_fields: [{ field: 'target_class_name', value: table }, { field: 'operation', value: operation }] });
const GROUPS = [group('incident', 'delete', 1), group('task_sla', 'delete', 1), group('sys_flow_context', 'update', 1)];
const ANSWER = `<?xml version="1.0" encoding="UTF-8"?><xml sysparm_processor="AJAXRollbackWorker" sysparm_name="start" answer="${PROGRESS}"/>`;

function fixture({ entries = [entry()], recoveries = [recoveryRow()], contexts = [contextRow()], groups = GROUPS, admin = true, answer = ANSWER,
  trackers = [{ sys_id: PROGRESS, state: '2', message: '' }], exists = false, after = true } = {}) {
  const commands = [];
  recordsCmd(fn => fn).builder({ command(c) { commands.push(c); return this; } });
  const handler = commands.find(c => c.command === 'undelete').handler;
  const calls = [];
  trackers = [...trackers];
  const writes = () => calls.filter(c => c.kind === 'write' || c.kind === 'script');
  const sdk = {
    baseURL: 'https://dev.example.service-now.com',
    listStrict: async (table, params) => {
      calls.push({ kind: 'read', table, ...Object.fromEntries(params) });
      if (table === 'sys_audit_delete') return entries;
      if (table === 'sys_delete_recovery') return recoveries;
      if (table === 'sys_rollback_context') return contexts;
      if (table === 'sys_user_has_role') return admin ? [{ sys_id: 'a' }] : [];
      if (after instanceof Error && calls.some(c => c.kind === 'write')) throw after;
      return (calls.some(c => c.kind === 'write') ? after : exists) ? [{ sys_id: ID }] : [];
    },
    aggregate: async (table, options) => { calls.push({ kind: 'aggregate', table, ...options }); return { groups }; },
    rawRequest: async (url, options) => { calls.push({ kind: 'write', url, method: options.method }); return answer; },
    get: async (table, id) => {
      calls.push({ kind: 'tracker', table, id });
      const next = trackers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    executeScript: async (script) => { calls.push({ kind: 'script', script }); return 'JSN_UNDELETE:dispatched'; },
  };
  let ok;
  const app = { config: {}, sdk, ok(data, opts) { ok = { data, opts }; } };
  return { sdk, calls, writes, get ok() { return ok; },
    run: (args = {}) => handler({ _: ['records', 'undelete'], table: 'incident', 'sys-id': ID, 'with-related': true, yes: false, force: false, ...args }, app) };
}

const pause = async () => {};

test('--yes without --with-related, and a malformed table or sys_id, are refused before any request', async () => {
  for (const args of [{ 'with-related': false, yes: true }, { table: 'incident^ORactive=true' }, { 'sys-id': 'INC0010166' }, { 'sys-id': `${ID}0` }]) {
    const f = fixture();
    await assert.rejects(f.run(args), /--yes goes with --with-related|--table|--sys-id/);
    assert.deepEqual(f.calls, [], JSON.stringify(args));
  }
});

test('--with-related previews what the delete recovery brings back, by table, without writing', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.writes(), []);
  assert.equal(f.calls[0].sysparm_fields, 'sys_id,tablename,documentkey,display_value,sys_created_on,sys_created_by,delete_recovery,payload');
  const reads = f.calls.filter(c => c.kind === 'read').map(c => [c.table, c.sysparm_query]);
  assert.deepEqual(reads.slice(2), [['sys_delete_recovery', `sys_id=${RECOVERY}`], ['sys_rollback_context', `sys_id=${CTX}`]]);
  const aggregate = f.calls.find(c => c.kind === 'aggregate');
  assert.equal(aggregate.table, 'sys_rollback_sequence');
  assert.equal(aggregate.query, `context=${CTX}^audit_delete=${AUDIT}^ORaudit_delete_pathLIKE${AUDIT}^recovered!=true^ORrecoveredISEMPTY`);
  assert.deepEqual(aggregate.groupBy, ['target_class_name', 'operation']);
  assert.equal(f.ok.data.restored, false);
  assert.equal(f.ok.data.total, 3);
  assert.deepEqual(f.ok.data.delete_recovery, { sys_id: RECOVERY, state: 'finished' });
  assert.deepEqual(f.ok.data.rollback_context, { sys_id: CTX, number: 'BAK0001284', state: 'recorded' });
  assert.equal(f.ok.opts.summary, 'Preview: undeleting incident INC0010166 with related records replays 3 operation(s) from BAK0001284: incident delete 1, task_sla delete 1, sys_flow_context update 1');
  assert.equal(f.ok.opts.breadcrumbs[0].cmd, `jsn records undelete --table incident --sys-id ${ID} --with-related --yes`);
});

test('--with-related refuses, writing nothing, when there is no usable delete recovery', async () => {
  const cases = [
    [{ entries: [entry({ delete_recovery: '' })] }, /has no delete recovery.*Table API deletes.*without --with-related/s],
    [{ entries: [entry({ delete_recovery: 'BAK0001284' })] }, /malformed delete recovery/],
    [{ recoveries: [] }, /Delete recovery .* cannot be read; the docs give seven days/],
    [{ recoveries: [recoveryRow({ sys_id: pair(CTX) })] }, /Delete recovery .* cannot be read/],
    [{ recoveries: [recoveryRow({ rollback_context: pair('', '') })] }, /has no rollback context/],
    [{ contexts: [] }, /rollback context .* cannot be read.*ten days/],
    [{ groups: [] }, /BAK0001284 has nothing left to restore/],
    [{ groups: [group('incident', 'delete', 0)] }, /Unreadable operation counts .*Nothing was restored/],
    [{ groups: [group('', 'delete', 1)] }, /Unreadable operation counts/],
    [{ groups: [group('incident', '', 1)] }, /Unreadable operation counts/],
    [{ exists: true }, /already exists\. Nothing was restored/],
    [{ entries: [] }, /No deleted record/],
  ];
  for (const [options, message] of cases) {
    for (const yes of [false, true]) {
      const f = fixture(options);
      await assert.rejects(f.run({ yes }), message);
      assert.deepEqual(f.writes(), [], JSON.stringify(options));
      assert.equal(f.ok, undefined);
    }
  }
});

test('--with-related --yes starts the worker for that deleted-record entry, follows it and reads the record back', async () => {
  const f = fixture();
  await f.run({ yes: true });
  const writes = f.writes();
  assert.equal(writes.length, 1);
  const url = new URL(writes[0].url);
  assert.equal(writes[0].method, 'POST');
  assert.equal(url.pathname, '/xmlhttp.do');
  assert.deepEqual(Object.fromEntries(url.searchParams), { sysparm_processor: 'AJAXRollbackWorker', sysparm_name: 'start', sysparm_ajax_processor_audit_delete_id: AUDIT });
  const admin = f.calls.findIndex(c => c.table === 'sys_user_has_role');
  assert.ok(admin >= 0 && admin < f.calls.indexOf(writes[0]));
  assert.deepEqual(f.calls.filter(c => c.kind === 'tracker').map(c => [c.table, c.id]), [['sys_execution_tracker', PROGRESS]]);
  assert.equal(f.calls.at(-1).table, 'incident');
  assert.equal(f.ok.data.restored, true);
  assert.equal(f.ok.data.progress_id, PROGRESS);
  assert.match(f.ok.opts.summary, /^Restored incident INC0010166 with related records from BAK0001284 \(3 operation\(s\) replayed/);
});

test('--with-related --yes refuses a user without admin before starting anything', async () => {
  const f = fixture({ admin: false });
  await assert.rejects(f.run({ yes: true }), /needs the admin role.*Nothing was restored/);
  assert.deepEqual(f.writes(), []);
});

test('--with-related --yes never reports success when the outcome is unknown or wrong', async () => {
  const check = new RegExp(`Check jsn records get --table incident --sys-id ${ID} and jsn records get --table sys_delete_recovery --sys-id ${RECOVERY}`);
  const cases = [
    [{ answer: '<xml answer="nope"/>' }, /returned no progress id, so its outcome is unknown/],
    [{ trackers: [{ sys_id: PROGRESS, state: '3', message: 'boom' }], after: false }, /ended failed \(boom\) and the record is still missing/],
    [{ trackers: [{ sys_id: PROGRESS, state: '3', message: 'boom' }] }, /ended failed \(boom\) and the record is back/],
    [{ after: false }, /ended successful and the record is still missing/],
    [{ trackers: [{ sys_id: PROGRESS, state: '9' }] }, /unreadable execution tracker.*do not rerun it/],
    [{ trackers: [Object.assign(new Error('socket hang up'), { status: 0 })] }, /started \(progress .*do not rerun it\. Reading its outcome failed: socket hang up/],
    [{ after: Object.assign(new Error('HTTP 500'), { status: 500 }) }, /started \(progress .*do not rerun it\. Reading its outcome failed: HTTP 500/],
  ];
  for (const [options, message] of cases) {
    const f = fixture(options);
    const error = await f.run({ yes: true }).then(() => null, e => e);
    assert.ok(error, JSON.stringify(options));
    assert.match(error.message, message);
    assert.match(`${error.message} ${error.hint}`, check);
    assert.equal(f.ok, undefined);
  }
});

test('runRelatedUndelete refuses a plan with a malformed id before any request', async () => {
  const plan = { table: 'incident', sys_id: ID, audit_delete: AUDIT, delete_recovery: { sys_id: RECOVERY }, rollback_context: { number: 'BAK0001284' } };
  for (const bad of [{ table: 'incident^ORactive=true' }, { sys_id: 'INC0010166' }, { audit_delete: 'x' }, { delete_recovery: { sys_id: '' } }]) {
    const f = fixture();
    await assert.rejects(runRelatedUndelete(f.sdk, { ...plan, ...bad }), /--table|--sys-id|Nothing was restored/);
    assert.deepEqual(f.calls, [], JSON.stringify(bad));
  }
});

test('runRelatedUndelete stops waiting at its deadline and says the worker carries on', async () => {
  const f = fixture({ trackers: Array.from({ length: 5 }, () => ({ sys_id: PROGRESS, state: '1' })) });
  const plan = { table: 'incident', sys_id: ID, audit_delete: AUDIT, delete_recovery: { sys_id: RECOVERY }, rollback_context: { number: 'BAK0001284' } };
  await assert.rejects(runRelatedUndelete(f.sdk, plan, { timeoutMs: 0, pause }), /still running after 0s .*carries on in the background/);
  assert.equal(f.writes().length, 1);
});

test('undelete --with-related stays a guarded mutation and its help lists the flags', () => {
  assert.equal(isMutationCommand({ _: ['records', 'undelete'], 'with-related': true }), true);
  const result = spawnSync(process.execPath, ['cli/bin/jsn.js', 'records', 'undelete', '--help'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--with-related', '--yes']) assert.ok(result.stdout.includes(flag), flag);
  assert.match(result.stdout, /Undelete With Related/);
});
