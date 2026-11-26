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
import { parseRolePath } from '../src/user-roles.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findCommand, findHandler, wrapHandler } from './support/command-test-helpers.js';

const command = usersCmd(wrapHandler);
const commands = captureCommands(command);
const handler = (name) => findHandler(commands, name);
const instance = 'https://dev.example.service-now.com';

describe('Users command', () => {
  it('exports usersCmd and preserves command, aliases and CRUD discoverability', () => {
    assert.equal(typeof usersCmd, 'function');
    assert.equal(command.command, 'users [subcommand]');
    assert.deepEqual(command.aliases, ['user']);
    assert.equal(typeof command.builder, 'function');
    assert.deepEqual(commands.map(c => c.command).sort(), ['access <identifier>', 'create', 'delete <identifier>', 'list', 'roles <identifier>', 'show <identifier>', 'update <identifier>']);
    assert.deepEqual(findCommand(commands, 'list').aliases, ['ls']);
    assert.deepEqual(findCommand(commands, 'show').aliases, ['get']);
    for (const c of commands) assert.equal(typeof c.handler, 'function');
  });

  for (const [columns, query, expectedColumns, fields] of [
    ['', '', ['user_name', 'name', 'email', 'active'], 'sys_id,user_name,name,email,active'],
    ['user_name,name', 'active=true', ['user_name', 'name'], 'sys_id,user_name,name'],
    ['*', '', ['*'], undefined],
  ]) {
    it(`list checks request, count and output for columns ${columns || 'default'}`, async () => {
      const rows = [{
        sys_id: 'abc', user_name: 'testuser',
        name: { value: 'raw-name', display_value: 'Test User' },
        email: 'test@example.com', active: 'true',
      }];
      const calls = [];
      const app = makeApp({ sdk: { list: async (table, params) => { calls.push([table, Object.fromEntries(params)]); return rows; } } });
      await handler('list')({ app, query, columns, limit: 20 });
      assert.deepEqual(calls, [['sys_user', {
        sysparm_limit: '20', sysparm_display_value: 'all',
        ...(fields ? { sysparm_fields: fields } : {}),
        ...(query ? { sysparm_query: query } : {}),
      }]]);
      const records = columns === '*' ? rows : [{ sys_id: 'abc', user_name: 'testuser', name: 'Test User', ...(columns ? {} : { email: 'test@example.com', active: 'true' }) }];
      assert.deepEqual(app.outputCalls, [{
        data: { table: 'sys_user', count: 1, columns: expectedColumns, records, context: { instance_url: instance } },
        opts: { summary: '1 user(s)' },
      }]);
    });
  }

  it('show resolves user_name and returns the record', async () => {
    const record = { sys_id: 'abc123', user_name: 'john.doe' };
    const calls = [];
    const app = makeApp({ sdk: { list: async (table, params) => { calls.push([table, Object.fromEntries(params)]); return [record]; } } });
    await handler('show')({ app, identifier: 'john.doe' });
    assert.deepEqual(calls, [['sys_user', { sysparm_query: 'user_name=john.doe', sysparm_limit: '2', sysparm_display_value: 'all' }]]);
    assert.deepEqual(app.outputCalls, [{ data: record, opts: { summary: 'User john.doe' } }]);
  });

  for (const [label, args, payload] of [
    ['flags',
      { username: 'newuser', name: 'New User', email: 'new@test.com' },
      { user_name: 'newuser', name: 'New User', email: 'new@test.com' },
    ],
    ['flags overriding data',
      { username: 'newuser', name: 'New User', email: 'new@test.com', data: '{"user_name":"old","active":false}' },
      { user_name: 'newuser', name: 'New User', email: 'new@test.com', active: false },
    ],
    ['data', { data: '{"user_name":"newuser"}' }, { user_name: 'newuser' }],
  ]) {
    it(`create sends exact payload from ${label} and reports the new user`, async () => {
      const record = { sys_id: 'new123', user_name: 'newuser' };
      const calls = [];
      const app = makeApp({ sdk: { create: async (...args) => { calls.push(args); return record; } } });
      await handler('create')({ app, ...args });
      assert.deepEqual(calls, [['sys_user', payload]]);
      assert.deepEqual(app.outputCalls, [{ data: record, opts: {
        summary: 'Created user newuser',
        breadcrumbs: [{ action: 'view', cmd: 'jsn users show newuser', description: 'View the new user' }],
      } }]);
    });
  }

  it('create rejects missing username before writing', async () => {
    let writes = 0;
    const app = makeApp({ sdk: { create: async () => { writes++; return {}; } } });
    await assert.rejects(() => handler('create')({ app }), { message: 'user_name is required (use --username or --data)' });
    assert.equal(writes, 0);
    assert.deepEqual(app.outputCalls, []);
  });

  for (const name of ['update', 'delete']) {
    it(`${name} resolves user_name and sends the exact mutation destination and output`, async () => {
      const calls = [];
      const updated = { sys_id: 'abc123', active: false };
      const app = makeApp({ sdk: {
        list: async (table, params) => { calls.push(['list', table, Object.fromEntries(params)]); return [{ sys_id: 'abc123', user_name: 'todelete' }]; },
        update: async (...args) => { calls.push(['update', ...args]); return updated; },
        delete: async (...args) => { calls.push(['delete', ...args]); },
      } });
      await handler(name)({ app, identifier: 'todelete', ...(name === 'update' ? { data: '{"active":false}' } : {}) });
      assert.deepEqual(calls, [
        ['list', 'sys_user', { sysparm_query: 'user_name=todelete', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id' }],
        name === 'update' ? ['update', 'sys_user', 'abc123', { active: false }] : ['delete', 'sys_user', 'abc123'],
      ]);
      const expected = name === 'update'
        ? { data: updated, opts: {
          summary: 'Updated user todelete',
          breadcrumbs: [{ action: 'view', cmd: 'jsn users show todelete', description: 'View the updated user' }],
        } }
        : { data: { identifier: 'todelete', message: 'User deleted' }, opts: { summary: 'Deleted user todelete' } };
      assert.deepEqual(app.outputCalls, [expected]);
    });
  }

  // Regression: all resolve paths request display values; mutations unwrap the
  // raw sys_id, not its display value, before sending an SDK destination.
  for (const name of ['show', 'update', 'delete']) {
    it(`${name} resolve requests all display values and handles wrapped sys_id`, async () => {
      const record = { sys_id: { value: 'raw123', display_value: 'not-the-id' }, user_name: 'target' };
      const calls = [];
      const app = makeApp({ sdk: {
        list: async (_table, params) => { assert.equal(params.get('sysparm_display_value'), 'all'); return [record]; },
        update: async (table, id) => { calls.push([table, id]); return record; },
        delete: async (table, id) => { calls.push([table, id]); },
      } });
      await handler(name)({ app, identifier: 'target', ...(name === 'update' ? { data: '{"active":"false"}' } : {}) });
      assert.deepEqual(calls, name === 'show' ? [] : [['sys_user', 'raw123']]);
      if (name === 'show') assert.deepEqual(app.lastOk.data, record);
    });

    for (const [identifier, expectedError, expectedCalls] of [
      ['ghost', { code: 'not_found', message: 'User not found: ghost' }, ['list', 'list', 'list', 'list']],
      ['x^OR1=1', /Unsafe identifier/, []],
    ]) {
      it(`${name} rejects ${identifier === 'ghost' ? 'not-found' : 'unsafe'} identifiers without mutating`, async () => {
        const calls = [];
        const app = makeApp({ sdk: {
          list: async () => { calls.push('list'); return []; },
          update: async () => { calls.push('update'); },
          delete: async () => { calls.push('delete'); },
        } });
        await assert.rejects(() => handler(name)({ app, identifier, ...(name === 'update' ? { data: '{}' } : {}) }), expectedError);
        assert.deepEqual(calls, expectedCalls);
        assert.deepEqual(app.outputCalls, []);
      });
    }
  }
});

describe('users roles', () => {
  const userId = 'a'.repeat(32);
  const roleId = 'b'.repeat(32);
  const field = (value, display = value) => ({ value, display_value: display });
  const userRow = { sys_id: field(userId, 'Not a key'), user_name: field('beth.anglin') };
  const roleRow = { sys_id: field(roleId), name: field('itil') };
  const hasRole = (role, extra = {}) => ({ sys_id: field(`${role}`.padEnd(32, '0')), user: field(userId, 'Beth Anglin'), role: field(roleId, role), 'role.name': field(role), inherited: field('false'), inh_count: field(''), state: field('Active'), ...extra });
  function fixture({ users = [userRow], roles = [roleRow], rows = [], reply, error } = {}) {
    const calls = [];
    const sdk = {
      baseURL: instance,
      list: async (table, params) => { calls.push(['list', table, Object.fromEntries(params)]); const q = params.get('sysparm_query'); return (table === 'sys_user' ? users : roles).filter(r => q.endsWith(`=${r.user_name?.value ?? r.name.value}`) || q.endsWith(`=${r.sys_id.value}`)); },
      listStrict: async (table, params) => { calls.push(['listStrict', table, Object.fromEntries(params)]); return rows; },
      request: async (url, opts) => { calls.push(['request', url, opts]); if (error) throw error; return reply; },
    };
    return { calls, app: makeApp({ sdk }) };
  }
  const userLookup = ['list', 'sys_user', { sysparm_query: 'user_name=beth.anglin', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,user_name' }];
  const roleLookup = ['list', 'sys_user_role', { sysparm_query: 'name=itil', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }];
  const apiCall = ['request', `${instance}/api/global/user_role_inheritance?user_sysid=${userId}`, { method: 'GET', readOnly: true }];

  it('lists role rows on the raw user sys_id, bounded with lookahead', async () => {
    const { calls, app } = fixture({ rows: [hasRole('itil'), hasRole('asset', { inherited: field('true'), inh_count: field('3') })] });
    await handler('roles')({ app, identifier: 'beth.anglin', limit: 1 });
    assert.deepEqual(calls, [userLookup, ['listStrict', 'sys_user_has_role', {
      sysparm_query: `user=${userId}^ORDERBYrole^ORDERBYsys_id`, sysparm_fields: 'sys_id,user,role,role.name,inherited,inh_count,state', sysparm_limit: '2', sysparm_display_value: 'all',
    }]]);
    const { data, opts } = app.lastOk;
    assert.deepEqual(data.user, { sys_id: userId, user_name: 'beth.anglin' });
    assert.deepEqual(data.records, [{ role: 'itil', inherited: 'false', inh_count: '', state: 'Active', role_sys_id: roleId, sys_id: 'itil'.padEnd(32, '0') }]);
    assert.deepEqual(data.pagination, { limit: 1, has_more: true });
    assert.equal(opts.summary, '1 role row(s) for beth.anglin, more available (raise --limit or narrow with --role)');
    assert.equal(data.coverage, 'visible_rows_only');
    assert.deepEqual(opts.breadcrumbs, [{ action: 'why', cmd: 'jsn users roles beth.anglin --why', description: 'How each role is granted' }]);
  });

  it('--role resolves the role to its raw sys_id without partial lookups and narrows the read', async () => {
    const { calls, app } = fixture({ rows: [hasRole('itil')] });
    await handler('roles')({ app, identifier: 'beth.anglin', role: 'itil', limit: 100 });
    assert.deepEqual(calls.slice(0, 2), [userLookup, roleLookup]);
    assert.equal(calls[2][2].sysparm_query, `user=${userId}^role=${roleId}^ORDERBYrole^ORDERBYsys_id`);
    const missing = fixture({ roles: [] });
    await assert.rejects(handler('roles')({ app: missing.app, identifier: 'beth.anglin', role: 'nope', limit: 100 }), { code: 'not_found' });
    assert.deepEqual(missing.calls.map(c => c[1]), ['sys_user', 'sys_user_role', 'sys_user_role']);
    assert.deepEqual(missing.app.outputCalls, []);
  });

  it('says an empty list is visible rows only, never that the user lacks the role', async () => {
    const { app } = fixture({ rows: [] });
    await handler('roles')({ app, identifier: 'beth.anglin', role: 'itil' });
    assert.equal(app.lastOk.data.count, 0);
    assert.equal(app.lastOk.opts.summary, 'No visible role rows for beth.anglin (role itil); row ACLs can hide rows, so this does not prove the user lacks a role (--why asks the platform)');
  });

  for (const [label, args] of [
    ['limit 0', { limit: 0 }], ['limit 1001', { limit: 1001 }], ['fractional limit', { limit: 1.5 }],
    ['unsafe user', { identifier: 'x^ORactive=true', limit: 100 }], ['unsafe role', { role: 'itil^ORname=admin', limit: 100 }],
    ['empty role', { role: '', limit: 100 }], ['unsafe user with --why', { identifier: 'x*', why: true }], ['unsafe role with --why', { role: 'a^b', why: true }],
    ['--limit with --why', { why: true, limit: 5 }],
  ]) {
    it(`rejects ${label} before any request`, async () => {
      const { calls, app } = fixture();
      await assert.rejects(handler('roles')({ app, identifier: 'beth.anglin', ...args }));
      assert.deepEqual(calls, []);
      assert.deepEqual(app.outputCalls, []);
    });
  }

  it('refuses role rows that belong to another user or role', async () => {
    for (const [role, row] of [[undefined, hasRole('itil', { user: field('c'.repeat(32), 'Beth Anglin') })], ['itil', hasRole('itil', { role: field('d'.repeat(32), 'itil') })], [undefined, null]]) {
      const { app } = fixture({ rows: [row] });
      await assert.rejects(handler('roles')({ app, identifier: 'beth.anglin', role, limit: 100 }), { code: 'malformed_response' });
      assert.deepEqual(app.outputCalls, []);
    }
  });

  const reply = { result: { user_name: 'beth.anglin', from_role: ['/asset/cmdb_query_builder/cmdb_read', '/itil', '/itil/cmdb_read', '', '/asset', '/asset/a', '/asset/b/a', '/x/y/z/a'],
    from_group: ['[Catalog Request Approvers for Sales]/itil', '[Hardware/Software [EMEA]]/itil/cmdb_read'] } };

  it('--why reads the API once with the raw sys_id and groups each path by its role', async () => {
    const { calls, app } = fixture({ reply });
    await handler('roles')({ app, identifier: 'beth.anglin', why: true });
    assert.deepEqual(calls, [userLookup, apiCall]);
    const { data, opts } = app.lastOk;
    assert.deepEqual(data.roles.map(r => r.name), ['a', 'asset', 'cmdb_read', 'itil']);
    assert.deepEqual(data.roles.find(r => r.name === 'itil').paths, [
      { via: 'direct', chain: ['itil'], path: '/itil' },
      { via: 'group', group: 'Catalog Request Approvers for Sales', chain: ['itil'], path: '[Catalog Request Approvers for Sales]/itil' },
    ]);
    assert.deepEqual(data.roles.find(r => r.name === 'cmdb_read').paths.map(p => [p.via, p.group, p.chain.join('>')]), [
      ['role', undefined, 'itil>cmdb_read'], ['group', 'Hardware/Software [EMEA]', 'itil>cmdb_read'], ['role', undefined, 'asset>cmdb_query_builder>cmdb_read'],
    ]);
    assert.equal(data.count, 4);
    assert.equal(data.path_count, 9);
    assert.equal(data.source, 'GET /api/global/user_role_inheritance');
    assert.equal(opts.summary, '4 role(s), 9 path(s) for beth.anglin');
    assert.equal(Object.keys(data).includes('_formatted'), false);
    assert.equal(data._formatted, [
      'beth.anglin holds 4 role(s) through 9 path(s) (User Role Inheritance API).',
      '', 'a', '  contained: asset > a', '  contained: asset > b > a', '  contained: x > y > z > a',
      '', 'asset', '  direct',
      '', 'cmdb_read', '  contained: itil > cmdb_read', '  group [Hardware/Software [EMEA]]: itil > cmdb_read', '  contained: asset > cmdb_query_builder > cmdb_read',
      '', 'itil', '  direct', '  group [Catalog Request Approvers for Sales]: itil',
    ].join('\n'));
  });

  it('--why caps human paths at three per role, with the command that shows the rest', async () => {
    const { app } = fixture({ reply: { result: { user_name: 'beth.anglin', from_role: ['/a/r', '/b/r', '/c/r', '/d/r', '/e/r'], from_group: [] } } });
    await handler('roles')({ app, identifier: 'beth.anglin', why: true });
    assert.equal(app.lastOk.data.roles[0].paths.length, 5);
    assert.ok(app.lastOk.data._formatted.endsWith('  contained: c > r\n  and 2 more: jsn users roles beth.anglin --why --role r'));
  });

  it('--why --role keeps that role, every path, and says plainly when no path reaches it', async () => {
    const { calls, app } = fixture({ reply });
    await handler('roles')({ app, identifier: 'beth.anglin', role: 'itil', why: true });
    assert.deepEqual(calls, [userLookup, roleLookup, apiCall]);
    assert.deepEqual(app.lastOk.data.roles.map(r => r.name), ['itil']);
    assert.deepEqual(app.lastOk.data.role, { sys_id: roleId, name: 'itil' });
    const none = fixture({ reply: { result: { user_name: 'beth.anglin', from_role: ['/asset'], from_group: [] } } });
    await handler('roles')({ app: none.app, identifier: 'beth.anglin', role: 'itil', why: true });
    assert.equal(none.app.lastOk.data.count, 0);
    assert.equal(none.app.lastOk.data._formatted, 'beth.anglin does not hold itil: no path in the User Role Inheritance API reply.');
  });

  it('--why reports a found user with no paths as zero roles', async () => {
    const { app } = fixture({ reply: { result: { user_name: 'beth.anglin', from_role: [], from_group: [''] } } });
    await handler('roles')({ app, identifier: 'beth.anglin', why: true });
    assert.deepEqual([app.lastOk.data.count, app.lastOk.data.path_count, app.lastOk.data.roles], [0, 0, []]);
  });

  const good = reply.result;
  for (const [label, body] of [
    ['an empty body', null], ['no result', {}], ['a result array', { result: [] }],
    ['a null user_name', { result: { ...good, user_name: null } }], ['an empty user_name', { result: { ...good, user_name: '' } }],
    ['another user\'s reply', { result: { ...good, user_name: 'abel.tuter' } }],
    ['from_role missing', { result: { user_name: 'beth.anglin', from_group: [] } }], ['from_group as a string', { result: { ...good, from_group: '[G]/itil' } }],
    ['a non-string path', { result: { ...good, from_role: [{ path: '/itil' }] } }],
    ['a role path without a slash', { result: { ...good, from_role: ['itil'] } }], ['an empty role segment', { result: { ...good, from_role: ['/a//b'] } }],
    ['a group path in from_role', { result: { ...good, from_role: ['[G]/itil'] } }], ['a group path without brackets', { result: { ...good, from_group: ['/itil'] } }],
    ['an empty group name', { result: { ...good, from_group: ['[]/itil'] } }], ['a group with no role', { result: { ...good, from_group: ['[G]/'] } }],
  ]) {
    it(`--why never reports success on ${label}`, async () => {
      const { app } = fixture({ reply: body });
      await assert.rejects(handler('roles')({ app, identifier: 'beth.anglin', why: true }), { code: 'malformed_response' });
      assert.deepEqual(app.outputCalls, []);
    });
  }

  for (const [status, hint] of [[403, /user_admin/]]) {
    it(`--why keeps HTTP ${status} an error and names what is missing`, async () => {
      const error = Object.assign(new Error(`HTTP ${status}`), { status, hint: 'generic' });
      const { app } = fixture({ error });
      await assert.rejects(handler('roles')({ app, identifier: 'beth.anglin', why: true }), err => err === error && hint.test(err.hint));
      assert.deepEqual(app.outputCalls, []);
    });
  }

  it('parseRolePath splits a group name on its last bracket', () => {
    assert.deepEqual(parseRolePath('[A]/B]/c/d', 'from_group'), { via: 'group', group: 'A]/B', chain: ['c', 'd'], path: '[A]/B]/c/d' });
    assert.deepEqual(parseRolePath('/c', 'from_role'), { via: 'direct', chain: ['c'], path: '/c' });
  });

  it('real CLI runs on a read-only profile with JSON, --get and human output, and refuses bad input with no request', async () => {
    const calls = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query') });
      const body = url.pathname === '/api/now/table/sys_user' ? { result: url.searchParams.get('sysparm_query') === 'user_name=beth.anglin' ? [userRow] : [] }
        : url.pathname === '/api/now/table/sys_user_role' ? { result: url.searchParams.get('sysparm_query') === 'name=itil' ? [roleRow] : [] }
          : url.pathname === '/api/now/table/sys_user_has_role' ? { result: [hasRole('itil')] }
            : url.pathname === '/api/global/user_role_inheritance' && url.searchParams.get('user_sysid') === userId ? reply : { result: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-users-roles-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'users', 'roles', ...args], { env, cwd: dir, timeout: 20000 });
    try {
      const why = JSON.parse((await run(['beth.anglin', '--why', '--json'])).stdout);
      assert.equal(why.ok, true);
      assert.deepEqual(why.data.roles.map(r => r.name), ['a', 'asset', 'cmdb_read', 'itil']);
      assert.equal((await run(['beth.anglin', '--why', '--role', 'itil', '--get', 'data.roles.0.paths.1.group'])).stdout.trim(), '"Catalog Request Approvers for Sales"');
      assert.match((await run(['beth.anglin', '--why', '--format', 'styled'])).stdout, /^beth\.anglin holds 4 role\(s\) through 9 path\(s\)[\s\S]* {2}group \[Catalog Request Approvers for Sales\]: itil/);
      const listed = JSON.parse((await run(['beth.anglin', '--json'])).stdout);
      assert.deepEqual(listed.data.records.map(r => [r.role, r.role_sys_id]), [['itil', roleId]]);
      assert.match((await run(['beth.anglin', '--format', 'styled'])).stdout, /1 role row\(s\) for beth\.anglin[\s\S]*itil/);
      const before = calls.length;
      for (const args of [['beth.anglin', '--limit', '0'], ['x^ORactive=true', '--why'], ['beth.anglin', '--role', 'a^b']]) {
        await assert.rejects(run([...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.equal(calls.length, before);
      await assert.rejects(run(['ghost', '--why', '--json']));
      assert.deepEqual(calls.filter(call => call.method !== 'GET' && call.pathname !== '/angular.do'), []);
      assert.ok(!calls.slice(before).some(call => call.pathname === '/api/global/user_role_inheritance'));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
