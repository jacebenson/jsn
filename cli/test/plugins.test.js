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
import { readDependencyTree, formatPluginTree, TREE_LIMITS } from '../src/plugins.js';
import { pluginsCmd } from '../src/commands/plugins.js';
import { isMutationCommand } from '../src/mutations.js';
import { compareInstanceInventory } from '../src/instance-inventory.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

// Raw v_plugin values: active is active/inactive and requires is comma-separated plugin ids.
const plugin = (id, requires = [], extra = {}) => ({ id, name: `Name of ${id}`, version: '1.0.0', available_version: '1.0.0', active: 'active', state: 'published', requires: requires.join(','), scope: 'global', entitled: 'not_applicable', block_install: 'false', supports_rollback: 'true', has_demo_data: 'false', licensable: 'false', provider: 'ServiceNow', ...extra });
// root -> a, b, an unlisted id; a -> c, b (b is shared); c -> a (a cycle); b -> b (requires itself).
const graph = [
  plugin('com.example.root', ['com.example.a', 'com.example.b', 'com.hidden.core']),
  plugin('com.example.a', ['com.example.c', 'com.example.b']),
  plugin('com.example.b', ['com.example.b'], { active: 'inactive', block_install: 'true' }),
  plugin('com.example.c', ['com.example.a']),
];
function fixtureSdk(rows = graph, reply = found => found) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, query: params.get('sysparm_query'), params });
    const ids = params.get('sysparm_query').replace(/^idIN/, '').split(',');
    return reply(rows.filter(row => ids.includes(row.id)), ids);
  } };
}

test('show reads one level per query by raw plugin id and names cycles, shared and unlisted plugins', async () => {
  const sdk = fixtureSdk();
  const data = await readDependencyTree(sdk, 'com.example.root');
  assert.deepEqual(sdk.calls.map(call => [call.table, call.query]), [['v_plugin', 'idINcom.example.root'], ['v_plugin', 'idINcom.example.a,com.example.b,com.hidden.core'], ['v_plugin', 'idINcom.example.c']]);
  for (const { params } of sdk.calls) {
    assert.equal(params.get('sysparm_display_value'), 'false');
    assert.ok(params.get('sysparm_fields').split(',').includes('requires'));
    assert.equal(Number(params.get('sysparm_limit')), params.get('sysparm_query').split(',').length);
  }
  assert.deepEqual(data.dependencies.map(dep => [dep.id, dep.depth, dep.listed, dep.active]), [['com.example.a', 1, true, true], ['com.example.b', 1, true, false], ['com.hidden.core', 1, false, null], ['com.example.c', 2, true, true]]);
  assert.equal(data.count, 4);
  assert.deepEqual(data.inactive, ['com.example.b']);
  assert.deepEqual(data.unlisted, ['com.hidden.core']);
  assert.deepEqual(data.cycles, [['com.example.c', 'com.example.a'], ['com.example.b', 'com.example.b']]);
  assert.equal(data.complete, true);
  assert.equal(data.plugin.block_install, false);
  assert.equal(data.dependencies[1].block_install, true);
  const text = formatPluginTree(data);
  assert.match(text, /Scope global, provider ServiceNow, state published, entitled not_applicable; rollback supported, no demo data, not licensable\n/);
  assert.match(text, /4 dependencies: 1 inactive, 1 not listed in v_plugin, 2 cycle\(s\)/);
  assert.match(text, /├─ com\.example\.a {2}Name of com\.example\.a 1\.0\.0, active\n│ {2}├─ com\.example\.c {2}.*\n│ {2}│ {2}└─ com\.example\.a \(cycle\)\n│ {2}└─ com\.example\.b {2}Name of com\.example\.b 1\.0\.0, INACTIVE, install blocked\n│ {2} {2} └─ com\.example\.b \(cycle\)\n├─ com\.example\.b \(shown above\)\n└─ com\.hidden\.core {2}not listed in v_plugin, state unknown/);
});

test('a plugin with no dependencies reads once; an id v_plugin does not list is not found', async () => {
  const lone = fixtureSdk([plugin('com.example.lone')]);
  const data = await readDependencyTree(lone, 'com.example.lone');
  assert.equal(lone.calls.length, 1);
  assert.equal(data.count, 0);
  assert.match(formatPluginTree(data), /\(no dependencies\)/);
  await assert.rejects(readDependencyTree(fixtureSdk(), 'com.example.absent'), error => error.code === 'not_found' && /Plugin not found: com\.example\.absent/.test(error.message) && /does not show it is absent or inactive/.test(error.hint));
});

test('invalid plugin ids are refused before any request', async () => {
  const sdk = fixtureSdk();
  for (const id of [undefined, '', 'bad^id', 'a,b', 'idINx y', 'x'.repeat(101)]) await assert.rejects(readDependencyTree(sdk, id), error => error.code === 'usage_error', String(id));
  assert.equal(sdk.calls.length, 0);
});

test('malformed, denied and inconsistent responses are never reported as a tree', async () => {
  const cases = {
    'display value for active': found => found.map(row => ({ ...row, active: 'Active' })),
    'unreadable id in requires': found => found.map(row => ({ ...row, requires: 'com.example.a^ORactive=true' })),
    'a row not asked for': found => [...found, plugin('com.example.other')],
    'the same row twice': found => [...found, ...found],
    'a row without an id': found => found.map(row => ({ ...row, id: '' })),
    'a non-object row': () => ['com.example.root'],
  };
  for (const [name, reply] of Object.entries(cases)) await assert.rejects(readDependencyTree(fixtureSdk(graph, reply), 'com.example.root'), /Malformed v_plugin response/, name);
  const denied = { listStrict: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } };
  await assert.rejects(readDependencyTree(denied, 'com.example.root'), /Forbidden/);
  let level = 0;
  const failsLater = fixtureSdk(graph, found => { if (++level === 2) throw Object.assign(new Error('Forbidden'), { status: 403 }); return found; });
  await assert.rejects(readDependencyTree(failsLater, 'com.example.root'), /Forbidden/);
});

test('reads are bounded: ids chunk at 100, and a deep or wide tree stops and says it is incomplete', async () => {
  const wide = Array.from({ length: 150 }, (_, i) => `com.example.w${i}`);
  const chunked = fixtureSdk([plugin('com.example.root', wide), ...wide.map(id => plugin(id))]);
  assert.equal((await readDependencyTree(chunked, 'com.example.root')).count, 150);
  assert.deepEqual(chunked.calls.map(call => call.query.split(',').length), [1, 100, 50]);

  const chain = Array.from({ length: TREE_LIMITS.depth + 2 }, (_, i) => plugin(`com.example.p${i}`, [`com.example.p${i + 1}`]));
  const deep = fixtureSdk(chain);
  const cut = await readDependencyTree(deep, 'com.example.p0');
  assert.equal(deep.calls.length, TREE_LIMITS.depth + 1);
  assert.deepEqual([cut.complete, cut.limit_reached, cut.count], [false, 'depth', TREE_LIMITS.depth]);
  assert.match(formatPluginTree(cut), /INCOMPLETE, the depth limit \(50\) was reached[\s\S]*com\.example\.p51 {2}not read: tree limit reached/);

  const many = Array.from({ length: TREE_LIMITS.nodes }, (_, i) => `com.example.n${i}`);
  const huge = fixtureSdk([plugin('com.example.root', many)]);
  const capped = await readDependencyTree(huge, 'com.example.root');
  assert.equal(huge.calls.length, 1);
  assert.deepEqual([capped.complete, capped.limit_reached], [false, 'nodes']);
});

// Serves the inventory read (a count, then pages) and the tree read (exact ids) from one row set.
function inventorySdk(rows) {
  const calls = [];
  return { calls, baseURL: 'http://fixture', request: async () => (calls.push('count'), { result: { stats: { count: String(rows.length) } } }), listStrict: async (_table, params) => {
    const get = key => params instanceof URLSearchParams ? params.get(key) : params[key];
    const query = get('sysparm_query');
    calls.push(query);
    if (query.startsWith('idIN')) return rows.filter(row => query.slice(4).split(',').includes(row.id));
    return rows.slice(Number(get('sysparm_offset')), Number(get('sysparm_offset')) + 200);
  } };
}
const local = row => ({ sys_id: `local-${row.id}`, ...row });
const profiles = sdks => ({ config: { profiles: { pdi: { instance_url: 'https://pdi.example.test' }, vendor: { instance_url: 'https://vendor.example.test' } } }, getSDKForProfile: (_instance, { profileName }) => sdks[profileName] });

test('plugins compare <id> narrows the comparison to the plugin and its tree read on the source', async () => {
  const source = [...graph, plugin('com.example.unrelated')].map(local);
  const target = [plugin('com.example.root', [], { version: '2.0.0' }), graph[1], plugin('com.example.c', [], { active: 'inactive' }), plugin('com.example.unrelated'), plugin('com.example.extra'), plugin('com.hidden.core')].map(local);
  const sdks = { pdi: inventorySdk(source), vendor: inventorySdk(target) };
  const data = await compareInstanceInventory({ source: 'pdi', target: 'vendor', id: 'com.example.root', maxPages: 30 }, profiles(sdks), 'plugins', false);
  assert.deepEqual(data.records.map(row => [row.id, row.status]), [['com.example.a', 'matching'], ['com.example.b', 'source_only'], ['com.example.c', 'different'], ['com.example.root', 'different']]);
  assert.deepEqual(data.tree, { plugin: 'com.example.root', count: 4, complete: true, unlisted: ['com.hidden.core'] });
  assert.deepEqual(data.counts, { matching: 1, different: 2, source_only: 1, target_only: 0, unknown: 0 });
  assert.equal(data.complete, true);
  assert.equal(sdks.vendor.calls.some(query => typeof query === 'string' && query.startsWith('idIN')), false);
  assert.match(data._formatted, /Narrowed to com\.example\.root and the 4 plugins it requires on pdi; 1 not listed in v_plugin there are not compared/);

  const whole = await compareInstanceInventory({ source: 'pdi', target: 'vendor', maxPages: 30 }, profiles({ pdi: inventorySdk(source), vendor: inventorySdk(target) }), 'plugins', false);
  assert.equal(whole.records.length, 7);
  assert.equal(Object.hasOwn(whole, 'tree'), false);
  assert.doesNotMatch(whole._formatted, /Narrowed/);

  const chain = Array.from({ length: TREE_LIMITS.depth + 2 }, (_, i) => local(plugin(`com.example.p${i}`, [`com.example.p${i + 1}`])));
  const cut = await compareInstanceInventory({ source: 'pdi', target: 'vendor', id: 'com.example.p0', maxPages: 30 }, profiles({ pdi: inventorySdk(chain), vendor: inventorySdk(chain) }), 'plugins', false);
  assert.deepEqual([cut.complete, cut.tree.complete, cut.records.length], [false, false, TREE_LIMITS.depth + 1]);
  assert.match(cut._formatted, /\(INCOMPLETE tree\)[\s\S]*Complete visible inventories/);

  for (const [args, code] of [[{ id: 'bad^id' }, 'usage_error'], [{ id: 'com.example.root', maxPages: 0 }, 'usage_error'], [{ id: 'com.example.absent' }, 'not_found']]) {
    const failing = { pdi: inventorySdk(source), vendor: inventorySdk(target) };
    const label = JSON.stringify(args);
    await assert.rejects(compareInstanceInventory({ source: 'pdi', target: 'vendor', maxPages: 30, ...args }, profiles(failing), 'plugins', false), error => error.code === code, label);
    assert.equal(failing.vendor.calls.length, 0, label);
    assert.equal(failing.pdi.calls.length, code === 'usage_error' ? 0 : 1, label);
  }
});

// root (inactive) -> a (inactive), b (active), an unlisted id; a -> c (inactive), b; c -> a (a cycle); d -> c.
const installGraph = () => [
  plugin('com.example.root', ['com.example.a', 'com.example.b', 'com.hidden.core'], { active: 'inactive' }),
  plugin('com.example.a', ['com.example.c', 'com.example.b'], { active: 'inactive' }),
  plugin('com.example.b'),
  plugin('com.example.c', ['com.example.a'], { active: 'inactive' }),
  plugin('com.example.d', ['com.example.c'], { active: 'inactive' }),
];
const TRACKER = 'f'.repeat(32);
const accepted = { result: { links: { progress: { id: TRACKER, url: `https://example.test/api/sn_cicd/progress/${TRACKER}` } }, status: '0', status_label: 'Pending', error: '', percent_complete: 0 } };
function installFixture({ rows = installGraph(), activation = accepted, progress = ['2'], activates = true, readback } = {}) {
  const commands = [];
  pluginsCmd(fn => fn).builder({ command(c) { commands.push(c); return this; } });
  const handler = commands.find(c => c.command.startsWith('install ')).handler;
  const reads = fixtureSdk(rows), sent = [];
  let posted = false, data, options;
  const sdk = { baseURL: 'https://example.test', listStrict: async (table, params) => {
    if (posted && readback) return readback();
    return reads.listStrict(table, params);
  }, request: async (url, opts) => {
    sent.push({ url, method: opts.method });
    if (url.includes('/activate')) {
      posted = true;
      if (activates) for (const row of rows) row.active = 'active';
      if (activation instanceof Error) throw activation;
      return activation;
    }
    const next = progress.length > 1 ? progress.shift() : progress[0];
    if (next instanceof Error) throw next;
    return { result: { status: next, status_label: { 1: 'Running', 2: 'Successful', 3: 'Failed' }[next], status_message: next === '3' ? 'Plugin dependency failed' : '', error: '', percent_complete: next === '2' ? 100 : 40 } };
  } };
  const app = { sdk, requireInstance() {}, ok(value, opts) { data = value; options = opts; } };
  const run = argv => handler({ yes: false, timeout: 1800, pollInterval: 0, ...argv }, app);
  return { run, reads: reads.calls, sent, get data() { return data; }, get options() { return options; } };
}

test('plugins install is a declared mutation; show and compare are reads', () => {
  assert.equal(isMutationCommand({ _: ['plugins', 'install'] }), true);
  for (const verb of ['show', 'compare']) assert.equal(isMutationCommand({ _: ['plugins', verb] }), false, verb);
});

test('install previews by default: required plugins first, unlisted and cycles named, nothing sent', async () => {
  const one = installFixture();
  await one.run({ ids: ['com.example.root'] });
  assert.equal(one.sent.length, 0);
  assert.deepEqual([one.data.dry_run, one.data.sent], [true, false]);
  assert.deepEqual(one.data.plugins.map(p => [p.id, p.required_by_request]), [['com.example.c', true], ['com.example.a', true], ['com.example.root', false]]);
  assert.deepEqual(one.data.unlisted, ['com.hidden.core']);
  assert.deepEqual(one.data.cycles, [['com.example.c', 'com.example.a']]);
  assert.deepEqual(one.data.refusals, []);
  assert.equal(one.data.rerun, 'jsn plugins install com.example.root --yes');
  assert.match(one.options.summary, /^Dry run: 3 plugin\(s\) would be activated; nothing sent$/);
  assert.match(one.data._formatted, /preview, nothing sent\nPlugins to activate, required plugins first:\n {2}1\. com\.example\.c .*, required\n {2}2\. com\.example\.a .*\n {2}3\. com\.example\.root {2}Name of com\.example\.root 1\.0\.0\nNot listed in v_plugin, state unknown: com\.hidden\.core\nCycles, not followed: com\.example\.c -> com\.example\.a/);

  const several = installFixture();
  await several.run({ ids: ['com.example.d', 'com.example.root', 'com.example.d'] });
  assert.equal(several.sent.length, 0);
  assert.deepEqual(several.data.requested, ['com.example.d', 'com.example.root']);
  // a and c require each other; entered from d, the walk reaches c first, so a comes before it.
  assert.deepEqual(several.data.plugins.map(p => p.id), ['com.example.a', 'com.example.c', 'com.example.d', 'com.example.root']);
  assert.equal(several.data.rerun, null);
});

test('install refuses before sending: several ids with --yes, bad input, active, blocked and incomplete trees', async () => {
  for (const argv of [{ ids: ['com.example.root', 'com.example.d'], yes: true }, { ids: ['bad^id'] }, { ids: [] }, { ids: ['com.example.root'], timeout: 0 }, { ids: ['com.example.root'], pollInterval: 301 }]) {
    const f = installFixture();
    await assert.rejects(f.run(argv), error => error.code === 'usage_error', JSON.stringify(argv));
    assert.deepEqual([f.reads.length, f.sent.length], [0, 0], JSON.stringify(argv));
  }
  const cases = {
    'already active': installGraph().map(row => row.id === 'com.example.root' ? { ...row, active: 'active' } : row),
    'it is required, inactive and its install is blocked': installGraph().map(row => row.id === 'com.example.c' ? { ...row, block_install: 'true' } : row),
    'install is blocked': installGraph().map(row => row.id === 'com.example.root' ? { ...row, block_install: 'true' } : row),
    'its dependency tree is incomplete (the depth limit was reached)': Array.from({ length: TREE_LIMITS.depth + 2 }, (_, i) => plugin(i ? `com.example.p${i}` : 'com.example.root', [`com.example.p${i + 1}`], { active: 'inactive' })),
  };
  for (const [reason, rows] of Object.entries(cases)) {
    const preview = installFixture({ rows });
    await preview.run({ ids: ['com.example.root'] });
    assert.ok(preview.data.refusals.some(r => r.reason === reason), reason);
    assert.equal(preview.data.rerun, null, reason);
    const sent = installFixture({ rows });
    await assert.rejects(sent.run({ ids: ['com.example.root'], yes: true }), error => error.code === 'usage_error' && error.message.includes(reason) && /Nothing was sent/.test(error.message), reason);
    assert.equal(sent.sent.length, 0, reason);
  }
});

test('install --yes activates one plugin, waits on its tracker and verifies every activated plugin on v_plugin', async () => {
  const f = installFixture({ progress: ['1', '2'] });
  await f.run({ ids: ['com.example.root'], yes: true });
  assert.deepEqual(f.sent.map(s => [s.method ?? 'GET', s.url]), [['POST', 'https://example.test/api/sn_cicd/plugin/com.example.root/activate'], ['GET', `https://example.test/api/sn_cicd/progress/${TRACKER}`], ['GET', `https://example.test/api/sn_cicd/progress/${TRACKER}`]]);
  assert.equal(f.reads.at(-1).query, 'idINcom.example.c,com.example.a,com.example.root');
  assert.deepEqual([f.data.verified, f.data.still_inactive, f.data.succeeded], [true, [], true]);
  assert.equal(f.options.summary, 'Activated com.example.root and 2 required plugin(s); verified on v_plugin');
  assert.match(f.data._formatted, /tracker f{32}, Successful[\s\S]*Verified: v_plugin shows all 3 active\./);
});

test('install --yes never reports a rejected, failed, unreadable or unverified activation as success', async () => {
  const forbidden = () => Object.assign(new Error('Forbidden'), { status: 403 });
  const cases = [
    ['api_error', { activation: { result: 'text' } }],
    ['plugin_activation_rejected', { activation: { result: { error: 'Plugin is not entitled', status: '3', links: { progress: { id: TRACKER } } } } }],
    ['plugin_activation_rejected', { activation: { result: { status: '0', links: {} } } }],
    ['plugin_activation_failed', { progress: ['3'] }],
    ['plugin_activation_failed', { progress: ['3'], readback: () => { throw forbidden(); } }],
    ['plugin_progress_unavailable', { progress: [forbidden()] }],
    ['plugin_verification_failed', { activates: false }],
    ['plugin_readback_unavailable', { readback: () => { throw forbidden(); } }],
  ];
  for (const [code, options] of cases) {
    const f = installFixture(options);
    await assert.rejects(f.run({ ids: ['com.example.root'], yes: true }), error => error.code === code, code);
    assert.equal(f.sent.filter(s => s.url.includes('/activate')).length, 1, code);
    assert.equal(f.data, undefined, code);
  }
});

test('an activation still running when the wait ends keeps its tracker, is not verified, exits 1 and is not resent', async () => {
  const sdk = installFixture({ progress: ['1'] });
  await sdk.run({ ids: ['com.example.root'], yes: true, timeout: 1, pollInterval: 1 });
  try {
    assert.equal(process.exitCode, 1);
    assert.deepEqual([sdk.data.wait_timed_out, sdk.data.verified, sdk.data.tracker_id], [true, false, TRACKER]);
    assert.equal(sdk.sent.filter(s => s.url.includes('/activate')).length, 1);
    assert.match(sdk.options.summary, /still running after 1s \(tracker f{32}\); not verified/);
  } finally { process.exitCode = undefined; }
});

test('real CLI shows the tree read-only with JSON, --get, human output and strict validation', async () => {
  const calls = [];
  const instance = inventorySdk(graph.map(local));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/now/stats/v_plugin') return instance.request().then(body => res.end(JSON.stringify(body)));
    if (url.pathname !== '/api/now/table/v_plugin') return res.end(JSON.stringify({ result: [] }));
    instance.listStrict('v_plugin', url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-plugins-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true }, writable: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic' } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const shown = JSON.parse((await run(['plugins', 'show', 'com.example.root', '--json'])).stdout);
    assert.equal(shown.ok, true);
    assert.deepEqual(shown.data.unlisted, ['com.hidden.core']);
    assert.deepEqual(JSON.parse((await run(['plugins', 'show', 'com.example.root', '--get', 'data.inactive'])).stdout), ['com.example.b']);
    const human = await run(['plugins', 'show', 'com.example.root', '--format', 'styled']);
    assert.match(human.stdout, /Name of com\.example\.root \[com\.example\.root\] 1\.0\.0, active[\s\S]*└─ com\.hidden\.core {2}not listed in v_plugin/);
    const narrowed = JSON.parse((await run(['plugins', 'compare', 'com.example.root', '--source', 'fixture', '--target', 'fixture', '--json'])).stdout);
    assert.deepEqual([narrowed.data.tree.plugin, narrowed.data.records.length, narrowed.data.counts.matching], ['com.example.root', 4, 4]);
    const before = calls.length;
    for (const args of [['show', 'bad^id'], ['show'], ['show', 'com.example.root', '--typo'], ['compare', 'com.example.a', 'com.example.b', '--source', 'fixture', '--target', 'fixture']]) await assert.rejects(run(['plugins', ...args, '--json']), undefined, JSON.stringify(args));
    assert.equal(calls.length, before);
    await assert.rejects(run(['plugins', 'show', 'com.example.absent', '--json']), error => error.code === 1 && /Error \(not_found\): Plugin not found: com\.example\.absent[\s\S]*does not show it is absent or inactive/.test(error.stderr));
    const installBefore = calls.length;
    await assert.rejects(run(['plugins', 'install', 'com.example.root', '--json']), error => error.code !== 0 && /read.only/i.test(error.stderr + error.stdout));
    assert.equal(calls.length, installBefore);
    const preview = JSON.parse((await run(['plugins', 'install', 'com.example.root', '--profile', 'writable', '--json'])).stdout);
    assert.deepEqual([preview.ok, preview.data.sent, preview.data.refusals], [true, false, [{ id: 'com.example.root', reason: 'already active' }, { id: 'com.example.b', reason: 'it is required, inactive and its install is blocked' }]]);
    await assert.rejects(run(['plugins', 'install', 'com.example.root', 'com.example.a', '--yes', '--profile', 'writable', '--json']), error => /one plugin at a time/.test(error.stderr + error.stdout));
    assert.ok(!calls.some(call => call.pathname.startsWith('/api/sn_cicd/')));
    const reads = calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    assert.ok(reads.length && reads.every(call => call.method === 'GET' && call.pathname === '/api/now/table/v_plugin'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
