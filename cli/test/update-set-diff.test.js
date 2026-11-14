import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { credKey } from '../src/auth/credential-store.js';
import { parseDiffWindow, readDiffTable, diffUpdateSets, formatUpdateSetDiff } from '../src/update-set-diff.js';

const execute = promisify(execFile);
const id = n => n.toString(16).padStart(32, '0');
test('count changes, page budget and provider 403 never establish absence', async () => {
  for (const mode of ['changed', 'budget', '403']) {
    let counts = 0;
    let pages = 0;
    const sdk = { baseURL: 'http://fixture', request: async url => {
      if (mode === '403') throw new Error('Provider 403 Forbidden');
      if (url.includes('/stats/')) return { result: { stats: { count: mode === 'budget' ? '21' : String(++counts) } } };
      return { result: [{ sys_id: id(++pages) }] };
    } };
    const coverage = [];
    assert.equal((await readDiffTable(sdk, 'test', '', ['sys_id'], coverage, mode)).complete, false);
    assert.match(coverage[0].error, mode === 'changed' ? /count changed/ : mode === 'budget' ? /Page budget/ : /403/);
    assert.equal(coverage[0].fetched, mode === 'budget' ? 20 : mode === 'changed' ? 1 : 0);
  }
});

test('named grouping, missing ancestor, artifact reasons and empty selection coverage', async () => {
  let selection = 'full';
  const rows = [
    { sys_id: id(1), name: 'Orphan child', state: 'complete', parent: id(99), sys_updated_on: '' },
    { sys_id: id(2), name: 'Standalone fix', state: 'complete', parent: '', sys_updated_on: '' },
  ];
  const sdk = side => ({ baseURL: 'http://fixture', request: async value => {
    const url = new URL(value);
    const table = url.pathname.split('/').at(-1);
    const query = url.searchParams.get('sysparm_query');
    if (table === 'sys_update_set' && query.includes('state=complete') && selection === 'error') throw new Error('Provider 403 Forbidden');
    let data = table === 'sys_update_set' ? (query.includes('state=complete') && selection === 'empty' ? [] : rows) : table === 'sys_remote_update_set' ? rows.map(row => ({ sys_id: row.sys_id, remote_sys_id: row.sys_id, update_set: '', name: row.name, state: 'committed' })) :
      (side === 'source' ? ['shared', 'only_source'] : ['shared', 'only_target']).map((name, i) => ({ sys_id: id(200 + i), name, action: 'INSERT_OR_UPDATE', payload: side, update_set: id(1), remote_update_set: id(1) }));
    return url.pathname.includes('/stats/') ? { result: { stats: { count: String(data.length) } } } : { result: data };
  } });
  const app = { config: { profiles: { source: { instance_url: 'http://source' }, target: { instance_url: 'http://target' } } }, getSDKForProfile: (_, options) => sdk(options.profileName), ok() {} };
  const run = () => diffUpdateSets({ source: 'source', target: 'target', from: '2026-10-01' }, app);
  const report = await run();
  assert.match(report._formatted, /Batch: \(unreadable/);
  assert.match(report._formatted, /Standalone update sets/);
  assert.match(report._formatted, /shared: content differs/);
  assert.match(report._formatted, /only_source: missing-in-target/);
  assert.match(report._formatted, /only_target: target-only/);
  assert.equal(report.sets[0].parent_name, null);
  const beforeRender = JSON.stringify(report);
  assert.equal(formatUpdateSetDiff(report), report._formatted);
  assert.equal(JSON.stringify(report), beforeRender);
  assert.equal(report.sets[0].parent, id(99));
  assert.deepEqual(report.sets[0].capture_counts, { source: 2, target: 2 });
  selection = 'empty';
  const empty = (await run())._formatted;
  assert.match(empty, /No selected sets:/);
  assert.doesNotMatch(empty, /Batch:|Standalone update sets| · 0|--verbose/);
  selection = 'error';
  const failed = await run();
  assert.doesNotMatch(failed._formatted, /No selected sets:/);
  assert.match(failed._formatted, /Source selection unreadable or incomplete/);
});

test('date windows validate calendar dates and default to two weeks', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  assert.equal(parseDiffWindow(undefined, now), '2026-10-01 00:00:00');
  assert.equal(parseDiffWindow('14d', now), '2026-10-01 00:00:00');
  assert.equal(parseDiffWindow('2026-10-01'), '2026-10-01 00:00:00');
  for (const value of ['dev', '2026-02-30', '0w', '-1d']) assert.throws(() => parseDiffWindow(value));
});
test('provider count and required fields fail closed', async () => {
  for (const result of [null, {}, [{ sys_id: id(1) }]]) {
    const coverage = [];
    const sdk = { baseURL: 'http://fixture', request: async url => url.includes('/stats/') ? { result: { stats: { count: '1' } } } : { result } };
    const read = await readDiffTable(sdk, 'test', '', ['sys_id', 'name'], coverage, 'fixture');
    assert.equal(read.complete, false);
    assert.equal(coverage[0].status, 'error');
  }
});
test('real CLI uses independent profiles, read-only evidence, JSON/get/human and hierarchy context', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-update-diff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const sets = Array.from({ length: 6 }, (_, index) => ({ sys_id: id(index + 1), name: 'Duplicate name', state: 'complete', parent: id(10), sys_updated_on: '2026-11-01 00:00:00' }));
  const context = [{ sys_id: id(10), name: 'Batch', state: 'in progress', parent: '', sys_updated_on: '2020-01-01 00:00:00' }, { sys_id: id(11), name: 'Old nested', state: 'in progress', parent: id(10), sys_updated_on: '2020-01-01 00:00:00' }];
  sets[5].parent = id(6); // selected cyclic ancestry must terminate and remain visible
  context.push({ sys_id: id(12), name: 'Nested older member', state: 'complete', parent: id(11), sys_updated_on: '2020-01-01 00:00:00' });
  const remotes = [1, 3, 4, 5, 6, 6].map((origin, index) => ({ sys_id: id(100 + index), name: 'Duplicate name', state: origin === 3 ? 'loaded' : 'committed', remote_sys_id: id(origin), update_set: id(200 + index) }));
  let unreadable = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const source = req.headers.authorization === `Basic ${Buffer.from('dev:fixture').toString('base64')}`;
    calls.push({ method: req.method, query: url.searchParams.get('sysparm_query'), source, path: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') { res.end('{}'); return; }
    if (req.method !== 'GET') { res.statusCode = 500; res.end('{}'); return; }
    const table = url.pathname.split('/').at(-1);
    const query = url.searchParams.get('sysparm_query') || '';
    let rows = [];
    if (table === 'sys_update_set') rows = query.includes('state=complete') ? sets : [...sets, ...context];
    if (table === 'sys_remote_update_set') rows = remotes;
    if (table === 'sys_update_xml') {
      const owner = query.match(/=(\w+)/)?.[1];
      rows = [{ sys_id: id(source ? 500 : 501), name: 'sys_script_' + id(999), action: 'INSERT_OR_UPDATE', payload: !source && owner === id(102) ? '<different/>' : '<record/>', [source ? 'update_set' : 'remote_update_set']: owner }];
      if (source && owner === id(5)) rows = [{ sys_id: id(500), name: 'hidden' }];
    }
    if (url.pathname.includes('/stats/')) { res.end(JSON.stringify({ result: { stats: { count: String(rows.length) } } })); return; }
    if (unreadable && table === 'sys_remote_update_set') { res.end('{}'); return; }
    // Deliberately short pages prove a short page is not exhaustion.
    const offset = Number(url.searchParams.get('sysparm_offset') || 0);
    res.end(JSON.stringify({ result: rows.slice(offset, offset + 2) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(dir, 'servicenow');
  await fs.mkdir(path.join(configDir, 'credentials'), { recursive: true });
  const config = JSON.stringify({ default_profile: 'dev', profiles: Object.fromEntries(['dev', 'test'].map(name => [name, { instance_url: instance, username: name, auth_method: 'basic' }])) });
  await fs.writeFile(path.join(configDir, 'config.json'), config);
  for (const name of ['dev', 'test']) await fs.writeFile(path.join(configDir, 'credentials', `${credKey(instance, name)}.json`), JSON.stringify({ auth_method: 'basic', username: name, password: 'fixture' }));
  const env = { ...process.env, PATH: '', XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: dir, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' };
  for (const key of Object.keys(env)) if (/^(SN_|SERVICENOW_)/i.test(key)) delete env[key];
  const run = args => execute(process.execPath, [fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), 'updatesets', 'diff', '--source', 'dev', '--target', 'test', ...args], { env, timeout: 20000 });
  const json = JSON.parse((await run(['--json', '--from', '2026-10-01'])).stdout);
  const report = json.data || json;
  assert.deepEqual(report.sets.filter(set => !set.context).map(set => set.status), ['Matching', 'Missing', 'Retrieved not committed', 'Different', 'Unknown', 'Unknown']);
  assert.equal(report.sets.filter(set => set.context).length, 3);
  assert.deepEqual(report.hierarchy_cycles, [id(6)]);
  assert.equal(report.sets[0].base, id(10));
  assert.equal(Object.hasOwn(report, '_formatted'), false);
  const human = await run(['--format', 'styled', '--from', '2026-10-01']);
  assert.match(human.stdout, /Batch: Batch/);
  assert.match(human.stdout, /dev → test · since 2026-10-01 00:00:00 UTC/);
  assert.match(human.stdout, / {2}Batch — Context only \(in progress\)\n {4}├─ Duplicate name — Committed, matching/);
  assert.match(human.stdout, / {4}└─ Old nested — Context only \(in progress\)\n {6}└─ Nested older member — Context only \(complete\)/);
  for (const label of ['Missing in target', 'Loaded, not committed', 'Content differs', 'Unable to verify']) assert.ok(human.stdout.includes(`— ${label}`));
  assert.match(human.stdout, /1 Committed, matching · 1 Missing in target · 1 Loaded, not committed · 1 Content differs · 2 Unable to verify/);
  assert.doesNotMatch(human.stdout, /Update set\s+Parent|Captures S\/T|Origin remote_sys_id|count-verified|Source ID:|not completion-transition/);
  assert.doesNotMatch(human.stdout, /Source state:|Complete target inventory:|Hierarchy context only;/);
  const verbose = await run(['--format', 'styled', '--verbose', '--from', '2026-10-01']);
  assert.match(verbose.stdout, /parent: Batch/);
  assert.match(verbose.stdout, /Captures: source 1 \/ target 1/);
  assert.match(verbose.stdout, /Complete target inventory:/);
  assert.match(verbose.stdout, /\[0000000000000000000000000000000a\]/);
  assert.ok(verbose.stdout.length > human.stdout.length);
  const verboseJSON = JSON.parse((await run(['--json', '--verbose', '--from', '2026-10-01'])).stdout);
  assert.deepEqual(verboseJSON.data || verboseJSON, report);
  assert.match(human.stdout, /sys_script_.*: content differs/);
  assert.match(human.stdout, /Context only/);
  if (process.env.JSN_DIFF_CAPTURE) await fs.writeFile(process.env.JSN_DIFF_CAPTURE, human.stdout);
  const extracted = await run(['--get', 'data.sets.0.status', '--from', '2w']);
  assert.match(extracted.stdout, /Matching/);
  await assert.rejects(run(['--from', 'dev']));
  unreadable = true;
  const failed = JSON.parse((await run(['--json'])).stdout);
  assert.ok((failed.data || failed).sets.every(set => set.status === 'Unknown'));
  assert.ok(calls.every(call => call.method === 'GET' || (call.method === 'POST' && call.path === '/angular.do')), JSON.stringify(calls.filter(call => call.method !== 'GET')));
  assert.ok(calls.some(call => call.source) && calls.some(call => !call.source));
  assert.ok(calls.filter(call => call.path.endsWith('sys_remote_update_set')).every(call => !call.query.includes('sys_updated_on')));
  assert.ok(calls.some(call => call.source && call.query?.includes('state=complete^sys_updated_on>=')));
  assert.equal(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'), config);
  for (const default_profile of [undefined, 'unrelated']) {
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ ...JSON.parse(config), default_profile }));
    assert.match((await run(['--format', 'styled'])).stdout, /Batch: Batch/);
  }
});
