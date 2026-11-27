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
import { groupMembersCmd } from '../src/commands/groupmembers.js';
import { isMutationCommand } from '../src/mutations.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const commands = captureCommands(groupMembersCmd(wrapHandler));
const [add, remove] = ['add', 'remove'].map(name => findHandler(commands, name));
const id = c => c.repeat(32);
const GROUP = id('e'), BETH = id('b'), ABEL = id('a'), DAVID = id('d');
const field = (value, display = value) => ({ value, display_value: display });
const NAMES = { [BETH]: 'beth.anglin', [ABEL]: 'abel.tuter', [DAVID]: "o'brien" };
const member = (rowId, user) => ({ sys_id: field(rowId), user: field(user, NAMES[user]), group: field(GROUP, 'Service Desk') });

// A fake instance: the Service Desk group, three users, and the sys_user_grmember rows in `rows`.
function fixture(rows = [], { createError = {}, deleteError = {}, keepDeleted = false, dropCreated = false, groups = 1 } = {}) {
  const calls = [];
  const state = [...rows];
  const sdk = {
    list: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['list', table, p]);
      if (table === 'sys_user_group') return p.sysparm_query === 'name=Service Desk' || p.sysparm_query === `sys_id=${GROUP}` ? Array.from({ length: groups }, (_, i) => ({ sys_id: field(i ? id('f') : GROUP), name: field('Service Desk') })) : [];
      const name = p.sysparm_query.split('=')[1];
      const user = Object.keys(NAMES).find(u => NAMES[u] === name || u === name);
      return user ? [{ sys_id: field(user), user_name: field(NAMES[user]) }] : [];
    },
    listStrict: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['listStrict', table, p]);
      const q = p.sysparm_query;
      if (q.startsWith('sys_idIN')) return state.filter(r => q.slice(8).split(',').includes(r.sys_id.value));
      if (q.startsWith(`group=${GROUP}^userIN`)) return state.filter(r => q.split('userIN')[1].split(',').includes(r.user.value));
      return state;
    },
    create: async (table, data) => {
      calls.push(['create', table, data]);
      if (createError[data.user]) throw createError[data.user];
      if (!dropCreated) state.push(member(String(state.length + 100).padStart(32, 'c'), data.user));
      return dropCreated ? null : { sys_id: 'x' };
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
const lookups = users => [['list', 'sys_user_group', { sysparm_query: 'name=Service Desk', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }],
  ...users.map(u => ['list', 'sys_user', { sysparm_query: `user_name=${u}`, sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,user_name' }])];
const membersRead = users => ['listStrict', 'sys_user_grmember', { sysparm_query: `group=${GROUP}^userIN${users.join(',')}`, sysparm_fields: 'sys_id,user,group', sysparm_limit: '1001', sysparm_display_value: 'all' }];

afterEach(() => { process.exitCode = undefined; });

describe('groupmembers add and remove', () => {
  it('add and remove stay mutations, so read-only profiles refuse them; list is a read', () => {
    assert.equal(isMutationCommand({ _: ['groupmembers', 'add'] }), true);
    assert.equal(isMutationCommand({ _: ['groupmembers', 'remove'] }), true);
    assert.equal(isMutationCommand({ _: ['groupmembers', 'list'] }), false);
  });

  it('add previews by default: adds only users who are not members yet, and writes nothing', async () => {
    const { calls, app } = fixture([member(id('1'), BETH)]);
    await add({ app, group: 'Service Desk', user: ['beth.anglin', "abel.tuter,o'brien"], yes: false });
    assert.deepEqual(calls, [...lookups(['beth.anglin', 'abel.tuter', "o'brien"]), membersRead([BETH, ABEL, DAVID])]);
    const { data, opts } = app.lastOk;
    assert.equal(data.dry_run, true);
    assert.deepEqual(data.group, { sys_id: GROUP, name: 'Service Desk' });
    assert.deepEqual(data.add.map(u => u.user_name), ['abel.tuter', "o'brien"]);
    assert.deepEqual(data.skipped, [{ sys_id: BETH, user_name: 'beth.anglin', reason: 'already_member' }]);
    assert.equal(data.rerun, "jsn groupmembers add --group 'Service Desk' --user 'abel.tuter,o'\\''brien' --yes");
    assert.equal(opts.summary, 'Dry run: would add 2 user(s) to Service Desk, 1 skipped; nothing written');
    assert.match(data._formatted, /^Would add to Service Desk:\n {2}abel\.tuter\n {2}o'brien\nSkipped:\n {2}beth\.anglin {2}is already a member of Service Desk\n\nRun: jsn groupmembers add/);
  });

  it('add --yes creates one {group, user} row per user to add and confirms each on a read-back', async () => {
    const { calls, app } = fixture([member(id('1'), BETH)]);
    await add({ app, group: 'Service Desk', user: ['beth.anglin', 'abel.tuter', "o'brien", BETH], yes: true });
    assert.deepEqual(writes(calls), [['create', 'sys_user_grmember', { group: GROUP, user: ABEL }], ['create', 'sys_user_grmember', { group: GROUP, user: DAVID }]]);
    assert.deepEqual(calls.at(-1), membersRead([ABEL, DAVID]));
    const { data, opts } = app.lastOk;
    assert.equal(data.verified, true);
    assert.deepEqual(data.added.map(u => u.user_name), ['abel.tuter', "o'brien"]);
    assert.equal(opts.summary, 'Added 2 user(s) to Service Desk; 1 skipped');
    assert.equal(process.exitCode, undefined);
  });

  it('add --yes with every user already a member, or remove --yes with none, writes nothing and says so', async () => {
    const { calls, app } = fixture([member(id('1'), BETH)]);
    await add({ app, group: 'Service Desk', user: ['beth.anglin'], yes: true });
    assert.deepEqual(writes(calls), []);
    assert.equal(app.lastOk.opts.summary, 'Nothing to add: every user is already a member of Service Desk');
    const none = fixture();
    await remove({ app: none.app, group: 'Service Desk', user: ['beth.anglin'], yes: true, expectCount: 0 });
    assert.deepEqual(writes(none.calls), []);
    assert.equal(none.app.lastOk.opts.summary, 'Nothing to remove: no visible Service Desk membership for these users');
  });

  it('add reports a denied create, or a create that returned nothing and left no row, as incomplete and exits nonzero', async () => {
    const denied = Object.assign(new Error('Forbidden'), { status: 403 });
    const { app } = fixture([], { createError: { [ABEL]: denied } });
    await add({ app, group: 'Service Desk', user: ['abel.tuter', 'beth.anglin'], yes: true });
    assert.equal(app.lastOk.data.verified, false);
    assert.deepEqual(app.lastOk.data.failed, [{ sys_id: ABEL, user_name: 'abel.tuter', error: 'Forbidden' }]);
    assert.deepEqual(app.lastOk.data.added.map(u => u.user_name), ['beth.anglin']);
    assert.equal(app.lastOk.opts.summary, 'Add incomplete or unverified: 1 added, 1 failed, 0 unconfirmed');
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    const dropped = fixture([], { dropCreated: true });
    await add({ app: dropped.app, group: 'Service Desk', user: ['beth.anglin'], yes: true });
    assert.deepEqual(dropped.app.lastOk.data.unconfirmed.map(u => u.user_name), ['beth.anglin']);
    assert.match(dropped.app.lastOk.data._formatted, /Not confirmed on the read-back:\n {2}beth\.anglin/);
    assert.equal(process.exitCode, 1);
  });

  for (const [label, args, expected] of [
    ['an unsafe group', { group: 'a^ORname=admins', user: ['beth.anglin'] }, { message: /^Unsafe identifier/ }],
    ['a wildcard user', { group: 'Service Desk', user: ['beth*'] }, { message: /^Unsafe identifier/ }],
    ['an unsafe user after a safe one', { group: 'Service Desk', user: ['beth.anglin', 'x^ORactive=true'] }, { message: /^Unsafe identifier/ }],
    ['no users', { group: 'Service Desk', user: [' , '] }, { code: 'usage_error' }],
    ['more than 100 users', { group: 'Service Desk', user: [Array.from({ length: 101 }, (_, i) => `u${i}`).join(',')] }, { code: 'usage_error' }],
  ]) {
    it(`add and remove reject ${label} before any request`, async () => {
      for (const handler of [add, remove]) {
        const { calls, app } = fixture();
        await assert.rejects(handler({ app, ...args, yes: true, expectCount: 1 }), expected);
        assert.deepEqual(calls, []);
        assert.deepEqual(app.outputCalls, []);
      }
    });
  }

  it('add and remove write nothing for a missing or ambiguous group, a missing user, or rows that do not match the request', async () => {
    const bad = [member(id('1'), BETH)];
    for (const [args, rows, opts, expected] of [
      [{ group: 'No Such Group', user: ['beth.anglin'] }, [], {}, { code: 'not_found' }],
      [{ group: 'Service Desk', user: ['beth.anglin'] }, [], { groups: 2 }, { code: 'ambiguous' }],
      [{ group: 'Service Desk', user: ['nobody'] }, [], {}, { code: 'not_found' }],
      [{ group: 'Service Desk', user: ['abel.tuter'] }, bad, {}, { code: 'malformed_response' }],
      [{ group: 'Service Desk', user: ['abel.tuter'] }, [{ ...bad[0], user: field(ABEL), group: field(id('f')) }], {}, { code: 'malformed_response' }],
      [{ group: 'Service Desk', user: ['abel.tuter'] }, [{ ...bad[0], user: field(ABEL), sys_id: field('') }], {}, { code: 'malformed_response' }],
      [{ group: 'Service Desk', user: ['abel.tuter'] }, Array.from({ length: 1001 }, (_, i) => member(String(i).padStart(32, '0'), ABEL)), {}, { code: 'usage_error', message: /More than 1000/ }],
    ]) {
      for (const handler of [add, remove]) {
        const { calls, app } = fixture(rows, opts);
        if (rows.length) app.sdk.listStrict = async () => rows;
        await assert.rejects(handler({ app, ...args, yes: true, expectCount: 1 }), expected, JSON.stringify(args));
        assert.deepEqual(writes(calls), []);
        assert.deepEqual(app.outputCalls, []);
        // A write never matches a group or user on part of a sys_id.
        assert.ok(calls.every(c => !/STARTSWITH|ENDSWITH/.test(c[2]?.sysparm_query || '')), JSON.stringify(calls));
      }
    }
  });

  it('remove previews every membership row for the users, and skips a user with no visible row', async () => {
    const { calls, app } = fixture([member(id('1'), BETH), member(id('2'), BETH), member(id('3'), ABEL)]);
    await remove({ app, group: 'Service Desk', user: ['beth.anglin', 'abel.tuter', "o'brien"], yes: false, profile: 'rw' });
    assert.deepEqual(writes(calls), []);
    const { data, opts } = app.lastOk;
    assert.deepEqual(data.remove.map(r => [r.sys_id, r.user.user_name]), [[id('1'), 'beth.anglin'], [id('2'), 'beth.anglin'], [id('3'), 'abel.tuter']]);
    assert.deepEqual(data.skipped.map(u => [u.user_name, u.reason]), [["o'brien", 'not_member']]);
    // The rerun carries the exact target and the pinned profile, as the old confirmation hint did.
    assert.equal(data.rerun, "jsn groupmembers remove --group 'Service Desk' --user beth.anglin,abel.tuter --expect-count 3 --yes --profile rw");
    assert.equal(opts.summary, 'Dry run: would remove 3 membership row(s) from Service Desk, 1 skipped; nothing written');
    assert.match(data._formatted, /o'brien {2}has no visible Service Desk membership; row ACLs can hide one/);
  });

  it('remove --yes refuses before any request without --expect-count, and deletes nothing when the count moved', async () => {
    for (const expectCount of [undefined, -1, 1.5]) {
      const { calls, app } = fixture([member(id('1'), BETH)]);
      await assert.rejects(remove({ app, group: 'Service Desk', user: ['beth.anglin'], yes: true, expectCount }), { code: 'usage_error', message: /needs --expect-count/ });
      assert.deepEqual(calls, []);
    }
    const { calls, app } = fixture([member(id('1'), BETH), member(id('3'), ABEL)]);
    await assert.rejects(remove({ app, group: 'Service Desk', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 1 }), { code: 'usage_error', message: 'Count mismatch: --expect-count 1, but 2 membership row(s) match now. Nothing removed.' });
    assert.deepEqual(writes(calls), []);
  });

  it('remove refuses the old --force before any request, even with --yes and a count', async () => {
    const { calls, app } = fixture([member(id('1'), BETH)]);
    await assert.rejects(remove({ app, group: 'Service Desk', user: ['beth.anglin'], force: true, yes: true, expectCount: 1 }), { code: 'usage_error', message: /does not take --force/ });
    assert.deepEqual(calls, []);
  });

  it('remove --yes deletes the rows by sys_id and confirms they are gone', async () => {
    const { calls, app } = fixture([member(id('1'), BETH), member(id('3'), ABEL)]);
    await remove({ app, group: 'Service Desk', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 2 });
    assert.deepEqual(writes(calls), [['delete', 'sys_user_grmember', id('1')], ['delete', 'sys_user_grmember', id('3')]]);
    assert.deepEqual(calls.at(-1), ['listStrict', 'sys_user_grmember', { sysparm_query: `sys_idIN${id('1')},${id('3')}`, sysparm_fields: 'sys_id', sysparm_limit: '3' }]);
    assert.equal(app.lastOk.data.verified, true);
    assert.equal(app.lastOk.opts.summary, 'Removed 2 membership row(s) from Service Desk');
  });

  it('remove reports a denied delete or a row still present, keeps going, and exits nonzero', async () => {
    const denied = Object.assign(new Error('Forbidden'), { status: 403 });
    const { calls, app } = fixture([member(id('1'), BETH), member(id('3'), ABEL)], { deleteError: { [id('1')]: denied } });
    await remove({ app, group: 'Service Desk', user: ['beth.anglin', 'abel.tuter'], yes: true, expectCount: 2 });
    assert.equal(writes(calls).length, 2);
    assert.deepEqual(app.lastOk.data.failed.map(f => [f.sys_id, f.error]), [[id('1'), 'Forbidden']]);
    assert.deepEqual(app.lastOk.data.removed.map(r => r.sys_id), [id('3')]);
    assert.equal(app.lastOk.opts.summary, 'Removal incomplete or unverified: 1 removed, 1 failed, 1 still present');
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    const kept = fixture([member(id('1'), BETH)], { keepDeleted: true });
    await remove({ app: kept.app, group: 'Service Desk', user: ['beth.anglin'], yes: true, expectCount: 1 });
    assert.deepEqual(kept.app.lastOk.data.remaining, [id('1')]);
    assert.equal(kept.app.lastOk.data.verified, false);
    assert.equal(process.exitCode, 1);
  });

  it('remove never reports success when the read-back returns a row it did not ask for', async () => {
    const { app } = fixture([member(id('1'), BETH)]);
    const strict = app.sdk.listStrict;
    app.sdk.listStrict = async (table, params) => (Object.fromEntries(params).sysparm_query.startsWith('sys_idIN') ? [{ sys_id: field(id('f')) }] : strict(table, params));
    await assert.rejects(remove({ app, group: 'Service Desk', user: ['beth.anglin'], yes: true, expectCount: 1 }), { code: 'malformed_response' });
    assert.deepEqual(app.outputCalls, []);
  });

  it('real CLI: a read-only profile refuses add with no request; a writable one previews, adds and removes', async () => {
    const calls = [];
    const rows = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, pathname: url.pathname, body: req.method === 'POST' && url.pathname === '/api/now/table/sys_user_grmember' ? JSON.parse(body) : body });
      const q = url.searchParams.get('sysparm_query') || '';
      let result = [];
      if (url.pathname === '/api/now/table/sys_user_group' && q === 'name=Service Desk') result = [{ sys_id: field(GROUP), name: field('Service Desk') }];
      else if (url.pathname === '/api/now/table/sys_user' && q === 'user_name=beth.anglin') result = [{ sys_id: field(BETH), user_name: field('beth.anglin') }];
      else if (url.pathname === '/api/now/table/sys_user_grmember' && req.method === 'POST') { rows.push(member(id('9'), BETH)); result = { sys_id: id('9') }; }
      else if (url.pathname.startsWith('/api/now/table/sys_user_grmember/') && req.method === 'DELETE') { rows.splice(0); res.statusCode = 204; return res.end(); }
      else if (url.pathname === '/api/now/table/sys_user_grmember') result = q.startsWith('sys_idIN') ? rows.filter(r => q.includes(r.sys_id.value)) : rows;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-groupmembers-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    const instance = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'rw', profiles: { rw: { instance_url: instance, auth_method: 'basic', read_only: false }, ro: { instance_url: instance, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'groupmembers', ...args], { env, cwd: dir, timeout: 20000 });
    const writesSeen = () => calls.filter(c => (c.method === 'POST' || c.method === 'DELETE') && c.pathname.startsWith('/api/now/table/sys_user_grmember'));
    try {
      const refused = await run(['add', '--group', 'Service Desk', '--user', 'beth.anglin', '--yes', '--profile', 'ro', '--json']).then(() => null, error => error);
      assert.match(`${refused.stdout}${refused.stderr}`, /read-only/);
      assert.deepEqual(calls, []);
      for (const args of [['add', '--group', 'a^ORname=x', '--user', 'beth.anglin', '--yes'], ['add', '--group', 'Service Desk', '--user', 'beth.anglin', '--bogus'], ['add', '--user', 'beth.anglin'], ['remove', '--group', 'Service Desk', '--user', 'beth.anglin', '--yes']]) {
        await assert.rejects(run([...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.deepEqual(calls, []);
      assert.equal(JSON.parse((await run(['add', '--group', 'Service Desk', '--user', 'beth.anglin', '--json'])).stdout).data.dry_run, true);
      assert.deepEqual(writesSeen(), []);
      assert.match((await run(['add', '--group', 'Service Desk', '--user', 'beth.anglin', '--yes', '--format', 'styled'])).stdout, /^Added to Service Desk:\n {2}beth\.anglin/);
      assert.deepEqual(writesSeen().map(c => c.body), [{ group: GROUP, user: BETH }]);
      const removed = JSON.parse((await run(['remove', '--group', 'Service Desk', '--user', 'beth.anglin', '--expect-count', '1', '--yes', '--json'])).stdout);
      assert.equal(removed.data.verified, true);
      assert.deepEqual(writesSeen().map(c => `${c.method} ${c.pathname}`).at(-1), `DELETE /api/now/table/sys_user_grmember/${id('9')}`);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
