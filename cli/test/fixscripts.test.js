import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMutationCommand } from '../src/mutations.js';
import '../src/command-families.js';

// fixscripts is a record profile over sys_script_fix. These run the real CLI over
// a mocked SDK: the table on the wire, the script read from a file, and the
// capture-context check that runs before the one write.
const root = fileURLToPath(new URL('..', import.meta.url));
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

test('create, update and delete are writes for the read-only profile and the mutation guard; list and show are reads', () => {
  for (const verb of ['create', 'update', 'delete']) assert.equal(isMutationCommand({ _: ['fixscripts', verb] }), true, verb);
  for (const verb of ['list', 'show']) assert.equal(isMutationCommand({ _: ['fixscripts', verb] }), false, verb);
});
