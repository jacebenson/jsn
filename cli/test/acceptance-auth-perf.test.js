import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAuthFixtures, fixtureEnvironment, scenarios as authScenarios } from './acceptance/auth.mjs';
import { beginSuite, endSuite, observeEnvironment, publicSummary, validateCapture } from './acceptance/performance.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const scratch = process.env.TMPDIR || os.tmpdir();
const ok = data => ({ exitCode: 0, stdout: '', stderr: '', json: { ok: true, data } });
const fail = (status = 401) => ({ exitCode: 1, stdout: '', stderr: '', json: { ok: false, error: { code: status === 401 ? 'auth_error' : 'api_error', message: `HTTP ${status}`, status } } });
const scenario = id => authScenarios.find(s => s.id === id);
async function context(t) {
  const outputDir = await fs.mkdtemp(path.join(scratch, 'jsn-auth-perf-offline-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const ctx = { outputDir, runKey: 'offline_run_1234', mode: 'pdi', profile: 'fixture', expectedHost: 'localhost', state: new Map(), calls: [], artifacts: [], db: new Map() };
  ctx.registerArtifact = async artifact => { ctx.artifacts.push(artifact); };
  ctx.read = async (table, options) => {
    if (table === 'domain') throw new Error('Invalid table domain');
    if (table === 'sys_user_has_role') return options.id ? ctx.db.get(options.id) : [];
    if (table === 'sys_user_role') return [{ sys_id: 'c'.repeat(32), name: 'itil' }];
    return ctx.db.get(options.id);
  };
  ctx.command = async (args, options = {}) => {
    ctx.calls.push({ args, options });
    if (args[0] === 'auth' && args[1] === 'status') return ok({ profiles: [{ name: ctx.profile, verified: true, diagnostics: { auth_method: 'oauth', probe: { status: 'succeeded' } } }] });
    if (args[0] === 'users' && args[1] === 'create') {
      const payload = JSON.parse(await fs.readFile(args[args.indexOf('--data-file') + 1], 'utf8'));
      const id = String(ctx.db.size + 1).padStart(32, '0');
      ctx.db.set(id, { ...payload, sys_id: id });
      return ok({ sys_id: id });
    }
    if (args[0] === 'records' && args[1] === 'create') {
      const payload = JSON.parse(await fs.readFile(args[args.indexOf('--data-file') + 1], 'utf8'));
      assert.equal(ctx.artifacts.some(a => a.table === 'sys_user' && a.id === payload.user), true);
      const id = 'd'.repeat(32 - ctx.artifacts.length) + String(ctx.artifacts.length).padStart(ctx.artifacts.length, '0');
      ctx.db.set(id, { ...payload, sys_id: id });
      return ok({ sys_id: id });
    }
    const users = ctx.state.get('auth.fixtures')?.users || [];
    const identity = users.find(u => u.username === options.env?.SN_USERNAME);
    if (args[0] === 'auth' && args[1] === 'login') return args.includes('--gck') ? fail() : ok({ authenticated: true });
    if (args[0] === 'users' && args[1] === 'update') {
      if (options.env) return fail(403);
      const payloadFile = args.indexOf('--data-file');
      if (payloadFile >= 0) Object.assign(ctx.db.get(args[2]), JSON.parse(await fs.readFile(args[payloadFile + 1], 'utf8')));
      return ok({ sys_id: args[2] });
    }
    if (args[0] === 'records' && args[1] === 'list') {
      if (!identity || options.env.SN_PASSWORD !== ctx.db.get(identity.id).user_password) return fail();
      return ok({ records: [{ sys_id: identity.id, user_name: identity.username }] });
    }
    throw new Error('Unexpected offline command');
  };
  return ctx;
}

test('invalid fixture configurations refuse every command before network/write', async t => {
  for (const change of [ctx => { ctx.mode = 'readonly'; }, ctx => { ctx.runKey = '../unsafe'; },
    ctx => ctx.state.set('auth.config', { roles: ['admin'] }),
    ctx => ctx.state.set('auth.config', { roles: ['security_admin'] }),
    ctx => ctx.state.set('auth.config', { domain: 'not-an-id' }),
    ctx => ctx.state.set('auth.config', { surprise: true }),
    ctx => { ctx.expectedHost = 'evil.test/path'; }]) {
    const ctx = await context(t);
    change(ctx);
    await assert.rejects(() => createAuthFixtures(ctx));
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.artifacts.length, 0);
  }
});

test('wrong bootstrap identity/method and unknown domain refuse account allocation', async t => {
  const ctx = await context(t);
  ctx.command = async args => { ctx.calls.push({ args }); return ok({ profiles: [{ name: ctx.profile, verified: true, diagnostics: { auth_method: 'basic', probe: { status: 'succeeded' } } }] }); };
  await assert.rejects(() => createAuthFixtures(ctx), /Verified OAuth/);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.artifacts.length, 0);
  const unknown = await context(t);
  unknown.read = async () => [];
  assert.equal((await createAuthFixtures(unknown)).status, 'blocked');
  assert.equal(unknown.calls.length, 1);
});

test('OAuth account setup checks real options, settings, private payloads and ownership before children', async t => {
  const ctx = await context(t);
  assert.equal((await createAuthFixtures(ctx)).status, 'passed');
  assert.equal(ctx.artifacts.length, 2);
  assert.equal(ctx.artifacts.every(a => a.table === 'sys_user' && a.cleanupArgs[2] === a.id), true);
  const users = ctx.state.get('auth.fixtures').users;
  for (const user of users) {
    const file = path.join(user.root, 'create.json');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const payload = JSON.parse(await fs.readFile(file));
    assert.equal(payload.web_service_access_only, user.kind === 'basic');
    assert.equal(payload.password_needs_reset, false);
    assert.equal(JSON.stringify(ctx.artifacts).includes(user.password), false);
    assert.equal(ctx.calls.some(c => c.args.includes(user.password)), false);
  }
  assert.equal((await scenario('auth.basic-valid-permissions').run(ctx)).status, 'passed');
  assert.equal((await scenario('auth.basic-invalid').run(ctx)).status, 'passed');
  assert.equal((await scenario('auth.basic-rotation').run(ctx)).status, 'passed');
  assert.equal((await scenario('auth.cookie-invalid').run(ctx)).status, 'passed');
  for (const id of ['auth.cookie-valid-permissions', 'auth.cookie-expired-renewal', 'auth.basic-expired-session']) {
    await assert.rejects(() => scenario(id).run(ctx), error => error.status === 'blocked-prerequisite' && error.message.length > 40);
  }
});

test('role links are created only under checkpointed users and exact cleanup dependencies', async t => {
  const ctx = await context(t);
  ctx.state.set('auth.config', { roles: ['itil'] });
  await createAuthFixtures(ctx);
  const links = ctx.artifacts.filter(a => a.table === 'sys_user_has_role');
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.dependsOn.length, 1);
    assert.ok(ctx.artifacts.some(a => a.table === 'sys_user' && a.id === link.dependsOn[0]));
    assert.ok(link.cleanupArgs.includes(link.id));
    assert.equal(link.cleanupArgs.some(arg => /LIKE|STARTSWITH|--query/.test(arg)), false);
  }
});

test('wrong authenticated fixture identity fails before permission mutation', async t => {
  const ctx = await context(t);
  await createAuthFixtures(ctx);
  const original = ctx.command;
  ctx.command = async (args, options) => args[0] === 'records' && args[1] === 'list'
    ? ok({ records: [{ sys_id: 'f'.repeat(32), user_name: 'wrong' }] }) : original(args, options);
  const prior = ctx.calls.length;
  await assert.rejects(() => scenario('auth.basic-valid-permissions').run(ctx), /identity\/readback failed/);
  assert.equal(ctx.calls.slice(prior).some(c => c.args[0] === 'users' && c.args[1] === 'update'), false);
});

test('denied-operation provider readback catches silent unexpected mutation', async t => {
  const ctx = await context(t);
  await createAuthFixtures(ctx);
  const original = ctx.command;
  ctx.command = async (args, options) => {
    if (args[0] === 'users' && args[1] === 'update' && options?.env) {
      ctx.db.get(args[2]).first_name = 'unexpected';
      return fail(403);
    }
    return original(args, options);
  };
  await assert.rejects(() => scenario('auth.basic-valid-permissions').run(ctx), /changed an owned fixture/);
});

test('dropped login settings stop immediately with parent already registered', async t => {
  const ctx = await context(t);
  const original = ctx.read;
  ctx.read = async (table, opts) => {
    const row = await original(table, opts);
    if (table === 'sys_user' && row) { const copy = { ...row }; delete copy.web_service_access_only; return copy; }
    return row;
  };
  await assert.rejects(() => createAuthFixtures(ctx), /settings were dropped/);
  assert.equal(ctx.artifacts.length, 1);
  assert.equal(ctx.calls.some(c => c.args[0] === 'records' && c.args[1] === 'create'), false);
});

test('environment isolates credential precedence, config, cache, data and keyring access', async t => {
  const ctx = await context(t);
  const env = fixtureEnvironment(ctx, path.join(ctx.outputDir, 'owned'), 'fixture-user', 'offline-only-secret');
  assert.equal(env.SERVICENOW_OAUTH_TOKEN, '');
  assert.equal(env.SN_LOCALHOST_USERNAME, '');
  assert.equal(env.SN_LOCALHOST_PASSWORD, '');
  assert.equal(env.SN_PASSWORD, 'offline-only-secret');
  assert.ok(env.PATH.endsWith('/no-keyring'));
});

const collectorNames = ['platform_health', 'transactions', 'error_warning_summary', 'event_queue', 'ecc_queue', 'flow_executions', 'record_counts', 'scheduled_and_cleanup'];
const capture = id => ({ capture_schema_version: 1, run_id: id, status: 'complete', username: 'private-user', instance: 'https://private-instance',
  collectors: collectorNames.map(name => ({ name, status: 'success', reason: 'private-token', data: { metrics: { 'private-user': 7 } } })) });

test('perf schema rejects malformed versions, missing/duplicate/unknown collectors', () => {
  const valid = capture('20261108T000000Z');
  assert.equal(validateCapture(valid), valid);
  for (const invalid of [{ ...valid, capture_schema_version: 2 }, { ...valid, run_id: '../escape' },
    { ...valid, collectors: [] }, { ...valid, collectors: [...valid.collectors.slice(1), valid.collectors[1]] },
    { ...valid, collectors: valid.collectors.map((c, i) => i === 0 ? { ...c, status: 'fake-success' } : c) }]) {
    assert.throws(() => validateCapture(invalid));
  }
});

test('suite hooks call only capture/show/list/compare, retain private evidence and omit raw secrets', async t => {
  const ctx = await context(t);
  const stored = [];
  ctx.command = async (args, options) => {
    ctx.calls.push({ args, options });
    assert.ok(options.env.JSN_DATA_HOME.startsWith(ctx.outputDir));
    if (args[1] === 'capture') { const run = capture(`20261108T00000${stored.length}Z`); stored.push(run); return ok(run); }
    if (args[1] === 'show') return ok(stored.find(r => r.run_id === args[2]));
    if (args[1] === 'list') return ok({ runs: stored, count: stored.length });
    return ok({ baseline: stored[0], new: stored[1] });
  };
  await beginSuite(ctx);
  assert.deepEqual(ctx.calls.map(c => c.args[1]), ['capture', 'show']);
  await endSuite(ctx);
  assert.deepEqual(ctx.calls.map(c => c.args[1]), ['capture', 'show', 'capture', 'show', 'list', 'compare']);
  const state = ctx.state.get('performance.suite');
  assert.deepEqual(state.coverage, { before: 'complete', after: 'complete', compare: 'passed', list: 'passed' });
  const summary = publicSummary({ revision: 'a'.repeat(40), version: '5.0.0', performance: state,
    timings: [{ id: 'auth.basic-invalid', durationMs: 3.2, status: 'passed', reason: 'private-token', username: 'private-user' }] });
  const serialized = JSON.stringify(summary);
  for (const secret of ['private-token', 'private-user', 'private-instance', '20261108T']) assert.equal(serialized.includes(secret), false);
  assert.equal(summary.performance.releaseGate, false);
  assert.equal((await fs.stat(path.join(state.root, 'before.json'))).mode & 0o777, 0o600);
  await assert.rejects(() => endSuite(ctx), /already ended/);
});

test('capture failures remain visible but never assert a performance release gate', async t => {
  const ctx = await context(t);
  ctx.command = async args => { ctx.calls.push({ args }); return fail(403); };
  await beginSuite(ctx);
  const summary = await endSuite(ctx);
  assert.equal(summary.releaseGate, false);
  assert.deepEqual(summary.coverage, { before: 'failed', after: 'failed', compare: 'blocked', list: 'failed' });
  assert.equal(ctx.calls.length, 3);
});

test('domain evidence is observed, read-only, and unknown for ACL/network failures', async t => {
  const ctx = await context(t);
  assert.equal((await observeEnvironment(ctx)).domainSeparation, 'not-installed');
  ctx.read = async () => [{ sys_id: 'global', sys_domain: 'global' }];
  const observed = await observeEnvironment(ctx);
  assert.equal(observed.domainTable, 'readable');
  assert.equal(observed.domainSeparation, 'unknown');
  ctx.read = async () => { throw new Error('403 forbidden'); };
  assert.equal((await observeEnvironment(ctx)).domainTable, 'unknown');
  assert.equal(ctx.calls.length, 0);
});

test('public schema deliberately refuses invalid provenance and timing inputs', () => {
  const valid = { revision: 'a'.repeat(40), version: '5.0.0', timings: [{ id: 'auth.basic', durationMs: 1, status: 'passed' }] };
  for (const invalid of [{ ...valid, revision: 'token' }, { ...valid, version: '5.0.0 https://private' },
    { ...valid, timings: [{ id: 'private-user@instance', durationMs: 1, status: 'passed' }] },
    { ...valid, timings: [{ id: 'auth.basic', durationMs: -1, status: 'passed' }] },
    { ...valid, timings: [...valid.timings, ...valid.timings] },
    { ...valid, timings: [{ id: 'auth.basic', durationMs: 1, status: 'silently-skipped' }] }]) assert.throws(() => publicSummary(invalid));
});

async function loopback(t) {
  const root = await fs.mkdtemp(path.join(scratch, 'jsn-auth-perf-cli-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('sysparm_type'), body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/api/now/table/sys_user') return res.end(JSON.stringify({ result: { ...JSON.parse(body), sys_id: '1'.repeat(32) } }));
    if (url.pathname.startsWith('/api/now/stats/')) return res.end(JSON.stringify({ result: { stats: { count: '0' }, groups: [] } }));
    if (url.pathname === '/api/now/table/sys_user') return res.end(JSON.stringify({ result: [{ sys_id: '2'.repeat(32), user_name: 'offline-user' }] }));
    if (url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(root, 'config', 'servicenow'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'offline', profiles: { offline: { instance_url: origin, username: 'offline-user', auth_method: 'oauth' } } }));
  const env = { HOME: root, PATH: path.dirname(process.execPath), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), JSN_DATA_HOME: path.join(root, 'data'),
    SERVICENOW_OAUTH_TOKEN: 'synthetic-loopback-only-token', SERVICENOW_INSTANCE_URL: origin, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', CI: '1' };
  const command = async (args, options = {}) => {
    const run = await exec(process.execPath, [cli, ...args, '--profile', 'offline', '--instance', origin], { cwd: root, env: { ...env, ...options.env }, timeout: 20000, maxBuffer: 2 ** 20 });
    return { exitCode: 0, stdout: run.stdout, stderr: run.stderr, json: JSON.parse(run.stdout) };
  };
  return { root, requests, command };
}

test('real pinned CLI users create accepts private data-file without secret argv', async t => {
  const fixture = await loopback(t);
  const file = path.join(fixture.root, 'user.json');
  await fs.writeFile(file, JSON.stringify({ user_name: 'offline-fixture', user_password: 'synthetic-password', web_service_access_only: true, password_needs_reset: false }), { mode: 0o600 });
  const result = await fixture.command(['users', 'create', '--data-file', file, '--json']);
  assert.equal(result.json.ok, true);
  const writes = fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/now/table/'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/now/table/sys_user');
  assert.equal(writes[0].body.user_password, 'synthetic-password');
  assert.equal(writes[0].body.web_service_access_only, true);
});

test('real pinned CLI perf suite hooks persist/read/list/compare synthetic loopback captures', async t => {
  const fixture = await loopback(t);
  const ctx = { outputDir: fixture.root, runKey: 'offline_perf_1234', state: new Map(), command: fixture.command,
    read: async () => { throw new Error('ACL unknown'); } };
  await beginSuite(ctx);
  const result = await endSuite(ctx);
  assert.equal(result.coverage.before, 'complete');
  assert.equal(result.coverage.after, 'complete');
  assert.equal(result.coverage.compare, 'passed');
  assert.equal(result.coverage.list, 'passed');
  assert.ok(fixture.requests.length > 0);
  assert.equal(fixture.requests.filter(r => r.path.startsWith('/api/now/table/') || r.path.startsWith('/api/now/stats/')).every(r => r.method === 'GET'), true);
  assert.equal(fixture.requests.filter(r => r.method !== 'GET').every(r => r.method === 'POST' && r.path === '/angular.do' && r.query === 'get_user' && r.body === null), true, 'Only normal OAuth session bootstrap is allowed alongside read-only data requests');
  assert.equal((await fs.stat(path.join(fixture.root, 'performance-private', 'data', 'perf', 'perf.db'))).mode & 0o777, 0o600);
});
