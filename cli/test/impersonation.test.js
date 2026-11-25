import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/cli.js';
import { impersonationRefusal, confirmImpersonatedWrite, runImpersonated } from '../src/impersonation.js';
import { SDKClient } from '../src/sdk.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const COOKIE = 'JSESSIONID=fixture-session-cookie';
const users = { fixture: id(1), 'abel.tuter': id(2) };
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

// A loopback instance with one UI session: login mints it, the impersonate POST
// switches it (unless refuseSwitch), logout ends it so its cookie answers 401.
async function withInstance(options, fn) {
  const state = { current: 'fixture', loggedOut: false, canImpersonate: true, refuseSwitch: false, failRevert: false, failCommand: false, holdCommand: false, bigRow: false, readOnly: false, ...options };
  const calls = [];
  const held = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const onSession = (req.headers.cookie || '').includes(COOKIE) && !state.loggedOut;
    const call = { method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query'), authorization: Boolean(req.headers.authorization), cookie: req.headers.cookie || '', token: req.headers['x-usertoken'] || '', as: state.current };
    calls.push(call);
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/angular.do' && url.searchParams.get('sysparm_type') === 'view_form.login') return json(200, {}, { 'Set-Cookie': `${COOKIE}; Path=/; HttpOnly` });
    if (url.pathname === '/angular.do') return json(200, {}, { 'X-UserToken-Response': 'fixture-token' });
    if (url.pathname === '/logout.do') { state.loggedOut = true; res.writeHead(302, { Location: 'logout_success.do' }); return res.end(); }
    if (url.pathname.startsWith('/api/now/') && !onSession && !req.headers.authorization) return json(401, { error: { message: 'User Not Authenticated' } });
    if (url.pathname === '/api/now/sg/impersonation/session') return json(200, { OriginalUser: 'fixture', CurrentUser: state.current, SessionToken: 'fixture-token', CanImpersonate: state.canImpersonate });
    if (url.pathname.startsWith('/api/now/ui/impersonate/')) {
      if (req.headers['content-type'] !== 'application/json') return json(415, { error: { message: 'Invalid content-type' } });
      if (state.failRevert && url.pathname.endsWith(users.fixture)) return json(500, { error: { message: 'synthetic revert failure' } });
      const target = Object.entries(users).find(([, sysId]) => url.pathname.endsWith(sysId))?.[0];
      if (!state.refuseSwitch && target) state.current = target;
      return json(201, { result: { user: 'null', impersonatedUser: url.pathname.split('/').pop() } });
    }
    if (url.pathname === '/api/now/table/sys_user') {
      const [field, value] = (call.query || '').split('=');
      const name = field === 'sys_id' ? Object.keys(users).find(key => users[key] === value) : value;
      return json(200, { result: users[name] ? [{ sys_id: users[name], user_name: name }] : [] });
    }
    if (url.pathname === `/api/now/table/sys_db_object/${id(21)}`) return json(200, { result: { sys_id: id(21), name: 'sys_metadata', super_class: '' } });
    if (url.pathname === '/api/now/table/sys_db_object') { const name = (call.query || '').split('=')[1]; return json(200, { result: [{ sys_id: id(20), name, super_class: name === 'incident' ? '' : id(21) }] }); }
    if (url.pathname.startsWith('/api/now/table/incident')) {
      if (state.holdCommand) return held.push(res);
      if (state.failCommand) return json(500, { error: { message: 'synthetic failure' } });
      if (req.method === 'POST') return json(201, { result: { sys_id: id(10), number: 'INC0000002', sys_created_by: state.current } });
      const row = { sys_id: id(9), number: 'INC0000001', short_description: state.bigRow ? 'x'.repeat(400000) : `read as ${state.current}` };
      return json(200, { result: url.pathname.endsWith(id(9)) ? row : [row] });
    }
    return json(404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-impersonation-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: state.readOnly } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const args = rest => [...loopbackCredentialArgs, cli, ...rest];
  const run = rest => promisify(execFile)(process.execPath, args(rest), { env, cwd: dir, timeout: 20000 });
  const fail = async rest => { try { await run(rest); } catch (error) { return error; } assert.fail(`expected ${rest.join(' ')} to fail`); };
  const start = rest => spawn(process.execPath, args(rest), { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await fn({ run, fail, start, calls, state, held, dir, base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const get = ['records', 'get', '--table', 'incident', '--sys-id', id(9), '--json', '--impersonate', 'abel.tuter'];
const paths = calls => calls.map(call => `${call.method} ${call.pathname}`);
function assertEnded(calls) {
  const tail = paths(calls).slice(-3);
  assert.deepEqual(tail, ['POST /api/now/ui/impersonate/' + users.fixture, 'GET /logout.do', 'GET /api/now/sg/impersonation/session'], 'reverts, logs out and checks the session is gone');
}

test('refuses local-state commands, commands that would not run as the user, and bad users before any request', async () => {
  const argv = (words, impersonate = 'abel.tuter') => ({ _: words, impersonate });
  for (const words of [['setup'], ['auth', 'login'], ['skill']]) assert.match(impersonationRefusal(argv(words)), /local state/, words.join(' '));
  for (const words of [['records', 'watch'], ['logs', 'follow'], ['compare'], ['plugins', 'compare'], ['store', 'compare'], ['updatesets', 'diff'], ['diff', 'record']]) assert.match(impersonationRefusal(argv(words)), /would not run as that user/, words.join(' '));
  for (const words of [['eval'], ['rest'], ['flows', 'publish']]) assert.match(impersonationRefusal({ ...argv(words), method: 'POST' }), /may write customization/, words.join(' '));
  for (const user of [true, '', '  ', '--json', 'abel^ORuser_name=admin', 'javascript:gs.getUserName()', 'abel\ntuter']) assert.match(impersonationRefusal(argv(['records', 'get'], user)), /user_name or sys_id/, JSON.stringify(user));
  for (const words of [['records', 'get'], ['records', 'list'], ['users', 'show'], ['logs', 'list'], ['plugins', 'list'], ['updatesets', 'show'], ['records', 'create'], ['records', 'delete'], ['rest']]) assert.equal(impersonationRefusal(argv(words)), null, words.join(' '));
  assert.equal(impersonationRefusal(argv(['records', 'get'], id(2))), null);
});

test('a browser-session profile is refused before a session is opened', async () => {
  let warmed = false;
  const app = { sdk: { authProvider: { getCredentials: async () => ({ auth_method: 'gck', access_token: 't', cookies: 'c=1' }) }, _warmSession: async () => { warmed = true; return 'c=1'; } } };
  let ran = false;
  await assert.rejects(runImpersonated(app, 'abel.tuter', async () => { ran = true; }), /browser-session/);
  assert.equal(warmed, false);
  assert.equal(ran, false);
});

test('runs the command on the impersonated session by cookie only, then reverts, logs out and confirms', async () => {
  await withInstance({}, async ({ run, calls, dir }) => {
    const { stdout } = await run(get);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.short_description, 'read as abel.tuter');
    const command = calls.filter(call => call.pathname.startsWith('/api/now/table/incident'));
    assert.equal(command.length, 1);
    assert.equal(command[0].as, 'abel.tuter');
    assert.equal(command[0].authorization, false, 'no per-request credential, which would undo the impersonation');
    assert.ok(command[0].cookie.includes(COOKIE));
    assert.equal(command[0].token, 'fixture-token');
    const switched = calls.findIndex(call => call.pathname === `/api/now/ui/impersonate/${users['abel.tuter']}`);
    assert.ok(switched > 0 && calls.indexOf(command[0]) > switched + 1, 'the switch is re-read before the command runs');
    assert.equal(calls[switched + 1].pathname, '/api/now/sg/impersonation/session');
    assertEnded(calls);
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/') && call.pathname !== '/api/now/sg/impersonation/session' || call.pathname === '/logout.do').every(call => !call.authorization));
    const files = fs.readdirSync(dir, { recursive: true }).map(file => path.join(dir, file)).filter(file => fs.statSync(file).isFile());
    assert.ok(files.every(file => !fs.readFileSync(file, 'utf8').includes('fixture-session-cookie')), 'the session cookie is never written to disk');
  });
});

test('accepts a sys_id for the user to impersonate', async () => {
  await withInstance({}, async ({ run, calls }) => {
    const envelope = JSON.parse((await run([...get.slice(0, -1), users['abel.tuter']])).stdout);
    assert.equal(envelope.data.short_description, 'read as abel.tuter');
    assert.ok(calls.some(call => call.query === `sys_id=${users['abel.tuter']}`));
  });
});

test('a switch the instance answers 201 but did not make is refused, and the session still ends', async () => {
  await withInstance({ refuseSwitch: true }, async ({ fail, calls }) => {
    const error = await fail(get);
    assert.match(error.stdout + error.stderr, /did not take effect/);
    assert.equal(calls.some(call => call.pathname.startsWith('/api/now/table/incident')), false);
    assertEnded(calls);
  });
});

test('a caller the instance says cannot impersonate is refused before the switch', async () => {
  await withInstance({ canImpersonate: false }, async ({ fail, calls }) => {
    const error = await fail(get);
    assert.match(error.stdout + error.stderr, /admin or impersonator role/);
    assert.equal(calls.some(call => call.pathname.startsWith('/api/now/ui/impersonate/')), false);
    assert.equal(calls.some(call => call.pathname.startsWith('/api/now/table/incident')), false);
    assert.deepEqual(paths(calls).slice(-2), ['GET /logout.do', 'GET /api/now/sg/impersonation/session']);
  });
});

test('an unknown user is refused before the switch', async () => {
  await withInstance({}, async ({ fail, calls }) => {
    const error = await fail([...get.slice(0, -1), 'nobody']);
    assert.match(error.stdout + error.stderr, /nobody/);
    assert.equal(calls.some(call => call.pathname.startsWith('/api/now/ui/impersonate/')), false);
    assert.equal(calls.at(-2).pathname, '/logout.do');
  });
});

test('a failing command keeps its own error and exit code, and the session still ends', async () => {
  await withInstance({ failCommand: true }, async ({ fail, calls }) => {
    const error = await fail(get);
    assert.equal(error.code, 1);
    assert.match(error.stdout + error.stderr, /synthetic failure|500/);
    assertEnded(calls);
  });
});

test('a failed switch back still logs out, and the session is confirmed gone', async () => {
  await withInstance({ failRevert: true }, async ({ run, calls }) => {
    await run(get);
    assertEnded(calls);
    assert.equal(calls.at(-1).as, 'abel.tuter', 'the revert did not happen, so logout is what ended the session');
  });
});

test('Ctrl-C ends the session, then exits 130', async () => {
  await withInstance({ holdCommand: true }, async ({ start, calls }) => {
    const child = start(get);
    const deadline = Date.now() + 15000;
    while (!calls.some(call => call.pathname.startsWith('/api/now/table/incident'))) {
      assert.ok(Date.now() < deadline, 'the command request never arrived');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    const [code] = await once(child, 'exit');
    assert.equal(code, 130);
    assertEnded(calls);
  });
});

test('refused commands send nothing to the instance', async () => {
  await withInstance({}, async ({ fail, calls }) => {
    for (const rest of [
      ['updatesets', 'diff', '--source', 'fixture', '--target', 'fixture'],
      ['compare', '--source', 'fixture', '--target', 'fixture'],
      ['eval', '--script', 'gs.info(1)'],
      ['rest', '/api/now/table/incident', '--method', 'POST', '--data', '{}'],
      ['records', 'watch', '--table', 'incident', '--sys-id', id(9)],
      ['logs', 'follow'],
      ['setup'],
      ['records', 'get', '--table', 'incident', '--sys-id', id(9), '--impersonate'],
      ['records', 'get', '--table', 'incident', '--sys-id', id(9), '--impersonate', 'a^ORuser_name=admin'],
    ]) {
      const error = await fail([...rest, ...(rest.includes('--impersonate') ? [] : ['--impersonate', 'abel.tuter']), '--json']);
      assert.equal(error.code, 2, rest.join(' '));
      assert.match(JSON.parse(error.stdout).error, /--impersonate/, rest.join(' '));
    }
    assert.equal(calls.length, 0);
  });
});

const create = ['records', 'create', '--table', 'incident', '--data', '{"short_description":"x"}', '--yes', '--json', '--impersonate', 'abel.tuter'];

test('a write as another user needs --impersonate-writes, and without it nothing is sent', async () => {
  await withInstance({}, async ({ fail, calls }) => {
    for (const rest of [create, ['records', 'delete', '--table', 'incident', '--sys-id', id(9), '--force', '--json', '--impersonate', 'abel.tuter']]) {
      const error = await fail(rest);
      const envelope = JSON.parse(error.stdout);
      assert.equal(error.code, 1, rest.join(' '));
      assert.equal(envelope.code, 'confirmation_required', rest.join(' '));
      assert.match(envelope.error, /as abel\.tuter/);
      assert.match(envelope.hint, /--impersonate-writes/);
    }
    assert.equal(calls.length, 0, '--yes and --force are not approval to write as another user');
  });
});

test('an approved record write runs on the impersonated session, with its table classified as the real user first', async () => {
  await withInstance({}, async ({ run, calls }) => {
    const envelope = JSON.parse((await run([...create, '--impersonate-writes'])).stdout);
    assert.equal(envelope.ok, true);
    const write = calls.find(call => call.method === 'POST' && call.pathname === '/api/now/table/incident');
    assert.equal(write.as, 'abel.tuter');
    assert.equal(write.authorization, false);
    assert.ok(write.cookie.includes(COOKIE));
    const switched = calls.findIndex(call => call.pathname === `/api/now/ui/impersonate/${users['abel.tuter']}`);
    const context = calls.findIndex(call => call.pathname === '/api/now/table/sys_db_object');
    assert.ok(context >= 0 && context < switched && calls[context].as === 'fixture', 'table ancestry is read as the real user, which a role-free user may not read');
    assertEnded(calls);
  });
});

test('a customization write is refused under --impersonate before the switch, since capture would follow that user', async () => {
  await withInstance({}, async ({ fail, calls }) => {
    const error = await fail(['records', 'create', '--table', 'sys_script_include', '--data', '{"name":"x"}', '--yes', '--json', '--impersonate', 'abel.tuter', '--impersonate-writes']);
    assert.equal(error.code, 2);
    assert.match(JSON.parse(error.stdout).error, /customization/);
    assert.equal(calls.some(call => call.method !== 'GET' && call.pathname.startsWith('/api/now/')), false, 'no switch and no write');
  });
});

test('a read-only profile still refuses an approved impersonated write', async () => {
  await withInstance({ readOnly: true }, async ({ fail, calls }) => {
    const error = await fail([...create, '--impersonate-writes']);
    assert.notEqual(error.code, 0);
    assert.match(error.stdout + error.stderr, /read-only|read_only/i);
    assert.equal(calls.length, 0);
  });
});

test('the interactive confirmation names the user and defaults to no', async () => {
  const argv = { _: ['records', 'create'], impersonate: ' abel.tuter ' };
  const asked = [];
  const ask = answer => async question => { asked.push(question); return answer; };
  await assert.rejects(confirmImpersonatedWrite({}, argv, { interactive: true, ask: ask(false) }), /cancelled/);
  await confirmImpersonatedWrite({}, argv, { interactive: true, ask: ask(true) });
  assert.match(asked[0].message, /as abel\.tuter\b/);
  assert.equal(asked[0].default, false);
  await confirmImpersonatedWrite({}, { ...argv, impersonateWrites: true }, { interactive: true, ask: ask(false) });
  await confirmImpersonatedWrite({}, { ...argv, _: ['records', 'list'] }, { interactive: true, ask: ask(false) });
  assert.equal(asked.length, 2, 'the flag and reads skip the question');
});

test('a reader that stops early still lets the session end', async () => {
  await withInstance({ bigRow: true }, async ({ start, calls }) => {
    const child = start(['records', 'list', '--table', 'incident', '--json', '--impersonate', 'abel.tuter']);
    await once(child.stdout, 'data');
    child.stdout.destroy();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assertEnded(calls);
  });
});

test('a command that warms its own UI session reuses the impersonated one instead of logging in again', async () => {
  await withInstance({}, async ({ base, calls }) => {
    const app = { sdk: new SDKClient(base, { getCredentials: async () => ({ auth_method: 'basic', username: 'fixture', password: 'fixture-secret' }) }) };
    let warmed;
    await runImpersonated(app, 'abel.tuter', async () => { warmed = await app.sdk._warmSession(); });
    assert.ok(warmed.includes(COOKIE));
    assert.equal(calls.filter(call => call.pathname === '/angular.do').length, 2, 'only the first login and token fetch');
    assertEnded(calls);
  });
});
