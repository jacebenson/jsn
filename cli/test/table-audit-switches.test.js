import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { withTableAudit } from '../src/commands/table-audit.js';
import { yargs } from '../src/cli-adapter.js';
import { tablesCmd } from '../src/commands/_simple.js';
import { rankedDiscoveries } from '../src/commands/discover.js';
import { isMutationCommand } from '../src/mutations.js';
import { needsMutationContext } from '../src/mutation-context.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = character => character.repeat(32);
const NO_AUDIT = id('7');
const NO_AUDIT_DELETE = id('8');
let next = 0;
const row = (name, element, extra = {}) => ({ sys_id: (++next).toString(16).padStart(32, '0'), name, element, internal_type: element ? 'string' : 'collection', audit: 'false', attributes: '', ...extra });
const hierarchy = (...names) => params => {
  const query = params.get('sysparm_query');
  const index = names.findIndex((name, i) => query === `name=${name}` || query === `sys_id=${id(String.fromCharCode(97 + i))}`);
  return index < 0 ? [] : [{ sys_id: id(String.fromCharCode(97 + index)), name: names[index], label: names[index], super_class: names[index + 1] ? { value: id(String.fromCharCode(98 + index)), display_value: names[index + 1] } : '' }];
};

function world(dictionary) {
  return {
    sys_db_object: hierarchy('x_case', 'x_task'),
    sys_schema_attribute: [{ sys_id: NO_AUDIT, name: 'no_audit' }, { sys_id: NO_AUDIT_DELETE, name: 'no_audit_delete' }],
    sys_schema_attribute_m2m: [],
    sys_dictionary: dictionary || [row('x_case', '', { audit: 'true' }), row('x_task', ''), row('x_case', 'priority'), row('x_task', 'short_description')],
    sys_properties: [{ name: 'glide.sys.audit_inserts', value: 'false' }],
  };
}

// Writes change what the next read sees; `sync` plays a platform that rebuilds attribute rows from the string.
function stateSdk(tables, { sync = false, failCreate = false, ignoreUpdate = false, dropCreate = false, looseQuery = false } = {}) {
  const writes = [];
  const reads = [];
  const ids = { no_audit: NO_AUDIT, no_audit_delete: NO_AUDIT_DELETE };
  return { writes, reads,
    async listStrict(table, params) {
      reads.push({ table, query: params.get('sysparm_query') });
      const value = tables[table];
      if (typeof value === 'function') return value(params);
      const one = params.get('sysparm_query').match(/^schema=(\w+)\^attribute=(\w+)$/);
      return one && !looseQuery ? value.filter(link => link.schema === one[1] && link.attribute === one[2]) : value;
    },
    async get(table, sysId) { return { sys_id: sysId, sys_scope: 'global' }; },
    async update(table, sysId, data) {
      writes.push({ method: 'update', table, sysId, data });
      if (ignoreUpdate) return {};
      const target = tables[table].find(item => item.sys_id === sysId);
      Object.assign(target, data);
      if (sync && data.attributes !== undefined) {
        for (const [name, attribute] of Object.entries(ids)) {
          tables.sys_schema_attribute_m2m = tables.sys_schema_attribute_m2m.filter(link => !(link.schema === sysId && link.attribute === attribute));
          if (data.attributes.split(',').some(part => part.split('=')[0].trim() === name)) tables.sys_schema_attribute_m2m.push({ sys_id: (++next).toString(16).padStart(32, 'e'), schema: sysId, attribute, value: 'true' });
        }
      }
      return target;
    },
    async create(table, data) {
      writes.push({ method: 'create', table, data });
      if (failCreate) throw new Error('create denied');
      const created = { sys_id: (++next).toString(16).padStart(32, 'c'), ...data };
      if (!dropCreate) tables[table].push(created);
      return created;
    },
    async delete(table, sysId) {
      writes.push({ method: 'delete', table, sysId });
      tables[table] = tables[table].filter(item => item.sys_id !== sysId);
    },
  };
}

const command = withTableAudit({ builder: y => y }, fn => fn);
let def;
command.builder({ command(value) { def = value; return this; } });
async function run(sdk, argv, app = {}) {
  const out = {};
  await def.handler({ _: ['tables', 'audit'], table: 'x_case', yes: false, ...argv }, { sdk, requireInstance() {}, output: { getFormat: () => 'json' }, ok(data, meta) { Object.assign(out, { data, meta }); }, ...app });
  return out;
}
const exitCode = process.exitCode;
afterEach(() => { process.exitCode = exitCode; });

test('a switch makes tables audit a mutation: read-only profiles and capture context apply', () => {
  tablesCmd(fn => fn);
  const argv = extra => ({ _: ['tables', 'audit', 'x_case'], ...extra });
  for (const extra of [{ on: true }, { off: true }, { exclude: 'priority' }, { include: 'priority' }, { deletes: 'off' }]) {
    assert.equal(isMutationCommand(argv(extra)), true, JSON.stringify(extra));
    assert.equal(needsMutationContext(argv(extra)), true, JSON.stringify(extra));
  }
  for (const extra of [{}, { field: 'priority' }, { on: false }, { yes: true }]) assert.equal(isMutationCommand(argv(extra)), false, JSON.stringify(extra));
  assert.equal(isMutationCommand({ _: ['tables', 'create'] }), true, 'the declared mutation subcommands still apply');
});

test('previews by default and writes nothing until --yes', async () => {
  const tables = world();
  const sdk = stateSdk(tables);
  const own = tables.sys_dictionary[0];
  const { data, meta } = await run(sdk, { off: true });
  assert.equal(sdk.writes.length, 0);
  assert.equal(data.dry_run, true);
  assert.deepEqual(data.set, { audit: 'false' });
  assert.equal(data.target.sys_id, own.sys_id);
  assert.equal(data.rerun, 'jsn tables audit x_case --off --yes');
  assert.equal(meta.summary, 'Dry run: would turn table auditing off for x_case');
  assert.equal((await run(sdk, { exclude: 'priority' })).data.rerun, 'jsn tables audit x_case --exclude priority --yes');
  assert.equal(sdk.writes.length, 0);
});

test('rejected input writes nothing, and bad switches read nothing either', async () => {
  for (const argv of [{ on: true, off: true }, { off: true, exclude: 'priority' }, { exclude: 'a^b' }, { include: '' }, { deletes: 'maybe' }]) {
    const sdk = stateSdk(world());
    await assert.rejects(run(sdk, { ...argv, yes: true }), undefined, JSON.stringify(argv));
    assert.equal(sdk.reads.length + sdk.writes.length, 0, JSON.stringify(argv));
  }
  const inherited = stateSdk(world());
  await assert.rejects(run(inherited, { exclude: 'short_description', yes: true }), error => error.message === 'short_description is defined on x_task; changing it there changes every table that extends x_task. No change was made.' && /jsn tables audit x_task --exclude short_description/.test(error.hint));
  const unknown = stateSdk(world());
  await assert.rejects(run(unknown, { include: 'nope', yes: true }), /Field nope was not found on x_case or its parents/);
  assert.equal(inherited.writes.length + unknown.writes.length, 0);
});

test('a state already in place writes nothing, even with --yes', async () => {
  const sdk = stateSdk(world());
  assert.equal((await run(sdk, { on: true, yes: true })).meta.summary, 'No change: Table auditing is already on for x_case.');
  assert.equal((await run(sdk, { include: 'priority', yes: true })).data.already, 'x_case.priority does not carry no_audit.');
  assert.equal((await run(sdk, { deletes: 'on', yes: true })).data.already, 'x_case does not carry no_audit_delete.');
  assert.equal(sdk.writes.length, 0);
});

test('--off writes the collection row\'s Audit tick and the re-read confirms it', async () => {
  const tables = world();
  const sdk = stateSdk(tables);
  const { data, meta } = await run(sdk, { off: true, yes: true });
  assert.deepEqual(sdk.writes, [{ method: 'update', table: 'sys_dictionary', sysId: tables.sys_dictionary[0].sys_id, data: { audit: 'false' } }]);
  assert.equal(data.verified, true);
  assert.equal(data.status.audited, false);
  assert.equal(meta.summary, 'Done: turn table auditing off for x_case; the re-read status agrees');
  assert.equal(process.exitCode, exitCode);
});

test('--exclude adds no_audit to the string, then the attribute row, keeping other attributes', async () => {
  const tables = world();
  const priority = tables.sys_dictionary[2];
  priority.attributes = 'ref_qual=a=b';
  // Another field's no_audit row must not count as this field's.
  Object.assign(tables.sys_dictionary[3], { attributes: 'no_audit=true' });
  tables.sys_schema_attribute_m2m.push({ sys_id: id('e'), schema: tables.sys_dictionary[3].sys_id, attribute: NO_AUDIT, value: 'true' });
  const sdk = stateSdk(tables);
  const { data } = await run(sdk, { exclude: 'priority', yes: true, field: 'priority' });
  assert.deepEqual(sdk.writes, [
    { method: 'update', table: 'sys_dictionary', sysId: priority.sys_id, data: { attributes: 'ref_qual=a=b,no_audit=true' } },
    { method: 'create', table: 'sys_schema_attribute_m2m', data: { schema: priority.sys_id, attribute: NO_AUDIT, value: 'true' } },
  ]);
  assert.equal(data.verified, true);
  assert.equal(data.status.field.audited, false);
  assert.deepEqual(data.status.attribute_rows.disagreements, []);
});

test('a platform that syncs attribute rows itself gets no second row', async () => {
  const tables = world();
  const sdk = stateSdk(tables, { sync: true });
  const { data } = await run(sdk, { exclude: 'priority', yes: true });
  assert.deepEqual(sdk.writes.map(write => write.method), ['update']);
  assert.equal(tables.sys_schema_attribute_m2m.length, 1);
  assert.equal(data.verified, true);
});

test('--include removes no_audit and its attribute row; in whitelist mode it adds audit=true to the string only', async () => {
  const tables = world();
  const priority = tables.sys_dictionary[2];
  priority.attributes = 'no_audit=true';
  tables.sys_schema_attribute_m2m.push({ sys_id: id('d'), schema: priority.sys_id, attribute: NO_AUDIT, value: 'true' });
  const sdk = stateSdk(tables);
  assert.equal((await run(sdk, { include: 'priority', yes: true })).data.verified, true);
  assert.deepEqual(sdk.writes, [
    { method: 'update', table: 'sys_dictionary', sysId: priority.sys_id, data: { attributes: '' } },
    { method: 'delete', table: 'sys_schema_attribute_m2m', sysId: id('d') },
  ]);
  const whitelist = world([row('x_case', '', { audit: 'true', attributes: 'audit_type=whitelist' }), row('x_task', ''), row('x_case', 'priority')]);
  const listed = stateSdk(whitelist);
  const { data } = await run(listed, { include: 'priority', yes: true, field: 'priority' });
  assert.deepEqual(listed.writes, [{ method: 'update', table: 'sys_dictionary', sysId: whitelist.sys_dictionary[2].sys_id, data: { attributes: 'audit=true' } }]);
  assert.equal(data.status.field.audited, true);
  const excluded = await run(stateSdk(whitelist), { exclude: 'priority' });
  assert.deepEqual(excluded.data.set, { attributes: '' }, 'whitelist exclude removes audit=true');
});

test('--deletes off adds no_audit_delete to the collection row and its attribute row', async () => {
  const tables = world();
  const own = tables.sys_dictionary[0];
  const sdk = stateSdk(tables);
  const { data } = await run(sdk, { deletes: 'off', yes: true });
  assert.deepEqual(sdk.writes, [
    { method: 'update', table: 'sys_dictionary', sysId: own.sys_id, data: { attributes: 'no_audit_delete=true' } },
    { method: 'create', table: 'sys_schema_attribute_m2m', data: { schema: own.sys_id, attribute: NO_AUDIT_DELETE, value: 'true' } },
  ]);
  assert.equal(data.verified, true);
  assert.equal(data.status.deletes.recorded, false);
});

test('a failed write or a re-read that disagrees is reported and exits nonzero', async () => {
  const failed = await run(stateSdk(world(), { failCreate: true }), { exclude: 'priority', yes: true });
  assert.equal(failed.data.verified, false);
  assert.equal(failed.data.error, 'create denied');
  assert.deepEqual(failed.data.written.map(write => write.action), ['update']);
  assert.match(failed.meta.summary, /^Change incomplete or unverified: 1 write\(s\); failed: create denied/);
  assert.equal(process.exitCode, 1);
  process.exitCode = exitCode;
  const ignored = await run(stateSdk(world(), { ignoreUpdate: true }), { off: true, yes: true });
  assert.equal(ignored.data.verified, false);
  assert.equal(ignored.data.status.audited, true);
  assert.equal(process.exitCode, 1);
  // A create that reports success but stores nothing leaves the string and the attribute rows disagreeing.
  const dropped = await run(stateSdk(world(), { dropCreate: true }), { exclude: 'priority', yes: true });
  assert.equal(dropped.data.error, undefined);
  assert.equal(dropped.data.verified, false);
  // With no attribute row to compare, the string alone decides.
  const unchanged = await run(stateSdk({ ...world(), sys_schema_attribute: [] }, { ignoreUpdate: true }), { exclude: 'priority', yes: true });
  assert.deepEqual(unchanged.data.written.map(write => write.action), ['update']);
  assert.equal(unchanged.data.verified, false);
});

test('attribute rows for another record are never deleted', async () => {
  const tables = world();
  const [, other, priority] = tables.sys_dictionary;
  Object.assign(priority, { attributes: 'no_audit=true' });
  Object.assign(other, { attributes: 'no_audit_delete=true' });
  tables.sys_schema_attribute_m2m.push({ sys_id: id('d'), schema: priority.sys_id, attribute: NO_AUDIT, value: 'true' }, { sys_id: id('e'), schema: other.sys_id, attribute: NO_AUDIT_DELETE, value: 'true' });
  const sdk = stateSdk(tables, { looseQuery: true });
  const { data } = await run(sdk, { include: 'priority', yes: true });
  assert.deepEqual(sdk.writes.map(write => write.method), ['update']);
  assert.equal(tables.sys_schema_attribute_m2m.length, 2);
  assert.match(data.error, /another record or attribute/);
  assert.equal(data.verified, false);
});

test('--deletes says when another rule still decides whether deletes are recorded', async () => {
  const ignored = [{ name: 'glide.sys.audit_inserts', value: 'false' }, { name: 'glide.db.audit.ignore.delete', value: 'x_case' }];
  const tables = { ...world(), sys_properties: ignored };
  tables.sys_dictionary[0].attributes = 'no_audit_delete=true';
  const done = await run(stateSdk(tables), { deletes: 'on', yes: true });
  assert.equal(done.data.verified, true);
  assert.match(done.meta.summary, /^Done: remove no_audit_delete from x_case; the re-read status agrees; deletes are still not recorded: x_case is listed in glide\.db\.audit\.ignore\.delete/);
  const already = await run(stateSdk({ ...world(), sys_properties: ignored }), { deletes: 'on', yes: true });
  assert.match(already.meta.summary, /^No change: x_case does not carry no_audit_delete\.; deletes are still not recorded: /);
  const plain = await run(stateSdk(world()), { deletes: 'off' });
  assert.doesNotMatch(plain.meta.summary, /still/);
});

test('each switch has its own discovery task', () => {
  const registry = yargs().option('json', { type: 'boolean' }).command(tablesCmd(fn => fn)).commandRegistry({ details: true });
  const first = query => rankedDiscoveries(registry, { query })[0]?.invocation;
  assert.equal(first('turn off auditing'), 'jsn tables audit <table> --off');
  assert.equal(first('turn on auditing'), 'jsn tables audit <table> --on');
  assert.equal(first('stop auditing a field'), 'jsn tables audit <table> --exclude <field>');
  assert.equal(first('stop auditing deletes'), 'jsn tables audit <table> --deletes off');
  assert.equal(first('is this table audited'), 'jsn tables audit <table> --json');
});

test('a record outside the verified scope is refused before the first write', async () => {
  const sdk = stateSdk(world());
  const app = { mutationContext: { verified: true, application_id: id('9') } };
  await assert.rejects(run(sdk, { off: true, yes: true }, app), /scope is unknown or differs from verified intended scope/);
  assert.equal(sdk.writes.length, 0);
});

test('real CLI: a switch is refused on a read-only profile, and needs capture context on a write profile', async () => {
  const calls = [];
  const tables = world();
  // sys_db_object extends sys_metadata, so the capture-context guard treats a tables write as customization.
  const metadata = { sys_id: id('n'), name: 'sys_metadata', super_class: '' };
  tables.sys_db_object = params => params.get('sysparm_query') === 'name=sys_db_object' ? [{ sys_id: id('m'), name: 'sys_db_object', super_class: { value: metadata.sys_id } }] : hierarchy('x_case', 'x_task')(params);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    const [, api, , , table, sysId] = url.pathname.split('/');
    if (sysId) { res.end(JSON.stringify({ result: sysId === metadata.sys_id ? metadata : null })); return; }
    if (api !== 'api' || !tables[table]) { res.end(JSON.stringify({ result: [] })); return; }
    stateSdk(tables).listStrict(table, url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-table-audit-switches-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  const profile = readOnly => ({ instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: readOnly });
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'reader', profiles: { reader: profile(true), writer: profile(false) } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const jsn = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  const refusal = async args => { try { await jsn(args); } catch (error) { return JSON.parse(error.stdout || error.stderr); } assert.fail(`expected ${args.join(' ')} to fail`); };
  try {
    const readOnly = await refusal(['tables', 'audit', 'x_case', '--off', '--yes', '--json']);
    assert.equal(readOnly.code, 'read_only');
    assert.equal(calls.length, 0, 'the read-only refusal comes before any request');
    assert.equal(JSON.parse((await jsn(['tables', 'audit', 'x_case', '--get', 'data.audited'])).stdout), true, 'a plain read still works on a read-only profile');
    const writer = await refusal(['--profile', 'writer', 'tables', 'audit', 'x_case', '--exclude', 'priority', '--json']);
    assert.equal(writer.error, 'Noninteractive customization writes require intended scope and update set.', JSON.stringify(writer));
    // POSTs to /angular.do are the session login; no table record is written.
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/')).every(call => call.method === 'GET'), JSON.stringify(calls));
    assert.match((await jsn(['tables', 'audit', '--help'])).stdout, /One switch per run, previewed unless --yes/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
