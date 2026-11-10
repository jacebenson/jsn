import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SDKClient } from '../src/sdk.js';
import { yargs } from '../src/cli-adapter.js';
import assert from 'node:assert/strict';
import { OutputWriter, resolvePath } from '../src/output.js';

function render(data, options = {}, outputOptions = {}) {
  let text = '';
  new OutputWriter({ format: 'json', writer: { write: chunk => { text += chunk; } }, ...options }).ok(data, outputOptions);
  return text;
}

test('machine JSON is compact and trims coaching; verbose restores legacy output', () => {
  const data = { records: [{ sys_id: 'fixture' }] };
  const options = { summary: 'One record', breadcrumbs: [{ action: 'list', cmd: 'jsn records list' }] };
  const compact = render(data, {}, options);
  assert.equal(compact.includes('\n  "'), false);
  assert.deepEqual(JSON.parse(compact), { ok: true, data });
  const verbose = render(data, { verbose: true }, options);
  assert.equal(verbose, JSON.stringify({ ok: true, data, ...options }, null, 2) + '\n');
});

test('selection shares the bracket/dot resolver and raw strings are shell-ready', () => {
  const data = { records: [{ sys_id: 'fixture' }] };
  assert.equal(render(data, { jqFilter: 'data.records[0].sys_id', raw: true }), 'fixture\n');
  assert.equal(render(data, { jqFilter: 'data.records.0.sys_id' }), '"fixture"\n');
  assert.equal(resolvePath({ data: [{ number: 'INC1' }] }, '.data[0].number'), 'INC1');
  assert.equal(render(data, { jqFilter: 'data.records', raw: true }), '[{"sys_id":"fixture"}]\n');
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-query-parity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'fixture.mjs');
  const requests = path.join(directory, 'requests.jsonl');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import { AuthManager } from ${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)};
    AuthManager.prototype.createProfileProvider = () => ({ getCredentials: async () => ({ auth_method: 'gck', access_token: 'fixture' }) });
    const rows = Array.from({ length: 6 }, (_, i) => ({ sys_id: 'fixture-' + i, number: 'INC000' + i,
      name: 'Fixture ' + i, short_description: 'Example incident ' + i, active: i !== 5 }));
    globalThis.fetch = async req => {
      const url = new URL(req.url);
      if (url.origin !== 'https://fixture.example.test' || req.method !== 'GET') throw new Error('Unexpected request: ' + req.url);
      fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ url: req.url, method: req.method }) + ${JSON.stringify('\n')});
      const query = url.searchParams.get('sysparm_query') || '';
      const filtered = query.split('^').includes('active=true') ? rows.filter(r => r.active) : rows;
      if (url.pathname.startsWith('/api/now/stats/')) return Response.json({ result: { stats: { count: String(filtered.length) } } });
      if (!url.pathname.startsWith('/api/now/table/')) throw new Error('Unexpected path: ' + url.pathname);
      const offset = Number(url.searchParams.get('sysparm_offset') || 0);
      const limit = Number(url.searchParams.get('sysparm_limit') || 20);
      return Response.json({ result: filtered.slice(offset, offset + limit) });
    };
  `);
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    SERVICENOW_INSTANCE_URL: '', SERVICENOW_FORMAT: '', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  return {
    requests: () => fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    run(args) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
        fileURLToPath(new URL('../bin/jsn.js', import.meta.url)), ...args, '--instance', 'https://fixture.example.test'],
      { env, cwd: directory, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(result.stderr, '');
      return result.stdout;
    },
  };
}
const list = ['records', 'list', '--table', 'incident', '--columns', 'sys_id,number,short_description,active'];

test('CLI -q filters records and generic commands, -S/quiet stay data-only', t => {
  const f = fixture(t);
  for (const command of [list, ['properties', 'list', '--columns', 'sys_id,name,active']]) {
    const result = JSON.parse(f.run([...command, '-q', 'active=true', '--json']));
    assert.equal(result.data.count, 5);
    assert.ok(result.data.records.every(r => r.active === true || r.active === 'true'));
  }
  for (const flag of ['-S', '--quiet', '--format=quiet']) {
    const result = JSON.parse(f.run([...list, '-q', 'active=true', flag]));
    assert.equal(result.count, 5);
    assert.equal(Object.hasOwn(result, 'ok'), false);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
  const urls = f.requests().filter(r => new URL(r.url).pathname.startsWith('/api/now/table/'));
  assert.ok(urls.length >= 5);
  assert.ok(urls.every(r => new URL(r.url).searchParams.get('sysparm_query').split('^').includes('active=true')));
});

test('CLI -q without query support fails clearly instead of silently ignoring it', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/jsn.js', import.meta.url)),
    'version', '-q', 'active=true', '--json'], { encoding: 'utf8', env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' } });
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error, /-q.*--query.*not supported/);
});

test('CLI compact/verbose JSON and bracket/dotted/raw selection', t => {
  const f = fixture(t);
  const help = f.run(['--help']);
  assert.match(help, /--select, --get/);
  assert.match(help, /--include-reference-links\s+Include/);
  const compact = f.run([...list, '--json']);
  const value = JSON.parse(compact);
  assert.equal(compact.includes('\n  "'), false);
  assert.equal(Object.hasOwn(value, 'breadcrumbs'), false);
  assert.equal(Object.hasOwn(value, 'summary'), false);
  const verbose = f.run([...list, '--json', '--verbose']);
  assert.ok(verbose.includes('\n  "'));
  assert.ok(JSON.parse(verbose).breadcrumbs.length > 0);
  assert.match(JSON.parse(verbose).summary, /record/);
  const bracket = f.run([...list, '--select', 'data.records[0].sys_id']);
  assert.equal(bracket, f.run([...list, '--select', 'data.records.0.sys_id']));
  assert.equal(JSON.parse(bracket), 'fixture-0');
  assert.equal(f.run([...list, '--select', 'data.records[0].sys_id', '--raw']), 'fixture-0\n');
  assert.equal(f.run([...list, '--get', 'data.records[0].sys_id', '--raw']), 'fixture-0\n');
});

test('CLI reference links default off at transport, opt-in omits the parameter', t => {
  const f = fixture(t);
  f.run([...list, '--json', '--no-count']);
  f.run([...list, '--json', '--no-count', '--include-reference-links']);
  const requests = f.requests();
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get('sysparm_exclude_reference_link'), 'true');
  assert.equal(new URL(requests[1].url).searchParams.has('sysparm_exclude_reference_link'), false);
});

test('CLI pagination hasMore uses count and offset, no-count makes no extra call', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.run([...list, '-q', 'active=true', '--limit', '3', '--json'])).data.pagination.hasMore, true);
  const short = JSON.parse(f.run([...list, '-q', 'active=true', '--limit', '3', '--offset', '3', '--json'])).data;
  assert.equal(short.count, 2);
  assert.equal(short.pagination.hasMore, false);
  assert.equal(short.pagination.total, 5);
  const before = f.requests().length;
  const uncounted = JSON.parse(f.run([...list, '--no-count', '--json'])).data.pagination;
  assert.equal(Object.hasOwn(uncounted, 'hasMore'), false);
  assert.equal(f.requests().length - before, 1);
});

test('list and listStrict preserve explicit reference parameters and never mutate input', async () => {
  const sdk = new SDKClient('https://fixture.example.test', null);
  const seen = [];
  sdk.request = async (url, options) => { seen.push({ url: new URL(url), options }); return { result: [{ sys_id: 'fixture' }] }; };
  for (const method of ['list', 'listStrict']) {
    const params = new URLSearchParams({ sysparm_limit: '1' });
    assert.deepEqual(await sdk[method]('incident', params), [{ sys_id: 'fixture' }]);
    assert.equal(seen.at(-1).url.searchParams.get('sysparm_exclude_reference_link'), 'true');
    assert.equal(params.has('sysparm_exclude_reference_link'), false);
    await sdk[method]('incident', { sysparm_exclude_reference_link: 'false' });
    assert.equal(seen.at(-1).url.searchParams.get('sysparm_exclude_reference_link'), 'false');
    sdk.includeReferenceLinks = true;
    await sdk[method]('incident');
    assert.equal(seen.at(-1).url.searchParams.has('sysparm_exclude_reference_link'), false);
    await sdk[method]('incident', { sysparm_exclude_reference_link: 'true' });
    assert.equal(seen.at(-1).url.searchParams.get('sysparm_exclude_reference_link'), 'true');
    sdk.includeReferenceLinks = false;
  }
});

test('every query declaration publishes -q through the shared adapter', async () => {
  const { buildCLI } = await import('../src/cli.js');
  const cli = buildCLI();
  let declarations = 0;
  function visit(node, commandPath = []) {
    node.build();
    if (node.options.has('query')) {
      declarations++;
      assert.ok(node.options.get('query').alias.includes('q'), commandPath.join(' '));
    }
    for (const child of node.children) visit(child, [...commandPath, child.name]);
  }
  visit(cli.root);
  assert.ok(declarations > 20);
  let argv;
  await yargs(['list', '-q', 'active=true']).command({ command: 'list', builder: y => y.option('query', { type: 'string', alias: 'filter' }), handler: v => { argv = v; } }).parse();
  assert.equal(argv.query, 'active=true');
  assert.equal(argv.filter, 'active=true');
});

test('trimmed fixture JSON is at least 40% smaller than real 0fb7f5f serialization', async t => {
  const f = fixture(t);
  const envelope = JSON.parse(f.run([...list, '-q', 'active=true', '--json', '--verbose']));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const source = execFileSync('git', ['show', '0fb7f5f:cli/src/output.js'], { cwd: root, encoding: 'utf8' })
    .replace("'./errors.js'", JSON.stringify(new URL('../src/errors.js', import.meta.url).href));
  const { OutputWriter: BaselineWriter } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let baseline = '';
  const options = { summary: envelope.summary, breadcrumbs: envelope.breadcrumbs };
  new BaselineWriter({ format: 'json', writer: { write: chunk => { baseline += chunk; } } }).ok(envelope.data, options);
  const compact = render(envelope.data, {}, options);
  const before = Buffer.byteLength(baseline), after = Buffer.byteLength(compact);
  t.diagnostic(JSON.stringify({ baselineBytes: before, compactBytes: after, reduction: 1 - after / before,
    estimatedTokensBefore: before / 4, estimatedTokensAfter: after / 4 }));
  assert.ok(after <= before * 0.6, `${after} must be <= 60% of ${before}`);
});
