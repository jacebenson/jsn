import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scenarios } from './acceptance/auth.mjs';
import { AppError, errAPI } from '../src/errors.js';
import { OutputWriter } from '../src/output.js';
import { usersCmd } from '../src/commands/users.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const scratch = process.env.TMPDIR || os.tmpdir();
const secret = 'SYNTHETIC_AUTH_SAFETY_PASSWORD_439';
const id = 'a'.repeat(32);

async function walk(directory) {
  const found = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(target));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

async function loopback(t) {
  const root = await fs.mkdtemp(path.join(scratch, 'jsn-auth-safety-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  let mode = 'success';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/angular.do') return res.end('{}');
    if (req.method === 'GET') return res.end(JSON.stringify({ result: [{ sys_id: id, user_name: 'offline-user' }] }));
    if (mode === 'echo') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Invalid user_password ${secret}`, detail: `Rejected password ${secret}` } }));
    }
    if (mode === 'validation') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: 'Invalid user_name', detail: 'user_name must be unique' } }));
    }
    if (mode === 'forbidden') {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: { message: 'ACL denied update' } }));
    }
    return res.end(JSON.stringify({ result: { ...JSON.parse(body), sys_id: id, user_password: secret, password: secret } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(root, 'config', 'servicenow'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'offline',
    profiles: { offline: { instance_url: origin, username: 'offline-user', auth_method: 'oauth' } },
  }), { mode: 0o600 });
  const env = {
    HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    JSN_DATA_HOME: path.join(root, 'data'), PATH: path.dirname(process.execPath),
    SERVICENOW_OAUTH_TOKEN: 'synthetic-oauth-only', SERVICENOW_INSTANCE_URL: origin,
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_DOCS_CHECK: '1', JSN_NO_PROMPTS: '1', CI: '1',
  };
  const command = async (args, payload) => {
    const file = path.join(root, `payload-${Math.random().toString(16).slice(2)}.json`);
    await fs.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    try {
      const run = await exec(process.execPath, [cli, ...args, '--data-file', file, '--profile', 'offline', '--instance', origin], { cwd: root, env, timeout: 20000, maxBuffer: 2 ** 20 });
      return { exitCode: 0, output: `${run.stdout}${run.stderr}` };
    } catch (error) {
      return { exitCode: error.code ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` };
    }
  };
  return { root, requests, command, setMode: value => { mode = value; } };
}

test('users create/update password-write provider errors never expose the submitted password', async t => {
  const fixture = await loopback(t);
  fixture.setMode('echo');
  for (const operation of ['create', 'update']) {
    for (const format of ['json', 'markdown']) {
      for (const field of ['user_password', 'password']) {
        const result = await fixture.command(['users', operation, ...(operation === 'update' ? [id] : []), '--format', format],
          { user_name: 'offline-user', [field]: secret });
        assert.equal(result.exitCode, 1, `${operation} ${format} ${field} must fail`);
        assert.equal(result.output.includes(secret), false, `${operation} ${format} ${field} leaked the submitted password`);
        assert.match(result.output, /password|Password/i, `${operation} ${format} ${field} must retain an actionable password message`);
        assert.match(result.output, format === 'json' ? /"code": "api_error"/ : /User (?:create|update) failed while setting a password \(HTTP 400\)/, `${operation} ${format} ${field} must preserve the error code/status`);
      }
    }
  }
  const persisted = [...await walk(path.join(fixture.root, 'data')), ...await walk(path.join(fixture.root, 'cache'))];
  for (const file of persisted) {
    const content = await fs.readFile(file);
    assert.equal(content.includes(Buffer.from(secret)), false, `persisted ${file} leaked the submitted password`);
  }
});

test('password-write success output and both password spellings stay redacted', async t => {
  const fixture = await loopback(t);
  for (const operation of ['create', 'update']) {
    for (const format of ['json', 'markdown']) {
      for (const field of ['user_password', 'password']) {
        const result = await fixture.command(['users', operation, ...(operation === 'update' ? [id] : []), '--format', format],
          { user_name: 'offline-user', [field]: secret });
        assert.equal(result.exitCode, 0, `${operation} ${format} ${field} must succeed`);
        assert.equal(result.output.includes(secret), false, `${operation} ${format} ${field} leaked a password field`);
      }
    }
  }
});

test('non-password write errors keep provider diagnostics', async t => {
  const fixture = await loopback(t);
  fixture.setMode('validation');
  const invalid = await fixture.command(['users', 'create', '--format', 'json'], { user_name: 'offline-user' });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.output, /Invalid user_name/);
  assert.match(invalid.output, /user_name must be unique/);
  fixture.setMode('forbidden');
  const forbidden = await fixture.command(['users', 'update', id, '--format', 'markdown'], { active: false });
  assert.equal(forbidden.exitCode, 1);
  assert.match(forbidden.output, /Error \(forbidden\)|Access forbidden/);
  assert.match(forbidden.output, /authorization\/ACL\/role/);
});

test('public error envelopes never serialize SDK cause or response bodies', () => {
  let rendered = '';
  const writer = { write: value => { rendered += value; }, isTTY: false };
  const cause = new Error(`provider body ${secret}`);
  cause.body = JSON.stringify({ error: { message: secret } });
  new OutputWriter({ format: 'json', writer }).err(new AppError('api_error', 'API error (status 400): rejected', '', 400, cause));
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /api_error/);
});

test('password-write handler drops injected SDK strings from cause, body, hint and recovery', async () => {
  const commands = captureCommands(usersCmd(wrapHandler));
  const handler = name => findHandler(commands, name);
  for (const [code, status] of [['api_error', 400], ['auth_error', 401]]) {
    const injected = new AppError(code, `provider message ${secret}`, `provider hint ${secret}`, status);
    injected.cause = new Error(`cause ${secret}`);
    injected.body = JSON.stringify({ error: { message: secret } });
    injected.recovery = `recovery ${secret}`;
    injected.profile = `profile ${secret}`;
    const app = makeApp({ sdk: { create: async () => { throw injected; } } });
    let thrown;
    await assert.rejects(() => handler('create')({ app, data: JSON.stringify({ user_name: 'offline-user', user_password: secret }) }), error => { thrown = error; return true; });
    assert.equal(thrown.code, code);
    assert.equal(thrown.status, status);
    for (const value of [thrown.message, thrown.hint, thrown.cause, thrown.body, thrown.recovery, thrown.profile]) {
      assert.equal(String(value ?? '').includes(secret), false, `${code} leaked through safe error field`);
    }
    assert.equal(thrown.recovery, code === 'auth_error' ? 'jsn auth login' : undefined);
    let rendered = '';
    new OutputWriter({ format: 'json', writer: { write: value => { rendered += value; }, isTTY: false } }).err(thrown);
    assert.equal(rendered.includes(secret), false, `${code} leaked through public output`);
    assert.match(rendered, new RegExp(`"code": "${code}"`));
    if (status === 401) assert.match(rendered, /"status": 401/);
  }
});

const ok = data => ({ exitCode: 0, stdout: '', stderr: '', json: { ok: true, data } });
const rejected = { exitCode: 1, stdout: '', stderr: '', json: { ok: false, code: 'auth_error', error: 'Authentication rejected for the active profile (HTTP 401).' } };

async function headersContext(t) {
  const dir = await fs.mkdtemp(path.join(scratch, 'jsn-auth-headers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const userRoot = path.join(dir, 'cookie');
  await fs.mkdir(userRoot);
  const user = { root: userRoot, username: 'synthetic-cookie-user', password: secret, id };
  const basic = { root: path.join(dir, 'basic'), username: 'synthetic-basic', id: 'b'.repeat(32) };
  const ctx = {
    outputDir: dir, mode: 'pdi', runKey: 'synthetic_safety_439', profile: 'offline',
    expectedHost: 'https://offline.example.test', state: new Map(),
  };
  ctx.state.set('auth.fixtures', { users: [basic, user], property: { id: 'c'.repeat(32) } });
  ctx.read = async () => ({ sys_id: 'c'.repeat(32), value: 'baseline' });
  let consumed = false;
  let expired = false;
  ctx.command = async (args, options = {}) => {
    if (args[0] === 'auth' && ['login', 'refresh'].includes(args[1])) { consumed = true; expired = false; return ok({}); }
    if (args[0] === 'auth') return ok({ profiles: [{ name: 'offline', authenticated: true, username: user.username }] });
    if (args[1] === 'list') return expired ? rejected : ok({ records: [{ sys_id: id, user_name: user.username }] });
    assert.equal(args[0], 'records'); assert.equal(args[1], 'update');
    const denied = { exitCode: 1, json: { ok: false, code: 'not_found', error: 'Record not found', hint: 'No accessible record matched' } };
    assert.equal(options.expectedDenial(denied), true);
    return denied;
  };
  return { dir, user, userRoot, ctx, state: () => ({ consumed, expired }), expire: () => { expired = true; } };
}

async function headersCase(t, phase, type) {
  const fixture = await headersContext(t);
  const { user, userRoot, ctx } = fixture;
  const inside = path.join(userRoot, 'session.txt');
  await fs.writeFile(inside, 'X-UserToken: synthetic\nCookie: synthetic=1\n', { mode: type === 'perms' ? 0o644 : 0o600 });
  const outsideRoot = await fs.mkdtemp(path.join(scratch, 'jsn-auth-foreign-'));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outsideFile = path.join(outsideRoot, 'foreign-session.txt');
  await fs.writeFile(outsideFile, 'X-UserToken: foreign\nCookie: foreign=1\n', { mode: 0o600 });
  const foreignCookie = path.join(outsideRoot, 'cookie');
  await fs.mkdir(foreignCookie);
  await fs.writeFile(path.join(foreignCookie, 'session.txt'), 'X-UserToken: foreign\nCookie: foreign=1\n', { mode: 0o600 });
  let headersFile = inside;
  if (type === 'outside') headersFile = path.join(fixture.dir, 'outside.txt');
  if (type === 'outside') await fs.writeFile(headersFile, 'X-UserToken: foreign\nCookie: foreign=1\n', { mode: 0o600 });
  if (type === 'leafsymlink') { headersFile = path.join(userRoot, 'session-link.txt'); await fs.symlink(outsideFile, headersFile); }
  if (type === 'parentsymlink') { await fs.symlink(outsideRoot, path.join(userRoot, 'bridge')); headersFile = path.join(userRoot, 'bridge', 'foreign-session.txt'); }
  if (type === 'ancestorsymlink') {
    await fs.symlink(outsideRoot, path.join(fixture.dir, 'bridge'));
    user.root = path.join(fixture.dir, 'bridge', 'cookie');
    headersFile = path.join(user.root, 'session.txt');
  }
  if (type === 'rootreplacement') {
    const original = `${userRoot}-original`;
    await fs.rename(userRoot, original);
    if (phase === 'acquire') { await fs.symlink(outsideRoot, userRoot); headersFile = path.join(userRoot, 'foreign-session.txt'); }
    else {
      await fs.mkdir(userRoot);
      headersFile = path.join(userRoot, 'session.txt');
      await fs.writeFile(headersFile, 'X-UserToken: synthetic\nCookie: synthetic=1\n', { mode: 0o600 });
      const stat = await fs.lstat(original);
      user.rootIdentity = { real: await fs.realpath(original), dev: stat.dev, ino: stat.ino };
    }
  }
  const moved = path.join(scratch, `jsn-auth-moved-${Math.random().toString(16).slice(2)}`);
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  const replaceOutput = async () => {
    await fs.rename(fixture.dir, moved);
    if (phase === 'acquire') await fs.symlink(outsideRoot, fixture.dir);
    else {
      await fs.mkdir(fixture.dir);
      await fs.mkdir(path.join(fixture.dir, 'cookie'));
      await fs.writeFile(path.join(fixture.dir, 'cookie', 'session.txt'), 'X-UserToken: synthetic\nCookie: synthetic=1\n', { mode: 0o600 });
    }
  };
  if (type === 'runroot') headersFile = path.join(fixture.dir, 'cookie', 'session.txt');
  if (type === 'valid' || type === 'source') headersFile = inside;
  const session = {
    source: type === 'source' ? 'personal-browser' : 'isolated-provider-login',
    headersFile, cookies: 'synthetic=1', token: 'synthetic',
  };
  if (phase === 'renew') { user.session = session; user.env = {}; }
  ctx.state.set('auth.browserAdapter', {
    acquire: async () => { if (type === 'runroot' && phase === 'acquire') await replaceOutput(); return session; },
    expire: async () => fixture.expire(),
    renew: async () => { if (type === 'runroot' && phase === 'renew') await replaceOutput(); return session; },
  });
  const idOf = phase === 'acquire' ? 'auth.cookie-valid-permissions' : 'auth.cookie-expired-renewal';
  let error;
  try { await scenarios.find(item => item.id === idOf).run(ctx); } catch (caught) { error = caught.message; }
  return { error, ...fixture.state() };
}

test('acquisition/renewal reject escaping headers and symlinked roots before consuming credentials', async t => {
  const invalid = ['source', 'outside', 'perms', 'leafsymlink', 'parentsymlink', 'rootreplacement', 'ancestorsymlink', 'runroot'];
  const failures = [];
  for (const phase of ['acquire', 'renew']) {
    for (const type of invalid) {
      const result = await headersCase(t, phase, type);
      if (!result.error || result.consumed) failures.push(`${phase} ${type}: rejected=${Boolean(result.error)} consumed=${result.consumed}`);
    }
    const valid = await headersCase(t, phase, 'valid');
    if (valid.error || !valid.consumed) failures.push(`${phase} valid: ${valid.error || 'credentials not consumed'}`);
  }
  assert.deepEqual(failures, []);
});

test('expiry still fails closed before renewal on non-authentication reads', async t => {
  const fixture = await headersContext(t);
  const { user, userRoot, ctx } = fixture;
  const inside = path.join(userRoot, 'session.txt');
  await fs.writeFile(inside, 'X-UserToken: synthetic\nCookie: synthetic=1\n', { mode: 0o600 });
  user.session = { source: 'isolated-provider-login', headersFile: inside, cookies: 'synthetic=1', token: 'synthetic' };
  let renewed = false;
  ctx.state.set('auth.browserAdapter', {
    expire: async () => fixture.expire(),
    renew: async () => { renewed = true; return { source: 'isolated-provider-login', headersFile: inside }; },
  });
  const original = ctx.command;
  ctx.command = async (args, options) => {
    if (args[1] === 'list') return ok({ records: [] });
    return original(args, options);
  };
  await assert.rejects(() => scenarios.find(item => item.id === 'auth.cookie-expired-renewal').run(ctx), /not rejected as authentication failure/);
  assert.equal(renewed, false);
});

test('sdk http errors still normalize without retaining response-body cause', () => {
  const error = errAPI(400, JSON.stringify({ error: { message: `bad ${secret}`, detail: `body ${secret}` } }));
  assert.equal(error.cause, null);
  assert.equal(String(error.message).includes(secret), true, 'API error normalization itself is unchanged for non-password commands');
});
