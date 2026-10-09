import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionsCmd } from '../src/commands/actions.js';
import { OutputWriter } from '../src/output.js';
import { isMutationCommand } from '../src/mutations.js';
import cliAdapter from '../src/cli-adapter.js';

const ID = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const fixture = { id: ID, scope: SCOPE, inputs: [], outputs: [{ name: 'response' }], steps: [{ cid: 'synthetic', inputs: [{ name: 'script', value: 'outputs.response = "echo";' }] }] };
function commands() {
  const collected = [];
  const y = { command(c) { collected.push(c); return this; } };
  actionsCmd(fn => fn).builder(y);
  return new Map(collected.map(c => [c.command.split(' ')[0], c]));
}
function app() {
  const writes = [];
  const output = new OutputWriter({ format: 'json', writer: { write: text => writes.push(text) } });
  const calls = [];
  return {
    calls, writes, output,
    ok: (data, opts) => output.ok(data, opts), err: e => output.err(e),
    config: { activeProfile: 'test', profiles: { test: { skip_confirmations: false } } },
    getEffectiveInstance: () => 'https://example.invalid',
    sdk: {
      baseURL: 'https://example.invalid',
      request: async (url, opts) => { calls.push(['request', url, opts]); return { result: [] }; },
      list: async (_table, params) => { calls.push(['list', params]); return [{ sys_id: ID, sys_scope: { value: SCOPE }, name: 'Echo' }]; },
      get: async (table, id) => { calls.push(['get', table, id]); return table === 'sys_scope' ? { sys_id: SCOPE } : { sys_id: ID, sys_scope: SCOPE }; },
      getProcessFlowAction: async (...args) => { calls.push(['definition', ...args]); return fixture; },
      createProcessFlowAction: async (...args) => { calls.push(['create', ...args]); return { sys_id: ID, status: 'verified', definition: fixture }; },
      updateProcessFlowAction: async (...args) => { calls.push(['update', ...args]); return { sys_id: ID, status: 'verified', definition: fixture }; },
      testProcessFlowAction: async (...args) => { calls.push(['test', ...args]); return { context: 'c'.repeat(32), state: 'COMPLETE', status: 'complete', outputs: { response: { value: 'echo', hasValue: true } } }; },
      delete: async (...args) => { calls.push(['delete', ...args]); },
    },
  };
}

test('one actions/action command preserves list/show/delete and exposes only verified requested lifecycle', () => {
  const map = commands();
  assert.deepEqual([...map.keys()], ['list', 'show', 'create', 'definition', 'update', 'test', 'step-types', 'delete']);
  assert.deepEqual(map.get('update').aliases, ['edit']);
  assert.deepEqual(actionsCmd(fn => fn).aliases, ['action']);
  for (const verb of ['create', 'update', 'edit', 'delete', 'test']) assert.equal(isMutationCommand({ _: ['actions', verb] }), true, verb);
  for (const verb of ['list', 'show', 'definition', 'step-types']) assert.equal(isMutationCommand({ _: ['actions', verb] }), false, verb);
});

test('definition --get extracts a directly reusable JSON document with executable script', async () => {
  const a = app(); a.output.setJqFilter('data');
  await commands().get('definition').handler({ identifier: 'Echo' }, a);
  assert.deepEqual(JSON.parse(a.writes.join('')), fixture);
  assert.deepEqual(a.calls.at(-1), ['definition', ID, SCOPE]);
});

test('create and update forward full data-file documents without generic table mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-action-definition-'));
  try {
    const file = path.join(dir, 'definition.json'); fs.writeFileSync(file, JSON.stringify(fixture));
    for (const verb of ['create', 'update']) {
      const a = app();
      await commands().get(verb).handler({ identifier: ID, scope: SCOPE, 'data-file': file }, a);
      const call = a.calls.find(c => c[0] === verb);
      assert.deepEqual(call, verb === 'create' ? ['create', SCOPE, fixture] : ['update', ID, SCOPE, fixture]);
      assert.equal(JSON.parse(a.writes.join('')).data.status, 'verified');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('test command loads saved definition by default and --get returns actual output', async () => {
  const a = app(); a.output.setJqFilter('data.outputs.response.value');
  await commands().get('test').handler({ identifier: ID, force: true, 'output-map': '{"response":"hello"}', wait: true, timeout: 7, 'run-on-thread': true, 'tracing-enabled': false }, a);
  assert.deepEqual(a.calls.at(-1), ['test', ID, undefined, undefined, { response: 'hello' }, { wait: true, timeout: 7, runOnThread: true, tracingEnabled: false }]);
  assert.equal(JSON.parse(a.writes.join('')), 'echo');
});

test('test supplied full JSON and input outputMap are separate documents', async () => {
  const a = app();
  await commands().get('test').handler({ identifier: ID, force: true, scope: SCOPE, data: JSON.stringify(fixture), 'output-map': '{"response":"value"}' }, a);
  assert.deepEqual(a.calls.at(-1).slice(1, 5), [ID, SCOPE, fixture, { response: 'value' }]);
});

test('partial creation/test failures use error envelopes and nonzero exit status', async () => {
  const oldExit = process.exitCode;
  try {
    for (const [verb, code] of [['create', 'action_create_partial'], ['test', 'action_test_timeout']]) {
      const a = app();
      a.sdk[verb === 'create' ? 'createProcessFlowAction' : 'testProcessFlowAction'] = async () => {
        const e = new Error(`unverified action ${ID}`); e.code = code; e.details = { sys_id: ID, status: 'unverified' }; throw e;
      };
      await commands().get(verb).handler({ identifier: ID, force: true, scope: SCOPE, data: JSON.stringify(fixture) }, a);
      const result = JSON.parse(a.writes.join(''));
      assert.equal(result.ok, false); assert.equal(result.code, code);
      assert.equal(JSON.parse(result.hint).sys_id, ID);
      assert.equal(process.exitCode, 1);
    }
  } finally { process.exitCode = oldExit; }
});

test('delete retains confirmation and scope mismatch fails before deletion', async () => {
  const a = app();
  await assert.rejects(commands().get('delete').handler({ identifier: ID }, a), e => e.code === 'confirmation_required');
  await assert.rejects(commands().get('delete').handler({ identifier: ID, scope: 'f'.repeat(32), force: true }, a), /does not match/);
  assert.ok(!a.calls.some(c => c[0] === 'delete'));
});

test('test script dispatch requires confirmation before any execution', async () => {
  const previous = process.env.JSN_NO_PROMPTS; process.env.JSN_NO_PROMPTS = '1';
  try {
    const a = app();
    await assert.rejects(commands().get('test').handler({ identifier: ID }, a), e => e.code === 'confirmation_required');
    assert.ok(!a.calls.some(c => c[0] === 'test'));
    await commands().get('test').handler({ identifier: ID, force: true }, a);
    assert.equal(a.calls.filter(c => c[0] === 'test').length, 1);
  } finally {
    if (previous === undefined) delete process.env.JSN_NO_PROMPTS; else process.env.JSN_NO_PROMPTS = previous;
  }
});

for (const response of [{}, { result: null }, { result: {} }, { error: { message: 'denied' }, result: [] }, { result: [{ sys_id: ID }] }]) {
  test(`delete cannot infer absence from ${JSON.stringify(response)}`, async () => {
    const a = app(); a.sdk.request = async () => response;
    await assert.rejects(commands().get('delete').handler({ identifier: ID, force: true }, a), /unverified/);
    assert.equal(a.writes.length, 0);
  });
}

test('delete confirms exact target absence through an explicit error-free array', async () => {
  const a = app();
  await commands().get('delete').handler({ identifier: ID, force: true }, a);
  const readback = a.calls.at(-1); const url = new URL(readback[1]);
  assert.equal(readback[0], 'request'); assert.equal(readback[2].method, 'GET');
  assert.equal(url.pathname, '/api/now/table/sys_hub_action_type_definition');
  assert.equal(url.searchParams.get('sysparm_query'), `sys_id=${ID}`);
  assert.equal(url.searchParams.get('sysparm_limit'), '1');
  assert.equal(JSON.parse(a.writes.join('')).data.deleted, true);
});

test('actual CLI adapter accepts action edit alias and wait options', async () => {
  const a = app();
  const parse = args => cliAdapter(args).command(actionsCmd(fn => argv => fn(argv, a))).parse();
  await parse(['action', 'edit', ID, '--scope', SCOPE, '--data', JSON.stringify(fixture)]);
  assert.equal(a.calls.at(-1)[0], 'update');
  await parse(['actions', 'test', ID, '--force', '--wait', '--timeout', '12', '--output-map', '{"response":"hello"}']);
  assert.equal(a.calls.at(-1)[5].wait, true);
  assert.equal(a.calls.at(-1)[5].timeout, 12);
});

const binary = path.resolve('bin/jsn.js');
const baseEnv = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', SERVICENOW_INSTANCE_URL: '' };
test('real binary help describes complete JSON and bounded wait without publish/snapshot', () => {
  for (const verb of ['', 'create', 'update', 'definition', 'test', 'step-types']) {
    const args = [binary, 'actions', ...(verb ? [verb] : []), '--help'];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: baseEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /publish|snapshot/);
    if (verb === 'test') assert.match(r.stdout, /--wait[\s\S]*--timeout/);
    if (verb === 'update' || verb === 'create') assert.match(r.stdout, /Full action definition/);
  }
});

test('real binary read-only profiles block every mutation including aliases before authentication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-actions-readonly-'));
  try {
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'test', active_profile: 'test', profiles: { test: { instance_url: 'https://example.invalid', auth_method: 'gck', read_only: true } } }));
    for (const root of ['actions', 'action']) {
      for (const verb of ['create', 'update', 'edit', 'delete', 'test']) {
        const args = [binary, root, verb, ...(verb === 'create' ? [] : [ID]), '--scope', SCOPE, '--json'];
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...baseEnv, XDG_CONFIG_HOME: dir }, timeout: 5000 });
        assert.equal(r.status, 1, `${root} ${verb}: ${r.stdout} ${r.stderr}`);
        const envelope = JSON.parse(r.stdout);
        assert.equal(envelope.ok, false);
        assert.match(envelope.error, /read.only/i);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
