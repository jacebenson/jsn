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
import { recordHistory, formatHistory } from '../src/records/history.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const SYS_ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const audit = (n, over = {}) => ({ sys_id: n.toString(16).padStart(32, '0'), tablename: 'incident', documentkey: SYS_ID, fieldname: 'priority', oldvalue: '4', newvalue: '3', user: 'alex.chen', reason: '', sys_created_on: `2026-11-2${n} 10:00:00`, ...over });
// The table-audit reads: incident extends task; incident's own collection row carries the Audit tick.
const hierarchy = names => params => {
  const query = params.get('sysparm_query');
  const i = names.findIndex((name, n) => query === `name=${name}` || query === `sys_id=${String(n).repeat(32)}`);
  return i < 0 ? [] : [{ sys_id: String(i).repeat(32), name: names[i], super_class: names[i + 1] ? { value: String(i + 1).repeat(32), display_value: names[i + 1] } : '' }];
};
const auditWorld = ({ audited = true, inserts = 'false', attributes = '' } = {}) => ({
  sys_db_object: hierarchy(['incident', 'task']),
  sys_schema_attribute: [{ sys_id: 'c'.repeat(32), name: 'no_audit' }],
  sys_schema_attribute_m2m: [],
  sys_dictionary: [
    { sys_id: '1'.repeat(32), name: 'incident', element: '', internal_type: 'collection', audit: String(audited), attributes: '' },
    { sys_id: '2'.repeat(32), name: 'task', element: '', internal_type: 'collection', audit: 'false', attributes: '' },
    { sys_id: '3'.repeat(32), name: 'task', element: 'priority', internal_type: 'integer', audit: 'false', attributes },
  ],
  sys_properties: [{ name: 'glide.sys.audit_inserts', value: inserts }],
});

// resolveRecord lists the record's own table; sys_audit and the table-audit reads go through listStrict.
function fixture({ record = { sys_id: SYS_ID, sys_class_name: 'incident' }, rows = [], tables = auditWorld() } = {}) {
  const calls = [];
  const sdk = {
    async list(table, params) {
      calls.push({ table, query: params.get('sysparm_query') });
      return record ? [record] : [];
    },
    async listStrict(table, params) {
      calls.push({ table, query: params.get('sysparm_query'), params: Object.fromEntries(params) });
      const value = table === 'sys_audit' ? rows : tables[table];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(params) : value ?? [];
    },
  };
  return { sdk, calls };
}

test('reads one record\'s changes keyed on its own class and raw sys_id, newest first, bounded and uncounted', async () => {
  const { sdk, calls } = fixture({ rows: [audit(3, { fieldname: 'assigned_to', oldvalue: '', newvalue: OTHER }), audit(2)] });
  const data = await recordHistory(sdk, { table: 'task', identifier: 'INC0010001', identifierField: 'number' });
  assert.deepEqual(calls[0], { table: 'task', query: 'number=INC0010001' });
  const read = calls.find(call => call.table === 'sys_audit');
  // The record was found on task, but sys_audit keeps rows under its own class.
  assert.deepEqual(read.params, {
    sysparm_query: `tablename=incident^documentkey=${SYS_ID}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`,
    sysparm_fields: 'sys_id,tablename,documentkey,fieldname,oldvalue,newvalue,user,reason,sys_created_on',
    sysparm_limit: '21', sysparm_display_value: 'false', sysparm_no_count: 'true',
  });
  assert.deepEqual(data.record, { sys_id: SYS_ID, table: 'incident', found: true });
  assert.equal(data.count, 2);
  assert.deepEqual(data.changes[0], { sys_id: '3'.padStart(32, '0'), changed_on: '2026-11-23 10:00:00', user: 'alex.chen', field: 'assigned_to', old_value: '', new_value: OTHER, reason: '' });
  assert.deepEqual(data.notes, []);
  assert.equal(calls.filter(call => call.table !== 'sys_audit' && call.table !== 'task').length, 0, 'audit status is read only to explain an empty history');
});

test('--field and --since narrow the keyed query; bad input rejects before any request', async () => {
  const { sdk, calls } = fixture({ rows: [audit(2)] });
  await recordHistory(sdk, { table: 'incident', identifier: SYS_ID, field: 'priority', since: '2026-11-01', limit: 5 });
  const read = calls.find(call => call.table === 'sys_audit');
  assert.equal(read.query, `tablename=incident^documentkey=${SYS_ID}^fieldname=priority^sys_created_on>=2026-11-01^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`);
  assert.equal(read.params.sysparm_limit, '6');
  const empty = fixture();
  for (const [options, message] of [
    [{ limit: 0 }, /--limit must be an integer from 1 to 200/], [{ limit: 201 }, /--limit/],
    [{ field: 'priority^ORactive=true' }, /--field must be a column name/], [{ since: 'yesterday' }, /--since must be a date/],
    [{ since: '2026-11-01^NQactive=true' }, /--since/], [{ identifier: `${SYS_ID}^NQ` }, /Unsafe identifier/],
  ]) await assert.rejects(recordHistory(empty.sdk, { table: 'incident', identifier: SYS_ID, ...options }), message);
  assert.equal(empty.calls.length, 0);
});

test('a deleted record still shows its history; a missing record with none is not found', async () => {
  const deleted = fixture({ record: null, rows: [audit(4, { fieldname: 'DELETED', oldvalue: 'DELETED', newvalue: 'DELETED' }), audit(3)] });
  const data = await recordHistory(deleted.sdk, { table: 'incident', identifier: SYS_ID });
  assert.equal(data.record.found, false);
  assert.equal(data.count, 2);
  assert.match(data.notes.join(' '), /No incident record has sys_id a{32} now; these rows are its history before it was deleted/);
  assert.match(formatHistory(data), /record deleted/);
  // A full sys_id is looked up exactly once: no prefix or suffix scans of the record's table.
  assert.equal(deleted.calls.filter(call => call.table === 'incident').length, 1);

  // Without the DELETED row (filtered out, or the record is hidden by ACLs) it does not claim a delete.
  const hidden = await recordHistory(fixture({ record: null, rows: [audit(3)] }).sdk, { table: 'incident', identifier: SYS_ID, field: 'priority' });
  assert.match(hidden.notes.join(' '), /is readable now \(deleted, or hidden by ACLs\)/);
  assert.doesNotMatch(hidden.notes.join(' '), /before it was deleted/);

  const missing = fixture({ record: null });
  await assert.rejects(recordHistory(missing.sdk, { table: 'incident', identifier: SYS_ID }), error => error.code === 'not_found' && /may not exist, or ACLs hide it/.test(error.hint) && /own table \(incident, not task\)/.test(error.hint) && !/--field/.test(error.hint));
  await assert.rejects(recordHistory(fixture({ record: null }).sdk, { table: 'incident', identifier: SYS_ID, field: 'priority' }), error => error.code === 'not_found' && /no rows for it matching --field or --since/.test(error.hint));
  // Without a sys_id there is no documentkey to read.
  const byNumber = fixture({ record: null });
  await assert.rejects(recordHistory(byNumber.sdk, { table: 'incident', identifier: 'INC0010001', identifierField: 'number' }), error => error.code === 'not_found');
  assert.equal(byNumber.calls.filter(call => call.table === 'sys_audit').length, 0);
});

test('an empty history says why where the audit settings tell, and never claims nothing changed', async () => {
  const off = await recordHistory(fixture({ tables: auditWorld({ audited: false }) }).sdk, { table: 'incident', identifier: SYS_ID });
  assert.equal(off.count, 0);
  assert.match(off.notes[0], /table auditing is off for incident/);
  assert.match(off.notes.join(' '), /admin-read by default/);

  const field = await recordHistory(fixture({ tables: auditWorld({ attributes: 'no_audit' }) }).sdk, { table: 'incident', identifier: SYS_ID, field: 'priority' });
  assert.match(field.notes[0], /task\.priority carries the no_audit attribute/);

  const inserts = await recordHistory(fixture().sdk, { table: 'incident', identifier: SYS_ID, since: '2026-11-01' });
  assert.match(inserts.notes[0], /on or after 2026-11-01, though incident is audited/);
  assert.match(inserts.notes[0], /glide\.sys\.audit_inserts/);
  assert.match(inserts.notes[0], /import sets, update set applies, Import XML and upgrades/);
  const withInserts = await recordHistory(fixture({ tables: auditWorld({ inserts: 'true' }) }).sdk, { table: 'incident', identifier: SYS_ID });
  assert.doesNotMatch(withInserts.notes[0], /audit_inserts/);

  // Audit status needs admin too; failing to read it is a note, not a failed history read.
  const unread = await recordHistory(fixture({ tables: { ...auditWorld(), sys_properties: [] } }).sdk, { table: 'incident', identifier: SYS_ID });
  assert.match(unread.notes[0], /audit status for incident was not read: No audit properties were readable/);
  assert.match(formatHistory(unread), /\(read-only\)\nNo changes found; audit status/);
});

test('a row for another record or field, or a malformed page, is never shown as history', async () => {
  for (const rows of [[audit(1, { documentkey: OTHER })], [audit(1, { tablename: 'task' })], [null], [[]], 'rows']) {
    await assert.rejects(recordHistory(fixture({ rows }).sdk, { table: 'incident', identifier: SYS_ID }), error => error.code === 'malformed_response', JSON.stringify(rows));
  }
  await assert.rejects(recordHistory(fixture({ rows: [audit(1, { fieldname: 'state' })] }).sdk, { table: 'incident', identifier: SYS_ID, field: 'priority' }), /another record or field/);
});

test('lookahead reports more changes without claiming a total, and long values are cut only in human output', async () => {
  const long = 'x'.repeat(300);
  const data = await recordHistory(fixture({ rows: [audit(3, { fieldname: 'description', newvalue: long }), audit(2), audit(1)] }).sdk, { table: 'incident', identifier: SYS_ID, limit: 2 });
  assert.equal(data.count, 2);
  assert.deepEqual(data.pagination, { limit: 2, has_more: true });
  assert.match(data.notes.join(' '), /More changes exist; raise --limit/);
  assert.equal(data.changes[0].new_value, long);
  const human = formatHistory(data);
  assert.match(human, /^History of incident a{32} from sys_audit, newest first, times UTC \(read-only\)/);
  assert.match(human, /2026-11-22 10:00:00 {2}alex\.chen {2}priority: "4" -> "3"/);
  assert.doesNotMatch(human, /x{300}/);
  assert.match(human, /--json returns them whole/);
});

test('real CLI reads only with GETs on a read-only profile, renders human and JSON output, and rejects bad input before transport', async () => {
  const calls = [];
  let { sdk } = fixture({ rows: [audit(2), audit(1, { fieldname: 'state', oldvalue: '1', newvalue: '2' })] });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    const table = url.pathname.split('/').pop();
    (table === 'incident' ? sdk.list(table, url.searchParams) : sdk.listStrict(table, url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-records-history-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const { stdout } = await run(['records', 'history', 'incident', 'INC0010001', '--identifier-field', 'number', '--json']);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.count, 2);
    assert.equal(envelope.data.changes[1].field, 'state');
    const human = await run(['records', 'history', 'incident', SYS_ID, '--format', 'styled']);
    assert.match(human.stdout, /priority: "4" -> "3"/);
    const get = await run(['records', 'history', 'incident', SYS_ID, '--get', 'data.changes.0.user']);
    assert.ok(get.stdout.includes('alex.chen'));
    const before = calls.filter(call => call.pathname.startsWith('/api/now/table/')).length;
    for (const args of [[SYS_ID, '--limit', '0'], [SYS_ID, '--field', 'a^b'], [SYS_ID, '--since', 'today'], [`${SYS_ID}^NQ`]]) {
      await assert.rejects(run(['records', 'history', 'incident', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.filter(call => call.pathname.startsWith('/api/now/table/')).length, before);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    // An empty history's summary is the reason, never a bare count of zero.
    ({ sdk } = fixture({ tables: auditWorld({ audited: false }) }));
    const empty = await run(['records', 'history', 'incident', SYS_ID, '--get', 'summary']);
    assert.match(empty.stdout, /No changes found: table auditing is off for incident/);
    assert.doesNotMatch(empty.stdout, /0 change/);
    const help = await run(['records', '--help']);
    assert.ok(help.stdout.includes('history'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
