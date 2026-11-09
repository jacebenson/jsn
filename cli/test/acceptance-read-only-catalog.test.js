import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { catalog, scenarios } from './acceptance/read-only-catalog.mjs';
import { runProcess } from '../scripts/acceptance/support.mjs';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(fs.readFileSync(new URL('./acceptance/coverage.json', import.meta.url), 'utf8'));
const id = 'a'.repeat(32), otherId = 'b'.repeat(32);
const stamp = '2026-01-01 00:00:00';
function pair(name) { return scenarios.filter(s => s.id !== 'readonly.catalog.ticket-options' && s.commandPaths[0].startsWith(`${name} `)); }

// Synthetic OAuth only, isolated config, asynchronous real CLI subprocesses.
// ctx.read uses a separate direct Table API GET, not the command's parsed result.
async function fixture(t, behavior = 'normal') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-readonly-catalog-'));
  const requests = [], commands = [];
  let mutations = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/angular.do' && url.search === '?sysparm_type=get_user') {
      // Production OAuth bootstrap is allowed; it is not a record mutation.
      res.setHeader('x-usertoken-response', 'synthetic-session-token'); res.end('{}'); return;
    }
    if (req.method !== 'GET') { mutations++; res.statusCode = 405; res.end('{"error":{"message":"mutation refused"}}'); return; }
    if (url.pathname === '/api/now/table/sys_scope' && url.searchParams.get('sysparm_fields') === 'sys_id,sys_class_name') {
      res.end(JSON.stringify({ result: [{ sys_id: otherId, sys_class_name: 'sys_scope' }] })); return;
    }
    if (!url.pathname.startsWith('/api/now/table/')) { res.statusCode = 404; res.end('{"error":{"message":"unexpected endpoint"}}'); return; }
    if (behavior === 'acl') { res.statusCode = 403; res.end('{"error":{"message":"forbidden"}}'); return; }
    if (behavior === 'missing-table') { res.statusCode = 404; res.end('{"error":{"message":"invalid table"}}'); return; }
    if (behavior === 'malformed') { res.end('{"result":{"unexpected":true}}'); return; }
    const independent = url.pathname.endsWith(`/${id}`);
    let record = { sys_id: id, sys_updated_on: stamp, name: 'Synthetic fixture', when: 'async' };
    if (behavior === 'missing-fields') delete record.sys_updated_on;
    if (behavior === 'missing-identity') delete record.sys_id;
    if (behavior === 'mismatch' && independent) record.sys_updated_on = '2026-01-02 00:00:00';
    if (behavior === 'wrong-show' && url.searchParams.get('sysparm_limit') === '2') record.sys_id = otherId;
    const fields = url.searchParams.get('sysparm_fields')?.split(',');
    if (fields) record = Object.fromEntries(Object.entries(record).filter(([key]) => fields.includes(key)));
    const result = behavior === 'empty' ? [] : independent ? record : behavior === 'oversized' ? [record, { ...record, sys_id: otherId }] : [record];
    res.end(JSON.stringify({ result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(root, 'servicenow'));
  fs.writeFileSync(path.join(root, 'servicenow/config.json'), JSON.stringify({ profiles: { fixture: { instance_url: target, auth_method: 'oauth', read_only: true } } }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: path.join(root, 'cache'), JSN_DATA_HOME: path.join(root, 'data'),
    SERVICENOW_OAUTH_TOKEN: 'synthetic-loopback-token', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', CI: '1' };
  for (const key of Object.keys(env)) if (/PROXY|^NODE_OPTIONS$|^SN_|^SERVICENOW_/i.test(key) && key !== 'SERVICENOW_OAUTH_TOKEN') delete env[key];
  const ctx = { state: new Map(), mode: 'readonly', profile: 'fixture', expectedHost: target,
    async command(args) {
      assert.ok(catalog.some(f => f.name === args[0]));
      assert.ok(['list', 'show'].includes(args[1]));
      commands.push(args);
      return runProcess(process.execPath, [path.join(cliRoot, 'bin/jsn.js'), ...args, '--profile', 'fixture', '--instance', target], { cwd: cliRoot, env });
    },
    async read(table, { id: exactId, fields, limit }) {
      assert.match(table, /^[a-zA-Z_][a-zA-Z0-9_]*$/); assert.match(exactId, /^[a-f0-9]{32}$/); assert.equal(limit, 1);
      const url = new URL(`${target}/api/now/table/${table}/${exactId}`);
      url.search = new URLSearchParams({ sysparm_fields: fields.join(','), sysparm_limit: String(limit), sysparm_display_value: 'false' });
      const response = await fetch(url, { headers: { Authorization: 'Bearer synthetic-loopback-token' } });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    } };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { ctx, requests, commands, get mutations() { return mutations; } };
}

test('every canonical path, option and requirement binding resolves against inventory', () => {
  const entries = new Map(inventory.entries.map(e => [e.path, e]));
  assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
  assert.ok(catalog.length > 20);
  for (const scenario of scenarios) {
    assert.equal(scenario.mutates, false); assert.deepEqual(scenario.modes, ['readonly', 'pdi']);
    for (const source of scenario.sources) assert.ok(fs.existsSync(path.resolve(cliRoot, '..', source)));
    for (const commandPath of scenario.commandPaths) {
      const entry = entries.get(commandPath); assert.ok(entry, commandPath); assert.equal(entry.declaredMutation, false);
      const binding = scenario.coverageBindings[commandPath];
      for (const option of Array.isArray(binding.options) ? binding.options : Object.keys(binding.options)) assert.ok(entry.effectiveOptions.includes(option), option);
      for (const requirement of binding.requirements) assert.ok(entry.acceptance.requirements.includes(requirement), requirement);
    }
    for (const dependency of scenario.requires) assert.ok(scenarios.some(s => s.id === dependency));
  }
  for (const family of catalog) {
    const parent = entries.get(family.name);
    assert.equal(parent.discovery.table, family.table);
    assert.equal(parent.recordProfile.table, family.table);
  }
  assert.ok(!scenarios.some(s => s.commandPaths.includes('tables show')));
  assert.ok(!scenarios.some(s => s.commandPaths.includes('requests show')));
  assert.ok(!scenarios.some(s => s.commandPaths.some(p => p.startsWith('store '))));
});

test('all reviewed resource families execute real JSON/human list/show with independent bounded GETs', async t => {
  const f = await fixture(t);
  for (const family of catalog) await t.test(family.name, async () => {
    const start = f.requests.length;
    for (const scenario of pair(family.name)) await scenario.run(f.ctx);
    const batch = f.requests.slice(start);
    assert.ok(batch.every(r =>
      r.method === 'POST' && r.path === '/angular.do' && r.query.sysparm_type === 'get_user' ||
      r.method === 'GET' && r.path === '/api/now/table/sys_scope' && r.query.sysparm_fields === 'sys_id,sys_class_name' && r.query.sysparm_limit === '1' ||
      r.method === 'GET' && [ `/api/now/table/${family.table}`, `/api/now/table/${family.table}/${id}` ].includes(r.path)));
    const requests = batch.filter(r => r.path.startsWith(`/api/now/table/${family.table}`));
    assert.equal(requests.length, family.show ? 6 : 3);
    assert.ok(requests.every(r => r.method === 'GET' && r.path.startsWith(`/api/now/table/${family.table}`)));
    const list = requests[0];
    assert.equal(list.query.sysparm_limit, '1');
    assert.equal(list.query.sysparm_display_value, 'false');
    assert.deepEqual(new Set(list.query.sysparm_fields.split(',')), new Set(['sys_id', 'sys_updated_on']));
    assert.ok(list.query.sysparm_query.includes('sys_idISNOTEMPTY'));
    if (family.extraQuery) assert.ok(list.query.sysparm_query.includes(family.extraQuery));
    assert.equal(requests[1].path, `/api/now/table/${family.table}/${id}`);
    assert.equal(requests[1].query.sysparm_limit, '1');
    assert.ok(requests[2].query.sysparm_query.includes(`sys_id=${id}`));
    if (family.show) {
      for (const index of [3, 5]) {
        assert.equal(requests[index].query.sysparm_query, `sys_id=${id}`);
        assert.equal(requests[index].query.sysparm_limit, '2');
        assert.equal(requests[index].query.sysparm_display_value, 'false');
      }
      assert.equal(requests[4].path, `/api/now/table/${family.table}/${id}`);
    }
    assert.deepEqual(f.ctx.state.get(`readonly.catalog.${family.name}.sample`), { id });
  });
  assert.equal(f.mutations, 0);
  assert.ok(f.commands.every(args => !args.includes('--count') && !args.includes('--follow') && !args.includes('--watch')));
  assert.ok(f.requests.every(r => !r.path.includes('/stats/')));
});

for (const [behavior, status] of [['acl', 'blocked-access'], ['missing-table', 'blocked-capability'], ['malformed', 'failed'], ['oversized', 'failed'], ['missing-fields', 'failed'], ['missing-identity', 'failed'], ['mismatch', 'failed']]) {
  test(`real CLI list ${behavior} cannot become a passing sample`, async t => {
    const f = await fixture(t, behavior);
    await assert.rejects(pair('includes')[0].run(f.ctx), error => error.status === status && !error.message.includes('Synthetic fixture'));
    assert.equal(f.ctx.state.has('readonly.catalog.includes.sample'), false);
    assert.equal(f.mutations, 0);
  });
}

test('shared ticket option factory sends exact offset/query/fields and extracted identity', async t => {
  const f = await fixture(t);
  const scenario = scenarios.find(s => s.id === 'readonly.catalog.ticket-options');
  assert.ok(scenario);
  await scenario.run(f.ctx);
  const tables = { incidents: 'incident', changes: 'change_request', tasks: 'sc_task' };
  for (const [family, table] of Object.entries(tables)) {
    const requests = f.requests.filter(r => r.path.startsWith(`/api/now/table/${table}`));
    const lists = requests.filter(r => r.path === `/api/now/table/${table}`);
    assert.ok(lists.length >= 2, family);
    const offsetList = lists.find(r => r.query.sysparm_offset === '1');
    const defaultList = lists.find(r => r.query.sysparm_offset === '0' && r.query.sysparm_query?.includes('sys_idISNOTEMPTY'));
    assert.ok(offsetList && defaultList && defaultList.query.sysparm_offset === '0', family);
    for (const list of [offsetList, defaultList]) {
      assert.equal(list.query.sysparm_limit, '1', family);
      assert.equal(list.query.sysparm_fields, 'sys_id,sys_id,sys_updated_on', family);
      assert.equal(list.query.sysparm_query, 'sys_idISNOTEMPTY^ORDERBYDESCsys_updated_on', family);
    }
    const shows = requests.filter(r => r.path === `/api/now/table/${table}/${id}`);
    assert.ok(shows.length >= 1, family);
    const showRequest = requests.find(r => r.query.sysparm_limit === '2' && r.query.sysparm_query === `sys_id=${id}`);
    assert.ok(showRequest, family);
    assert.ok(f.commands.some(args => args[0] === family && args[1] === 'show' && args.includes('--get')), family);
  }
  assert.equal(f.mutations, 0);
});

test('visible empty list is not exact show coverage and show performs zero requests', async t => {
  const f = await fixture(t, 'empty');
  await pair('includes')[0].run(f.ctx);
  const before = f.requests.length;
  await assert.rejects(pair('includes')[1].run(f.ctx), error => error.status === 'blocked-prerequisite');
  assert.equal(f.requests.length, before); assert.equal(f.mutations, 0);
});
test('real CLI show cannot pass a record with the wrong identity', async t => {
  const f = await fixture(t, 'wrong-show');
  await pair('includes')[0].run(f.ctx);
  await assert.rejects(pair('includes')[1].run(f.ctx), error => error.status === 'failed' && !error.message.includes(otherId));
  assert.equal(f.mutations, 0);
});
test('unprepared show blocks rather than choosing a guessed target', async () => {
  let calls = 0;
  await assert.rejects(pair('incidents')[1].run({ state: new Map(), command() { calls++; } }), error => error.status === 'blocked-prerequisite');
  assert.equal(calls, 0);
});
