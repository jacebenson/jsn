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
import { recordVersions, formatVersions, parsePayload, diffPayloads, lineDiff } from '../src/records/versions.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const KEY = `sys_script_include_${id(1)}`;
const xml = (script, updated, scope = 'Global') => `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><active>true</active><name>SynthUtil</name><script><![CDATA[${script}]]></script><sys_id>${id(1)}</sys_id><sys_scope display_value="${scope}">global</sys_scope><sys_updated_on>${updated}</sys_updated_on></sys_script_include></record_update>`;
const payloads = {
  [id(13)]: xml('var a = 1;\nvar b = 2;\nreturn a + b;', '2026-01-03 10:00:00'),
  [id(12)]: xml('var a = 1;\nvar b = 3;\nreturn a + b;', '2026-01-02 10:00:00', 'Wrong label, same raw value'),
  [id(11)]: xml('var a = 1;\nvar b = 2;\nreturn a + b;', '2026-01-01 10:00:00'),
};
const version = (n, state) => ({ sys_id: field(id(n)), name: field(KEY), record_name: field('SynthUtil'), state: field(state, state[0].toUpperCase() + state.slice(1)), action: field('INSERT_OR_UPDATE'), source_table: field('sys_update_set'), source: field(id(30), 'Synthetic set'), sys_recorded_at: field(String(n)), sys_created_on: field(`2026-01-0${n - 10} 10:00:00`), sys_created_by: field('admin') });
const tables = {
  sys_script_include: [{ sys_id: field(id(1)), name: field('SynthUtil'), sys_update_name: field(KEY), sys_class_name: field('sys_script_include', 'Script Include') }],
  sys_update_version: [version(13, 'current'), version(12, 'previous'), version(11, 'history')],
  sys_update_xml: [{ sys_id: field(id(41)), name: field(KEY), update_set: field(''), remote_update_set: field(id(32), 'Retrieved preview'), action: field('INSERT_OR_UPDATE'), sys_updated_on: field('2026-01-04 10:00:00'), sys_updated_by: field('admin') }, { sys_id: field(id(40)), name: field(KEY), update_set: field(id(31), 'Synthetic moved set'), action: field('INSERT_OR_UPDATE'), sys_updated_on: field('2026-01-03 10:00:00'), sys_updated_by: field('admin') }],
};

// Exact-condition filter over the fixture tables; ORDERBY terms are asserted by tests, not applied.
function filter(rows, query) {
  const terms = query.split('^').filter(term => !term.startsWith('ORDERBY'));
  return rows.filter(row => terms.every(term => {
    const [, name, op, value] = term.match(/^(\w+?)(=|STARTSWITH|ENDSWITH|ISNOTEMPTY)(.*)$/);
    const actual = row[name]?.value ?? row[name] ?? '';
    return op === 'ISNOTEMPTY' ? actual !== '' : op === '=' ? actual === value : op === 'STARTSWITH' ? actual.startsWith(value) : actual.endsWith(value);
  }));
}
function fixtureSdk(overrides = {}) {
  const calls = [];
  const read = async (table, params) => {
    calls.push({ table, params });
    let rows = filter(overrides[table] ?? tables[table] ?? [], params.get('sysparm_query'));
    if (params.get('sysparm_display_value') === 'false') rows = rows.map(row => ({ ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v?.value ?? v])), ...(params.get('sysparm_fields').includes('payload') ? { payload: (overrides.payloads ?? payloads)[row.sys_id.value] } : {}) }));
    return rows.slice(0, Number(params.get('sysparm_limit')));
  };
  return { calls, list: read, listStrict: read };
}

test('lists versions newest first by the record update name, with bounded lookahead and the latest capture', async () => {
  const sdk = fixtureSdk();
  const data = await recordVersions(sdk, { table: 'sys_script_include', identifier: id(1), limit: 2 });
  assert.equal(sdk.calls[0].params.get('sysparm_fields'), 'sys_id,sys_update_name,sys_class_name');
  assert.equal(sdk.calls[1].table, 'sys_update_version');
  assert.equal(sdk.calls[1].params.get('sysparm_query'), `name=${KEY}^ORDERBYDESCsys_recorded_at^ORDERBYDESCsys_id`);
  assert.equal(sdk.calls[1].params.get('sysparm_limit'), '3');
  assert.doesNotMatch(sdk.calls[1].params.get('sysparm_fields'), /payload,|payload$/);
  assert.equal(sdk.calls[2].params.get('sysparm_query'), `name=${KEY}^update_setISNOTEMPTY^ORDERBYDESCsys_updated_on^ORDERBYDESCsys_id`);
  assert.deepEqual(data.versions.map(row => [row.number, row.state.value]), [[1, 'current'], [2, 'previous']]);
  assert.deepEqual(data.pagination, { limit: 2, has_more: true });
  assert.deepEqual(data.latest_update.update_set, field(id(31), 'Synthetic moved set'));
  assert.equal(data.record.update_name, KEY);
  const human = formatVersions(data);
  assert.match(human, /Synthetic moved set.*0{30}1f/);
  assert.match(human, /1 {2}current[\s\S]*2 {2}previous/);
  assert.match(human, /raise --limit/);
});

test('--diff compares version N to the current version on raw values and diffs scripts by line', async () => {
  const sdk = fixtureSdk();
  const data = await recordVersions(sdk, { table: 'sys_script_include', identifier: id(1), diff: 2 });
  assert.equal(sdk.calls[3].params.get('sysparm_query'), `name=${KEY}^state=current`);
  assert.equal(sdk.calls[4].params.get('sysparm_query'), `sys_id=${id(12)}`);
  for (const call of sdk.calls.slice(3)) assert.equal(call.params.get('sysparm_display_value'), 'false');
  assert.equal(data.diff.status, 'different');
  assert.equal(data.diff.records.length, 1);
  const [record] = data.diff.records;
  // sys_updated_on is noise and the scope display label differs but its raw value does not.
  assert.deepEqual(record.fields.map(change => change.field), ['script']);
  assert.deepEqual(record.fields[0].lines.changes, [{ op: '-', line: 2, text: 'var b = 3;' }, { op: '+', line: 2, text: 'var b = 2;' }]);
  assert.match(formatVersions(data), /CHANGED script:\n {6}-2: var b = 3;\n {6}\+2: var b = 2;/);
  const same = await recordVersions(fixtureSdk(), { table: 'sys_script_include', identifier: id(1), diff: 3 });
  assert.equal(same.diff.status, 'equal');
  assert.match(formatVersions(same), /no differences/);
});

test('--identifier-field selects an exact human field and resolves to the raw sys_id', async () => {
  const sdk = fixtureSdk();
  const data = await recordVersions(sdk, { table: 'sys_script_include', identifier: 'SynthUtil', identifierField: 'name' });
  assert.equal(sdk.calls[0].params.get('sysparm_query'), 'name=SynthUtil');
  assert.equal(data.record.sys_id, id(1));
});

test('a record without a readable update name falls back to class and sys_id and says so', async () => {
  const sdk = fixtureSdk({ incident: [{ sys_id: field(id(2)), sys_class_name: field('incident') }] });
  const data = await recordVersions(sdk, { table: 'incident', identifier: id(2) });
  assert.equal(sdk.calls[1].params.get('sysparm_query'), `name=incident_${id(2)}^ORDERBYDESCsys_recorded_at^ORDERBYDESCsys_id`);
  assert.equal(data.count, 0);
  assert.equal(data.latest_update, null);
  const human = formatVersions(data);
  assert.match(human, /looked up as incident_/);
  assert.match(human, /glide\.update\.suppress_update_version/);
  assert.match(human, /does not mean the record is unchanged/);
  assert.match(human, /none readable in sys_update_xml/);
  assert.match(human, /ACLs can hide them/);
  assert.match(human, /No sys_update_xml row in an update set was readable for incident_/);
  const many = Array.from({ length: 201 }, (_, i) => ({ sys_id: field(id(100 + i)), name: field(KEY), state: field(i ? 'history' : 'current') }));
  const capped = await recordVersions(fixtureSdk({ sys_update_version: many }), { table: 'sys_script_include', identifier: id(1), limit: 200 });
  assert.equal(capped.count, 200);
  assert.match(formatVersions(capped), /only the newest 200 can be listed or compared/);
});

test('invalid input rejects before any call', async () => {
  const sdk = fixtureSdk();
  const base = { table: 'sys_script_include', identifier: id(1) };
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { diff: 0 }, { diff: 201 }, { diff: 1.5 }, { diff: Number.NaN }]) {
    await assert.rejects(recordVersions(sdk, { ...base, ...options }), /--limit|--diff/);
  }
  for (const options of [{ identifier: '' }, { identifier: `${id(1)}^NQ` }, { identifier: '*' }, { table: 'bad table' }, { identifierField: 'name^x' }]) {
    await assert.rejects(recordVersions(sdk, { ...base, ...options }));
  }
  assert.equal(sdk.calls.length, 0);
});

test('denied, malformed, missing and mismatched evidence is never reported as success', async () => {
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    const sdk = fixtureSdk();
    sdk.listStrict = async () => { throw error; };
    await assert.rejects(recordVersions(sdk, { table: 'sys_script_include', identifier: id(1) }), e => e === error);
  }
  const malformedSdk = fixtureSdk();
  malformedSdk.listStrict = async () => ({ result: [] });
  await assert.rejects(recordVersions(malformedSdk, { table: 'sys_script_include', identifier: id(1) }), /Malformed/);
  const base = { table: 'sys_script_include', identifier: id(1) };
  for (const table of ['sys_update_version', 'sys_update_xml']) {
    const sdk = fixtureSdk();
    const read = sdk.listStrict;
    sdk.listStrict = async (name, params) => name === table ? tables[table].map(row => ({ ...row, name: field('other', KEY) })) : read(name, params);
    await assert.rejects(recordVersions(sdk, base), /another record/);
  }
  await assert.rejects(recordVersions(fixtureSdk(), { ...base, diff: 1 }), /is the current version/);
  await assert.rejects(recordVersions(fixtureSdk(), { ...base, diff: 4 }), /does not exist/);
  await assert.rejects(recordVersions(fixtureSdk({ sys_update_version: tables.sys_update_version.map(row => ({ ...row, state: field('history') })) }), { ...base, diff: 2 }), /No current version/);
  await assert.rejects(recordVersions(fixtureSdk({ sys_update_version: [version(13, 'current'), version(14, 'current'), version(12, 'previous')] }), { ...base, diff: 3 }), /More than one current/);
  for (const payload of ['', '<record_update/>', '<record_update><sys_script_include action="INSERT_OR_UPDATE">', '<!DOCTYPE x><record_update><x action="DELETE"><sys_id>1</sys_id></x></record_update>']) {
    await assert.rejects(recordVersions(fixtureSdk({ payloads: { ...payloads, [id(12)]: payload } }), { ...base, diff: 2 }), error => error.code === 'malformed_response');
  }
});

test('composite payloads compare each record by table and sys_id, inside or outside a container', () => {
  const older = parsePayload('<record_update><sys_ui_list action="INSERT_OR_UPDATE"><name>incident</name><sys_id>L1</sys_id></sys_ui_list><sys_ui_list_element action="INSERT_OR_UPDATE"><element>number</element><position>0</position><sys_id>E1</sys_id></sys_ui_list_element><sys_ui_list_element action="INSERT_OR_UPDATE"><element>state</element><position>1</position><sys_id>E2</sys_id></sys_ui_list_element></record_update>');
  const current = parsePayload('<record_update><wrapper><sys_ui_list action="INSERT_OR_UPDATE"><name>incident</name><sys_id>L1</sys_id></sys_ui_list></wrapper><sys_ui_list_element action="INSERT_OR_UPDATE"><element>number</element><position>1</position><sys_id>E1</sys_id></sys_ui_list_element><sys_ui_list_element action="INSERT_OR_UPDATE"><element>priority</element><position>0</position><sys_id>E3</sys_id></sys_ui_list_element></record_update>');
  assert.equal(older.length, 3);
  assert.deepEqual(diffPayloads(older, current).map(record => [record.sys_id, record.status, record.fields?.map(change => [change.field, change.a, change.b])]), [
    ['E1', 'changed', [['position', '0', '1']]], ['E2', 'removed', undefined], ['E3', 'added', undefined],
  ]);
  assert.deepEqual(parsePayload('<record_update><x action="DELETE"><ref display_value="Label">abc</ref></x></record_update>')[0], { table: 'x', action: 'DELETE', fields: { ref: { value: 'abc', display_value: 'Label' } } });
});

test('line diff trims the shared head and tail and stays bounded on huge rewrites', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), { changes: [{ op: '-', line: 2, text: 'b' }, { op: '+', line: 3, text: 'd' }] });
  const big = n => Array.from({ length: 2500 }, (_, i) => `${n}${i}`).join('\n');
  assert.deepEqual(lineDiff(`top\n${big('x')}`, `top\n${big('y')}`), { truncated: true, first_line: 2, removed: 2500, added: 2500 });
});

test('real CLI reads only with GETs on a read-only profile, renders human and JSON output, and rejects bad input before transport', async () => {
  const calls = [];
  const sdk = fixtureSdk();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    sdk.listStrict(url.pathname.split('/').pop(), url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-records-versions-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const { stdout } = await run(['records', 'versions', 'sys_script_include', 'SynthUtil', '--identifier-field', 'name', '--diff', '2', '--json']);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.versions.length, 3);
    assert.equal(envelope.data.diff.records[0].fields[0].field, 'script');
    const human = await run(['records', 'versions', 'sys_script_include', id(1), '--diff', '2', '--format', 'styled']);
    assert.match(human.stdout, /Synthetic moved set/);
    assert.match(human.stdout, /\+2: var b = 2;/);
    const get = await run(['records', 'versions', 'sys_script_include', id(1), '--get', 'data.latest_update.update_set.value']);
    assert.ok(get.stdout.includes(id(31)));
    const before = calls.length;
    for (const args of [[id(1), '--diff', '0'], [id(1), '--limit', '500'], [`${id(1)}^NQ`], ['*']]) {
      await assert.rejects(run(['records', 'versions', 'sys_script_include', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.filter(call => call.pathname.startsWith('/api/now/table/')).length, calls.slice(0, before).filter(call => call.pathname.startsWith('/api/now/table/')).length);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    const help = await run(['records', '--help']);
    assert.ok(help.stdout.includes('versions'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
