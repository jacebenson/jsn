import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecord, formatFind } from '../src/records/find.js';
import { recordsCmd } from '../src/commands/records.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const ID = '0123456789abcdef0123456789abcdef';

// Fixture SDK: Table API rows per table, and the background script's printed
// output. Every call is recorded so zero-request refusals are observable.
function fixture({ rows = {}, script, scriptError } = {}) {
  const calls = [];
  const sdk = {
    async listStrict(table, params) {
      calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit'), display: params.get('sysparm_display_value') });
      const value = rows[table];
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    async executeScript(source, scope, opts) {
      calls.push({ script: source, scope, opts });
      if (scriptError) throw scriptError;
      return Array.isArray(script) ? script.shift() ?? '' : script ?? '';
    },
  };
  return { sdk, calls };
}
const printed = out => `*** Script: JSN_RECORDS_FIND:${JSON.stringify({ found: null, tried: 0, left: 0, skipped: 0, failed: 0, last: '', more: false, errors: [], ...out })}`;

test('a sys_metadata row answers from the Table API with its real class and no script', async () => {
  const { sdk, calls } = fixture({ rows: { sys_metadata: [{ sys_id: ID, sys_class_name: { value: 'sys_script_include', display_value: 'Script Include' }, sys_name: 'MyUtil' }] } });
  const data = await findRecord(sdk, { sysId: ID });
  assert.equal(data.found, true);
  assert.equal(data.table, 'sys_script_include');
  assert.equal(data.display_value, 'MyUtil');
  assert.equal(data.found_in, 'sys_metadata');
  assert.equal(data.method, 'table_api');
  assert.deepEqual(calls.map(call => call.table), ['sys_metadata']);
  assert.equal(calls[0].query, `sys_id=${ID}`);
  assert.equal(calls[0].limit, '1');
  assert.equal(calls[0].display, 'all');
  assert.match(formatFind(data), /is a sys_script_include record: MyUtil/);
});

test('a task row answers after sys_metadata misses, still without a script', async () => {
  const { sdk, calls } = fixture({ rows: { task: [{ sys_id: ID, sys_class_name: { value: 'incident', display_value: 'Incident' }, number: 'INC0010001' }] } });
  const data = await findRecord(sdk, { sysId: ID });
  assert.equal(data.table, 'incident');
  assert.equal(data.display_value, 'INC0010001');
  assert.equal(data.found_in, 'task');
  assert.deepEqual(calls.map(call => call.table), ['sys_metadata', 'task']);
  assert.equal(calls.some(call => call.script), false);
});

test('other tables are searched by a bounded background script that reads only', async () => {
  const { sdk, calls } = fixture({ script: printed({ found: { table: 'sys_user_grmember', base: 'sys_user_grmember', display: 'Abel Tuter' }, tried: 2900, left: 3167, skipped: 99, last: 'sys_user_grmember' }) });
  const data = await findRecord(sdk, { sysId: ID.toUpperCase(), maxTables: 4000, timeLimit: 45 });
  assert.equal(data.sys_id, ID);
  assert.equal(data.found, true);
  assert.equal(data.table, 'sys_user_grmember');
  assert.equal(data.display_value, 'Abel Tuter');
  assert.equal(data.method, 'background_script');
  assert.deepEqual(data.search, { complete: true, tables_tried: 2900, base_tables: 3167, skipped_tables: 99, stopped_by: null, failed_tables: 0, background_scripts: 1, errors: [] });
  const run = calls.find(call => call.script);
  assert.equal(run.scope, 'global');
  // A slice runs at most 20 seconds; the client waits 30 seconds past that, and its timeout arms the cancel.
  assert.equal(run.opts.timeout, 50000);
  // It writes nothing, so no rollback context is recorded (access-analyzer check does the same).
  assert.equal(run.opts.rollback, false);
  assert.match(run.script, new RegExp(`var id = '${ID}'`));
  assert.match(run.script, /maxTables = 4000/);
  assert.match(run.script, /getTime\(\) \+ 20000/);
  // A slice left with less time than one query takes still reads one table, so it is never "no progress".
  assert.match(run.script, /\(first \|\| new Date\(\)\.getTime\(\) < deadline\)/);
  assert.match(run.script, /addNullQuery\('super_class'\)/);
  assert.doesNotMatch(run.script, /addQuery\('name'/);
  // Tables keyed on another field are left out: get() would ignore sys_id there and print a stack trace per table.
  assert.match(run.script, /addJoinQuery\('sys_dictionary', 'name', 'name'\)\.addCondition\('element', 'sys_id'\)/);
  // get() can answer with a row whose sys_id differs (pa_scores_l1 did on a PDI); only the exact sys_id counts.
  assert.match(run.script, /gr\.get\('sys_id', id\) && gr\.getUniqueValue\(\) == id/);
  // Remote (scripted) and virtual tables run code or compute rows, so they are skipped.
  assert.match(run.script, /scriptable_table/);
  assert.match(run.script, /provider_class/);
  assert.doesNotMatch(run.script, /\.(insert|update|deleteRecord|deleteMultiple|updateMultiple|setValue)\(/);
  assert.match(formatFind(data), /background script/);
});

test('each slice resumes after the last table the one before it read', async () => {
  const { sdk, calls } = fixture({ script: [printed({ tried: 900, left: 3167, skipped: 10, last: 'cmdb_ci', more: true }), printed({ tried: 2100, left: 2200, skipped: 89, last: 'x_tbl' })] });
  const data = await findRecord(sdk, { sysId: ID, maxTables: 5000 });
  const runs = calls.filter(call => call.script);
  assert.equal(runs.length, 2);
  assert.match(runs[1].script, /addQuery\('name', '>', 'cmdb_ci'\)/);
  assert.match(runs[1].script, /maxTables = 4100/);
  assert.equal(data.found, false);
  assert.deepEqual(data.search, { complete: true, tables_tried: 3000, base_tables: 3167, skipped_tables: 99, stopped_by: null, failed_tables: 0, background_scripts: 2, errors: [] });
  assert.match(formatFind(data), /No record with sys_id/);

  const stuck = fixture({ script: [printed({ tried: 1, left: 9, last: 'b', more: true }), printed({ tried: 1, left: 8, last: 'b', more: true })] });
  await assert.rejects(findRecord(stuck.sdk, { sysId: ID }), /no progress/);
  // The instance orders names by its own collation (password_policy before pa_active_jobs on a PDI), not JavaScript's.
  const collation = fixture({ script: [printed({ tried: 1, left: 9, last: 'password_policy', more: true }), printed({ tried: 1, left: 8, last: 'pa_active_jobs', more: true }), printed({ tried: 1, left: 7, last: 'pa_cached_scores' })] });
  assert.equal((await findRecord(collation.sdk, { sysId: ID })).search.background_scripts, 3);
});

test('a cap is reported as not found within the bound, never as absent', async () => {
  const tables = fixture({ script: [printed({ tried: 5, left: 3167, last: 'alm_asset', more: true })] });
  const capped = await findRecord(tables.sdk, { sysId: ID, maxTables: 5 });
  assert.equal(tables.calls.filter(call => call.script).length, 1);
  assert.equal(capped.search.stopped_by, 'tables');
  assert.match(formatFind(capped), /--max-tables/);

  const clock = [0, 0, 61000];
  const timed = fixture({ script: [printed({ tried: 1200, left: 3167, skipped: 40, last: 'cmdb_ci', more: true })] });
  const data = await findRecord(timed.sdk, { sysId: ID, timeLimit: 60 }, { now: () => clock.shift() ?? 61000 });
  assert.equal(data.found, false);
  assert.equal(data.search.complete, false);
  assert.equal(data.search.stopped_by, 'time');
  const text = formatFind(data);
  assert.match(text, /not found within the bound/i);
  assert.match(text, /--time-limit/);
  assert.doesNotMatch(text, /No record with sys_id/);
});

test('a finished search with no match says so, and a table that failed makes it incomplete', async () => {
  const done = fixture({ script: printed({ tried: 3068, left: 3167, skipped: 99 }) });
  const data = await findRecord(done.sdk, { sysId: ID });
  assert.equal(data.found, false);
  assert.equal(data.search.complete, true);
  assert.match(formatFind(data), /No record with sys_id/);

  const failed = fixture({ script: printed({ tried: 3068, left: 3167, skipped: 99, failed: 1, errors: [{ table: 'u_broken', message: 'boom' }] }) });
  const partial = await findRecord(failed.sdk, { sysId: ID });
  assert.equal(partial.search.complete, false);
  assert.match(formatFind(partial), /u_broken/);
  assert.doesNotMatch(formatFind(partial), /No record with sys_id/);
});

test('missing, unparseable or malformed script output is an error, not "not found"', async () => {
  for (const script of ['', 'JSN_RECORDS_FIND:{not json', printed({ tried: 'x' }), printed({ more: 'yes' }), printed({ last: "x' + gs.x + '" }), printed({ found: { table: 'bad table!' } })]) {
    const { sdk } = fixture({ script });
    await assert.rejects(findRecord(sdk, { sysId: ID }), /printed (no|a malformed) search result|not valid JSON/);
  }
});

test('a failed script keeps what the Table API proved and the original error code', async () => {
  const denied = Object.assign(new Error('Not authorized to access scripts page.'), { code: 'forbidden' });
  const { sdk } = fixture({ scriptError: denied });
  await assert.rejects(findRecord(sdk, { sysId: ID }), error => error.code === 'forbidden'
    && /returned no sys_metadata or task row with sys_id \w+ that this user can read; /.test(error.message) && /Not authorized/.test(error.message));
});

test('a denied or malformed Table API read is never reported as a miss', async () => {
  const forbidden = Object.assign(new Error('Access forbidden (HTTP 403).'), { code: 'forbidden', status: 403 });
  const denied = fixture({ rows: { sys_metadata: forbidden } });
  await assert.rejects(findRecord(denied.sdk, { sysId: ID }), /forbidden/);
  assert.equal(denied.calls.some(call => call.script), false);

  const other = fixture({ rows: { task: [{ sys_id: 'f'.repeat(32), sys_class_name: 'incident' }] } });
  await assert.rejects(findRecord(other.sdk, { sysId: ID }), /another sys_id/);
  const junk = fixture({ rows: { sys_metadata: ['row'] } });
  await assert.rejects(findRecord(junk.sdk, { sysId: ID }), /Malformed/);
});

test('invalid input sends nothing', async () => {
  for (const [sysId, opts] of [['abc', {}], [`${ID}^ORsys_id!=x`, {}], ['g'.repeat(32), {}], [undefined, {}],
    [ID, { maxTables: 0 }], [ID, { maxTables: 20001 }], [ID, { maxTables: 1.5 }], [ID, { timeLimit: 0 }], [ID, { timeLimit: 601 }]]) {
    const { sdk, calls } = fixture();
    await assert.rejects(findRecord(sdk, { sysId, ...opts }), /sys_id|--max-tables|--time-limit/);
    assert.equal(calls.length, 0);
  }
});

// The scripts write no records, but they run arbitrary server-side code as jsn eval does, so read-only profiles refuse
// find as they refuse eval; it needs no capture context, because nothing it does is captured in an update set.
test('a read-only profile refuses records find before any request', async t => {
  assert.equal(isMutationCommand({ _: ['records', 'find', ID] }), true);
  assert.equal(needsMutationContext({ _: ['records', 'find', ID] }), false);
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-records-find-'));
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"result":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const configDir = path.join(directory, 'config');
  await fs.mkdir(path.join(configDir, 'servicenow'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: directory, XDG_CONFIG_HOME: configDir, XDG_CACHE_HOME: path.join(directory, 'cache'), JSN_DATA_HOME: path.join(directory, 'data'), JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'synthetic-fixture-only' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const refused = await promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'records', 'find', ID, '--json'], { cwd: directory, env, timeout: 20000 }).then(() => null, error => error);
  assert.ok(refused, 'records find exits nonzero on a read-only profile');
  assert.equal(JSON.parse(refused.stdout).code, 'read_only');
  assert.deepEqual(requests, []);
});

test('records find reports a miss and exits nonzero', async () => {
  const commands = {};
  const y = { command(def) { commands[def.command] = def; return y; } };
  recordsCmd(fn => fn).builder(y);
  const find = commands['find <sys_id>'];
  assert.ok(find, 'records find is registered');
  const { sdk } = fixture({ script: printed({ tried: 10, left: 10 }) });
  const out = [];
  const before = process.exitCode;
  await find.handler({ sys_id: ID, maxTables: 10000, timeLimit: 120 }, { sdk, requireInstance() {}, ok: (data, meta) => out.push({ data, meta }) });
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
  assert.equal(out[0].data.found, false);
  // Skipped tables and tables with no sys_id field are never searched, so a complete miss names what was searched.
  assert.equal(out[0].meta.summary, 'Not found in sys_metadata, task or the 10 base tables searched');
});
