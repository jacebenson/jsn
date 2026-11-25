import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SDKClient } from '../src/sdk.js';
import { credKey } from '../src/auth/credential-store.js';
import { readInventory, readObservedStoreApps, compareInventories, recommendAlignment, formatInventoryComparison } from '../src/instance-inventory.js';

const plugin = (id, extra = {}) => ({ sys_id: `local-${id}`, id, name: id, active: 'active', version: '1.0', ...extra });
function sdk(rows, { total = rows.length, pageSize = 200, countAfter = total } = {}) {
  let counts = 0;
  return { baseURL: 'http://fixture', request: async (_url, options) => {
    assert.equal(options.method, 'GET');
    return { result: { stats: { count: String(++counts === 1 ? total : countAfter) } } };
  }, listStrict: async (_table, params) => rows.slice(params.sysparm_offset, params.sysparm_offset + pageSize) };
}

test('stable IDs ignore local sys_ids; version, activation, installation and presence remain distinct', async () => {
  const a = await readInventory(sdk([plugin('shared'), plugin('changed'), plugin('only-a')]), 'plugins');
  const b = await readInventory(sdk([plugin('shared', { sys_id: 'other-local-id' }), plugin('changed', { active: 'inactive', version: '2.0' }), plugin('only-b')]), 'plugins');
  const incompleteVersion = await readInventory(sdk([plugin('shared', { version: '' })]), 'plugins');
  assert.equal(compareInventories(incompleteVersion, b).find(row => row.id === 'shared').status, 'unknown');
  const rows = compareInventories(a, b);
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['changed', 'different'], ['only-a', 'source_only'], ['only-b', 'target_only'], ['shared', 'matching']]);
  assert.deepEqual(rows[0].changes, ['version', 'active']);
  const app = { sys_id: 'app-local', scope: 'sn_example', name: 'Store app', active: 'true', version: '1.0', install_date: '2026-01-01', latest_version: '9.0' };
  const sa = await readInventory(sdk([app]), 'store');
  const sb = await readInventory(sdk([{ ...app, sys_id: 'different', active: 'false', version: '' }]), 'store');
  assert.deepEqual(compareInventories(sa, sb)[0].changes, ['version', 'active', 'installed']);
});

test('directional recommendations do not downgrade, uninstall or infer installation from version alone', async () => {
  const item = { version: '2.0', active: true, installed: true };
  assert.equal(recommendAlignment(item, null, true, 'store')[0].action, 'install');
  assert.equal(recommendAlignment(item, { ...item, active: false }, true, 'plugins')[0].action, 'activate');
  assert.equal(recommendAlignment(item, null, false, 'store')[0].action, 'investigate_access');
  assert.equal(recommendAlignment(null, item, true, 'store')[0].action, 'review_target_only');
  assert.equal(recommendAlignment(item, { ...item, version: '3.0' }, true, 'store')[0].action, 'review_version');
  assert.equal(recommendAlignment(item, { ...item, version: '1.0' }, true, 'store')[0].action, 'align_version');
  assert.equal(recommendAlignment(item, { ...item, version: '2.0-beta' }, true, 'store')[0].action, 'review_version');
  assert.equal(recommendAlignment(item, { ...item, version: '2.0.0' }, true, 'store')[0].action, 'review_version');
  assert.equal(recommendAlignment(item, item, true, 'store')[0].action, 'none');
  const local = { sys_id: 'x', scope: 'sn_example', name: 'Store app', active: 'true', version: '2.0', install_date: '' };
  const source = await readInventory(sdk([local]), 'store');
  assert.equal(source.items.get('sn_example').installed, null);
  assert.equal(recommendAlignment(source.items.get('sn_example'), item, true, 'store')[0].action, 'investigate_installation');
  const records = Array.from({ length: 51 }, (_, index) => ({ id: String(index), status: 'different', before: item, after: item, recommendations: [{ message: 'Review target.' }] }));
  const report = { kind: 'plugins', source: 'a', target: 'b', complete: true, coverage: {}, counts: { different: 51 }, records };
  assert.match(formatInventoryComparison(report), /1 additional rows omitted/);
  assert.doesNotMatch(formatInventoryComparison(report, true), /additional rows omitted/);
});

test('short pages exhaust provider counts, not page shape', async () => {
  const result = await readInventory(sdk([plugin('a'), plugin('b'), plugin('c')], { pageSize: 1 }), 'plugins');
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.fetched, 3);
});

test('duplicates, missing fields, invalid states, malformed responses, limits and count drift fail closed', async () => {
  const cases = [
    [sdk([plugin('a'), plugin('a', { sys_id: 'other' })]), 'duplicate_or_invalid_identity'],
    [sdk([plugin('a'), plugin('b', { sys_id: 'local-a' })]), 'duplicate_or_invalid_identity'],
    [sdk([{ sys_id: 'x', id: 'a', name: 'a', active: 'active' }]), 'missing_fields'],
    [sdk([plugin('a', { active: 'mystery' })]), 'unknown_state'],
    [sdk([plugin('', {})]), 'duplicate_or_invalid_identity'],
    [sdk([plugin('a')], { total: 2 }), 'unstable_pagination'],
    [sdk([plugin('a'), plugin('b')], { pageSize: 1 }), 'page_limit_or_count_mismatch', 1],
    [sdk([plugin('a')], { countAfter: 2 }), 'count_changed'],
    [{ ...sdk([]), request: async () => ({}) }, 'unreadable_count'],
    [{ ...sdk([plugin('a')]), listStrict: async () => ({}) }, 'unstable_pagination'],
    [{ ...sdk([]), request: async () => { throw Object.assign(new Error('private provider text'), { status: 403 }); } }, 'forbidden'],
  ];
  const complete = await readInventory(sdk([plugin('other')]), 'plugins');
  for (const [client, reason, pages] of cases) {
    const result = await readInventory(client, 'plugins', pages);
    assert.equal(result.coverage.status, 'unknown', reason);
    assert.equal(result.coverage.reason, reason);
    assert.ok(compareInventories(result, complete).every(row => row.status === 'unknown'));
    assert.doesNotMatch(JSON.stringify(result.coverage), /private provider text/);
  }
});

test('Store comparison requires session auth while other tables honor the OAuth session policy', async t => {
  const calls = [];
  const previous = process.env.JSN_ALWAYS_WARM_SESSION;
  t.after(() => {
    if (previous === undefined) delete process.env.JSN_ALWAYS_WARM_SESSION;
    else process.env.JSN_ALWAYS_WARM_SESSION = previous;
  });
  t.mock.method(globalThis, 'fetch', async request => {
    const url = new URL(request.url);
    const flags = { path: url.pathname, cookie: request.headers.has('cookie'), token: request.headers.has('x-usertoken'), bearer: request.headers.get('authorization')?.startsWith('Bearer ') || false };
    calls.push(flags);
    if (url.pathname === '/angular.do') return new Response('{}', { headers: { 'Set-Cookie': 'JSESSIONID=fixture; Path=/', 'X-UserToken-Response': 'fixture-user-token' } });
    if (url.pathname.endsWith('sys_scope')) return new Response('{"result":[]}');
    const store = url.pathname.endsWith('sys_store_app');
    if (store && (!flags.cookie || !flags.token || flags.bearer)) return new Response('{}', { status: 403 });
    const row = store ? { sys_id: 'store-local', scope: 'sn_fixture', name: 'Fixture app', version: '1.0', active: 'true', install_date: '2026-01-01' } : plugin('com.fixture');
    return new Response(JSON.stringify(url.pathname.includes('/stats/') ? { result: { stats: { count: '1' } } } : { result: [row] }));
  });
  for (const mode of ['default', '0']) {
    if (mode === 'default') delete process.env.JSN_ALWAYS_WARM_SESSION;
    else process.env.JSN_ALWAYS_WARM_SESSION = mode;
    calls.length = 0;
    const client = new SDKClient('https://fixture.invalid', { getCredentials: async () => ({ auth_method: 'oauth', access_token: 'fixture-token' }) });
    assert.equal((await readInventory(client, 'store')).coverage.status, 'complete');
    assert.equal((await readInventory(client, 'plugins')).coverage.status, 'complete');
    await client.listStrict('sys_properties', { sysparm_limit: 1 });
    const storeCalls = calls.filter(row => row.path.endsWith('sys_store_app'));
    const otherCalls = calls.filter(row => row.path.endsWith('v_plugin') || row.path.endsWith('sys_properties'));
    assert.ok(storeCalls.length > 0 && otherCalls.length > 0);
    assert.ok(storeCalls.every(row => row.cookie && row.token && !row.bearer), mode);
    assert.ok(otherCalls.every(row => mode === '0' ? row.bearer && !row.cookie && !row.token : row.cookie && row.token && !row.bearer), mode);
  }
});

test('App Client failures invalidate positive evidence; page limits never establish absence', async () => {
  const app = { sys_id: 'a', scope: 'sn_a', name: 'App', version: '1.0' };
  for (const apps of [[app, { ...app, sys_id: 'b' }], [{ ...app, scope: '' }], null]) {
    const result = await readObservedStoreApps({ baseURL: 'http://fixture', request: async () => ({ result: { apps } }) }, 2, 'forbidden');
    assert.equal(result.coverage.status, 'unknown');
    assert.equal(result.coverage.observed_items_usable, false);
    assert.ok(compareInventories(result, result, 'store').every(row => row.status === 'unknown'));
  }
  const limited = await readObservedStoreApps({ baseURL: 'http://fixture', request: async () => ({ result: { apps: [app] } }) }, 1, 'forbidden');
  assert.equal(limited.coverage.reason, 'page_limit_no_provider_total');
  assert.equal(limited.coverage.status, 'unknown');
  assert.equal(limited.coverage.fetched, 1);
  assert.equal(compareInventories(limited, limited, 'store')[0].status, 'matching');
  assert.equal(compareInventories(limited, limited, 'store')[0].before.active, null);
});

test('real CLI parser, independent profiles, human/JSON/get, ACL failures and zero mutations', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-inventory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let denied = false;
  let observedStore = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    calls.push([req.method, url.pathname]);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') { res.end('{}'); return; }
    const destination = req.headers.authorization === `Basic ${Buffer.from('destination:fixture').toString('base64')}`;
    if (url.pathname === '/api/sn_appclient/appmanager/apps') {
      assert.equal(req.method, 'POST');
      assert.equal(url.searchParams.get('tab_context'), 'installed');
      if (denied) { res.statusCode = 403; res.end('{}'); return; }
      const apps = [
        { sys_id: destination ? 'local-target' : 'local-source', scope: 'sn_shared', name: 'Readable Store app', version: destination ? '2.0' : '1.0', latest_version: '9.0' },
        { sys_id: 'only-' + destination, scope: 'sn_only_' + destination, name: 'Only observed on one side', version: '1.0' },
      ];
      const offset = Number(url.searchParams.get('sysparm_offset'));
      res.end(JSON.stringify({ result: { apps: apps.slice(offset, offset + 1) } })); return;
    }
    if (req.method !== 'GET') { res.statusCode = 500; res.end('{}'); return; }
    if (denied || observedStore && url.pathname.endsWith('sys_store_app')) { res.statusCode = 403; res.end('{"error":{"message":"Forbidden"}}'); return; }
    const store = url.pathname.endsWith('sys_store_app');
    const rows = store ? [{ sys_id: destination ? 'local-b' : 'local-a', scope: 'sn_example', name: 'Store app', active: 'true', install_date: '2026-01-01', latest_version: '9.0', version: destination ? '2.0' : '1.0' }] : [plugin('com.example', { sys_id: destination ? 'local-b' : 'local-a', version: destination ? '2.0' : '1.0' })];
    res.end(JSON.stringify(url.pathname.includes('/stats/') ? { result: { stats: { count: '1' } } } : { result: rows }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(dir, 'servicenow');
  await fs.mkdir(path.join(configDir, 'credentials'), { recursive: true, mode: 0o700 });
  const config = JSON.stringify({ profiles: Object.fromEntries(['source', 'destination'].map(name => [name, { instance_url: instance, username: name, auth_method: 'basic' }])) });
  await fs.writeFile(path.join(configDir, 'config.json'), config);
  for (const name of ['source', 'destination']) await fs.writeFile(path.join(configDir, 'credentials', `${credKey(instance, name)}.json`), JSON.stringify({ auth_method: 'basic', username: name, password: 'fixture' }), { mode: 0o600 });
  const env = { ...process.env, PATH: '', HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: dir, JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' };
  for (const key of Object.keys(env)) if (/^(SN_|SERVICENOW_)/i.test(key)) delete env[key];
  const execute = promisify(execFile);
  const run = (kind, args) => execute(process.execPath, [fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), ...(kind === 'compare' ? ['compare'] : [kind, 'compare']), '--source', 'source', '--target', 'destination', ...args], { env, timeout: 20000 });
  for (const kind of ['plugins', 'store']) {
    const result = JSON.parse((await run(kind, ['--json'])).stdout);
    assert.equal(result.data.complete, true);
    assert.equal(result.data.records[0].status, 'different');
    assert.equal(result.data.records[0].before.version, '1.0');
    assert.equal(result.data.records[0].after.version, '2.0');
    assert.equal(Object.hasOwn(result.data, '_formatted'), false);
    const human = (await run(kind, ['--format', 'styled'])).stdout;
    assert.match(human, /source -> destination/);
    assert.match(human, /1.0, active.* -> 2.0, active/);
    assert.match((await run(kind, ['--get', 'data.counts.different'])).stdout, /1/);
    await assert.rejects(run(kind, ['--max-pages', '0', '--json']));
  }
  const combined = JSON.parse((await run('compare', ['--json'])).stdout).data;
  assert.deepEqual(combined.counts, { matching: 0, different: 2, source_only: 0, target_only: 0, unknown: 0 });
  assert.equal(combined.inventories.store.records[0].before.available_version, '9.0');
  assert.equal(combined.inventories.store.records[0].before.version, '1.0');
  assert.match((await run('compare', ['--format', 'styled'])).stdout, /WHAT TO DO ON TARGET/);
  assert.equal(JSON.parse((await run('compare', ['--get', 'data.counts.different'])).stdout), 2);
  const reversed = JSON.parse((await run('compare', ['--source', 'destination', '--target', 'source', '--json'])).stdout).data;
  assert.equal(reversed.inventories.plugins.records[0].recommendations[0].action, 'align_version');
  assert.equal(combined.inventories.plugins.records[0].recommendations[0].action, 'review_version');
  observedStore = true;
  const partialJSON = await run('compare', ['--json']).catch(error => { assert.equal(error.code, 1); return error; });
  const partial = JSON.parse(partialJSON.stdout).data;
  assert.equal(partial.inventories.plugins.complete, true);
  assert.equal(partial.inventories.store.complete, false);
  assert.equal(partial.inventories.store.coverage.source.fetched, 2);
  assert.equal(partial.inventories.store.coverage.source.exhaustion, 'empty_page_observed');
  const shared = partial.inventories.store.records.find(row => row.id === 'sn_shared');
  assert.equal(shared.evidence, 'observed_pair');
  assert.equal(shared.status, 'different');
  assert.equal(shared.recommendations[0].action, 'review_version');
  assert.equal(shared.before.active, null);
  assert.equal(shared.before.version, '1.0');
  assert.equal(shared.before.available_version, '9.0');
  assert.ok(partial.inventories.store.records.filter(row => row.id !== 'sn_shared').every(row => row.status === 'unknown' && row.recommendations[0].action === 'investigate_access'));
  const partialHuman = await run('compare', ['--format', 'styled']).catch(error => error);
  assert.match(partialHuman.stdout, /Readable Store app \[sn_shared\]/);
  assert.match(partialHuman.stdout, /Review newer target version/);
  const partialGet = await run('compare', ['--get', 'data.inventories.store.counts']).catch(error => error);
  assert.equal(JSON.parse(partialGet.stdout).different, 1);
  denied = true;
  await assert.rejects(run('store', ['--json']), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout).data;
    assert.equal(report.complete, false);
    assert.equal(report.coverage.source.reason, 'forbidden');
    assert.deepEqual(report.records, []);
    return true;
  });
  assert.ok(calls.every(([method, endpoint]) => method === 'GET' || method === 'POST' && ['/angular.do', '/api/sn_appclient/appmanager/apps'].includes(endpoint)));
  assert.equal(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'), config);
});
