import { describe, it, afterEach } from 'node:test';
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
import { userRolesCmd } from '../src/commands/userroles.js';
import { isMutationCommand } from '../src/mutations.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const commands = captureCommands(userRolesCmd(wrapHandler));
const [list, add, remove] = ['list', 'add', 'remove'].map(name => findHandler(commands, name));
const id = c => c.repeat(32);
const ROLE = id('e'), BETH = id('b'), ABEL = id('a'), DAVID = id('d');
const field = (value, display = value) => ({ value, display_value: display });
const NAMES = { [BETH]: 'beth.anglin', [ABEL]: 'abel.tuter', [DAVID]: 'david.loo' };
const grant = (rowId, user, inherited) => ({ sys_id: field(rowId), user: field(user, NAMES[user]), role: field(ROLE, 'itil'), inherited: field(String(inherited)) });

// A fake instance: itil exists, three users, and the sys_user_has_role rows in `rows`.
function fixture(rows = [], { createError = {}, deleteError = {}, keepDeleted = false, dropCreated = false } = {}) {
  const calls = [];
  const state = [...rows];
  const sdk = {
    list: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['list', table, p]);
      if (table === 'sys_user_role') return p.sysparm_query === 'name=itil' || p.sysparm_query === `sys_id=${ROLE}` ? [{ sys_id: field(ROLE), name: field('itil') }] : [];
      const name = p.sysparm_query.split('=')[1];
      const user = Object.keys(NAMES).find(u => NAMES[u] === name || u === name);
      return user ? [{ sys_id: field(user), user_name: field(NAMES[user]) }] : [];
    },
    listStrict: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['listStrict', table, p]);
      const q = p.sysparm_query;
      if (q.startsWith('sys_idIN')) return state.filter(r => q.slice(8).split(',').includes(r.sys_id.value));
      if (q.startsWith(`role=${ROLE}^userIN`)) return state.filter(r => q.split('userIN')[1].split(',').includes(r.user.value));
      return state;
    },
    create: async (table, data) => {
      calls.push(['create', table, data]);
      if (createError[data.user]) throw createError[data.user];
      if (!dropCreated) state.push(grant(String(state.length + 100).padStart(32, 'c'), data.user, false));
      return { sys_id: 'x' };
    },
    delete: async (table, rowId) => {
      calls.push(['delete', table, rowId]);
      if (deleteError[rowId]) throw deleteError[rowId];
      if (!keepDeleted) state.splice(state.findIndex(r => r.sys_id.value === rowId), 1);
    },
  };
  return { calls, app: makeApp({ sdk }) };
}
const writes = calls => calls.filter(c => c[0] === 'create' || c[0] === 'delete');
const lookups = users => [['list', 'sys_user_role', { sysparm_query: 'name=itil', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }],
  ...users.map(u => ['list', 'sys_user', { sysparm_query: `user_name=${u}`, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,user_name' }])];
const grantsRead = users => ['listStrict', 'sys_user_has_role', { sysparm_query: `role=${ROLE}^userIN${users.join(',')}`, sysparm_fields: 'sys_id,user,role,inherited', sysparm_limit: '1001', sysparm_display_value: 'all' }];

afterEach(() => { process.exitCode = undefined; });

describe('userroles', () => {
  it('add and remove are mutations, so read-only profiles refuse them; list is a read', () => {
    assert.equal(isMutationCommand({ _: ['userroles', 'add'] }), true);
    assert.equal(isMutationCommand({ _: ['userroles', 'remove'] }), true);
    assert.equal(isMutationCommand({ _: ['userroles', 'list'] }), false);
  });

  it('list reads sys_user_has_role with a bounded lookahead and says whether more rows exist', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('2'), BETH, true), grant(id('3'), ABEL, true)]);
    await list({ app, query: 'user.user_name=beth.anglin', limit: 2 });
    assert.deepEqual(calls, [['listStrict', 'sys_user_has_role', { sysparm_limit: '3', sysparm_display_value: 'all', sysparm_fields: 'sys_id,user.user_name,role.name,inherited,state', sysparm_query: 'user.user_name=beth.anglin' }]]);
    const { data, opts } = app.lastOk;
    assert.equal(data.count, 2);
    assert.deepEqual(data.pagination, { limit: 2, has_more: true });
    assert.equal(opts.summary, '2 user role(s)');
    for (const limit of [0, 1001, 1.5]) {
      const bad = fixture();
      await assert.rejects(list({ app: bad.app, limit }), { code: 'usage_error' });
      assert.deepEqual(bad.calls, []);
    }
  });

  it('add previews by default: grants only users without a direct row, counts an inherited-only user as needing one, and writes nothing', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('2'), ABEL, true)]);
    await add({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter,david.loo'], yes: false });
    assert.deepEqual(calls, [...lookups(['beth.anglin', 'abel.tuter', 'david.loo']), grantsRead([BETH, ABEL, DAVID])]);
    const { data, opts } = app.lastOk;
    assert.equal(data.dry_run, true);
    assert.deepEqual(data.role, { sys_id: ROLE, name: 'itil' });
    assert.deepEqual(data.grant.map(u => u.user_name), ['abel.tuter', 'david.loo']);
    assert.deepEqual(data.skipped, [{ sys_id: BETH, user_name: 'beth.anglin', reason: 'holds_directly' }]);
    assert.equal(data.rerun, 'jsn userroles add --role itil --user abel.tuter,david.loo --yes');
    assert.equal(opts.summary, 'Dry run: would grant itil directly to 2 user(s), 1 skipped; nothing written');
    assert.match(data._formatted, /^Would grant itil directly to:\n {2}abel\.tuter\n {2}david\.loo\nSkipped:\n {2}beth\.anglin {2}already holds itil directly\n\nRun: jsn userroles add/);
  });

  it('add --yes creates one {user, role} row per user to grant and confirms each on a read-back', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('2'), ABEL, true)]);
    await add({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter', 'david.loo', BETH], yes: true });
    assert.deepEqual(writes(calls), [['create', 'sys_user_has_role', { user: ABEL, role: ROLE }], ['create', 'sys_user_has_role', { user: DAVID, role: ROLE }]]);
    assert.deepEqual(calls.at(-1), grantsRead([ABEL, DAVID]));
    const { data, opts } = app.lastOk;
    assert.equal(data.verified, true);
    assert.deepEqual(data.granted.map(u => u.user_name), ['abel.tuter', 'david.loo']);
    assert.equal(opts.summary, 'Granted itil directly to 2 user(s); 1 skipped');
    assert.equal(process.exitCode, undefined);
  });

  it('add --yes with every user already holding the role directly writes nothing and says so', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false)]);
    await add({ app, role: 'itil', user: ['beth.anglin'], yes: true });
    assert.deepEqual(writes(calls), []);
    assert.equal(app.lastOk.opts.summary, 'Nothing to grant: every user already holds itil directly');
    assert.equal(calls.filter(c => c[0] === 'listStrict').length, 1);
    const none = fixture([grant(id('2'), BETH, true)]);
    await remove({ app: none.app, role: 'itil', user: ['beth.anglin'], yes: true, expectCount: 0 });
    assert.deepEqual(writes(none.calls), []);
    assert.equal(none.calls.filter(c => c[0] === 'listStrict').length, 1);
    assert.equal(none.app.lastOk.opts.summary, 'Nothing to remove: no visible direct itil row for these users');
  });

  it('add reports a denied create or a grant missing on the read-back as incomplete and exits nonzero', async () => {
    const denied = Object.assign(new Error('Forbidden'), { status: 403 });
    const { app } = fixture([], { createError: { [ABEL]: denied } });
    await add({ app, role: 'itil', user: ['abel.tuter', 'david.loo'], yes: true });
    assert.equal(app.lastOk.data.verified, false);
    assert.deepEqual(app.lastOk.data.failed, [{ sys_id: ABEL, user_name: 'abel.tuter', error: 'Forbidden' }]);
    assert.deepEqual(app.lastOk.data.granted.map(u => u.user_name), ['david.loo']);
    assert.equal(app.lastOk.opts.summary, 'Grant incomplete or unverified: 1 granted, 1 failed, 0 unconfirmed');
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    // An inherited row for the same user is not the direct grant that was asked for.
    const dropped = fixture([grant(id('2'), DAVID, true)], { dropCreated: true });
    await add({ app: dropped.app, role: 'itil', user: ['david.loo'], yes: true });
    assert.deepEqual(dropped.app.lastOk.data.unconfirmed.map(u => u.user_name), ['david.loo']);
    assert.equal(process.exitCode, 1);
  });

  for (const [label, args] of [
    ['an unsafe role', { role: 'itil^ORname=admin', user: ['beth.anglin'] }],
    ['a wildcard user', { role: 'itil', user: ['beth*'] }],
    ['an unsafe user after a safe one', { role: 'itil', user: ['beth.anglin', 'x^ORactive=true'] }],
    ['no users', { role: 'itil', user: [' , '] }],
    ['more than 100 users', { role: 'itil', user: [Array.from({ length: 101 }, (_, i) => `u${i}`).join(',')] }],
  ]) {
    it(`add and remove reject ${label} before any request`, async () => {
      for (const handler of [add, remove]) {
        const { calls, app } = fixture();
        await assert.rejects(handler({ app, ...args, yes: true }));
        assert.deepEqual(calls, []);
        assert.deepEqual(app.outputCalls, []);
      }
    });
  }

  it('add and remove write nothing for a missing role or user, or grant rows that do not match the request', async () => {
    const bad = [grant(id('1'), BETH, false)];
    for (const [args, rows] of [
      [{ role: 'nosuchrole', user: ['beth.anglin'] }, []],
      [{ role: 'itil', user: ['nobody'] }, []],
      [{ role: 'itil', user: ['abel.tuter'] }, bad],
      [{ role: 'itil', user: ['abel.tuter'] }, [{ ...bad[0], user: field(ABEL), role: field(id('f')) }]],
      [{ role: 'itil', user: ['abel.tuter'] }, [{ ...bad[0], user: field(ABEL), inherited: field('') }]],
      [{ role: 'itil', user: ['abel.tuter'] }, [{ ...bad[0], user: field(ABEL), sys_id: field('') }]],
      [{ role: 'itil', user: ['abel.tuter'] }, Array.from({ length: 1001 }, (_, i) => grant(String(i).padStart(32, '0'), ABEL, true))],
    ]) {
      for (const handler of [add, remove]) {
        const { calls, app } = fixture(rows);
        if (rows.length) app.sdk.listStrict = async () => rows;
        await assert.rejects(handler({ app, ...args, yes: true }), undefined, JSON.stringify(args));
        assert.deepEqual(writes(calls), []);
        assert.deepEqual(app.outputCalls, []);
        // A write never matches a user or role on part of a sys_id.
        assert.ok(calls.every(c => !/STARTSWITH|ENDSWITH/.test(c[2]?.sysparm_query || '')), JSON.stringify(calls));
      }
    }
  });

  it('remove never reports success when the read-back returns a row it did not ask for', async () => {
    const { app } = fixture([grant(id('1'), BETH, false)]);
    const strict = app.sdk.listStrict;
    app.sdk.listStrict = async (table, params) => (Object.fromEntries(params).sysparm_query.startsWith('sys_idIN') ? [{ sys_id: field(id('f')) }] : strict(table, params));
    await assert.rejects(remove({ app, role: 'itil', user: ['beth.anglin'], yes: true, expectCount: 1 }), { code: 'malformed_response' });
    assert.deepEqual(app.outputCalls, []);
  });

  it('remove previews the direct rows only, and skips a user who holds the role only by inheritance', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('2'), BETH, true), grant(id('3'), ABEL, true)]);
    await remove({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter', 'david.loo'], yes: false });
    assert.deepEqual(writes(calls), []);
    const { data, opts } = app.lastOk;
    assert.deepEqual(data.remove, [{ sys_id: id('1'), user: { sys_id: BETH, user_name: 'beth.anglin' } }]);
    assert.deepEqual(data.skipped.map(u => [u.user_name, u.reason]), [['abel.tuter', 'inherited_only'], ['david.loo', 'no_visible_row']]);
    assert.equal(data.rerun, 'jsn userroles remove --role itil --user beth.anglin --expect-count 1 --yes');
    assert.equal(opts.summary, 'Dry run: would remove 1 direct itil grant(s), 2 skipped; nothing written');
    assert.match(data._formatted, /abel\.tuter {2}holds itil only through a group or a containing role; inherited rows are never removed/);
    assert.match(data._formatted, /david\.loo {2}has no visible itil row; row ACLs can hide one/);
  });

  it('remove --yes refuses before any request without --expect-count, and deletes nothing when the count moved', async () => {
    for (const expectCount of [undefined, -1, 1.5]) {
      const { calls, app } = fixture([grant(id('1'), BETH, false)]);
      await assert.rejects(remove({ app, role: 'itil', user: ['beth.anglin'], yes: true, expectCount }), { code: 'usage_error', message: /needs --expect-count/ });
      assert.deepEqual(calls, []);
    }
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('3'), ABEL, false)]);
    await assert.rejects(remove({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 1 }), { code: 'usage_error', message: 'Count mismatch: --expect-count 1, but 2 direct row(s) match now. Nothing removed.' });
    assert.deepEqual(writes(calls), []);
  });

  it('the preview\'s rerun keeps the profile and instance it ran against', async () => {
    const { app } = fixture([]);
    await add({ app, role: 'itil', user: ['beth.anglin'], yes: false, profile: 'dev', instance: 'https://dev.example.com' });
    assert.equal(app.lastOk.data.rerun, 'jsn userroles add --role itil --user beth.anglin --yes --profile dev --instance https://dev.example.com');
    const gone = fixture([grant(id('1'), BETH, false)]);
    await remove({ app: gone.app, role: 'itil', user: ['beth.anglin'], yes: false, profile: 'dev' });
    assert.equal(gone.app.lastOk.data.rerun, 'jsn userroles remove --role itil --user beth.anglin --expect-count 1 --yes --profile dev');
  });

  it('remove --yes deletes only the direct rows by sys_id and confirms they are gone', async () => {
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('2'), BETH, true), grant(id('3'), ABEL, false)]);
    await remove({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 2 });
    assert.deepEqual(writes(calls), [['delete', 'sys_user_has_role', id('1')], ['delete', 'sys_user_has_role', id('3')]]);
    assert.deepEqual(calls.at(-1), ['listStrict', 'sys_user_has_role', { sysparm_query: `sys_idIN${id('1')},${id('3')}`, sysparm_fields: 'sys_id', sysparm_limit: '3' }]);
    assert.equal(app.lastOk.data.verified, true);
    assert.equal(app.lastOk.opts.summary, 'Removed 2 direct itil grant(s)');
  });

  it('remove reports a denied delete, keeps going, and exits nonzero', async () => {
    const denied = Object.assign(new Error('Forbidden'), { status: 403 });
    const { calls, app } = fixture([grant(id('1'), BETH, false), grant(id('3'), ABEL, false)], { deleteError: { [id('1')]: denied } });
    await remove({ app, role: 'itil', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 2 });
    assert.equal(writes(calls).length, 2);
    assert.deepEqual(app.lastOk.data.failed.map(f => [f.sys_id, f.error]), [[id('1'), 'Forbidden']]);
    assert.deepEqual(app.lastOk.data.removed.map(r => r.sys_id), [id('3')]);
    assert.equal(app.lastOk.opts.summary, 'Removal incomplete or unverified: 1 removed, 1 failed, 1 still present');
    assert.match(app.lastOk.data._formatted, /Failed:\n {2}beth\.anglin {2}Forbidden/);
    assert.equal(process.exitCode, 1);
  });

  it('remove reports a row still present after its delete as unverified and exits nonzero', async () => {
    const { app } = fixture([grant(id('1'), BETH, false)], { keepDeleted: true });
    await remove({ app, role: 'itil', user: ['beth.anglin'], yes: true, expectCount: 1 });
    assert.equal(app.lastOk.data.verified, false);
    assert.deepEqual(app.lastOk.data.remaining, [id('1')]);
    assert.equal(app.lastOk.opts.summary, 'Removal incomplete or unverified: 0 removed, 0 failed, 1 still present');
    assert.equal(process.exitCode, 1);
  });

  it('real CLI: a read-only profile refuses add with no request; a writable one previews, grants and lists', async () => {
    const calls = [];
    const rows = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, pathname: url.pathname, body: req.method === 'POST' && url.pathname === '/api/now/table/sys_user_has_role' ? JSON.parse(body) : body });
      const q = url.searchParams.get('sysparm_query') || '';
      let result = [];
      if (url.pathname === '/api/now/table/sys_user_role' && q === 'name=itil') result = [{ sys_id: field(ROLE), name: field('itil') }];
      else if (url.pathname === '/api/now/table/sys_user' && q === 'user_name=beth.anglin') result = [{ sys_id: field(BETH), user_name: field('beth.anglin') }];
      else if (url.pathname === '/api/now/table/sys_user_has_role' && req.method === 'POST') { rows.push(grant(id('9'), BETH, false)); result = { sys_id: id('9') }; }
      else if (url.pathname === '/api/now/table/sys_user_has_role') result = rows;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-userroles-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    const instance = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'rw', profiles: { rw: { instance_url: instance, auth_method: 'basic', read_only: false }, ro: { instance_url: instance, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'userroles', ...args], { env, cwd: dir, timeout: 20000 });
    const posts = () => calls.filter(c => c.method === 'POST' && c.pathname === '/api/now/table/sys_user_has_role');
    try {
      const refused = await run(['add', '--role', 'itil', '--user', 'beth.anglin', '--yes', '--profile', 'ro', '--json']).then(() => null, error => error);
      assert.match(`${refused.stdout}${refused.stderr}`, /read-only/);
      assert.deepEqual(calls, []);
      for (const args of [['add', '--role', 'itil^ORname=admin', '--user', 'beth.anglin', '--yes'], ['add', '--role', 'itil', '--user', 'beth.anglin', '--bogus'], ['add', '--user', 'beth.anglin']]) {
        await assert.rejects(run([...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.deepEqual(calls, []);
      assert.equal(JSON.parse((await run(['add', '--role', 'itil', '--user', 'beth.anglin', '--json'])).stdout).data.dry_run, true);
      assert.deepEqual(posts(), []);
      assert.match((await run(['add', '--role', 'itil', '--user', 'beth.anglin', '--yes', '--format', 'styled'])).stdout, /^Granted itil directly to:\n {2}beth\.anglin/);
      assert.deepEqual(posts().map(c => c.body), [{ user: BETH, role: ROLE }]);
      const listed = JSON.parse((await run(['list', '--get', 'data.count'])).stdout);
      assert.equal(listed, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
