import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';
import { usersCmd } from '../src/commands/users.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const handler = findHandler(captureCommands(usersCmd(wrapHandler)), 'access');
const userId = 'a'.repeat(32);
const field = (value, display = value) => ({ value, display_value: display });
const user = (extra = {}) => ({
  sys_id: field(userId), user_name: field('beth.anglin'), name: field('Beth Anglin'), active: field('true'), locked_out: field('false'),
  password_needs_reset: field('false'), failed_attempts: field('0'), last_login_time: field('2026-11-20 09:00:00', '20/11/2026 20:00:00'),
  web_service_access_only: field('false'), internal_integration_user: field('false'), ...extra,
});
const event = (n, extra = {}) => ({ sys_id: field(`${n}`.padEnd(32, 'e')), name: field('login.failed'), parm1: field('beth.anglin'), parm2: field(`10.0.0.${n}`), sys_created_on: field(`2026-11-26 01:0${n}:00`), ...extra });
const userRead = ['list', 'sys_user', { sysparm_query: 'user_name=beth.anglin', sysparm_limit: '2', sysparm_display_value: 'all',
  sysparm_fields: 'sys_id,user_name,name,active,locked_out,password_needs_reset,failed_attempts,last_login_time,web_service_access_only,internal_integration_user' }];
const eventRead = limit => ['listStrict', 'sysevent', { sysparm_query: 'name=login.failed^parm1=beth.anglin^ORDERBYDESCsys_created_on',
  sysparm_fields: 'sys_id,name,parm1,parm2,sys_created_on', sysparm_limit: String(limit + 1), sysparm_display_value: 'all' }];

function fixture({ users = [user()], events = [], error } = {}) {
  const calls = [];
  const sdk = {
    list: async (table, params) => { calls.push(['list', table, Object.fromEntries(params)]); return params.get('sysparm_query').endsWith('=beth.anglin') ? users : []; },
    listStrict: async (table, params) => { calls.push(['listStrict', table, Object.fromEntries(params)]); if (error) throw error; return events; },
  };
  return { calls, app: makeApp({ sdk }) };
}

describe('users access', () => {
  it('reads the user flags and the newest login.failed events, bounded with lookahead, and names every blocker', async () => {
    const { calls, app } = fixture({ users: [user({ active: field('false'), locked_out: field('true'), password_needs_reset: field('true'), failed_attempts: field('5') })], events: [event(3), event(2), event(1)] });
    await handler({ app, identifier: 'beth.anglin', limit: 2 });
    assert.deepEqual(calls, [userRead, eventRead(2)]);
    const { data, opts } = app.lastOk;
    assert.deepEqual(data.user, { sys_id: userId, user_name: 'beth.anglin', name: 'Beth Anglin' });
    assert.equal(data.sign_in, 'blocked');
    assert.deepEqual(data.findings.map(f => [f.field, f.effect]), [['active', 'blocks'], ['locked_out', 'blocks'], ['password_needs_reset', 'blocks_api']]);
    assert.equal(data.fields.failed_attempts, '5');
    assert.equal(data.fields.last_login_time, '2026-11-20 09:00:00');
    assert.deepEqual(data.login_failures.records, [{ created: '2026-11-26 01:03:00', source: '10.0.0.3', sys_id: '3'.padEnd(32, 'e') }, { created: '2026-11-26 01:02:00', source: '10.0.0.2', sys_id: '2'.padEnd(32, 'e') }]);
    assert.deepEqual(data.login_failures.pagination, { limit: 2, has_more: true });
    assert.equal(opts.summary, 'beth.anglin cannot sign in: inactive, locked out, password needs reset');
    const text = data._formatted;
    assert.match(text, /^beth\.anglin \(Beth Anglin\) cannot sign in\./);
    assert.match(text, /Locked out: every sign-in is refused until locked_out is cleared, and attempts while locked write no login\.failed events\./);
    assert.match(text, /2026-11-26 01:03:00 {2}from 10\.0\.0\.3/);
    assert.match(text, /older events not shown \(raise --limit, up to 100\)/);
    assert.equal(Object.keys(data).includes('_formatted'), false);
  });

  it('says no flag blocks a clean user, and that an empty event list proves nothing', async () => {
    const { app } = fixture();
    await handler({ app, identifier: 'beth.anglin', limit: 10 });
    const { data, opts } = app.lastOk;
    assert.equal(data.sign_in, 'not_blocked');
    assert.deepEqual(data.findings, []);
    assert.equal(data.login_failures.count, 0);
    assert.equal(data.login_failures.coverage, 'retained_visible_rows_only');
    assert.match(data.login_failures.visibility, /an empty list does not prove there were no failures/);
    assert.deepEqual(data.not_checked, ['password', 'SSO', 'MFA', 'IP access rules']);
    assert.equal(opts.summary, 'beth.anglin: no sys_user flag blocks sign-in');
    assert.match(data._formatted, /No login\.failed events found\. Event rows rotate out after a few days, and a locked-out user's attempts write none\./);
    assert.match(data._formatted, /The password itself, SSO, MFA and IP rules are not checked\./);
  });

  it('tells web-service-only users apart, and counts failed attempts short of a lockout', async () => {
    const { app } = fixture({ users: [user({ web_service_access_only: field('true'), internal_integration_user: field('true'), failed_attempts: field('3') })] });
    await handler({ app, identifier: 'beth.anglin', limit: 10 });
    const { data, opts } = app.lastOk;
    assert.equal(data.sign_in, 'web_services_only');
    assert.deepEqual(data.findings.map(f => [f.field, f.effect]), [['web_service_access_only', 'blocks_ui'], ['internal_integration_user', 'info'], ['failed_attempts', 'info']]);
    assert.match(data.findings[2].message, /^3 failed sign-in attempt\(s\) since the last successful one/);
    assert.equal(opts.summary, 'beth.anglin can sign in to web services only, not the UI');
  });

  it('a password reset alone still lets the UI sign in to set one, and refuses API calls; with web services only it blocks both', async () => {
    const reset = fixture({ users: [user({ password_needs_reset: field('true') })] });
    await handler({ app: reset.app, identifier: 'beth.anglin', limit: 10 });
    assert.equal(reset.app.lastOk.data.sign_in, 'new_password_required');
    assert.equal(reset.app.lastOk.opts.summary, 'beth.anglin must set a new password at the next UI sign-in; API calls are refused until then');
    assert.match(reset.app.lastOk.data._formatted, /^beth\.anglin \(Beth Anglin\) must set a new password at the next UI sign-in; API calls are refused until then\./);
    const both = fixture({ users: [user({ password_needs_reset: field('true'), web_service_access_only: field('true') })] });
    await handler({ app: both.app, identifier: 'beth.anglin', limit: 10 });
    assert.equal(both.app.lastOk.data.sign_in, 'blocked');
    assert.equal(both.app.lastOk.opts.summary, 'beth.anglin cannot sign in: password needs reset, web services only');
  });

  for (const [label, args] of [
    ['limit 0', { limit: 0 }], ['limit 101', { limit: 101 }], ['fractional limit', { limit: 1.5 }],
    ['an unsafe identifier', { identifier: 'x^ORactive=true' }], ['a wildcard identifier', { identifier: 'beth*' }],
  ]) {
    it(`rejects ${label} before any request`, async () => {
      const { calls, app } = fixture();
      await assert.rejects(handler({ app, identifier: 'beth.anglin', limit: 10, ...args }));
      assert.deepEqual(calls, []);
      assert.deepEqual(app.outputCalls, []);
    });
  }

  it('reports a missing user as not found and reads no events', async () => {
    const { calls, app } = fixture({ users: [] });
    await assert.rejects(handler({ app, identifier: 'beth.anglin', limit: 10 }), { code: 'not_found' });
    assert.ok(!calls.some(c => c[1] === 'sysevent'));
    assert.deepEqual(app.outputCalls, []);
  });

  it('never reports a denied event read or a malformed reply as a clean answer', async () => {
    const denied = fixture({ error: Object.assign(new Error('Forbidden'), { status: 403 }) });
    await assert.rejects(handler({ app: denied.app, identifier: 'beth.anglin', limit: 10 }), { status: 403 });
    assert.deepEqual(denied.app.outputCalls, []);
    for (const options of [
      { users: [user({ locked_out: undefined })] },
      { events: [event(1, { parm1: field('someone.else') })] },
      { events: [event(1, { name: field('login') })] },
      { events: [null] },
    ]) {
      const { app } = fixture(options);
      await assert.rejects(handler({ app, identifier: 'beth.anglin', limit: 10 }), { code: 'malformed_response' }, JSON.stringify(options));
      assert.deepEqual(app.outputCalls, []);
    }
  });

  it('never joins events on an empty user name', async () => {
    for (const row of [user({ user_name: field('') }), user({ user_name: undefined })]) {
      const calls = [];
      const sdk = { list: async () => [row], listStrict: async (...args) => { calls.push(args); return [event(1, { parm1: field('') })]; } };
      const app = makeApp({ sdk });
      await assert.rejects(handler({ app, identifier: userId, limit: 10 }), { code: 'malformed_response' });
      assert.deepEqual(calls, []);
      assert.deepEqual(app.outputCalls, []);
    }
  });

  it('refuses to build the event query from a stored user name holding query characters', async () => {
    const calls = [];
    const sdk = { list: async () => [user({ user_name: field('x^ORparm1ISNOTEMPTY') })], listStrict: async (...args) => { calls.push(args); return []; } };
    const app = makeApp({ sdk });
    await assert.rejects(handler({ app, identifier: userId, limit: 10 }), /Unsafe identifier/);
    assert.deepEqual(calls, []);
    assert.deepEqual(app.outputCalls, []);
  });

  it('real CLI runs on a read-only profile with JSON, --get and human output, and refuses bad input with no request', async () => {
    const calls = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      calls.push({ method: req.method, pathname: url.pathname });
      const body = url.pathname === '/api/now/table/sys_user' ? { result: url.searchParams.get('sysparm_query') === 'user_name=beth.anglin' ? [user({ locked_out: field('true') })] : [] }
        : url.pathname === '/api/now/table/sysevent' ? { result: [event(1)] } : { result: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-users-access-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'users', 'access', ...args], { env, cwd: dir, timeout: 20000 });
    try {
      const out = JSON.parse((await run(['beth.anglin', '--json'])).stdout);
      assert.equal(out.ok, true);
      assert.equal(out.data.sign_in, 'blocked');
      assert.equal((await run(['beth.anglin', '--get', 'data.login_failures.records.0.source'])).stdout.trim(), '"10.0.0.1"');
      assert.match((await run(['beth.anglin', '--format', 'styled'])).stdout, /^beth\.anglin \(Beth Anglin\) cannot sign in\.[\s\S]*from 10\.0\.0\.1/);
      const before = calls.length;
      for (const args of [['beth.anglin', '--limit', '0'], ['x^ORactive=true'], ['beth.anglin', '--bogus']]) {
        await assert.rejects(run([...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.equal(calls.length, before);
      assert.deepEqual(calls.filter(call => call.method !== 'GET' && call.pathname !== '/angular.do'), []);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
