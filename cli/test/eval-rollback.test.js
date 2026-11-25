import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yargs } from '../src/cli-adapter.js';
import { evalCmd } from '../src/commands/eval.js';
import { runRollback } from '../src/eval-rollback.js';
import { isMutationCommand } from '../src/mutations.js';
import { SDKClient } from '../src/sdk.js';

const EXEC = 'c8ef6285c3fc971068353eec0501311a';
const CTX = '3323c505c370971068353eec0501310c';
const PROGRESS = '4f1b2c3d4e5f60718293a4b5c6d7e8f9';
const pair = (value, display_value = value) => ({ value, display_value });
const historyRow = (extra = {}) => ({ sys_id: pair(EXEC), script: pair("var gr = new GlideRecord('incident'); gr.insert();"),
  executed_by: pair('6816f79cc0a8016401c5a33be04be441', 'System Administrator'), started: pair('2026-11-25 10:00:00'),
  rollback_context: pair(CTX, 'BAK0001572'), ...extra });
const contextRow = (state = 'recorded', extra = {}) => ({ sys_id: pair(CTX), number: pair('BAK0001572'),
  state: pair(state, { recorded: 'Finished recording', rolled_back: 'Rolled back' }[state] || state), type: pair('scripts_bg', 'Scripts - Background'), ...extra });
const group = (table, operation, count) => ({ stats: { count: String(count) }, groupby_fields: [{ field: 'target_class_name', value: table }, { field: 'operation', value: operation }] });
const ANSWER = `<?xml version="1.0" encoding="UTF-8"?><xml sysparm_processor="AJAXRollbackWorker" sysparm_name="start" answer="${PROGRESS}"/>`;

function fixture({ history = [historyRow()], contexts = [contextRow(), contextRow('rolled_back')], groups = [group('incident', 'insert', 1), group('task_sla', 'update', 2)],
  admin = true, answer = ANSWER, trackers = [{ sys_id: PROGRESS, state: '2', message: '' }] } = {}) {
  const commands = [];
  const builder = new Proxy({}, { get: (_target, name) => name === 'command' ? (c) => { commands.push(c); return builder; } : () => builder });
  evalCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command === 'rollback <execution>').handler;
  const calls = [];
  contexts = [...contexts]; trackers = [...trackers];
  const sdk = {
    baseURL: 'https://dev.example.service-now.com',
    listStrict: async (table, params) => {
      calls.push({ kind: 'read', table, ...Object.fromEntries(params) });
      if (table === 'sys_script_execution_history') return history;
      if (table === 'sys_rollback_context') { const next = contexts.shift(); if (next instanceof Error) throw next; return [next]; }
      if (table === 'sys_user_has_role') return admin ? [{ sys_id: 'a' }] : [];
      return [];
    },
    aggregate: async (table, options) => { calls.push({ kind: 'aggregate', table, ...options }); return { groups }; },
    rawRequest: async (url, options) => { calls.push({ kind: 'write', url, method: options.method }); return answer; },
    get: async (table, id) => {
      calls.push({ kind: 'tracker', table, id });
      const next = trackers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  let ok;
  const app = { sdk, ok(data, opts) { ok = { data, opts }; } };
  return { sdk, calls, writes: () => calls.filter(c => c.kind === 'write'), get ok() { return ok; },
    run: (args = {}) => handler({ _: ['eval', 'rollback'], execution: EXEC, yes: false, ...args }, app) };
}

const plan = { execution: EXEC, rollback_context: { sys_id: CTX, number: 'BAK0001572', state: 'recorded' }, operations: [], total: 3 };

test('eval rollback refuses a malformed execution id before any request', async () => {
  for (const execution of ['BAK0001572', `${EXEC}0`, '', undefined, `${EXEC.slice(0, 31)}^`]) {
    const f = fixture();
    await assert.rejects(f.run({ execution }), /32-character sys_id/);
    assert.deepEqual(f.calls, []);
  }
});

test('eval rollback previews the execution and its recorded operations without writing', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls.slice(0, 3), [
    { kind: 'read', table: 'sys_script_execution_history', sysparm_query: `sys_id=${EXEC}`, sysparm_fields: 'sys_id,script,executed_by,started,rollback_context', sysparm_display_value: 'all', sysparm_limit: '1' },
    { kind: 'read', table: 'sys_rollback_context', sysparm_query: `sys_id=${CTX}`, sysparm_fields: 'sys_id,number,state,type', sysparm_display_value: 'all', sysparm_limit: '1' },
    { kind: 'aggregate', table: 'sys_rollback_sequence', query: `context=${CTX}`, groupBy: ['target_class_name', 'operation'] },
  ]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.ok.data.rolled_back, false);
  assert.equal(f.ok.data.total, 3);
  assert.deepEqual(f.ok.data.operations, [{ table: 'incident', operation: 'insert', count: 1 }, { table: 'task_sla', operation: 'update', count: 2 }]);
  assert.deepEqual(f.ok.data.rollback_context, { sys_id: CTX, number: 'BAK0001572', state: 'recorded' });
  assert.equal(f.ok.data.executed_by, 'System Administrator');
  assert.equal(f.ok.opts.summary, 'Preview: rolling back BAK0001572 (script run by System Administrator at 2026-11-25 10:00:00) reverts 3 recorded operation(s): incident insert 1, task_sla update 2');
  assert.equal(f.ok.opts.breadcrumbs[0].cmd, `jsn eval rollback ${EXEC} --yes`);
});

test('eval rollback refuses, writing nothing, when the execution or its context cannot be rolled back', async () => {
  const cases = [
    [{ history: [] }, /not found|sys_script_execution_history/i],
    [{ history: [historyRow({ sys_id: pair('0'.repeat(32)) })] }, /is not c8ef/],
    [{ history: [historyRow({ rollback_context: pair('', '') })] }, /no rollback context/],
    [{ history: [historyRow({ rollback_context: pair('BAK0001572') })] }, /sys_id for the rollback context/],
    [{ contexts: [undefined] }, /not found|sys_rollback_context/i],
    [{ contexts: [contextRow('recorded', { sys_id: pair('0'.repeat(32)) })] }, /is not 3323/],
    [{ contexts: [contextRow('recorded', { type: pair('delete_recovery', 'Deleted Record(s)') })] }, /not a background script's/],
    [{ contexts: [contextRow('rolled_back')] }, /is Rolled back, not Finished recording/],
    [{ contexts: [contextRow('partially_rolled_back')] }, /not Finished recording/],
    [{ groups: [] }, /recorded no operations/],
    [{ groups: [group('incident', 'insert', 0)] }, /Unreadable operation counts/],
    [{ groups: [{ stats: { count: '1' }, groupby_fields: [] }] }, /Unreadable operation counts/],
  ];
  for (const [options, message] of cases) {
    for (const yes of [false, true]) {
      const f = fixture(options);
      await assert.rejects(f.run({ yes }), message);
      assert.deepEqual(f.writes(), []);
      assert.equal(f.ok, undefined);
    }
  }
});

test('eval rollback --yes starts the platform rollback, follows its tracker and checks the context', async () => {
  const f = fixture();
  await f.run({ yes: true });
  const [write] = f.writes();
  const url = new URL(write.url);
  assert.equal(write.method, 'POST');
  assert.equal(url.origin + url.pathname, 'https://dev.example.service-now.com/xmlhttp.do');
  assert.deepEqual(Object.fromEntries(url.searchParams), { sysparm_processor: 'AJAXRollbackWorker', sysparm_name: 'start', sysparm_ajax_processor_context_id: CTX });
  assert.deepEqual(f.calls.find(c => c.table === 'sys_user_has_role'), { kind: 'read', table: 'sys_user_has_role', sysparm_query: 'user=javascript:gs.getUserID()^role.name=admin', sysparm_fields: 'sys_id', sysparm_limit: '1' });
  assert.ok(f.calls.findIndex(c => c.table === 'sys_user_has_role') < f.calls.indexOf(write));
  assert.deepEqual(f.calls.filter(c => c.kind === 'tracker'), [{ kind: 'tracker', table: 'sys_execution_tracker', id: PROGRESS }]);
  assert.equal(f.calls.at(-1).table, 'sys_rollback_context');
  assert.equal(f.ok.data.rolled_back, true);
  assert.equal(f.ok.data.progress_id, PROGRESS);
  assert.equal(f.ok.data.rollback_context.state, 'rolled_back');
  assert.equal(f.ok.opts.summary, 'Rolled back BAK0001572: its context now reads Rolled back (3 operation(s) recorded; records changed since by anything else are left as they are)');
});

test('eval rollback refuses a user without admin before starting anything', async () => {
  const f = fixture({ admin: false });
  await assert.rejects(f.run({ yes: true }), /needs the admin role/);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.ok, undefined);
});

test('eval rollback reports an unknown outcome when the processor gives no progress id', async () => {
  for (const answer of ['<xml answer=""/>', '<xml answer="null"/>', 'not xml <', '<!DOCTYPE x><xml answer="' + PROGRESS + '"/>', '<html>login</html>']) {
    const f = fixture({ answer });
    await assert.rejects(f.run({ yes: true }), error => error.code === 'api_error' && error.hint === `Check jsn records get --table sys_rollback_context --sys-id ${CTX}.` && /returned no progress id, so its outcome is unknown/.test(error.message));
    assert.equal(f.writes().length, 1);
    assert.deepEqual(f.calls.filter(c => c.kind === 'tracker'), []);
    assert.equal(f.ok, undefined);
  }
});

test('eval rollback waits through an unreadable tracker and a running state', async () => {
  const notFound = Object.assign(new Error('Record not found'), { status: 404 });
  const f = fixture({ trackers: [notFound, { sys_id: PROGRESS, state: '1' }, { sys_id: PROGRESS, state: 'successful' }], contexts: [contextRow('rolled_back')] });
  const pauses = [];
  const data = await runRollback(f.sdk, plan, { pause: async ms => { pauses.push(ms); } });
  assert.equal(data.rolled_back, true);
  assert.deepEqual(pauses, [2000, 2000]);
});

test('eval rollback never reports success unless the tracker succeeded and the context reads rolled back', async () => {
  const cases = [
    [{ trackers: [{ sys_id: PROGRESS, state: '3', message: 'Rollback failed' }] }, /ended failed \(Rollback failed\)/],
    [{ trackers: [{ sys_id: PROGRESS, state: '4' }] }, /ended cancelled/],
    [{ contexts: [contextRow(), contextRow('partially_rolled_back')] }, /ended successful and the context reads partially_rolled_back, not Rolled back/],
    [{ trackers: [{ sys_id: PROGRESS, state: '7' }] }, /unreadable execution tracker/],
    [{ trackers: [{ sys_id: '0'.repeat(32), state: '2' }] }, /unreadable execution tracker/],
    [{ trackers: [Object.assign(new Error('denied'), { status: 403 })] }, /The rollback of BAK0001572 started \(progress 4f1b\w+\); check jsn records get --table sys_rollback_context --sys-id 3323\w+ and do not rerun it\. Reading its outcome failed: denied$/],
    [{ contexts: [contextRow(), Object.assign(new Error('timed out'), { status: 504 })] }, /started \(progress 4f1b\w+\); check .* and do not rerun it\. Reading its outcome failed: timed out$/],
    [{ contexts: [contextRow(), undefined] }, /do not rerun it\. Reading its outcome failed: .*not found/i],
  ];
  for (const [options, message] of cases) {
    const f = fixture(options);
    await assert.rejects(f.run({ yes: true }), error => error.code === 'api_error' && error.hint === `Check jsn records get --table sys_rollback_context --sys-id ${CTX}.` && message.test(error.message));
    assert.equal(f.ok, undefined);
  }
});

test('eval rollback stops waiting at its deadline and says the rollback carries on', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture({ trackers: Array.from({ length: 10 }, () => ({ sys_id: PROGRESS, state: '1' })) });
  await assert.rejects(runRollback(f.sdk, plan, { timeoutMs: 5000, pause: async ms => t.mock.timers.tick(ms) }),
    error => error.code === 'api_error' && /still running after 5s \(progress 4f1b.*\)\. It carries on in the background/.test(error.message));
  assert.equal(f.calls.filter(c => c.kind === 'tracker').length, 4);
});

test('eval rollback is a mutation, so a read-only profile refuses it', () => {
  assert.equal(isMutationCommand({ _: ['eval', 'rollback'] }), true);
});

test('eval reports the execution history id and offers its rollback', async () => {
  const run = async (rollback) => {
    let ok;
    const sdk = { runBackgroundScript: async () => ({ output: 'done', execution_id: EXEC }) };
    const app = { sdk, mutationContext: { scope: 'global', application_id: 'global' }, getEffectiveInstance: () => 'https://dev.example.service-now.com', ok: (data, opts) => { ok = { data, opts }; } };
    await evalCmd(fn => fn).handler({ _: ['eval'], script: 'gs.print(1)', rollback }, app);
    return ok;
  };
  const recorded = await run(true);
  assert.equal(recorded.data.execution, EXEC);
  assert.equal(recorded.opts.breadcrumbs.at(-1).cmd, `jsn eval rollback ${EXEC}`);
  const unrecorded = await run(false);
  assert.equal(unrecorded.data.execution, EXEC);
  assert.equal(unrecorded.opts.breadcrumbs.some(b => b.action === 'rollback'), false);
});

test('background scripts return the execution history id the page links to', async () => {
  const sdk = new SDKClient('https://dev.example.service-now.com', null);
  let html = `[0:00:00.161] <HTML><BODY>Script completed in scope global: script<HR/>Script execution history and recovery <A target='blank' HREF='sys_script_execution_history.do?sys_id=${EXEC}'>available here</A><HR/><PRE>*** Script: hello<BR/></PRE><HR/></BODY></HTML>`;
  sdk._warmSession = async () => '';
  sdk._getScriptsPageCSRF = async () => 'token';
  sdk.rawRequest = async () => html;
  assert.deepEqual(await sdk.runBackgroundScript('gs.print("hello")', ''), { output: '*** Script: hello', execution_id: EXEC });
  assert.equal(await sdk.executeScript('gs.print("hello")', ''), '*** Script: hello');
  html = `<HTML><BODY><PRE>*** Script: incident.do?sys_id=${CTX}<BR/></PRE></BODY></HTML>`;
  assert.deepEqual(await sdk.runBackgroundScript('gs.print("x")', ''), { output: `*** Script: incident.do?sys_id=${CTX}`, execution_id: null });
});

test('eval keeps taking a stray positional to its own handler now that it has a rollback subcommand', async () => {
  const route = async (args) => {
    const seen = [], failures = [];
    await yargs(args).strictCommands().command(evalCmd(_fn => argv => { seen.push(argv); })).fail(message => failures.push(message)).parse();
    return { seen, failures };
  };
  const stray = await route(['eval', 'gs.print(1)']);
  assert.deepEqual(stray.failures, []);
  assert.equal(stray.seen.length, 1);
  assert.equal(stray.seen[0].execution, undefined);
  const rollback = await route(['eval', 'rollback', EXEC, '--yes']);
  assert.deepEqual(rollback.failures, []);
  assert.equal(rollback.seen.length, 1);
  assert.equal(rollback.seen[0].execution, EXEC);
  assert.equal(rollback.seen[0].yes, true);
});

test('eval help says the rollback subcommand is optional', () => {
  let usage;
  const builder = new Proxy({}, { get: (_target, name) => name === 'usage' ? (value) => { usage = value; return builder; } : () => builder });
  evalCmd(fn => fn).builder(builder);
  assert.equal(usage, 'Usage: jsn eval [rollback <execution>] [options]');
});
