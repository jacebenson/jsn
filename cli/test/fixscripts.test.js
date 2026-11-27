import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMutationCommand } from '../src/mutations.js';
import { fixscriptsCmd } from '../src/commands/_simple.js';
import '../src/command-families.js';

// fixscripts is a record profile over sys_script_fix. These run the real CLI over
// a mocked SDK: the table on the wire, the script read from a file, and the
// capture-context check that runs before the one write.
const root = fileURLToPath(new URL('..', import.meta.url));
const scope = 'a'.repeat(32), execution = 'e'.repeat(32);
const stored = 'var gr = new GlideRecord("incident");\ngr.addQuery("impact", 1);\ngs.info("lowered " + gr.getRowCount());';
let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jsn-fixscripts-'));
  writeFileSync(path.join(dir, 'fix.js'), 'var gr = new GlideRecord("incident");\ngr.addQuery("impact", 1);\n');
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import { appendFileSync } from 'node:fs';
import * as config from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import * as sdk from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
globalThis.fetch = () => { throw new Error('No network permitted'); };
const scope = 'a'.repeat(32), set = 'b'.repeat(32);
const log = (method, ...args) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([method, ...args]) + '\\n');
mock.module(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}, { namedExports: { ...config, loadConfig: () => ({ profiles: { fixture: { instance_url: 'https://fixture.invalid', username: 'fixture', auth_method: 'basic', read_only: process.env.FIXTURE_READONLY === '1' } }, activeProfile: 'fixture', defaultProfile: 'fixture' }) } });
class SDKClient {
  constructor() { this.baseURL = 'https://fixture.invalid'; }
  async list(table, params) {
    log('list', table, params.toString());
    if (table === 'sys_db_object') return [{ sys_id: 'fix-table', name: 'sys_script_fix', super_class: 'metadata' }];
    if (table === 'sys_script_fix' && params.get('sysparm_display_value') === 'false') return [{ sys_id: 'c'.repeat(32), name: 'Lower impact', script: process.env.FIXTURE_EMPTY ? ' ' : ${JSON.stringify(stored)}, record_for_rollback: process.env.FIXTURE_NO_ROLLBACK ? 'false' : 'true', unloadable: 'false', sys_scope: process.env.FIXTURE_RECORD_SCOPE || scope }];
    if (table === 'sys_script_fix') return [{ sys_id: 'c'.repeat(32), name: 'Lower impact', record_for_rollback: 'true', unloadable: 'false', sys_scope: { value: scope, display_value: 'Global' } }];
    if (table === 'sys_user') return [{ sys_id: 'user', user_name: 'fixture' }];
    if (table === 'sys_user_preference') return [{ value: params.get('sysparm_query').includes('apps.current_app') ? scope : set }];
    if (table === 'sys_scope') return [{ sys_id: process.env.FIXTURE_MISMATCH ? 'd'.repeat(32) : scope, scope: 'global' }];
    if (table === 'sys_update_set') return [{ sys_id: set, name: 'Data fixes' }];
    throw new Error('Unexpected list: ' + table);
  }
  async get(table) {
    log('get', table);
    if (table === 'sys_db_object') return { name: 'sys_metadata' };
    if (table === 'sys_scope') return { scope: 'global' };
    if (table === 'sys_update_set') return { sys_id: set, name: 'Data fixes', application: scope, state: 'in progress' };
    throw new Error('Unexpected get: ' + table);
  }
  async request(endpoint, options) {
    log('request', endpoint, options);
    if (options.method !== 'GET') throw new Error('Unexpected mutation');
    return { result: { current: endpoint.endsWith('/application') ? scope : { sysId: set } } };
  }
  async create(table, data) {
    log('create', table, data);
    return { sys_id: 'created', ...data };
  }
  async runBackgroundScript(script, scopeId, opts) {
    log('runBackgroundScript', script, scopeId, { ...opts, signal: opts.signal instanceof AbortSignal });
    return { output: 'lowered 3', execution_id: ${JSON.stringify(execution)} };
  }
}
mock.module(${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)}, { namedExports: { ...sdk, SDKClient } });
`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(args, env = {}) {
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', pathToFileURL(path.join(dir, 'fixture.mjs')).href, path.join(root, 'bin/jsn.js'), ...args], {
    cwd: dir, timeout: 10000, encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', FIXTURE_LOG: log, ...env },
  });
  assert.ifError(result.error);
  return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const intent = ['--expect-scope', 'global', '--expect-update-set', 'Data fixes'];

for (const alias of ['fixscripts', 'fixscript']) {
  test(`${alias} list reads sys_script_fix with the fix script columns`, () => {
    const result = run([alias, 'list', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.data.table, 'sys_script_fix');
    assert.deepEqual(output.data.columns, ['name', 'record_for_rollback', 'unloadable', 'sys_scope']);
    assert.equal(output.data.records[0].name, 'Lower impact');
    const reads = result.calls.filter(call => call[0] === 'list' && call[1] === 'sys_script_fix');
    assert.equal(reads.length, 1);
    assert.equal(new URLSearchParams(reads[0][2]).get('sysparm_fields'), 'sys_id,name,record_for_rollback,unloadable,sys_scope');
  });
}

test('create checks the intended scope and update set, then writes one fix script with the script file as given', () => {
  const result = run(['fixscripts', 'create', '-f', 'name=Lower impact', '-f', `script=@${path.join(dir, 'fix.js')}`, ...intent, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const script = readFileSync(path.join(dir, 'fix.js'), 'utf8');
  assert.deepEqual(result.calls.filter(call => call[0] === 'create'), [['create', 'sys_script_fix', { name: 'Lower impact', script }]]);
  const first = result.calls.findIndex(call => call[0] === 'create');
  assert.ok(result.calls.slice(0, first).some(call => call[0] === 'list' && call[1] === 'sys_user_preference' && call[2].includes('sys_update_set')), 'the update set preference is read before the write');
  assert.equal(JSON.parse(result.stdout).data.sys_id, 'created');
});

for (const [label, family, args, env, code] of [
  ['read-only', 'fixscripts', intent, { FIXTURE_READONLY: '1' }, 'read_only'],
  ['read-only, through the alias', 'fixscript', intent, { FIXTURE_READONLY: '1' }, 'read_only'],
  ['missing intent', 'fixscripts', [], {}, 'usage_error'],
  ['scope mismatch', 'fixscripts', intent, { FIXTURE_MISMATCH: '1' }, 'usage_error'],
]) {
  test(`create refused by ${label} writes nothing`, () => {
    const result = run([family, 'create', '-f', 'name=Lower impact', ...args, '--json'], env);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, code);
    assert.ok(!result.calls.some(call => call[0] === 'create' || (call[0] === 'request' && call[2].method !== 'GET')));
  });
}

for (const [verb, args] of [['update', ['Lower impact', '-f', 'script=x']], ['delete', ['Lower impact', '--force']]]) {
  test(`${verb} refused by a read-only profile writes nothing`, () => {
    const result = run(['fixscripts', verb, ...args, ...intent, '--json'], { FIXTURE_READONLY: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, 'read_only');
    assert.ok(!result.calls.some(call => !['list', 'get'].includes(call[0]) && !(call[0] === 'request' && call[2].method === 'GET')));
  });
}

test('run without --yes previews the stored script and runs nothing', () => {
  const result = run(['fixscripts', 'run', 'Lower impact', ...intent, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { data } = JSON.parse(result.stdout);
  assert.equal(data.dry_run, true);
  assert.equal(data.sys_id, 'c'.repeat(32));
  assert.equal(data.script, stored);
  assert.equal(data.record_for_rollback, true);
  assert.equal(data.unloadable, false);
  assert.ok(!result.calls.some(call => call[0] === 'runBackgroundScript'));
});

test('the terminal view shows the script on a preview and what it printed on a run', () => {
  const preview = run(['fixscripts', 'run', 'Lower impact', ...intent, '--format', 'styled']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Dry run: would run fix script Lower impact/);
  assert.ok(preview.stdout.includes(stored));
  const ran = run(['fixscripts', 'run', 'Lower impact', ...intent, '--yes', '--format', 'styled']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /Ran fix script Lower impact\n\nlowered 3/);
});

test('run --yes runs the stored script unchanged, once, in the fix script\'s scope with its rollback setting and a cancel signal', () => {
  const result = run(['fixscripts', 'run', 'Lower impact', ...intent, '--yes', '--json', '--verbose']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.filter(call => call[0] === 'runBackgroundScript'),
    [['runBackgroundScript', stored, scope, { rollback: true, quotaManagedTransaction: true, sandbox: false, scriptlet: false, timeout: 30000, signal: true }]]);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.output, 'lowered 3');
  assert.equal(output.data.execution, execution);
  assert.ok(output.breadcrumbs.some(item => item.cmd === `jsn eval rollback ${execution}`));
});

test('a fix script without Record for rollback runs without a rollback context; --timeout reaches the instance call', () => {
  const result = run(['fixscripts', 'run', 'Lower impact', ...intent, '--timeout', '600', '--yes', '--json', '--verbose'], { FIXTURE_NO_ROLLBACK: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [call] = result.calls.filter(item => item[0] === 'runBackgroundScript');
  assert.equal(call[3].rollback, false);
  assert.equal(call[3].timeout, 600000);
  assert.ok(!JSON.parse(result.stdout).breadcrumbs.some(item => item.cmd.includes('eval rollback')));
});

for (const [label, args, env, code, message, readsNothing] of [
  ['read-only', intent, { FIXTURE_READONLY: '1' }, 'read_only', /read-only/i, true],
  ['missing intent', [], {}, 'usage_error', /require intended scope and update set/],
  ['session scope mismatch', intent, { FIXTURE_MISMATCH: '1' }, 'usage_error', /Intended scope does not match/],
  ['a fix script in another scope', intent, { FIXTURE_RECORD_SCOPE: 'd'.repeat(32) }, 'usage_error', /Fix script scope is unknown or differs/],
  ['an empty script', intent, { FIXTURE_EMPTY: '1' }, 'usage_error', /has no script/],
  ['--timeout 0', [...intent, '--timeout', '0'], {}, 'usage_error', /--timeout must be a whole number of seconds from 1 to 86400/, true],
]) {
  test(`run refused by ${label} runs nothing`, () => {
    const result = run(['fixscripts', 'run', 'Lower impact', ...args, '--yes', '--json'], env);
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.code, code, result.stdout);
    assert.match(output.error, message);
    assert.ok(!result.calls.some(call => call[0] === 'runBackgroundScript' || call[0] === 'create'));
    if (readsNothing) assert.deepEqual(result.calls, []);
  });
}

test('a Global fix script (empty sys_scope) runs in the verified global scope', async () => {
  // Global records store an empty sys_scope; comparing '' to 'global' refused every one.
  let handler;
  fixscriptsCmd(fn => fn).builder({ command(definition) { if (definition.command?.startsWith('run ')) handler = definition.handler; return this; } });
  const seen = [];
  const app = { requireInstance() {}, mutationContext: { verified: true, application_id: 'global' }, config: {}, session: {},
    ok(data) { seen.push(data); },
    sdk: { list: async () => [{ sys_id: 'c'.repeat(32), name: 'Lower impact', script: stored, record_for_rollback: 'false', sys_scope: '' }],
      runBackgroundScript: async (script, scope, options) => { seen.push({ scope, options }); return { output: 'done', execution_id: 'e'.repeat(32) }; } } };
  await handler({ identifier: 'Lower impact', yes: true, timeout: 30 }, app);
  assert.equal(seen[0].scope, 'global');
  assert.equal(seen.at(-1).name, 'Lower impact');
});

test('Ctrl-C while a fix script runs aborts the signal given to the instance call, and the handler is removed after', async () => {
  let handler;
  fixscriptsCmd(fn => fn).builder({ command(definition) { if (definition.command?.startsWith('run ')) handler = definition.handler; return this; } });
  assert.equal(typeof handler, 'function');
  const before = process.listenerCount('SIGINT');
  const write = process.stderr.write;
  const writes = [];
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  const app = { requireInstance() {}, mutationContext: { verified: true, application_id: scope }, ok() { throw new Error('no success output after a cancel'); },
    sdk: { list: async () => [{ sys_id: 'c'.repeat(32), name: 'Lower impact', script: stored, record_for_rollback: 'true', sys_scope: scope }],
      runBackgroundScript: async (_script, _scope, opts) => { process.emit('SIGINT'); assert.equal(opts.signal.aborted, true); throw new Error('stopped'); } } };
  try { await assert.rejects(handler({ identifier: 'Lower impact', yes: true, timeout: 30 }, app), /stopped/); }
  finally { process.stderr.write = write; }
  assert.match(writes.join(''), /Cancelling the fix script on the instance/);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('create, update, delete and run are writes for the read-only profile and the mutation guard; list and show are reads', () => {
  for (const verb of ['create', 'update', 'delete', 'run']) assert.equal(isMutationCommand({ _: ['fixscripts', verb] }), true, verb);
  for (const verb of ['list', 'show']) assert.equal(isMutationCommand({ _: ['fixscripts', verb] }), false, verb);
});
