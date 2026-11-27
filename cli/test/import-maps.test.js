import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCmd } from '../src/commands/import.js';
import { isMutationCommand } from '../src/mutations.js';
import { readImportMaps, formatImportMaps } from '../src/import-sets.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const MAP = 'c'.repeat(32);
const OLD = 'd'.repeat(32);
const ref = (value, display) => ({ value, display_value: display ?? value });
const id = n => String(n).padStart(32, '0');
const map = (sys_id = MAP, extra = {}) => ({ sys_id: ref(sys_id), name: ref(sys_id === MAP ? 'Staged users' : 'Old users'), source_table: ref('u_staging'),
  target_table: ref('sys_user'), active: ref(sys_id === MAP ? 'true' : 'false'), order: ref(sys_id === MAP ? '100' : '200'), run_business_rules: ref('true'),
  enforce_mandatory_fields: ref('Only Mapped Fields'), copy_empty_fields: ref('false'), create_new_record_on_empty_coalesce_fields: ref('false'),
  run_script: ref(sys_id === MAP ? 'true' : 'false'), script: ref('target.active = true;'), ...extra });
const entry = (n, target_field, extra = {}) => ({ sys_id: ref(id(n)), map: ref(MAP, 'Staged users'), source_field: ref(`u_${target_field}`), target_field: ref(target_field),
  coalesce: ref('false'), coalesce_empty_fields: ref('false'), use_source_script: ref('false'), choice_action: ref('create'), date_format: ref(''), source_script: ref(''), ...extra });
const script = (n, when, order, extra = {}) => ({ sys_id: ref(id(100 + n)), map: ref(MAP, 'Staged users'), when: ref(when), order: ref(String(order)),
  active: ref('true'), script: ref(`// ${when} ${order}`), ...extra });
const ENTRIES = [entry(1, 'department', { choice_action: ref('reject') }), entry(2, 'email', { coalesce: ref('true') }),
  entry(3, 'name', { use_source_script: ref('true'), source_script: ref('answer = source.u_first + " " + source.u_last;') }),
  entry(4, 'start_date', { date_format: ref('yyyy-MM-dd') }), entry(5, 'user_name', { map: ref(OLD, 'Old users') })];
const SCRIPTS = [script(1, 'onComplete', 100), script(2, 'onBefore', 100, { active: ref('false') }), script(3, 'onStart', 100),
  script(4, 'onBefore', 200), script(5, 'onMystery', 50)];

function fakeSdk(tables) {
  const calls = [];
  return {
    calls,
    listStrict: async (table, params) => {
      calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit'), display: params.get('sysparm_display_value') });
      const answer = tables[table];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params.get('sysparm_query')) : (answer ?? []);
    },
  };
}
const staged = (extra = {}) => ({ sys_transform_map: q => q.startsWith('source_table=u_staging') ? [map(), map(OLD)] : [],
  sys_transform_entry: ENTRIES, sys_transform_script: SCRIPTS, ...extra });

test('import maps is a read, so read-only profiles allow it', () => {
  importCmd(fn => fn);
  assert.equal(isMutationCommand({ _: ['import', 'maps', 'u_staging'] }), false);
});

test('import maps refuses bad input before any request', async () => {
  for (const [target, message] of [['', /staging table, a transform map name/], ['  ', /staging table/], [undefined, /staging table/],
    ['u_staging^ORactive=true', /\^/], ['u_staging\nx', /control/]]) {
    const sdk = fakeSdk({});
    await assert.rejects(readImportMaps(sdk, target), message);
    assert.equal(sdk.calls.length, 0, `no request for ${JSON.stringify(target)}`);
  }
});

test('import maps on a staging table reads its maps, then their field maps and scripts by raw sys_id, without script bodies', async () => {
  const sdk = fakeSdk(staged());
  const data = await readImportMaps(sdk, 'u_staging');
  assert.deepEqual(sdk.calls.map(c => [c.table, c.query, c.limit, c.display]), [
    ['sys_transform_map', 'source_table=u_staging^ORDERBYorder^ORDERBYname', '51', 'all'],
    ['sys_transform_entry', `mapIN${MAP},${OLD}^ORDERBYDESCcoalesce^ORDERBYtarget_field`, '1001', 'all'],
    ['sys_transform_script', `mapIN${MAP},${OLD}^ORDERBYorder`, '201', 'all'],
  ]);
  assert.deepEqual(sdk.calls.map(c => c.fields.split(',')), [
    ['sys_id', 'name', 'source_table', 'target_table', 'active', 'order', 'run_business_rules', 'enforce_mandatory_fields', 'copy_empty_fields', 'create_new_record_on_empty_coalesce_fields', 'run_script'],
    ['sys_id', 'map', 'source_field', 'target_field', 'coalesce', 'coalesce_empty_fields', 'use_source_script', 'choice_action', 'date_format'],
    ['sys_id', 'map', 'when', 'order', 'active'],
  ]);
  assert.equal(data.matched_by, 'source_table');
  assert.equal(data.maps.length, 2);
  const [staging, old] = data.maps;
  assert.deepEqual({ ...staging, field_maps: undefined, transform_scripts: undefined }, { sys_id: MAP, name: 'Staged users', source_table: 'u_staging', target_table: 'sys_user',
    active: true, order: 100, run_business_rules: true, enforce_mandatory_fields: 'Only Mapped Fields', copy_empty_fields: false,
    create_new_record_on_empty_coalesce_fields: false, run_script: true, coalesce: ['email'], field_maps: undefined, transform_scripts: undefined });
  assert.equal(old.active, false);
  assert.deepEqual(staging.field_maps.map(f => f.target_field), ['department', 'email', 'name', 'start_date']);
  assert.deepEqual(staging.field_maps[2], { sys_id: id(3), source_field: 'u_name', target_field: 'name', coalesce: false, coalesce_empty_fields: false, use_source_script: true, choice_action: 'create', date_format: '' });
  assert.deepEqual(old.field_maps.map(f => f.target_field), ['user_name']);
  assert.deepEqual(old.coalesce, []);
  assert.deepEqual(staging.transform_scripts.map(s => [s.when, s.order, s.active]),
    [['onStart', 100, true], ['onBefore', 100, false], ['onBefore', 200, true], ['onComplete', 100, true], ['onMystery', 50, true]], 'firing order, then order; unknown when last');
  assert.ok(!('script' in staging) && !('script' in staging.transform_scripts[0]) && !('source_script' in staging.field_maps[2]), 'no body without --scripts');
  assert.deepEqual([data.has_more, data.field_maps_has_more, data.scripts_has_more, data.notes], [false, false, false, []]);
  const text = formatImportMaps(data);
  assert.match(text, /^Transform maps reading u_staging \(2\)/);
  assert.match(text, /Staged users \[c{32}\] u_staging -> sys_user, order 100\n/);
  assert.match(text, /Old users \[d{32}\] u_staging -> sys_user, order 200 \(inactive\)/);
  assert.match(text, /Coalesce on email: a row whose email matches an existing sys_user record updates it; any other row inserts a new one\./);
  assert.match(text, /No coalesce field: every row inserts a new record\./);
  assert.match(text, /u_email +email +yes +no +create/);
  assert.match(text, /u_name +name +no +yes/);
  assert.match(text, /u_start_date +start_date +no +no +create +yyyy-MM-dd/);
  assert.match(text, /onStart +100\n {4}onBefore +100 +inactive\n {4}onBefore +200\n {4}onComplete +100\n {4}onMystery +50/);
  assert.match(text, /Map script: runs/);
  assert.doesNotMatch(text, /target\.active = true|answer = source/);
});

test('import maps --scripts reads and prints the map script, field map source scripts and transform script bodies', async () => {
  const sdk = fakeSdk(staged());
  const data = await readImportMaps(sdk, 'u_staging', { scripts: true });
  assert.deepEqual(sdk.calls.map(c => c.fields.split(',').at(-1)), ['script', 'source_script', 'script']);
  const [staging] = data.maps;
  assert.equal(staging.script, 'target.active = true;');
  assert.equal(staging.field_maps[2].source_script, 'answer = source.u_first + " " + source.u_last;');
  assert.equal(staging.transform_scripts[0].script, '// onStart 100');
  const text = formatImportMaps(data);
  assert.match(text, /Map script: runs\n {6}target\.active = true;/);
  assert.match(text, /name source script:\n {6}answer = source\.u_first/);
  assert.match(text, /onStart +100\n {6}\/\/ onStart 100/);
  assert.match(text, /Map script: off \(Run script is not set\)\n {6}target\.active = true;/, 'a stored body that does not run says so');
});

test('import maps says how empty coalesce values behave, field-level Coalesce empty fields first', async () => {
  const onEmpty = { create_new_record_on_empty_coalesce_fields: ref('true') };
  const sdk = fakeSdk(staged({ sys_transform_map: () => [map(MAP, onEmpty), map(OLD, onEmpty)],
    sys_transform_entry: [entry(2, 'email', { coalesce: ref('true'), coalesce_empty_fields: ref('true') }), entry(5, 'user_name', { map: ref(OLD), coalesce: ref('true') })] }));
  const data = await readImportMaps(sdk, 'u_staging');
  assert.equal(data.maps[0].field_maps[0].coalesce_empty_fields, true);
  const [staging, old] = formatImportMaps(data).split('\n\n').slice(1);
  assert.match(staging, /Coalesce empty fields on email: an empty value matches an existing record where that field is empty\./);
  assert.doesNotMatch(staging, /all empty inserts/, 'Coalesce empty fields overrides the map setting');
  assert.match(old, /A row whose coalesce fields are all empty inserts a new record\./);
});

test('import maps falls back to a map name, and a sys_id reads that map alone', async () => {
  const byName = fakeSdk({ sys_transform_map: q => q.startsWith('name=Staged users') ? [map()] : [] });
  const named = await readImportMaps(byName, 'Staged users');
  assert.deepEqual(byName.calls.map(c => [c.table, c.query]).slice(0, 2), [
    ['sys_transform_map', 'source_table=Staged users^ORDERBYorder^ORDERBYname'],
    ['sys_transform_map', 'name=Staged users^ORDERBYorder^ORDERBYname'],
  ]);
  assert.equal(named.matched_by, 'name');
  assert.match(formatImportMaps(named), /^Transform maps named Staged users \(1\)/);
  const bySysId = fakeSdk({ sys_transform_map: [map()] });
  const one = await readImportMaps(bySysId, MAP.toUpperCase());
  assert.deepEqual(bySysId.calls.map(c => [c.table, c.query]), [
    ['sys_transform_map', `sys_id=${MAP.toUpperCase()}^ORDERBYorder^ORDERBYname`],
    ['sys_transform_entry', `mapIN${MAP}^ORDERBYDESCcoalesce^ORDERBYtarget_field`],
    ['sys_transform_script', `mapIN${MAP}^ORDERBYorder`],
  ]);
  assert.equal(one.matched_by, 'sys_id');
});

test('import maps says not found rather than reporting an empty table', async () => {
  const sdk = fakeSdk({});
  await assert.rejects(readImportMaps(sdk, 'u_nothing'), { code: 'not_found', message: /Transform map not found: u_nothing/ });
  assert.deepEqual(sdk.calls.map(c => c.query), ['source_table=u_nothing^ORDERBYorder^ORDERBYname', 'name=u_nothing^ORDERBYorder^ORDERBYname']);
  const bySysId = fakeSdk({});
  await assert.rejects(readImportMaps(bySysId, MAP), { code: 'not_found' });
  assert.equal(bySysId.calls.length, 1, 'a sys_id is not retried as a name');
});

test('import maps refuses rows that point somewhere else', async () => {
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_map: [map(MAP, { source_table: ref('u_other') })] })), 'u_staging'), /different record/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_map: [map(MAP, { sys_id: ref(OLD) })] })), MAP), /different record/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_map: [map(MAP, { sys_id: ref('x,y') })] })), 'u_staging'), /unexpected sys_id/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_entry: [entry(1, 'email', { map: ref('b'.repeat(32)) })] })), 'u_staging'), /field map of another transform map/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_script: [script(1, 'onStart', 100, { map: ref('b'.repeat(32)) })] })), 'u_staging'), /script of another transform map/);
});

test('import maps stops at 50 maps, 1000 field maps and 200 scripts with one row of lookahead, and says so', async () => {
  const many = Array.from({ length: 51 }, (_, i) => map(id(i + 1), { name: ref(`Map ${i}`) }));
  const sdk = fakeSdk({ sys_transform_map: many,
    sys_transform_entry: Array.from({ length: 1001 }, (_, i) => entry(i, `f${i}`, { map: ref(id(1)) })),
    sys_transform_script: Array.from({ length: 201 }, (_, i) => script(i, 'onBefore', i, { map: ref(id(1)) })) });
  const data = await readImportMaps(sdk, 'u_staging');
  assert.equal(data.maps.length, 50);
  assert.equal(sdk.calls[1].query, `mapIN${many.slice(0, 50).map(m => m.sys_id.value).join(',')}^ORDERBYDESCcoalesce^ORDERBYtarget_field`);
  assert.equal(data.maps[0].field_maps.length, 1000);
  assert.equal(data.maps[0].transform_scripts.length, 200);
  assert.deepEqual([data.has_more, data.field_maps_has_more, data.scripts_has_more], [true, true, true]);
  assert.equal(data.notes.length, 3);
  assert.match(formatImportMaps(data), /More than 50 transform maps match[\s\S]*More than 1000 field maps[\s\S]*More than 200 transform scripts/);
});

test('import maps never reports a denied or malformed response as success', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readImportMaps(fakeSdk({ sys_transform_map: denied }), 'u_staging'), /Forbidden/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_entry: denied })), 'u_staging'), /Forbidden/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_script: denied })), 'u_staging'), /Forbidden/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_map: ['junk'] })), 'u_staging'), /Malformed/);
  await assert.rejects(readImportMaps(fakeSdk(staged({ sys_transform_entry: [null] })), 'u_staging'), /Malformed/);
});

test('import maps command summarises the maps and offers the script bodies', async () => {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; }, epilogue() { return this; } };
  importCmd(fn => fn).builder(builder);
  const { handler } = commands.find(c => c.command.startsWith('maps '));
  let data;
  let options;
  const app = { requireInstance() {}, sdk: fakeSdk(staged()), ok(value, opts) { data = value; options = opts; } };
  await handler({ target: 'u_staging', scripts: false }, app);
  assert.equal(options.summary, 'Transform maps reading u_staging: 2 map(s), 1 inactive; coalesce on email (Staged users)');
  assert.deepEqual(options.breadcrumbs, [{ action: 'scripts', cmd: 'jsn import maps u_staging --scripts', description: 'Print the script bodies' }]);
  assert.match(data._formatted, /Staged users/);
  assert.equal(Object.keys(data).includes('_formatted'), false);
});

test('real CLI reads import maps with JSON, --get, human output and strict validation, using GET only', async () => {
  const calls = [];
  const tables = staged();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    const answer = tables[url.pathname.split('/').pop()];
    res.end(JSON.stringify({ result: typeof answer === 'function' ? answer(url.searchParams.get('sysparm_query')) : (answer ?? []) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-import-maps-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const listed = JSON.parse((await run(['import', 'maps', 'u_staging', '--json'])).stdout);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.data.maps.map(m => m.coalesce), [['email'], []]);
    assert.equal(JSON.parse((await run(['import', 'maps', 'u_staging', '--scripts', '--get', 'data.maps.0.script'])).stdout), 'target.active = true;');
    const human = await run(['import', 'maps', 'u_staging', '--format', 'styled']);
    assert.match(human.stdout, /Staged users \[c{32}\][\s\S]*Coalesce on email/);
    const before = calls.length;
    for (const args of [['u_staging^ORactive=true'], [], ['u_staging', '--typo']]) {
      await assert.rejects(run(['import', 'maps', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    assert.match((await run(['import', '--help'])).stdout, /maps/);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
