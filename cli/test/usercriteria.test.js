import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMutationCommand } from '../src/mutations.js';
import '../src/command-families.js';

// usercriteria is a record profile over user_criteria. These run the real CLI over
// a mocked SDK: the table on the wire, the catalog items show lists from both link
// tables, and the capture-context check that runs before the one write.
const root = fileURLToPath(new URL('..', import.meta.url));
const criteria = 'c'.repeat(32);
let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jsn-usercriteria-'));
  writeFileSync(path.join(dir, 'fixture.mjs'), `
import { mock } from 'node:test';
import { appendFileSync } from 'node:fs';
import * as config from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import * as sdk from ${JSON.stringify(new URL('../src/sdk.js', import.meta.url).href)};
globalThis.fetch = () => { throw new Error('No network permitted'); };
const scope = 'a'.repeat(32), set = 'b'.repeat(32), elsewhere = 'e'.repeat(32), criteria = ${JSON.stringify(criteria)};
const appScope = process.env.FIXTURE_APP_SCOPE || 'global';
const log = (method, ...args) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([method, ...args]) + '\\n');
mock.module(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}, { namedExports: { ...config, loadConfig: () => ({ profiles: { fixture: { instance_url: 'https://fixture.invalid', username: 'fixture', auth_method: 'basic', read_only: process.env.FIXTURE_READONLY === '1' } }, activeProfile: 'fixture', defaultProfile: 'fixture' }) } });
const item = (id, label) => ({ sys_id: id.repeat(32), sc_cat_item: { value: id.repeat(32).replace(/^./, 'f'), display_value: label } });
class SDKClient {
  constructor() { this.baseURL = 'https://fixture.invalid'; }
  async list(table, params) {
    log('list', table, params.toString());
    if (table === 'sys_db_object') return [{ sys_id: 'uc-table', name: 'user_criteria', super_class: 'metadata' }];
    if (table === 'user_criteria') return [{ sys_id: { value: criteria, display_value: criteria }, name: 'Service desk only', active: 'true', match_all: 'false', sys_scope: { value: process.env.FIXTURE_RECORD_ELSEWHERE ? elsewhere : scope, display_value: 'Global' } }];
    if (table === 'sc_cat_item_user_criteria_mtom') return [item('1', 'Request a laptop'), item('2', 'Reset a password')];
    if (table === 'sc_cat_item_user_criteria_no_mtom') return process.env.FIXTURE_DENY_NO ? Promise.reject(Object.assign(new Error('denied'), { status: 403 })) : [item('3', 'Order a server')];
    if (table === 'sys_user') return [{ sys_id: 'user', user_name: 'fixture' }];
    if (table === 'sys_user_preference') return [{ value: params.get('sysparm_query').includes('apps.current_app') ? scope : set }];
    if (table === 'sys_scope') return [{ sys_id: process.env.FIXTURE_MISMATCH ? 'd'.repeat(32) : scope, scope: appScope }];
    if (table === 'sys_update_set') return [{ sys_id: set, name: 'Catalog access' }];
    throw new Error('Unexpected list: ' + table);
  }
  async get(table, id) {
    log('get', table);
    if (table === 'sys_db_object') return { name: 'sys_metadata' };
    if (table === 'sys_scope') return { scope: id === elsewhere ? 'global' : appScope };
    if (table === 'sys_update_set') return { sys_id: set, name: 'Catalog access', application: scope, state: 'in progress' };
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
  async update(table, id, data) {
    log('update', table, id, data);
    return { sys_id: id, ...data };
  }
  async delete(table, id) {
    log('delete', table, id);
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
const intent = ['--expect-scope', 'global', '--expect-update-set', 'Catalog access'];

for (const alias of ['usercriteria', 'uc']) {
  test(`${alias} list reads user_criteria with the criteria columns`, () => {
    const result = run([alias, 'list', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.data.table, 'user_criteria');
    assert.deepEqual(output.data.columns, ['name', 'active', 'match_all', 'sys_scope']);
    assert.equal(output.data.records[0].name, 'Service desk only');
    const reads = result.calls.filter(call => call[0] === 'list' && call[1] === 'user_criteria');
    assert.equal(reads.length, 1);
    assert.equal(new URLSearchParams(reads[0][2]).get('sysparm_fields'), 'sys_id,name,active,match_all,sys_scope');
  });
}

test('show lists the catalog items whose Available for and Not available for lists hold the criteria, joined on its raw sys_id', () => {
  const result = run(['usercriteria', 'show', 'Service desk only', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const essential = JSON.parse(result.stdout).data._essential;
  assert.deepEqual(essential.available_for.records.map(row => row.sc_cat_item.display_value), ['Request a laptop', 'Reset a password']);
  assert.deepEqual(essential.not_available_for.records.map(row => row.sc_cat_item.display_value), ['Order a server']);
  for (const table of ['sc_cat_item_user_criteria_mtom', 'sc_cat_item_user_criteria_no_mtom']) {
    const reads = result.calls.filter(call => call[0] === 'list' && call[1] === table);
    assert.equal(reads.length, 1, table);
    const params = new URLSearchParams(reads[0][2]);
    assert.equal(params.get('sysparm_query'), `user_criteria=${criteria}^ORDERBYsc_cat_item`);
    assert.equal(params.get('sysparm_fields'), 'sys_id,sc_cat_item');
    assert.equal(params.get('sysparm_limit'), '101');
  }
});

test('show prints both lists for people, and a denied list as unavailable rather than empty', () => {
  const human = run(['usercriteria', 'show', 'Service desk only', '--styled']);
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Essential: available_for \(2 loaded\)[\s\S]*sc_cat_item: Request a laptop/);
  assert.match(human.stdout, /Essential: not_available_for \(1 loaded\)[\s\S]*sc_cat_item: Order a server/);
  const denied = JSON.parse(run(['usercriteria', 'show', 'Service desk only', '--json'], { FIXTURE_DENY_NO: '1' }).stdout).data._essential.not_available_for;
  assert.equal(denied.status, 'unavailable');
  assert.equal(denied.error.code, 'forbidden');
  assert.deepEqual(denied.records, []);
});

test('show --no-essential reads neither link table', () => {
  const result = run(['usercriteria', 'show', 'Service desk only', '--no-essential', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.calls.some(call => call[0] === 'list' && call[1].startsWith('sc_cat_item_user_criteria')));
});

test('create checks the intended scope and update set, then writes one criteria record', () => {
  const result = run(['usercriteria', 'create', '-f', 'name=Service desk only', '-f', 'match_all=false', ...intent, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.filter(call => call[0] === 'create'), [['create', 'user_criteria', { name: 'Service desk only', match_all: 'false' }]]);
  const first = result.calls.findIndex(call => call[0] === 'create');
  assert.ok(result.calls.slice(0, first).some(call => call[0] === 'list' && call[1] === 'sys_user_preference' && call[2].includes('sys_update_set')), 'the update set preference is read before the write');
  assert.equal(JSON.parse(result.stdout).data.sys_id, 'created');
});

test('create writes each kind of criteria as given: a script with = and a newline, and match all over every condition field', () => {
  const script = "var u = new GlideRecord('sys_user');\nanswer = u.get(user_id) && u.getValue('title') == 'Contractor';";
  const conditions = Object.fromEntries(['user', 'group', 'role', 'department', 'company', 'location'].map((field, n) => [field, String(n + 1).repeat(32)]));
  for (const fields of [{ name: 'Contractors', advanced: 'true', script }, { name: 'Field leads', match_all: 'true', ...conditions }, { name: 'Field any', match_all: 'false', ...conditions }]) {
    const result = run(['usercriteria', 'create', ...Object.entries(fields).flatMap(([field, value]) => ['-f', `${field}=${value}`]), ...intent, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls.filter(call => call[0] === 'create'), [['create', 'user_criteria', fields]]);
  }
});

for (const [label, family, args, env, code] of [
  ['read-only', 'usercriteria', intent, { FIXTURE_READONLY: '1' }, 'read_only'],
  ['read-only, through the alias', 'uc', intent, { FIXTURE_READONLY: '1' }, 'read_only'],
  ['missing intent', 'usercriteria', [], {}, 'usage_error'],
  ['scope mismatch', 'usercriteria', intent, { FIXTURE_MISMATCH: '1' }, 'usage_error'],
]) {
  test(`create refused by ${label} writes nothing`, () => {
    const result = run([family, 'create', '-f', 'name=Service desk only', ...args, '--json'], env);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, code);
    assert.ok(!result.calls.some(call => call[0] === 'create' || (call[0] === 'request' && call[2].method !== 'GET')));
  });
}

for (const [verb, args] of [['update', ['Service desk only', '-f', 'active=false']], ['delete', ['Service desk only', '--force']]]) {
  test(`${verb} refused by a read-only profile writes nothing`, () => {
    const result = run(['usercriteria', verb, ...args, ...intent, '--json'], { FIXTURE_READONLY: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).code, 'read_only');
    assert.ok(!result.calls.some(call => !['list', 'get'].includes(call[0]) && !(call[0] === 'request' && call[2].method === 'GET')));
  });
}

test('update in the current application scope writes the one record it read', () => {
  const result = run(['usercriteria', 'update', 'Service desk only', '-f', 'active=false', '--expect-scope', 'x_demo', '--expect-update-set', 'Catalog access', '--json'], { FIXTURE_APP_SCOPE: 'x_demo' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.filter(call => call[0] === 'update'), [['update', 'user_criteria', criteria, { active: 'false' }]]);
});

for (const [verb, args] of [['update', ['-f', 'active=false']], ['delete', ['--force']]]) {
  test(`${verb} of a criteria record in another scope than the current application is refused and writes nothing`, () => {
    const result = run(['usercriteria', verb, 'Service desk only', ...args, '--expect-scope', 'x_demo', '--expect-update-set', 'Catalog access', '--json'], { FIXTURE_APP_SCOPE: 'x_demo', FIXTURE_RECORD_ELSEWHERE: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /record is in scope 'global', but your current scope is 'x_demo'/);
    assert.ok(!result.calls.some(call => ['update', 'delete'].includes(call[0])));
  });
}

test('create, update and delete are writes for the read-only profile and the mutation guard; list and show are reads', () => {
  for (const verb of ['create', 'update', 'delete']) assert.equal(isMutationCommand({ _: ['usercriteria', verb] }), true, verb);
  for (const verb of ['list', 'show']) assert.equal(isMutationCommand({ _: ['usercriteria', verb] }), false, verb);
});
