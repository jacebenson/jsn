import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeFlowSearchDefinition, searchFlows, formatFlowSearch } from '../src/flow-search.js';
import { OutputWriter } from '../src/output.js';
import { isMutationCommand } from '../src/mutations.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { flowsCmd } from '../src/commands/flows.js';
import { execFileSync } from 'node:child_process';

function searchCommand() {
  let command;
  const builder = { command(entry) { if (entry.command === 'search <term>') command = entry; return this; }, demandCommand() { return this; }, epilogue() { return this; } };
  flowsCmd(handler => handler).builder(builder);
  return command;
}

test('flows search is registered without a prompt and exposes refresh in executable help', () => {
  assert.ok(searchCommand(), 'search command registered');
  const output = execFileSync(process.execPath, ['bin/jsn.js', 'flows', 'search', '--help'], { encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' } });
  assert.match(output, /--refresh/);
});

function provider() {
  const calls = [];
  const definitions = new Map([
    ['a'.repeat(32), { actionInstances: [{ values: gzipSync(JSON.stringify({ script: 'current.number = 42;' })).toString('base64') }], triggerInstances: [] }],
    ['b'.repeat(32), { actionInstances: [], triggerInstances: [] }],
  ]);
  const sdk = { baseURL: 'https://example.service-now.com', request: async (url, options) => {
    assert.equal(options.method, 'GET');
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.includes('/stats/')) return { result: { stats: { count: '2' } } };
    if (parsed.pathname.includes('/table/')) {
      const offset = Number(parsed.searchParams.get('sysparm_offset'));
      // Deliberately short pages. Never infer exhaustion from page length.
      return { result: [...definitions.keys()].slice(offset, offset + 1).map(sys_id => ({ sys_id, name: `Flow ${sys_id[0]}` })) };
    }
    const data = definitions.get(parsed.pathname.split('/').pop());
    if (data instanceof Error) throw data;
    return { result: { data } };
  } };
  return { sdk, calls, definitions };
}

test('cold/warm/refresh cache searches decoded text and revalidates access before reuse', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const { sdk, calls, definitions } = provider();
  const options = { sdk, cacheRoot, context: { profile: 'reader', username: 'alice', domain: '' }, term: 'current.number' };
  const cold = await searchFlows(options);
  const windows = process.platform === 'win32';
  assert.equal(cold.cache.state, windows ? 'disabled' : 'built');
  assert.equal(cold.coverage.decoded, 2);
  assert.equal(cold.coverage.complete_visible_inventory, true);
  assert.equal(cold.match_count, 1);
  assert.equal(cold.matches[0].line, 1);
  assert.match(cold.matches[0].path, /script/);
  if (windows) {
    assert.equal(cold.cache.file, null);
    assert.deepEqual(await fs.readdir(cacheRoot), []);
  } else {
    assert.equal((await fs.stat(cold.cache.file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(cold.cache.file))).mode & 0o777, 0o700);
  }
  const warm = await searchFlows(options);
  assert.equal(warm.cache.state, windows ? 'disabled' : 'reused');
  assert.equal(warm.cache.reused_definitions, windows ? 0 : 2);
  assert.ok(calls.filter(url => url.includes('/processflow/')).length === 4);
  const refreshed = await searchFlows({ ...options, refresh: true });
  assert.equal(refreshed.cache.state, windows ? 'disabled' : 'refreshed');
  assert.equal(refreshed.cache.reused_definitions, 0);
  const other = await searchFlows({ ...options, context: { ...options.context, username: 'bob' } });
  if (windows) assert.equal(other.cache.file, null);
  else assert.notEqual(other.cache.file, cold.cache.file);
  definitions.set('a'.repeat(32), new Error('403 Forbidden'));
  const denied = await searchFlows(options);
  assert.equal(denied.match_count, 0, 'must not return stale privileged cached source');
  assert.equal(denied.coverage.complete_visible_inventory, false);
  assert.equal(denied.failures[0].stage, 'download');
});

test('Windows policy never touches cache paths and re-downloads after access revocation', async t => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-windows-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { sdk, definitions, calls } = provider();
  const options = { sdk, platform: 'win32', term: 'current', cacheRoot: path.join(root, 'missing') };
  const cold = await searchFlows(options);
  assert.equal(cold.match_count, 1);
  assert.equal(cold.cache.state, 'disabled');
  assert.equal(cold.cache.file, null);
  assert.match(formatFlowSearch(cold), /Windows.*in-memory/);
  assert.deepEqual(await fs.readdir(root), []);
  // A file in place of the cache root would fail any disk traversal. It must
  // remain untouched, even with refresh and an identity change.
  await fs.writeFile(options.cacheRoot, 'old sensitive cache sentinel');
  const warm = await searchFlows({ ...options, refresh: true, context: { username: 'bob' } });
  assert.equal(warm.match_count, 1);
  assert.equal(warm.cache.reused_definitions, 0);
  assert.equal(warm.cache.previous_age_seconds, null);
  assert.equal(calls.filter(url => url.includes('/processflow/')).length, 4);
  definitions.set('a'.repeat(32), new Error('403 Forbidden'));
  assert.equal((await searchFlows(options)).match_count, 0);
  assert.equal(await fs.readFile(options.cacheRoot, 'utf8'), 'old sensitive cache sentinel');
  // Directory junctions need no Windows symlink privilege; POSIX uses a symlink.
  await fs.rm(options.cacheRoot);
  const target = path.join(root, 'target');
  await fs.mkdir(target);
  await fs.symlink(target, options.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await searchFlows(options);
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal((await fs.lstat(options.cacheRoot)).isSymbolicLink(), true);
});

test('partial downloads and corrupted encoded definitions remain distinct from decoded coverage', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const { sdk, definitions } = provider();
  definitions.set('a'.repeat(32), { actionInstances: [{ values: 'H4sIbroken' }] });
  const result = await searchFlows({ sdk, cacheRoot, term: 'anything' });
  assert.equal(result.coverage.downloaded, 2);
  assert.equal(result.coverage.decoded, 1);
  assert.equal(result.coverage.complete_visible_inventory, false);
  assert.equal(result.failures[0].stage, 'decode');
  assert.match(formatFlowSearch(result), /FAILED decode/);
  assert.match(formatFlowSearch(result), /PARTIAL/);
});

test('malformed inventory/count and pagination limits never claim complete empty results', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const { sdk } = provider();
  const limited = await searchFlows({ sdk, cacheRoot, term: 'current', maxPages: 1 });
  assert.equal(limited.coverage.complete_visible_inventory, false);
  assert.match(limited.failures[0].message, /limit/);
  const malformed = { ...sdk, request: async () => ({ result: {} }) };
  const report = await searchFlows({ sdk: malformed, cacheRoot, term: 'current', refresh: true });
  assert.equal(report.coverage.provider_count, null);
  assert.equal(report.coverage.complete_visible_inventory, false);
  assert.deepEqual(report.failures.map(item => item.stage), ['inventory_count', 'inventory']);
});

test('cache isolation includes instance, profile, identity and domain and rejects unsafe files', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const { sdk } = provider();
  const files = [];
  for (const context of [{ profile: 'one' }, { profile: 'two' }, { username: 'bob' }, { domain: 'other' }]) {
    files.push((await searchFlows({ sdk, cacheRoot, context, term: 'current' })).cache.file);
  }
  files.push((await searchFlows({ sdk: { ...sdk, baseURL: 'https://other.service-now.com' }, cacheRoot, context: { profile: 'one' }, term: 'current' })).cache.file);
  if (process.platform === 'win32') {
    assert.deepEqual(files, Array(5).fill(null));
    assert.deepEqual(await fs.readdir(cacheRoot), []);
    return; // No persisted identities exist to cross-contaminate on Windows.
  }
  assert.equal(new Set(files).size, 5);
  await fs.chmod(files[0], 0o644);
  await assert.rejects(searchFlows({ sdk, cacheRoot, context: { profile: 'one' }, term: 'current' }), /permissions/);
  await fs.rm(files[0]);
  await fs.symlink(files[1], files[0]);
  await assert.rejects(searchFlows({ sdk, cacheRoot, context: { profile: 'one' }, term: 'current' }), /ELOOP/);
});

test('provider count changes and explicit read denial cannot release cached source', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const { sdk, definitions } = provider();
  let counts = 0;
  const request = sdk.request;
  sdk.request = async (url, options) => url.includes('/stats/') ? { result: { stats: { count: String(++counts === 1 ? 2 : 3) } } } : request(url, options);
  const changed = await searchFlows({ sdk, cacheRoot, term: 'current' });
  assert.equal(changed.coverage.complete_visible_inventory, false);
  assert.ok(changed.failures.some(f => f.stage === 'inventory_count' && /changed/.test(f.message)));
  definitions.set('a'.repeat(32), { actionInstances: [{ script: 'private source' }], security: { can_read: false } });
  const denied = await searchFlows({ sdk, cacheRoot, term: 'private' });
  assert.equal(denied.match_count, 0);
  assert.ok(denied.failures.some(f => f.stage === 'download'));
});

test('handler uses normal JSON, extraction and human output with read-only command classification', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'flow-search-'));
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheRoot;
  t.after(async () => { if (before === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = before; await fs.rm(cacheRoot, { recursive: true, force: true }); });
  assert.equal(isMutationCommand({ _: ['flows', 'search', 'current'] }), false);
  const { sdk } = provider();
  for (const [format, jqFilter] of [['json', undefined], ['json', 'data.match_count'], ['styled', undefined], ['markdown', undefined]]) {
    let text = '';
    const output = new OutputWriter({ format, jqFilter, writer: { write: chunk => { text += chunk; } } });
    await searchCommand().handler({ term: 'current.number', format, json: true }, { sdk, requireInstance() {}, session: { profileName: 'reader', username: 'alice', profile: { read_only: true } }, ok: (data, opts) => output.ok(data, opts) });
    if (jqFilter) assert.equal(text.trim(), '1');
    else if (format === 'json') {
      const envelope = JSON.parse(text);
      assert.equal(envelope.data.match_count, 1);
      assert.equal(envelope.data._formatted, undefined);
    } else assert.match(text, /current.number/);
  }
});

test('fixed encoded provider-shaped fixture exposes script lines, not base64', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/flow-search-encoded.json', import.meta.url), 'utf8'));
  const decoded = decodeFlowSearchDefinition(fixture.definition);
  const script = decoded.find(entry => entry.path.endsWith('.inputs[0].value'));
  assert.equal(script.text, 'var result = current.number;\nreturn result;');
  assert.ok(!decoded.some(entry => entry.text.startsWith('H4sI')));
});

test('decodes provider gzip JSON values and retains readable scripts with source paths', () => {
  const values = gzipSync(JSON.stringify({ inputs: [{ name: 'script', value: 'answer = current.number;\nreturn answer;' }] })).toString('base64');
  const result = decodeFlowSearchDefinition({ actionInstances: [{ id: 'step1', values }], triggerInstances: [] });
  assert.ok(result.some(entry => entry.path === '$.actionInstances[0].values.inputs[0].value' && entry.text.includes('current.number')));
  assert.throws(() => decodeFlowSearchDefinition({ actionInstances: [{ values: 'H4sIcorrupted' }] }), /decode/i);
  assert.throws(() => decodeFlowSearchDefinition({ security: { can_read: true } }), /structure/i);
});
