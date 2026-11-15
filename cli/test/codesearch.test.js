import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchGraphQL, matchingRows } from '../src/codesearch-graphql.js';
import { CODESEARCH_CATALOG } from '../src/codesearch-catalog.js';
import { codesearchCmd, renderCodeSearch } from '../src/commands/codesearch.js';
import { credKey } from '../src/auth/credential-store.js';
import { isMutationCommand } from '../src/mutations.js';

const CLI = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
const id = (n) => n.toString(16).padStart(32, '0');
const row = (n, extra = {}) => ({ sys_id: { value: id(n) }, name: { value: 'Fixture' }, script: { value: 'needle needle\ncontext only\nNEEDLE' }, description: { value: '' }, ...extra });
const response = (rows, table = 'sys_script_include') => ({ result: { data: { GlideRecord_Query: { [table]: { _results: rows } } } } });
function fixture(pages, configuration = []) {
  const calls = [];
  const app = { getEffectiveInstance: () => 'https://fixture.invalid', sdk: { request: async (url, options) => {
    calls.push({ url, options });
    if (!options) return { result: configuration };
    const query = JSON.parse(options.body).query;
    const offset = Number(query.match(/offset: (\d+)/)[1]);
    return typeof pages === 'function' ? pages(query, offset) : response(pages[offset] ?? []);
  } } };
  return { app, calls };
}
const search = (app, options = {}) => searchGraphQL(app, { term: 'needle', table: 'sys_script_include', ...options });

test('public command registration preserves options and read-only classification', () => {
  for (const args of [['codesearch', '--help'], ['codesearch', 'search', '--help']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /search/);
    if (args.length > 2) for (const option of ['table', 'scope', 'limit', 'search-group', 'all-scopes', 'max-pages', 'max-requests']) assert.ok(result.stdout.includes(`--${option}`));
  }
  assert.notEqual(spawnSync(process.execPath, [CLI, 'codesearch', 'search', '--json'], { env }).status, 0);
  codesearchCmd((fn) => fn);
  assert.equal(isMutationCommand({ _: ['codesearch', 'search', 'needle'] }), false);
});

test('literal matches count occurrences, not surrounding context or just lines', () => {
  const rows = matchingRows(row(1), 'sys_script_include', ['script'], 'needle');
  assert.deepEqual(rows, [{ table: 'sys_script_include', name: 'Fixture', field: 'script', lines: '1,3', matches: 3, context: 'needle needle', sys_id: id(1) }]);
  assert.equal(matchingRows(row(1), 't', ['script'], '.*').length, 0);
  assert.throws(() => matchingRows(row(1), 't', ['script'], ''));
});

test('short pages advance by requested window, not returned count; gaps in IDs are legal', async () => {
  const { app, calls } = fixture({ 0: [row(1)], 250: [row(300)], 500: [] });
  const data = await search(app);
  assert.equal(data.status, 'complete');
  assert.equal(data.recordCount, 2);
  assert.equal(data.fieldCount, 2);
  assert.equal(data.matchCount, 6);
  assert.equal(data.coverage[0].pages, 3);
  assert.deepEqual(calls.slice(1).map((call) => Number(JSON.parse(call.options.body).query.match(/offset: (\d+)/)[1])), [0, 250, 500]);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.method, 'POST');
    const query = JSON.parse(call.options.body).query;
    assert.match(query, /^query \{/);
    assert.match(query, /nameLIKEneedle\^ORscriptLIKEneedle\^ORdescriptionLIKEneedle\^ORDERBYsys_id/);
    assert.doesNotMatch(query, /mutation/);
  }
});

test('whole-catalog budgets disclose every unsearched source', async () => {
  const { app, calls } = fixture((query) => {
    const table = query.match(/GlideRecord_Query \{ (\w+)\(/)[1];
    return response([], table);
  });
  const data = await search(app, { table: undefined, maxRequests: 2 });
  assert.equal(data.coverage.length, Object.keys(CODESEARCH_CATALOG).length);
  assert.equal(data.coverage.filter((source) => source.status === 'complete').length, 1);
  assert.ok(data.coverage.slice(1).every((source) => source.reason === 'request budget'));
  assert.equal(data.status, 'partial');
  assert.equal(calls.length, 2);
});

test('record, page and request budgets explicitly preserve partial results', async () => {
  for (const [options, reason, expected] of [[{ limit: 1 }, /record limit/, 1], [{ maxPages: 1 }, /page budget/, 2], [{ maxRequests: 1 }, /request budget/, 0]]) {
    const { app, calls } = fixture({ 0: [row(1), row(2)] });
    const data = await search(app, options);
    assert.equal(data.status, 'partial');
    assert.equal(data.recordCount, expected);
    assert.match(data.coverage[0].reason, reason);
    assert.ok(calls.length <= (options.maxRequests ?? 1000));
  }
});

test('duplicates, reversed IDs, missing identities and missing fields never claim complete', async () => {
  for (const bad of [row(1), row(0), { ...row(2), sys_id: undefined }, { ...row(2), description: undefined }]) {
    const broken = JSON.parse(JSON.stringify(bad));
    const { app } = fixture({ 0: [row(1)], 250: [broken] });
    const data = await search(app);
    assert.equal(data.status, 'partial');
    assert.equal(data.recordCount, 1);
    assert.match(data.coverage[0].reason, /pagination|requested field/);
  }
});

test('GraphQL and JSN 2xx error envelopes and unreadable payloads are not empty success', async () => {
  for (const payload of [{ errors: [{ message: 'provider failed' }] }, { result: { errors: [{ message: 'provider failed' }], data: {} } }, { ok: false, error: { message: 'failed' } }, { result: { error: { message: 'failed' } } }, {}, { result: { data: { GlideRecord_Query: { sys_script_include: { _results: null } } } } }]) {
    const { app } = fixture(() => payload);
    const data = await search(app);
    assert.equal(data.status, 'partial');
    assert.equal(data.records.length, 0);
    assert.ok(data.coverage[0].reason);
  }
});

test('schema validation exposes unavailable fields and searches supported fields at same offset', async () => {
  const { app, calls } = fixture((query, offset) => query.includes('description { value }') ?
    { result: { errors: [{ message: 'Cannot query field "description" on type "sys_script_include".' }] } } : response(offset ? [] : [{ sys_id: { value: id(1) }, name: { value: 'needle' }, script: { value: '' } }]));
  const data = await search(app);
  assert.equal(data.status, 'partial');
  assert.deepEqual(data.coverage[0].unsupportedFields, ['description']);
  assert.equal(data.records.length, 1);
  assert.match(renderCodeSearch(data), /Unsupported fields: description/);
  assert.equal(calls.length, 4);
  const unsupported = fixture(() => ({ errors: [{ message: 'Cannot query field "sys_script_include" on type "GlideRecord_Query".' }] }));
  assert.equal((await search(unsupported.app)).status, 'unsupported');
});

test('configured tables, extra fields and filters are additive and scope-constrained on every NQ branch', async () => {
  const configuration = [{ table: 'u_code', search_fields: 'title,u_script', additional_filter: 'active=true^NQcategory=custom^EQ' }];
  const { app, calls } = fixture((query, offset) => response(offset ? [] : [{ sys_id: { value: id(1) }, sys_scope: { value: id(20) }, title: { value: 'Needle' }, u_script: { value: 'needle' } }], 'u_code'), configuration);
  const data = await search(app, { table: 'u_code', scope: 'x_app', allScopes: false });
  assert.equal(data.recordCount, 1);
  assert.equal(data.fieldCount, 2);
  assert.equal(data.status, 'complete');
  assert.match(new URL(calls[0].url).searchParams.get('sysparm_query'), /search_group.name=sn_devstudio.Studio Search Group/);
  const query = JSON.parse(calls[1].options.body).query;
  assert.match(query, /active=true\^sys_scope.scope=x_app\^titleLIKEneedle\^ORu_scriptLIKEneedle\^NQcategory=custom\^sys_scope.scope=x_app\^titleLIKEneedle\^ORu_scriptLIKEneedle/);
  const existing = fixture(() => response([]), [{ table: 'sys_script_include', search_fields: 'u_script', additional_filter: 'active=true' }]);
  const report = await search(existing.app);
  assert.deepEqual(report.coverage[0].fields, ['name', 'script', 'description', 'u_script']);
  assert.match(JSON.parse(existing.calls[1].options.body).query, /active=true/);
});

test('configuration unavailable or malformed is partial, ACL/auth denial aborts without fallback', async () => {
  for (const failure of [new Error('404 not found'), new Error('Unreadable response')]) {
    const { app } = fixture({});
    const original = app.sdk.request;
    app.sdk.request = (url, options) => options ? original(url, options) : Promise.reject(failure);
    assert.equal((await search(app)).configuration.status, 'partial');
  }
  const malformed = fixture({}, [{ table: 'u_code', search_fields: 'u_script' }]);
  assert.equal((await search(malformed.app)).status, 'partial');
  for (const error of [new Error('401 Unauthorized'), new Error('403 Forbidden'), Object.assign(new Error('No saved credentials'), { code: 'auth_error' })]) {
    const { app, calls } = fixture({});
    app.sdk.request = async () => { throw error; };
    await assert.rejects(search(app), error);
    assert.equal(calls.length, 0);
  }
  for (const payload of [{ errors: [{ message: 'Forbidden' }] }, { result: { errors: [{ message: 'rejected', extensions: { code: 'ACCESS_DENIED' } }] } }]) {
    const { app, calls } = fixture(() => payload);
    await assert.rejects(search(app), /Forbidden|access denied/);
    assert.equal(calls.length, 2);
  }
  const unauthenticated = fixture(() => ({ errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] }));
  await assert.rejects(search(unauthenticated.app), { code: 'auth_error' });
});

test('invalid terms, identifiers and budgets fail before any transport call; quoted terms remain data', async () => {
  for (const options of [{ term: '' }, { term: 'x^NQsys_idISNOTEMPTY' }, { term: 'x\nfoo' }, { term: 'javascript:gs.info(1)' }, { scope: 'x^ORactive=true' }, { table: 'x) { sys_id' }, { limit: 0 }, { pageSize: 0.5 }, { maxPages: Infinity }, { maxRequests: 10001 }, { allScopes: false }]) {
    const { app, calls } = fixture({});
    await assert.rejects(search(app, options), { code: 'usage_error' });
    assert.equal(calls.length, 0);
  }
  const { app, calls } = fixture({});
  await search(app, { term: 'a"\\b' });
  const query = JSON.parse(calls[1].options.body).query;
  const encoded = JSON.parse(query.match(/queryConditions: ("(?:\\.|[^"\\])*"), pagination/)[1]);
  assert.equal(encoded, 'nameLIKEa"\\b^ORscriptLIKEa"\\b^ORdescriptionLIKEa"\\b^ORDERBYsys_id');
});

test('historical catalog is explicit, broad and does not include Flow internals', () => {
  assert.ok(Object.keys(CODESEARCH_CATALOG).length >= 45);
  for (const table of ['sp_widget', 'sys_variable_value', 'sys_dictionary', 'wf_activity_definition', 'sys_script_include', 'sys_ui_page']) assert.ok(CODESEARCH_CATALOG[table]);
  assert.equal(CODESEARCH_CATALOG.sys_hub_flow, undefined);
  assert.ok(CODESEARCH_CATALOG.content_block_programmatic.includes('programmatic_content'));
});

test('configured scripts and ordering directives never execute or drop restrictions', async () => {
  for (const filter of ['name=javascript:gs.info(1)', 'active=true^ORDERBYname', 'ORDERBYname', 'active=true^EQ^name=test']) {
    const { app, calls } = fixture({}, [{ table: 'sys_script_include', search_fields: 'script', additional_filter: filter }]);
    const data = await search(app);
    assert.equal(data.status, 'partial');
    assert.match(data.coverage[0].reason, /query control directives/);
    assert.equal(calls.length, 1);
  }
});

test('real CLI authenticates a read-only profile and preserves every output format plus extraction', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-codesearch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let denied = false;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/angular.do')) { res.end(JSON.stringify({ result: 'fixture' })); return; }
    if (req.url.startsWith('/api/now/table/sn_codesearch_table')) { res.end(JSON.stringify({ result: [] })); return; }
    if (req.url === '/api/now/graphql') {
      if (denied) { res.end(JSON.stringify({ result: { errors: [{ message: 'Forbidden by ACL' }] } })); return; }
      const offset = Number(JSON.parse(body).query.match(/offset: (\d+)/)[1]);
      res.end(JSON.stringify(response(offset ? [] : [row(1)]))); return;
    }
    res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const instance = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(dir, 'servicenow');
  await fs.mkdir(path.join(configDir, 'credentials'), { recursive: true });
  const config = JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: instance, username: 'fixture', auth_method: 'basic', read_only: true } } });
  await fs.writeFile(path.join(configDir, 'config.json'), config);
  await fs.writeFile(path.join(configDir, 'credentials', `${credKey(instance, 'fixture')}.json`), JSON.stringify({ auth_method: 'basic', username: 'fixture', password: 'offline-fixture' }));
  const environment = { ...env, PATH: '', XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: dir, JSN_NO_HEADER: '1' };
  for (const key of Object.keys(environment)) if (/^(SN_|SERVICENOW_)/i.test(key)) delete environment[key];
  const execute = promisify(execFile);
  const run = (args) => execute(process.execPath, [CLI, 'codesearch', 'search', 'needle', '--table', 'sys_script_include', ...args], { env: environment, timeout: 20000 });
  const json = JSON.parse((await run(['--json'])).stdout);
  assert.equal(json.data.status, 'complete');
  assert.equal(json.data.matchCount, 3);
  assert.equal(Object.hasOwn(json.data, '_formatted'), false);
  assert.equal((await run(['--get', 'data.recordCount'])).stdout.trim(), '1');
  for (const format of ['auto', 'json', 'styled', 'markdown', 'csv', 'quiet']) {
    const result = await run(['--format', format]);
    if (['auto', 'json'].includes(format)) assert.equal(JSON.parse(result.stdout).data.recordCount, 1);
    if (format === 'styled') {
      assert.match(result.stdout, /1 record\(s\), 1 field\(s\), 3 match\(es\) — complete/);
      assert.match(result.stdout, /jsn flows search/);
      if (process.env.JSN_CODESEARCH_CAPTURE) await fs.writeFile(process.env.JSN_CODESEARCH_CAPTURE, result.stdout);
    }
    if (['markdown', 'csv'].includes(format)) assert.match(result.stdout, /sys_script_include/);
  }
  assert.ok(calls.some((call) => call.auth === `Basic ${Buffer.from('fixture:offline-fixture').toString('base64')}`));
  assert.ok(calls.every((call) => call.method === 'GET' || (call.method === 'POST' && (call.path === '/api/now/graphql' || call.path.startsWith('/angular.do')))));
  assert.ok(calls.filter((call) => call.path === '/api/now/graphql').every((call) => JSON.parse(call.body).query.startsWith('query {')));
  assert.ok(calls.every((call) => !call.path.includes('sn_codesearch/code_search') && !call.path.includes('processflow')));
  assert.equal(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'), config);
  denied = true;
  await assert.rejects(run(['--json']), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stdout + error.stderr, /Forbidden by ACL/);
    assert.equal(JSON.parse(error.stdout || error.stderr).ok, false);
    return true;
  });
});
