import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapiCmd } from '../src/commands/scrapi.js';
import { isMutationCommand } from '../src/mutations.js';
import { errAPI } from '../src/errors.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const CLI = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
const res = (httpMethod, route, description) => ({ httpMethod, route, description });
const CATALOGUE = {
  now: {
    'Table API': { apiName: 'now/table', description: 'CRUD on existing tables', scripted: false, versions: {
      latest: { resources: [res('GET', '/now/table/{tableName}', 'Retrieve records from a table'), res('POST', '/now/table/{tableName}', 'Create a record')] },
      v2: { resources: [res('GET', '/now/v2/table/{tableName}', 'Retrieve records from a table')] } } },
    'Attachment API': { apiName: 'now/attachment', description: 'Files on records', versions: { latest: { resources: [res('POST', '/now/attachment/file', 'Upload a file')] } } },
  },
  x_acme: { 'Generic API': { apiName: 'x_acme/generic', description: 'Acme', scripted: true, versions: { v1: { resources: [res('DELETE', '/x_acme/generic/widget/{id}', 'Remove a Widget')] } } } },
  sn_udc: { 'Generic API': { apiName: 'sn_udc/generic', description: 'UDC', versions: { v1: { resources: [res('GET', '/sn_udc/generic/ping', 'Ping')] } } } },
};
const NAMESPACES = ['crypto', ...Object.keys(CATALOGUE)];
const SPEC_JSON = '{\n  "openapi" : "3.0.1",\n  "info" : { "title" : "Table API" }\n}';
const SPEC_YAML = '---\nopenapi: "3.0.1"\ninfo:\n  title: "Table API"\n';

function fixture({ services, spec } = {}) {
  const commands = [];
  scrapiCmd(fn => fn).builder({ command(c) { commands.push(c); return this; } });
  const handler = name => commands.find(c => c.command.split(' ')[0] === name).handler;
  const calls = [];
  let data, meta, out = '';
  const app = {
    getEffectiveInstance: () => 'https://fixture.invalid',
    requireInstance() {},
    output: { writer: { write: (s) => { out += s; } } },
    ok(value, opts) { data = value; meta = opts; },
    sdk: {
      request: async (url, opts) => {
        calls.push({ url, opts });
        const u = new URL(url);
        if (u.pathname === '/api/now/doc/namespaces') return { result: NAMESPACES };
        const ns = u.searchParams.get('namespace');
        if (services) return services(ns);
        return { result: ns ? (CATALOGUE[ns] ? { [ns]: CATALOGUE[ns] } : {}) : CATALOGUE };
      },
      rawRequest: async (url, opts) => {
        calls.push({ url, opts, raw: true });
        if (spec) return spec(url);
        return new URL(url).searchParams.get('format') === 'yaml' ? SPEC_YAML : SPEC_JSON;
      },
    },
  };
  return {
    calls, get data() { return data; }, get meta() { return meta; }, get out() { return out; },
    search: (args) => handler('search')({ limit: 50, ...args }, app),
    spec: (args) => handler('spec')(args, app),
  };
}

test('scrapi search and spec are registered reads with their options; create stays a mutation', () => {
  for (const [sub, options] of [['search', ['namespace', 'method', 'limit']], ['spec', ['namespace', 'yaml']]]) {
    const result = spawnSync(process.execPath, [CLI, 'scrapi', sub, '--help'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const option of options) assert.ok(result.stdout.includes(`--${option}`), `${sub} --${option}`);
  }
  assert.equal(isMutationCommand({ _: ['scrapi', 'search', 'table'] }), false);
  assert.equal(isMutationCommand({ _: ['scrapi', 'spec', 'Table API'] }), false);
  assert.equal(isMutationCommand({ _: ['scrapi', 'create'] }), true);
});

test('search matches API name, route (which carries the namespace) and descriptions case-insensitively in one read', async () => {
  const f = fixture();
  await f.search({ term: 'TABLE' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://fixture.invalid/api/now/doc/services');
  assert.equal(f.calls[0].opts.method, 'GET');
  assert.deepEqual(f.data.records[0], { namespace: 'now', api: 'Table API', version: 'latest', method: 'GET', route: '/api/now/table/{tableName}', description: 'Retrieve records from a table' });
  assert.deepEqual(f.data.records.map(r => r.route), ['/api/now/table/{tableName}', '/api/now/table/{tableName}', '/api/now/v2/table/{tableName}']);
  for (const [term, routes] of [['widget', ['/api/x_acme/generic/widget/{id}']], ['acme', ['/api/x_acme/generic/widget/{id}']], ['upload', ['/api/now/attachment/file']], ['crud', ['/api/now/table/{tableName}', '/api/now/table/{tableName}', '/api/now/v2/table/{tableName}']], ['nothing-here', []]]) {
    const g = fixture();
    await g.search({ term });
    assert.deepEqual(g.data.records.map(r => r.route), routes, term);
    assert.equal(g.data.total, routes.length);
  }
});

test('--namespace narrows the read and --method the rows', async () => {
  const f = fixture();
  await f.search({ term: 'a', namespace: 'now', method: 'post' });
  assert.equal(f.calls[0].url, 'https://fixture.invalid/api/now/doc/services?namespace=now');
  assert.deepEqual(f.data.records.map(r => `${r.method} ${r.route}`), ['POST /api/now/table/{tableName}', 'POST /api/now/attachment/file']);
});

test('--limit bounds the rows and the total says how many matched', async () => {
  const f = fixture();
  await f.search({ term: 'api', limit: 2 });
  assert.equal(f.data.records.length, 2);
  assert.equal(f.data.count, 2);
  assert.equal(f.data.total, 6);
  assert.match(f.meta.summary, /2 of 6 REST endpoints/);
  assert.match(f.meta.summary, /--limit/);
});

test('an unknown namespace is a usage error naming the nearest real one, never zero matches', async () => {
  for (const run of [f => f.search({ term: 'table', namespace: 'NOW' }), f => f.spec({ api: 'Table API', namespace: 'nwo' })]) {
    const f = fixture();
    await assert.rejects(run(f), (err) => err.code === 'usage_error' && /No REST API namespace/.test(err.message) && /--namespace now\b/.test(err.hint));
    assert.deepEqual(f.calls.map(c => new URL(c.url).pathname), ['/api/now/doc/services', '/api/now/doc/namespaces']);
  }
  const f = fixture();
  await assert.rejects(f.search({ term: 'x', namespace: 'crypto' }), (err) => err.code === 'usage_error' && /crypto.*publishes no REST APIs/.test(err.message));
});

test('invalid input is refused before any request', async () => {
  const f = fixture();
  for (const args of [{ term: '' }, { term: '  ' }, { term: 'x', method: 'FETCH' }, { term: 'x', limit: 0 }, { term: 'x', limit: 1.5 }, { term: 'x', namespace: '' }]) {
    await assert.rejects(f.search(args), (err) => err.code === 'usage_error', JSON.stringify(args));
  }
  for (const args of [{ api: '' }, { api: 'Table API', namespace: ' ' }]) {
    await assert.rejects(f.spec(args), (err) => err.code === 'usage_error', JSON.stringify(args));
  }
  assert.equal(f.calls.length, 0);
});

test('a missing, malformed or empty catalogue is never reported as no matches', async () => {
  for (const body of [{ result: [] }, {}, null, { result: 'x' }, { result: { now: { 'Table API': { versions: { v1: { resources: [{ httpMethod: 'GET' }] } } } } } }]) {
    const f = fixture({ services: () => body });
    await assert.rejects(f.search({ term: 'table' }), (err) => err.code === 'malformed_response', JSON.stringify(body));
  }
  const empty = fixture({ services: () => ({ result: {} }) });
  await assert.rejects(empty.search({ term: 'table' }), /catalogue came back empty/);
  const denied = fixture({ services: () => { throw errAPI(403, ''); } });
  await assert.rejects(denied.search({ term: 'table' }), (err) => err.status === 403);
});

test('spec resolves the exact title, then apiName, then a unique substring, and asks for any media type', async () => {
  for (const [api, namespace, name] of [['table api', 'now', 'Table API'], ['now/attachment', 'now', 'Attachment API'], ['ATTACH', 'now', 'Attachment API']]) {
    const f = fixture();
    await f.spec({ api });
    const raw = f.calls.find(c => c.raw);
    const u = new URL(raw.url);
    assert.equal(u.pathname, '/api/now/doc/oas_3');
    assert.deepEqual(Object.fromEntries(u.searchParams), { namespace, name, format: 'json' });
    assert.equal(raw.opts.method, 'GET');
    // oas_3 answers Accept: application/json with 406.
    assert.equal(raw.opts.headers.Accept, '*/*');
    assert.equal(f.out, `${SPEC_JSON}\n`);
    assert.equal(f.data, undefined);
  }
});

test('an exact title or apiName wins over names that only contain it', async () => {
  const api = apiName => ({ apiName, versions: {} });
  const services = () => ({ result: { now: { 'Import Set API': api('now/import'), 'Import Set API (scoped)': api('now/import_scoped') } } });
  for (const wanted of ['import set api', 'now/import']) {
    const f = fixture({ services });
    await f.spec({ api: wanted });
    assert.equal(new URL(f.calls[1].url).searchParams.get('name'), 'Import Set API', wanted);
  }
});

test('an ambiguous or unknown spec name fails before the export, listing candidates with namespaces', async () => {
  const f = fixture();
  await assert.rejects(f.spec({ api: 'Generic API' }), (err) => err.code === 'ambiguous' && /--namespace x_acme/.test(err.hint) && /--namespace sn_udc/.test(err.hint));
  await assert.rejects(f.spec({ api: 'api' }), (err) => err.code === 'ambiguous' && /Table API/.test(err.hint) && /Attachment API/.test(err.hint));
  await assert.rejects(f.spec({ api: 'no such thing' }), (err) => err.code === 'usage_error' && /No REST API matches "no such thing"/.test(err.message) && /jsn scrapi search/.test(err.hint));
  assert.equal(f.calls.filter(c => c.raw).length, 0);
  const g = fixture();
  await g.spec({ api: 'Generic API', namespace: 'sn_udc' });
  assert.equal(g.calls[0].url, 'https://fixture.invalid/api/now/doc/services?namespace=sn_udc');
  assert.equal(new URL(g.calls[1].url).searchParams.get('namespace'), 'sn_udc');
});

test('spec prints YAML verbatim, and --json wraps the document in the envelope', async () => {
  const f = fixture();
  await f.spec({ api: 'Table API', yaml: true });
  assert.equal(new URL(f.calls[1].url).searchParams.get('format'), 'yaml');
  assert.equal(f.out, SPEC_YAML);
  const g = fixture();
  await g.spec({ api: 'Table API', format: 'json' });
  assert.equal(g.out, '');
  assert.deepEqual(g.data, { namespace: 'now', api: 'Table API', format: 'json', spec: JSON.parse(SPEC_JSON) });
  const h = fixture();
  await h.spec({ api: 'Table API', yaml: true, format: 'json' });
  assert.equal(h.data.spec, SPEC_YAML);
});

test('a spec body that is not an OpenAPI document is never printed as one', async () => {
  for (const [yaml, body] of [[false, '<html>login</html>'], [false, '{"result":{}}'], [true, '<html>login</html>'], [false, '']]) {
    const f = fixture({ spec: () => body });
    await assert.rejects(f.spec({ api: 'Table API', yaml }), (err) => err.code === 'malformed_response', body);
    assert.equal(f.out, '');
  }
});

test('real CLI: search and spec over a loopback instance on a read-only profile', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, accept: req.headers.accept });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/now/doc/namespaces') return res.end(JSON.stringify({ result: NAMESPACES }));
    if (url.pathname === '/api/now/doc/services') {
      const ns = url.searchParams.get('namespace');
      const catalogue = { ...CATALOGUE, now: { ...CATALOGUE.now, 'Stale API': { apiName: 'now/stale', versions: {} } } };
      return res.end(JSON.stringify({ result: ns ? (catalogue[ns] ? { [ns]: catalogue[ns] } : {}) : catalogue }));
    }
    if (url.pathname === '/api/now/doc/oas_3') {
      if (/application\/json/.test(req.headers.accept || '')) { res.statusCode = 406; return res.end('{"error":{"message":"requested service can not respond in any media type specified in the Accept header","detail":null},"status":"failure"}'); }
      if (url.searchParams.get('name') === 'Stale API') { res.statusCode = 404; return res.end('{"error":{"message":"Not Found","detail":"Version latest not found for now/Stale API"},"status":"failure"}'); }
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.end(url.searchParams.get('format') === 'yaml' ? SPEC_YAML : SPEC_JSON);
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jsn-scrapi-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const childEnv = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, CLI, ...args], { env: childEnv, cwd: dir, timeout: 20000 });
  try {
    const search = JSON.parse((await run(['scrapi', 'search', 'table', '--json'])).stdout);
    assert.equal(search.ok, true);
    assert.equal(search.data.total, 3);
    assert.equal((await run(['scrapi', 'search', 'table', '--get', 'data.records.0.route'])).stdout.trim(), '"/api/now/table/{tableName}"');
    const human = (await run(['scrapi', 'search', 'upload', '--format', 'styled'])).stdout;
    assert.match(human, /POST\s+\/api\/now\/attachment\/file\s+now · Attachment API · latest/);
    assert.equal((await run(['scrapi', 'spec', 'Table API'])).stdout, `${SPEC_JSON}\n`);
    assert.equal((await run(['scrapi', 'spec', 'table api', '--yaml'])).stdout, SPEC_YAML);
    assert.equal(JSON.parse((await run(['scrapi', 'spec', 'Table API', '--json'])).stdout).data.spec.openapi, '3.0.1');
    await assert.rejects(run(['scrapi', 'spec', 'Stale API', '--json']), (err) => JSON.parse(err.stdout).error.includes('Version latest not found for now/Stale API'));
    await assert.rejects(run(['scrapi', 'search', 'table', '--namespace', 'nwo', '--json']), (err) => /--namespace now/.test(JSON.parse(err.stdout).hint));
    const before = calls.length;
    for (const args of [['search'], ['search', 'table', '--typo'], ['search', 'table', '--method', 'FETCH'], ['spec'], ['spec', 'x', '--typo']]) {
      await assert.rejects(run(['scrapi', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    assert.ok(calls.every(call => (call.pathname.startsWith('/api/now/doc/') && call.method === 'GET') || call.pathname === '/angular.do'));
    assert.ok(calls.filter(call => call.pathname === '/api/now/doc/oas_3').every(call => call.accept === '*/*'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
