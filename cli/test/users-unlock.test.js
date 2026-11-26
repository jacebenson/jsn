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
import { isMutationCommand } from '../src/mutations.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const handler = findHandler(captureCommands(usersCmd(wrapHandler)), 'unlock');
const userId = 'a'.repeat(32);
const field = (value, display = value) => ({ value, display_value: display });
const user = (extra = {}) => ({
  sys_id: field(userId), user_name: field('beth.anglin'), name: field('Beth Anglin'), active: field('true'), locked_out: field('true'),
  password_needs_reset: field('false'), failed_attempts: field('5'), last_login_time: field(''), web_service_access_only: field('false'), internal_integration_user: field('false'), ...extra,
});
const unlocked = (extra = {}) => user({ locked_out: field('false'), failed_attempts: field('0'), ...extra });
const FIELDS = 'sys_id,user_name,name,active,locked_out,password_needs_reset,failed_attempts,last_login_time,web_service_access_only,internal_integration_user';
const read = query => ['list', 'sys_user', { sysparm_query: query, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: FIELDS }];

// reads[] answers the sys_user reads in turn: the lookup, then the read-back after the write.
function fixture({ reads = [[user()], [unlocked()]], updateError } = {}) {
  const calls = [];
  let n = 0;
  const sdk = {
    list: async (table, params) => { calls.push(['list', table, Object.fromEntries(params)]); return reads[Math.min(n++, reads.length - 1)]; },
    update: async (table, id, data) => { calls.push(['update', table, id, data]); if (updateError) throw updateError; return {}; },
  };
  return { calls, app: makeApp({ sdk }) };
}
const writes = calls => calls.filter(c => c[0] === 'update');

describe('users unlock', () => {
  it('is a mutation, so read-only profiles refuse it, and users access stays a read', () => {
    assert.equal(isMutationCommand({ _: ['users', 'unlock'] }), true);
    assert.equal(isMutationCommand({ _: ['users', 'access'] }), false);
  });

  it('previews without --yes: shows the two fields it would change and writes nothing', async () => {
    const { calls, app } = fixture();
    await handler({ app, identifier: 'beth.anglin', yes: false });
    assert.deepEqual(calls, [read('user_name=beth.anglin')]);
    const { data, opts } = app.lastOk;
    assert.equal(data.dry_run, true);
    assert.deepEqual(data.change, { locked_out: { from: 'true', to: 'false' }, failed_attempts: { from: '5', to: '0' } });
    assert.equal(data.rerun, 'jsn users unlock beth.anglin --yes');
    assert.equal(opts.summary, 'Dry run: would unlock beth.anglin; nothing written');
    assert.match(data._formatted, /^Would unlock beth\.anglin \(Beth Anglin\):\n {2}locked_out {11}true -> false\n {2}failed_attempts {6}5 -> 0\n\nRun: jsn users unlock beth\.anglin --yes$/);
  });

  it('the preview\'s rerun keeps the profile and instance it ran against', async () => {
    const { app } = fixture();
    await handler({ app, identifier: 'beth.anglin', yes: false, profile: 'dev', instance: 'https://dev.example.com' });
    assert.equal(app.lastOk.data.rerun, 'jsn users unlock beth.anglin --yes --profile dev --instance https://dev.example.com');
  });

  it('--yes clears locked_out, zeroes failed_attempts, and reads the user back on its sys_id', async () => {
    const { calls, app } = fixture();
    await handler({ app, identifier: 'beth.anglin', yes: true });
    assert.deepEqual(calls, [read('user_name=beth.anglin'), ['update', 'sys_user', userId, { locked_out: 'false', failed_attempts: '0' }], read(`sys_id=${userId}`)]);
    const { data, opts } = app.lastOk;
    assert.equal(data.dry_run, false);
    assert.equal(data.unlocked, true);
    assert.equal(data.sign_in, 'not_blocked');
    assert.equal(opts.summary, 'Unlocked beth.anglin');
  });

  it('says what still blocks sign-in after the unlock', async () => {
    const { app } = fixture({ reads: [[user({ active: field('false') })], [unlocked({ active: field('false') })]] });
    await handler({ app, identifier: 'beth.anglin', yes: true });
    const { data, opts } = app.lastOk;
    assert.equal(data.sign_in, 'blocked');
    assert.deepEqual(data.findings.map(f => f.field), ['active']);
    assert.equal(opts.summary, 'Unlocked beth.anglin; still blocked: inactive');
    assert.match(data._formatted, /Inactive: every sign-in is refused\./);
  });

  it('leaves a forced password reset in place and says it is still pending', async () => {
    const reset = { password_needs_reset: field('true') };
    const { calls, app } = fixture({ reads: [[user(reset)], [unlocked(reset)]] });
    await handler({ app, identifier: 'beth.anglin', yes: true });
    assert.deepEqual(calls[1], ['update', 'sys_user', userId, { locked_out: 'false', failed_attempts: '0' }]);
    const { data, opts } = app.lastOk;
    assert.equal(data.sign_in, 'new_password_required');
    assert.equal(opts.summary, 'Unlocked beth.anglin; still blocked: password needs reset');
    assert.match(data._formatted, /\n\nStill must set a new password at the next UI sign-in; API calls are refused until then:\n {2}Password needs reset:/);
  });

  for (const [label, row] of [['not locked', user({ locked_out: field('false') })], ['locked_out empty', user({ locked_out: field('') })]]) {
    it(`refuses a user who is ${label}, with or without --yes, and writes nothing`, async () => {
      for (const yes of [false, true]) {
        const { calls, app } = fixture({ reads: [[row]] });
        await assert.rejects(handler({ app, identifier: 'beth.anglin', yes }), { code: 'usage_error', message: /beth\.anglin is not locked out/ });
        assert.deepEqual(writes(calls), []);
        assert.deepEqual(app.outputCalls, []);
      }
    });
  }

  for (const [label, identifier] of [['an unsafe identifier', 'x^ORlocked_out=true'], ['a wildcard identifier', 'beth*'], ['an empty identifier', '']]) {
    it(`rejects ${label} before any request`, async () => {
      const { calls, app } = fixture();
      await assert.rejects(handler({ app, identifier, yes: true }));
      assert.deepEqual(calls, []);
      assert.deepEqual(app.outputCalls, []);
    });
  }

  it('writes nothing for a missing user or a reply without the flags', async () => {
    for (const reads of [[[]], [[user({ password_needs_reset: undefined })]]]) {
      const { calls, app } = fixture({ reads });
      await assert.rejects(handler({ app, identifier: 'beth.anglin', yes: true }));
      assert.deepEqual(writes(calls), []);
      assert.deepEqual(app.outputCalls, []);
    }
  });

  it('never reports success when the write is denied or the read-back shows a field not cleared', async () => {
    const denied = fixture({ updateError: Object.assign(new Error('Forbidden'), { status: 403 }) });
    await assert.rejects(handler({ app: denied.app, identifier: 'beth.anglin', yes: true }), { status: 403 });
    assert.deepEqual(denied.app.outputCalls, []);
    for (const after of [user(), unlocked({ failed_attempts: field('5') }), unlocked({ sys_id: field('b'.repeat(32)) })]) {
      const { app } = fixture({ reads: [[user()], [after]] });
      await assert.rejects(handler({ app, identifier: 'beth.anglin', yes: true }), { message: /not confirmed|another user/ });
      assert.deepEqual(app.outputCalls, []);
    }
    const gone = fixture({ reads: [[user()], []] });
    await assert.rejects(handler({ app: gone.app, identifier: 'beth.anglin', yes: true }));
    assert.deepEqual(gone.app.outputCalls, []);
  });

  it('real CLI previews and unlocks on a writable profile, and a read-only profile refuses it with no request', async () => {
    const calls = [];
    let locked = true;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, pathname: url.pathname, body: req.method === 'PUT' ? JSON.parse(body) : body });
      if (req.method === 'PUT' && url.pathname === `/api/now/table/sys_user/${userId}`) locked = false;
      const q = url.searchParams.get('sysparm_query');
      const result = url.pathname === '/api/now/table/sys_user' && (q === 'user_name=beth.anglin' || q === `sys_id=${userId}`) ? [locked ? user() : unlocked()] : req.method === 'PUT' ? {} : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-users-unlock-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    const instance = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'rw', profiles: { rw: { instance_url: instance, auth_method: 'basic', read_only: false }, ro: { instance_url: instance, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'users', 'unlock', ...args], { env, cwd: dir, timeout: 20000 });
    const puts = () => calls.filter(c => c.method === 'PUT');
    try {
      const refused = await run(['beth.anglin', '--yes', '--profile', 'ro', '--json']).then(() => null, error => error);
      assert.match(`${refused.stdout}${refused.stderr}`, /read-only/);
      assert.deepEqual(calls, []);
      for (const args of [['x^ORlocked_out=true', '--yes'], ['beth.anglin', '--bogus']]) {
        await assert.rejects(run([...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.deepEqual(calls, []);
      const preview = JSON.parse((await run(['beth.anglin', '--json'])).stdout);
      assert.equal(preview.data.dry_run, true);
      assert.deepEqual(puts(), []);
      assert.match((await run(['beth.anglin', '--yes', '--format', 'styled'])).stdout, /^Unlocked beth\.anglin \(Beth Anglin\)\./);
      assert.deepEqual(puts().map(c => [c.pathname, c.body]), [[`/api/now/table/sys_user/${userId}`, { locked_out: 'false', failed_attempts: '0' }]]);
      await assert.rejects(run(['beth.anglin', '--yes', '--json']));
      assert.equal(puts().length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
