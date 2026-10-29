import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRecord } from '../src/resolve-record.js';
import { listRecords, updateRecord, deleteRecord } from '../src/records-engine.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
function memorySdk(rows, calls = []) {
  return { list: async (table, params) => {
    calls.push({ table, params: Object.fromEntries(params) });
    const query = params.get('sysparm_query');
    const [, field, op, value] = query.match(/^(\w+)(STARTSWITH|ENDSWITH|=)(.*)$/);
    return rows.filter(row => op === '=' ? row[field] === value : op === 'STARTSWITH'
      ? row[field]?.startsWith(value) : row[field]?.endsWith(value)).slice(0, Number(params.get('sysparm_limit')));
  } };
}
test('resolver preserves exact human precedence, supports legacy ids and disambiguates collisions', async () => {
  const rows = [{ sys_id: 'legacy-id', name: 'Other' }, { sys_id: 'other-id', name: 'legacy-id' }];
  const sdk = memorySdk(rows);
  assert.equal((await resolveRecord(sdk, { table: 'x_custom', identifier: 'legacy-id', matchField: 'name' })).sys_id, 'other-id');
  assert.equal((await resolveRecord(sdk, { table: 'x_custom', identifier: 'legacy-id', identifierField: 'sys_id' })).sys_id, 'legacy-id');
  assert.equal((await resolveRecord(sdk, { table: 'x_custom', identifier: 'legacy-id', matchField: 'number' })).sys_id, 'legacy-id');
});
test('exact, prefix and suffix lookups are bounded and never pick ambiguous or missing records', async () => {
  const rows = [{ sys_id: 'prefix-one-tail' }, { sys_id: 'prefix-two-other' }];
  const calls = [];
  const sdk = memorySdk(rows, calls);
  await assert.rejects(resolveRecord(sdk, { table: 'x_custom', identifier: 'prefix' }), error => {
    assert.equal(error.code, 'ambiguous'); assert.equal(error.resolution.mode, 'prefix');
    assert.equal(error.resolution.matches, 2); assert.equal(error.resolution.at_least, true); return true;
  });
  assert.equal((await resolveRecord(sdk, { table: 'x_custom', identifier: '-tail' })).sys_id, 'prefix-one-tail');
  await assert.rejects(resolveRecord(sdk, { table: 'x_custom', identifier: 'absent' }), error => {
    assert.equal(error.code, 'not_found'); assert.equal(error.resolution.mode, 'suffix');
    assert.equal(error.resolution.matches, 0); assert.equal(error.resolution.attempts.length, 3); return true;
  });
  await assert.rejects(resolveRecord(memorySdk([{ sys_id: 'same' }, { sys_id: 'same' }]), { table: 'x_custom', identifier: 'same' }), error => error.code === 'ambiguous' && error.resolution.mode === 'exact');
  assert.ok(calls.every(call => call.params.sysparm_limit === '2'));
});
test('display-only sys_id wrappers cannot become mutation destinations', async () => {
  let writes = 0;
  const sdk = { list: async () => [{ sys_id: { display_value: 'not-a-raw-id' } }],
    update: async () => { writes++; }, delete: async () => { writes++; } };
  await assert.rejects(updateRecord(sdk, { table: 'x_custom', identifier: 'Named', data: {} }), /no readable sys_id/);
  await assert.rejects(deleteRecord(sdk, { table: 'x_custom', identifier: 'Named' }), /no readable sys_id/);
  assert.equal(writes, 0);
});
test('explicit human fields do not fall back to partial ids and validation precedes reads', async () => {
  const calls = [], sdk = memorySdk([{ sys_id: 'has-fragment' }], calls);
  await assert.rejects(resolveRecord(sdk, { table: 'x_custom', identifier: 'fragment', identifierField: 'number' }), error => error.code === 'not_found');
  assert.equal(calls.length, 1);
  for (const opts of [{ table: 'x^ORbad' }, { identifierField: 'name^ORbad' }, { identifier: 'x^OR1=1' }]) {
    await assert.rejects(resolveRecord(sdk, { table: 'x_custom', identifier: 'safe', ...opts }));
  }
  assert.equal(calls.length, 1);
});
test('CRUD transport shares bounded resolution and retains raw reference values', async () => {
  const calls = [], sdk = memorySdk([{ sys_id: 'full-legacy', name: 'Named' }], calls);
  const writes = [];
  sdk.update = async (table, id, data) => { writes.push(['update', table, id, data]); return data; };
  sdk.delete = async (table, id) => writes.push(['delete', table, id]);
  await updateRecord(sdk, { table: 'x_custom', identifier: 'legacy', data: { active: true } });
  await deleteRecord(sdk, { table: 'x_custom', identifier: 'full-' });
  assert.deepEqual(writes, [['update', 'x_custom', 'full-legacy', { active: true }], ['delete', 'x_custom', 'full-legacy']]);
  await assert.rejects(updateRecord(sdk, { table: 'x_custom', identifier: 'missing', data: {} }));
  assert.equal(writes.length, 2);
  const parameters = new URLSearchParams({ sysparm_query: 'name=Named' });
  await listRecords(sdk, { table: 'x_custom', params: parameters, displayValues: 'both' });
  assert.equal(calls.at(-1).params.sysparm_display_value, 'all');
  assert.equal(parameters.has('sysparm_display_value'), false);
});

test('real CLI resolves generic/ticket/factory reads and writes without subprocess dispatch or unsafe targets', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn records engine '));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const rows = [{ sys_id: 'legacy-target', number: 'INC001', name: 'Named', short_description: 'Fixture',
    assigned_to: { value: 'raw-user', display_value: 'Display User' } },
  { sys_id: 'legacy-second', number: 'INC002', name: 'Second' }];
  const requests = [], writes = [];
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push({ method: req.method, url });
    const parts = url.pathname.split('/');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') { res.end('{}'); return; }
    if (req.method !== 'GET') {
      let body = ''; for await (const chunk of req) body += chunk;
      writes.push({ method: req.method, id: parts[5], data: body ? JSON.parse(body) : null });
      res.end(JSON.stringify({ result: { ...rows[0], ...(body ? JSON.parse(body) : {}) } })); return;
    }
    let found;
    if (parts[5]) found = rows.find(row => row.sys_id === parts[5]);
    else {
      const query = url.searchParams.get('sysparm_query') || '';
      const match = query.match(/^(\w+)(STARTSWITH|ENDSWITH|=)([^^]*)/);
      found = match ? rows.filter(row => match[2] === '=' ? row[match[1]] === match[3]
        : match[2] === 'STARTSWITH' ? row[match[1]]?.startsWith(match[3]) : row[match[1]]?.endsWith(match[3])) : rows;
      found = found.slice(0, Number(url.searchParams.get('sysparm_limit') || 20));
    }
    const mode = url.searchParams.get('sysparm_display_value');
    const convert = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value && typeof value === 'object' ? mode === 'all' ? value : mode === 'true' ? value.display_value : value.value : value]));
    res.end(JSON.stringify({ result: Array.isArray(found) ? found.map(convert) : convert(found) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(directory, 'servicenow'));
  await fs.writeFile(path.join(directory, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'other', profiles: {
    selected: { instance_url: instance, auth_method: 'basic', username: 'fixture', include_counts: false },
    other: { instance_url: 'http://example.invalid', auth_method: 'basic' },
    readonly: { instance_url: instance, auth_method: 'basic', read_only: true },
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '', SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  async function run(args, code = 0, profile = 'selected') {
    let result;
    try { result = { ...await execute(process.execPath, [cli, '--profile', profile, ...args, '--json'], { cwd: directory, env, timeout: 15000 }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes('fixture-secret'));
    return JSON.parse(result.stdout);
  }
  const base = ['records', 'get', '--table', 'x_custom', '--sys-id', 'legacy-target'];
  const before = requests.length;
  assert.equal((await run(base)).data.assigned_to, 'Display User');
  assert.equal(requests.slice(before).filter(r => r.url.pathname === '/api/now/table/x_custom').length, 1, 'generic exact get reuses its lookup result');
  assert.equal((await run([...base, '--display-values', 'raw'])).data.assigned_to, 'raw-user');
  assert.deepEqual((await run([...base, '--display-values', 'both'])).data.assigned_to, rows[0].assigned_to);
  assert.equal((await run(['records', 'get', '--table', 'incident', '--identifier', 'INC001', '--identifier-field', 'number'])).data.sys_id, 'legacy-target');
  assert.equal((await run(['incidents', 'show', 'INC001'])).data.assigned_to.value, 'raw-user');
  assert.equal((await run(['includes', 'show', 'Named'])).data.sys_id, 'legacy-target');
  const ambiguous = await run(['records', 'update', '--table', 'x_custom', '--sys-id', 'legacy-', '-f', 'short_description=Changed'], 1);
  assert.equal(ambiguous.code, 'ambiguous'); assert.equal(ambiguous.resolution.mode, 'prefix'); assert.equal(writes.length, 0);
  const absent = await run(['records', 'get', '--table', 'x_custom', '--sys-id', 'absent'], 1);
  assert.equal(absent.code, 'not_found'); assert.equal(absent.resolution.matches, 0);
  await run(['records', 'update', '--table', 'x_custom', '--sys-id', 'target', '-f', 'short_description=Changed']);
  assert.equal(writes.at(-1).id, 'legacy-target');
  await run(['incidents', 'update', 'INC001', '-f', 'short_description=Ticket']);
  assert.equal(writes.at(-1).id, 'legacy-target');
  const n = writes.length;
  await run(['records', 'delete', '--table', 'x_custom', '--sys-id', 'target'], 1);
  assert.equal(writes.length, n, 'unapproved delete cannot write');
  await run(['records', 'delete', '--table', 'x_custom', '--sys-id', 'target', '--force']);
  assert.equal(writes.at(-1).id, 'legacy-target');
  const count = requests.length;
  await run(['records', 'update', '--table', 'x_custom', '--sys-id', 'target', '-f', 'short_description=Blocked'], 1, 'readonly');
  assert.equal(requests.length, count, 'read-only guard blocks before any lookup or mutation');
  assert.ok(requests.filter(r => !r.url.searchParams.has('sysparm_fields') && r.url.searchParams.has('sysparm_query') && /^(?:sys_id|number|name)(?:=|STARTSWITH|ENDSWITH)/.test(r.url.searchParams.get('sysparm_query')))
    .every(r => r.url.searchParams.get('sysparm_limit') === '2'));
});
