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
import { readAtfSteps, formatAtfSteps } from '../src/atf-steps.js';
import { isMutationCommand } from '../src/mutations.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const script = Array.from({ length: 30 }, (_, i) => i ? `    gs.info('synthetic line ${i}');` : '(function(outputs, steps, stepResult, assertEqual) {').join('\r\n');
const value = (n, step, element, type, text, order, label = element) => ({ sys_id: field(id(n)), document: field('sys_atf_step'), document_key: field(step, 'Test Step: not a join key'), variable: field(id(n + 500), label), 'variable.element': field(element), 'variable.internal_type': field(type), order: field(String(order)), value: field(text) });
const tables = {
  sys_atf_test: [{ sys_id: field(id(1)), name: field('Synthetic login'), active: field('true') }, { sys_id: field(id(2)), name: field('Synthetic twin'), active: field('true') }, { sys_id: field(id(3)), name: field('Synthetic twin'), active: field('false') }],
  sys_atf_step: [
    { sys_id: field(id(10)), test: field(id(1), 'Synthetic login'), order: field('1'), active: field('true'), step_config: field(id(110), 'Record Insert'), description: field('Record Insert'), notes: field('') },
    { sys_id: field(id(11)), test: field(id(1), 'Synthetic login'), order: field('2'), active: field('true'), step_config: field(id(111), 'Run Server Side Script'), description: field('Check five\nusers exist'), notes: field('Synthetic note') },
    { sys_id: field(id(12)), test: field(id(1), 'Synthetic login'), order: field('3'), active: field('false'), step_config: field(id(112), 'Impersonate'), description: field(''), notes: field('') },
  ],
  sys_variable_value: [
    value(20, id(10), 'table', 'table_name', 'incident', 100, 'Table'),
    value(21, id(10), 'field_values', 'template_value', 'short_description=Synthetic^active=true', 200, 'Field values'),
    value(22, id(11), 'jasmine_version', 'choice', '3.1', 100, 'Jasmine version'),
    value(24, id(12), 'view', 'string', '', 100, 'View'),
    value(23, id(11), 'script', 'script', script, 200, 'Test script'),
  ],
};
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    for (const clause of (params.get('sysparm_query') || '').split('^')) {
      const [, name, op, val] = clause.match(/^(\w+?)(=|IN)(.*)$/) || [];
      if (name) rows = rows.filter(row => op === 'IN' ? val.split(',').includes(row[name]?.value) : row[name]?.value === val);
    }
    return rows.slice(0, Number(params.get('sysparm_limit')));
  } };
}
const queries = sdk => sdk.calls.map(call => [call.table, call.params.get('sysparm_query'), call.params.get('sysparm_limit')]);

test('steps list in order with their inputs, joined on the raw step sys_id and named by the variable element', async () => {
  const sdk = fixtureSdk();
  const data = await readAtfSteps(sdk, 'Synthetic login');
  assert.deepEqual(queries(sdk), [
    ['sys_atf_test', 'name=Synthetic login', '2'],
    ['sys_atf_step', `test=${id(1)}^ORDERBYorder`, '201'],
    ['sys_variable_value', `document=sys_atf_step^document_keyIN${id(10)},${id(11)},${id(12)}^ORDERBYorder`, '1001'],
  ]);
  assert.ok(sdk.calls.every(call => call.params.get('sysparm_display_value') === 'all'));
  assert.equal(sdk.calls[2].params.get('sysparm_fields'), 'sys_id,document,document_key,variable,variable.element,variable.internal_type,order,value');
  assert.deepEqual(data.test, { table: 'sys_atf_test', sys_id: id(1), name: 'Synthetic login', active: true });
  assert.deepEqual(data.steps.records.map(s => [s.order, s.step_config_name, s.active, s.inputs.map(i => i.name)]), [['1', 'Record Insert', true, ['table', 'field_values']], ['2', 'Run Server Side Script', true, ['jasmine_version', 'script']], ['3', 'Impersonate', false, ['view']]]);
  assert.deepEqual(data.steps.records[0].inputs[0], { sys_id: id(20), name: 'table', label: 'Table', variable: id(520), type: 'table_name', value: 'incident', value_length: 8, truncated: false });
  const shown = data.steps.records[1].inputs[1];
  assert.deepEqual([shown.value.split('\n').length, shown.value_length, shown.truncated], [20, script.length, true]);
  assert.deepEqual(data.input_values, { table: 'sys_variable_value', count: 5, has_more: false });
  const human = formatAtfSteps(data);
  assert.match(human, /^Synthetic login\nsys_atf_test 0+1\n\nSteps \(3\):\n {4}1 {2}Record Insert\n {9}table: incident\n {9}field_values: short_description=Synthetic\^active=true\n/);
  assert.match(human, / {4}2 {2}Run Server Side Script: Check five users exist\n {9}jasmine_version: 3\.1\n {9}script:\n {11}\(function\(outputs, steps, stepResult, assertEqual\) \{\n {11} {4}gs\.info\('synthetic line 1'\);/);
  assert.match(human, /gs\.info\('synthetic line 19'\);\n {11}\(\d+ more character\(s\), --full for the whole script\)\n {4}3 {2}Impersonate \(inactive\)\n {9}view:$/);
  assert.doesNotMatch(human, /line 20|\r/);
});

test('--full keeps a script whole, by sys_id, and a test with no steps says so', async () => {
  const sdk = fixtureSdk();
  const data = await readAtfSteps(sdk, id(1), { full: true });
  assert.equal(queries(sdk)[0][1], `sys_id=${id(1)}`);
  assert.deepEqual([data.steps.records[1].inputs[1].value, data.steps.records[1].inputs[1].truncated], [script, false]);
  assert.match(formatAtfSteps(data), /synthetic line 29'\);\n {4}3 {2}Impersonate/);
  assert.equal(data.steps.records[1].description, 'Check five\nusers exist');
  const notes = Array.from({ length: 25 }, (_, i) => `row ${i}`).join('\n');
  const plain = await readAtfSteps(fixtureSdk({ sys_variable_value: [value(32, id(10), 'field_values', 'template_value', notes, 100)] }), id(1));
  assert.deepEqual([plain.steps.records[0].inputs[0].value, plain.steps.records[0].inputs[0].truncated], [notes, false]);
  assert.doesNotMatch(formatAtfSteps(plain), /No input values/);
  const defaults = formatAtfSteps(await readAtfSteps(fixtureSdk({ sys_variable_value: [] }), id(1)));
  assert.match(defaults, / {4}3 {2}Impersonate \(inactive\)\n\nNo input values were readable: every input is at its default, or ACLs hide them\.$/);
  const long = 'x'.repeat(20000);
  const capped = await readAtfSteps(fixtureSdk({ sys_variable_value: [value(30, id(10), 'field_values', 'template_value', long, 100), value(31, id(11), 'script', 'script', long, 200)] }), id(1), { full: true });
  assert.deepEqual(capped.steps.records.map(s => s.inputs.map(i => [i.value.length, i.truncated])), [[[16384, true]], [[20000, false]], []]);
  assert.match(formatAtfSteps(capped), / {11}\(3616 more character\(s\)\)\n/);
  const sdkEmpty = fixtureSdk({ sys_atf_step: [] });
  const empty = await readAtfSteps(sdkEmpty, id(1));
  assert.deepEqual(queries(sdkEmpty).map(q => q[0]), ['sys_atf_test', 'sys_atf_step']);
  assert.match(formatAtfSteps(empty), /No steps were readable: the test has none, or ACLs hide them\.$/);
});

test('long reads say more exist', async () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ ...tables.sys_atf_step[0], sys_id: field(id(1000 + i)), order: field(String(i + 1)) }));
  const capped = await readAtfSteps(fixtureSdk({ sys_atf_step: many, sys_variable_value: [] }), id(1));
  assert.deepEqual([capped.steps.count, capped.steps.has_more], [200, true]);
  assert.match(formatAtfSteps(capped), /More steps exist than the 200 read\./);
  const values = Array.from({ length: 1005 }, (_, i) => value(5000 + i, id(10), `input_${i}`, 'string', 'v', i));
  const full = await readAtfSteps(fixtureSdk({ sys_variable_value: values }), id(1));
  assert.deepEqual(full.input_values, { table: 'sys_variable_value', count: 1000, has_more: true });
  assert.match(formatAtfSteps(full), /More input values exist than the 1000 read; later steps may show none\./);
});

test('invalid test references reject before any request, and a shared name is refused with both sys_ids', async () => {
  const sdk = fixtureSdk();
  for (const invalid of ['', ' ', ' Synthetic login', 'Synthetic login ', 'a^ORname=b', 'Synthetic*', 'a\nb', 123, undefined]) await assert.rejects(readAtfSteps(sdk, invalid), /sys_id or exact name/);
  assert.equal(sdk.calls.length, 0);
  const twin = fixtureSdk();
  await assert.rejects(readAtfSteps(twin, 'Synthetic twin'), new RegExp(`More than one ATF test is named "Synthetic twin" \\(${id(2)}, ${id(3)}\\)\\. Pass the sys_id\\.`));
  assert.equal(twin.calls.length, 1);
});

function answering(table, rows) {
  const sdk = fixtureSdk();
  const base = sdk.listStrict;
  sdk.listStrict = async (name, params) => name === table ? (sdk.calls.push({ table: name, params }), rows) : base(name, params);
  return sdk;
}

test('an unknown test is no data, and mismatched, denied or malformed reads are never reported as steps', async () => {
  assert.equal(await readAtfSteps(fixtureSdk(), id(99)), null);
  assert.equal(await readAtfSteps(fixtureSdk(), 'No such test'), null);
  await assert.rejects(readAtfSteps(answering('sys_atf_test', [{ ...tables.sys_atf_test[0], sys_id: field(id(98)) }]), id(1)), /different record/);
  await assert.rejects(readAtfSteps(answering('sys_atf_test', [{ ...tables.sys_atf_test[0], name: field('Synthetic logout') }]), 'Synthetic login'), /different record/);
  const otherCase = await readAtfSteps(answering('sys_atf_test', [{ ...tables.sys_atf_test[0], name: field('Synthetic LOGIN') }]), 'Synthetic login');
  assert.deepEqual([otherCase.test.sys_id, otherCase.test.name, otherCase.steps.count], [id(1), 'Synthetic LOGIN', 3]);
  const upper = await readAtfSteps(answering('sys_atf_test', [{ ...tables.sys_atf_test[0], sys_id: field(id(0xabc)) }]), id(0xabc).toUpperCase());
  assert.deepEqual([upper.test.sys_id, upper.steps.count], [id(0xabc), 0]);
  await assert.rejects(readAtfSteps(answering('sys_atf_step', [{ ...tables.sys_atf_step[0], test: field(id(98), id(1)) }]), id(1)), /another test/);
  await assert.rejects(readAtfSteps(answering('sys_variable_value', [{ ...tables.sys_variable_value[0], document_key: field(id(98), id(10)) }]), id(1)), /another record/);
  await assert.rejects(readAtfSteps(answering('sys_variable_value', [{ ...tables.sys_variable_value[0], document: field('sys_atf_test') }]), id(1)), /another record/);
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(readAtfSteps({ listStrict: async () => { throw error; } }, id(1)), e => e === error);
  }
  await assert.rejects(readAtfSteps({ listStrict: async () => [null] }, id(1)), /Malformed/);
  await assert.rejects(readAtfSteps(answering('sys_variable_value', [[]]), id(1)), /Malformed/);
  assert.equal(isMutationCommand({ _: ['atf', 'steps'] }), false);
});

test('real CLI lists steps on a read-only profile, and rejects bad input before any request', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'Requested URI does not represent any resource' } })); }
    Promise.resolve(fixtureSdk().listStrict(url.pathname.split('/').pop(), url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-atf-steps-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['atf', 'steps', 'Synthetic login', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.steps.records.map(s => s.step_config_name), ['Record Insert', 'Run Server Side Script', 'Impersonate']);
    assert.equal(envelope.data.steps.records[1].inputs[1].truncated, true);
    const human = await run(['atf', 'steps', id(1), '--full', '--format', 'styled']);
    assert.match(human.stdout, /2 {2}Run Server Side Script: Check five users exist\n[^]*synthetic line 29/);
    const get = await run(['atf', 'steps', id(1), '--get', 'data.steps.records.1.inputs.0.value']);
    assert.equal(JSON.parse(get.stdout), '3.1');
    const none = await run(['atf', 'steps', id(99), '--json']).catch(error => error);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /not_found/);
    const before = calls.length;
    for (const args of [['a^ORname=b'], ['Synthetic*'], [id(1), '--typo']]) {
      await assert.rejects(run(['atf', 'steps', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    assert.match((await run(['atf', 'steps', '--help'])).stdout, /--full/);
    assert.deepEqual(calls.filter(call => call.method !== 'GET' && call.pathname !== '/angular.do'), []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
