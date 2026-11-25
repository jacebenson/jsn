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
import { readTableAudit, formatTableAudit, parseAttributes } from '../src/table-audit.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = character => character.repeat(32);
const NO_AUDIT = id('7');
const NO_AUDIT_DELETE = id('8');
let next = 0;
const row = (name, element, extra = {}) => ({ sys_id: (++next).toString(16).padStart(32, '0'), name, element, internal_type: element ? 'string' : 'collection', audit: 'false', attributes: '', ...extra });
const link = (schema, attribute, value = 'true') => ({ sys_id: (++next).toString(16).padStart(32, 'f'), schema: schema.sys_id, attribute, value });
const hierarchy = (...names) => params => {
  const query = params.get('sysparm_query');
  const index = names.findIndex((name, i) => query === `name=${name}` || query === `sys_id=${id(String.fromCharCode(97 + i))}`);
  return index < 0 ? [] : [{ sys_id: id(String.fromCharCode(97 + index)), name: names[index], label: names[index], super_class: names[index + 1] ? { value: id(String.fromCharCode(98 + index)), display_value: names[index + 1] } : '' }];
};

function world(over = {}) {
  return {
    sys_db_object: hierarchy('x_case', 'x_task'),
    sys_schema_attribute: [{ sys_id: NO_AUDIT, name: 'no_audit' }, { sys_id: NO_AUDIT_DELETE, name: 'no_audit_delete' }],
    sys_schema_attribute_m2m: [],
    sys_dictionary: [row('x_case', '', { audit: 'true' }), row('x_task', ''), row('x_task', 'short_description')],
    sys_properties: [],
    ...over,
  };
}

function fixtureSdk(tables) {
  const calls = [];
  return { calls, async listStrict(table, params) {
    calls.push({ table, params: Object.fromEntries(params) });
    const value = tables[table];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value ?? [];
  } };
}

test('reads the hierarchy, attribute rows, dictionary and properties with bounded GET queries', async () => {
  const sdk = fixtureSdk(world());
  const data = await readTableAudit(sdk, 'x_case', { field: 'short_description' });
  assert.deepEqual(sdk.calls.map(call => call.table), ['sys_db_object', 'sys_db_object', 'sys_schema_attribute', 'sys_schema_attribute_m2m', 'sys_dictionary', 'sys_properties']);
  const [, , attributes, links, dictionary, properties] = sdk.calls.map(call => call.params);
  assert.deepEqual(attributes, { sysparm_query: 'nameINno_audit,audit,audit_type,no_audit_delete', sysparm_fields: 'sys_id,name', sysparm_limit: '2001' });
  assert.deepEqual(links, { sysparm_query: `attributeIN${NO_AUDIT},${NO_AUDIT_DELETE}^schema.nameINx_case,x_task`, sysparm_fields: 'sys_id,schema,attribute,value', sysparm_limit: '2001' });
  assert.deepEqual(dictionary, { sysparm_query: 'nameINx_case,x_task', sysparm_fields: 'sys_id,name,element,internal_type,audit,attributes', sysparm_limit: '2001' });
  assert.deepEqual(properties, { sysparm_query: 'nameINglide.sys.audit_inserts,glide.db.audit.ignore.delete,glide.ui.audit_deleted_tables', sysparm_fields: 'name,value', sysparm_limit: '2001' });
  assert.equal(data.audited, true);
  assert.equal(data.mode, 'all');
  assert.deepEqual(data.ancestors, ['x_task']);
  assert.deepEqual(data.inserts, { audited: false, property: { name: 'glide.sys.audit_inserts', value: null, default: true }, reason: 'glide.sys.audit_inserts is not set (default false); inserts are not audited on any table.' });
  assert.deepEqual(data.updates, { audited: true });
  assert.deepEqual(data.reads, { audited: false });
  assert.equal(data.deletes.recorded, true);
  assert.deepEqual(data.field, { name: 'short_description', table: 'x_task', audited: true, reason: 'x_case is audited and nothing excludes short_description.' });
  assert.deepEqual(data.attribute_rows, { compared: ['no_audit', 'no_audit_delete'], string_only: ['audit', 'audit_type'], disagreements: [] });
  assert.match(formatTableAudit(data), /Table audit +on[\s\S]*Reads +never audited[\s\S]*Field short_description: audited/);
});

test('table auditing is not inherited from an audited parent', async () => {
  const sdk = fixtureSdk(world({ sys_dictionary: [row('x_case', ''), row('x_task', '', { audit: 'true' }), row('x_task', 'short_description')] }));
  const data = await readTableAudit(sdk, 'x_case', { field: 'short_description' });
  assert.equal(data.audited, false);
  assert.deepEqual(data.parents_audited, ['x_task']);
  assert.deepEqual(data.updates, { audited: false });
  assert.equal(data.field.audited, false);
  assert.equal(data.field.reason, 'Table auditing is off for x_case; x_task audits, but auditing does not inherit.');
  assert.match(formatTableAudit(data), /x_task audits, but x_case does not/);
});

test('field verdicts: system, encrypted, no_audit by presence, nearest row and whitelist', async () => {
  const dictionary = [
    row('x_case', '', { audit: 'true' }), row('x_task', ''),
    row('x_task', 'sys_updated_on'), row('x_task', 'sys_class_name'), row('x_task', 'sys_domain_id'),
    row('x_task', 'secret', { internal_type: 'password2' }),
    row('x_task', 'work_notes', { attributes: 'no_audit' }),
    row('x_task', 'state', { attributes: 'no_audit=false' }),
    row('x_task', 'priority', { attributes: 'no_audit=true' }), row('x_case', 'priority', { attributes: 'max_length=40' }),
    row('x_task', 'short_description'),
  ];
  const verdict = async (field, rows = dictionary) => (await readTableAudit(fixtureSdk(world({ sys_dictionary: rows, sys_schema_attribute: [] })), 'x_case', { field })).field;
  assert.deepEqual(await verdict('sys_updated_on'), { name: 'sys_updated_on', table: 'x_task', audited: false, reason: 'System fields (sys_*) are never audited, except sys_class_name and sys_domain_id.' });
  assert.equal((await verdict('sys_class_name')).audited, true);
  assert.equal((await verdict('sys_domain_id')).audited, true);
  assert.deepEqual(await verdict('secret'), { name: 'secret', table: 'x_task', audited: false, reason: 'x_task.secret is an encrypted field (password2); encrypted fields are never audited.' });
  assert.equal((await verdict('work_notes')).reason, 'x_task.work_notes carries the no_audit attribute.');
  assert.equal((await verdict('state')).audited, false, 'no_audit excludes by presence; its value is ignored');
  assert.deepEqual(await verdict('priority'), { name: 'priority', table: 'x_case', audited: true, reason: 'x_case is audited and nothing excludes priority.' }, 'the row on the table itself wins over the parent row');
  await assert.rejects(verdict('missing'), /Field missing was not found on x_case or its parents/);

  const whitelist = [row('x_case', '', { audit: 'true', attributes: 'audit_type=whitelist,update_synch=true' }), row('x_task', ''), row('x_task', 'state', { attributes: 'audit=true' }), row('x_task', 'short_description')];
  assert.deepEqual(await verdict('state', whitelist), { name: 'state', table: 'x_task', audited: true, reason: 'x_case is in whitelist mode and x_task.state carries audit=true.' });
  assert.equal((await verdict('short_description', whitelist)).reason, 'x_case is in whitelist mode (audit_type=whitelist) and x_task.short_description does not carry audit=true.');
  const data = await readTableAudit(fixtureSdk(world({ sys_dictionary: dictionary })), 'x_case');
  assert.deepEqual(data.excluded_fields, [{ field: 'state', table: 'x_task' }, { field: 'work_notes', table: 'x_task' }], 'x_case.priority shadows the no_audit on x_task.priority');
  assert.deepEqual(data.encrypted_fields, [{ field: 'secret', table: 'x_task', type: 'password2' }]);
  assert.match(formatTableAudit(data), /Excluded +state \(x_task\), work_notes \(x_task\) \(no_audit\)/);
});

test('inserts follow glide.sys.audit_inserts only on an audited table', async () => {
  const inserts = { sys_properties: [{ name: 'glide.sys.audit_inserts', value: 'true' }] };
  assert.equal((await readTableAudit(fixtureSdk(world(inserts)), 'x_case')).inserts.audited, true);
  const off = await readTableAudit(fixtureSdk(world({ ...inserts, sys_dictionary: [row('x_case', ''), row('x_task', '')] })), 'x_case');
  assert.deepEqual(off.inserts, { audited: false, property: { name: 'glide.sys.audit_inserts', value: 'true', default: false }, reason: 'Table auditing is off for x_case.' });
});

test('deletes: no_audit_delete, the ignore list and its default, and the sys_ table rule', async () => {
  const deletes = async (table, over = {}) => (await readTableAudit(fixtureSdk(world({ sys_db_object: hierarchy(table), sys_dictionary: [row(table, '', over.collection)], sys_properties: over.properties || [] })), table)).deletes;
  assert.deepEqual(await deletes('x_case', { collection: { attributes: 'no_audit_delete=true' } }), { recorded: false, reason: 'x_case carries the no_audit_delete attribute.', no_audit_delete: true, ignore_delete: { value: null, default: true }, audit_deleted_tables: null });
  assert.equal((await deletes('sc_cart')).reason, 'sc_cart is listed in glide.db.audit.ignore.delete (its default list; no sys_properties row).');
  const replaced = { properties: [{ name: 'glide.db.audit.ignore.delete', value: 'x_case, x_log' }] };
  assert.equal((await deletes('sc_cart', replaced)).recorded, true, 'setting the property replaces the default list');
  assert.equal((await deletes('x_case', replaced)).reason, 'x_case is listed in glide.db.audit.ignore.delete.');
  assert.equal((await deletes('sys_x')).reason, 'sys_x is a sys_ table not listed in glide.ui.audit_deleted_tables.');
  assert.equal((await deletes('sys_x', { properties: [{ name: 'glide.ui.audit_deleted_tables', value: 'sys_user,sys_x' }] })).recorded, true);
  assert.equal((await deletes('x_case')).reason, 'Deleted x_case records are kept in sys_audit_delete, even though table auditing is off.');
});

test('attribute string and sys_schema_attribute_m2m rows are both read and disagreements reported', async () => {
  const notes = row('x_task', 'work_notes', { attributes: 'no_audit=true' });
  const state = row('x_task', 'state');
  const agreed = row('x_task', 'priority', { attributes: 'no_audit=true' });
  const sdk = fixtureSdk(world({
    sys_dictionary: [row('x_case', '', { audit: 'true' }), row('x_task', ''), notes, state, agreed],
    sys_schema_attribute_m2m: [link(state, NO_AUDIT), link(agreed, NO_AUDIT), link({ sys_id: id('9'), name: 'x_other', element: 'state' }, NO_AUDIT)],
  }));
  const data = await readTableAudit(sdk, 'x_case', { field: 'work_notes' });
  assert.deepEqual(data.attribute_rows.disagreements, [
    { table: 'x_task', field: 'work_notes', attribute: 'no_audit', attributes_string: 'true', attribute_row: null },
    { table: 'x_task', field: 'state', attribute: 'no_audit', attributes_string: null, attribute_row: 'true' },
  ]);
  assert.deepEqual(data.field.attribute_disagreements, [data.attribute_rows.disagreements[0]]);
  assert.equal(data.field.audited, false, 'verdicts follow the attributes string');
  assert.deepEqual(data.excluded_fields.map(item => item.field), ['priority', 'work_notes'], 'an m2m row the string lacks is reported, not counted as an exclusion');
  assert.match(formatTableAudit(data), /Disagreement +x_task\.state no_audit: attributes string absent, sys_schema_attribute_m2m true/);
});

test('rejected input reads nothing', async () => {
  for (const [table, field] of [['', undefined], ['x case', undefined], ['x_case^ORsys_idISNOTEMPTY', undefined], ['1x', undefined], [undefined, undefined], ['x_case', ''], ['x_case', 'a^b'], ['x_case', 'a,b']]) {
    const sdk = fixtureSdk(world());
    await assert.rejects(readTableAudit(sdk, table, { field }), /Provide a table name|--field must be a column name/, JSON.stringify([table, field]));
    assert.equal(sdk.calls.length, 0);
  }
});

test('missing, denied, malformed and oversized reads are never reported as status', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_db_object: [] })), 'x_case'), /Table hierarchy not found/);
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_dictionary: denied })), 'x_case'), /Forbidden/);
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_properties: denied })), 'x_case'), /Forbidden/);
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_schema_attribute_m2m: [null] })), 'x_case'), error => error.code === 'malformed_response');
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_dictionary: Array.from({ length: 2001 }, (_, i) => row('x_task', `f${i}`)) })), 'x_case'), /More than 2000 sys_dictionary rows/);
  await assert.rejects(readTableAudit(fixtureSdk(world({ sys_dictionary: [row('x_task', '')] })), 'x_case'), /No readable collection row for x_case/);
  const noDefinitions = fixtureSdk(world({ sys_schema_attribute: [] }));
  assert.deepEqual((await readTableAudit(noDefinitions, 'x_case')).attribute_rows.string_only, ['no_audit', 'audit', 'audit_type', 'no_audit_delete']);
  assert.ok(!noDefinitions.calls.some(call => call.table === 'sys_schema_attribute_m2m'), 'no attribute ids, no unfiltered m2m read');
});

test('parseAttributes treats a bare key as true and keeps values with =', () => {
  assert.deepEqual(parseAttributes('no_audit, audit_type=whitelist,ref_qual=a=b,'), { no_audit: 'true', audit_type: 'whitelist', ref_qual: 'a=b' });
  assert.deepEqual(parseAttributes(''), {});
});

test('real CLI: read-only profile, JSON, --get, styled output, strict validation, GET only', async () => {
  const calls = [];
  const tables = world({ sys_db_object: hierarchy('x_case', 'x_task'), sys_dictionary: [row('x_case', '', { audit: 'true' }), row('x_task', ''), row('x_task', 'work_notes', { attributes: 'no_audit=true' })] });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    const table = url.pathname.startsWith('/api/now/table/') && url.pathname.split('/').pop();
    if (!table) { res.end(JSON.stringify({ result: [] })); return; }
    fixtureSdk(tables).listStrict(table, url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-table-audit-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'tables', 'audit', ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['x_case', '--field', 'work_notes', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data._formatted, undefined);
    assert.equal(envelope.data.field.audited, false);
    assert.equal(JSON.parse((await run(['x_case', '--get', 'data.audited'])).stdout), true);
    const styled = (await run(['x_case', '--styled'])).stdout;
    assert.match(styled, /Audit status: x_case \(extends x_task\)/);
    assert.match(styled, /Excluded +work_notes \(x_task\)/);
    const tableCalls = () => calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    const before = tableCalls().length;
    for (const args of [['x_case', '--typo'], ['bad^name', '--json'], ['x_case', '--field', 'a^b'], []]) {
      await assert.rejects(run(args), undefined, JSON.stringify(args));
    }
    assert.equal(tableCalls().length, before, 'rejected input reads nothing');
    const help = (await run(['--help'])).stdout;
    assert.match(help, /Reads are never audited/);
    assert.ok(tableCalls().length && tableCalls().every(call => call.method === 'GET'));
    assert.ok(calls.every(call => call.pathname.startsWith('/api/now/table/') || call.pathname === '/angular.do'), JSON.stringify(calls.map(call => call.pathname)));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
