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
    // A field ACL can drop requires from the row; read as no requirements, the tree would look complete.
    'a row without requires': found => found.map(({ requires: _requires, ...row }) => row),
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

test('real CLI shows the tree read-only with JSON, --get, human output and strict validation', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname !== '/api/now/table/v_plugin') return res.end(JSON.stringify({ result: [] }));
    fixtureSdk().listStrict('v_plugin', url.searchParams).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-plugins-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
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
    const before = calls.length;
    for (const args of [['show', 'bad^id'], ['show'], ['show', 'com.example.root', '--typo']]) await assert.rejects(run(['plugins', ...args, '--json']), undefined, JSON.stringify(args));
    assert.equal(calls.length, before);
    await assert.rejects(run(['plugins', 'show', 'com.example.absent', '--json']), error => error.code === 1 && /Error \(not_found\): Plugin not found: com\.example\.absent[\s\S]*does not show it is absent or inactive/.test(error.stderr));
    const reads = calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    assert.ok(reads.length && reads.every(call => call.method === 'GET' && call.pathname === '/api/now/table/v_plugin'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
