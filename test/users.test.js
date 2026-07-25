// Tests for users command — structure, handler logic with mock SDK
// Patterns from Go: internal/commands/users_test.go

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure Tests ───

describe('Users Command Structure', () => {
  it('should export usersCmd function', async () => {
    const { usersCmd } = await import('../src/commands/users.js');
    assert.strictEqual(typeof usersCmd, 'function');
  });

  it('should define users command with aliases', async () => {
    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => fn;
    const cmd = usersCmd(wrap);
    assert.ok(cmd.command.includes('users'));
    assert.deepStrictEqual(cmd.aliases, ['user']);
  });

  it('should define create, update, delete subcommands', async () => {
    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => fn;
    const cmd = usersCmd(wrap);
    assert.strictEqual(typeof cmd.builder, 'function');

    const subcommands = [];
    const mockYargs = {
      command: (c) => {
        subcommands.push(typeof c === 'string' ? c : c.command);
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);

    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'), 'should have list');
    assert.ok(names.includes('show'), 'should have show/get');
    assert.ok(names.includes('create'), 'should have create');
    assert.ok(names.includes('update'), 'should have update');
    assert.ok(names.includes('delete'), 'should have delete');
  });
});

// ─── Handler Tests ───

describe('Users Command Handlers', () => {
  function makeApp(mockSdk = {}) {
    return {
      config: { instance_url: 'https://test-instance.service-now.com', format: 'json' },
      getEffectiveInstance: () => 'https://test-instance.service-now.com',
      output: { getFormat: () => 'json' },
      sdk: {
        list: async () => [],
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => {},
        ...mockSdk,
      },
      ok: (data, opts = {}) => ({ data, opts }),
      err: (error) => { throw error; },
      requireInstance: () => {},  // no-op for tests
    };
  }

  it('list should call sdk.list with sys_user table', async () => {
    let listCalled = false;
    let listTable = '';
    const app = makeApp({
      list: async (table, _params) => {
        listCalled = true;
        listTable = table;
        return [{ sys_id: 'abc', user_name: 'testuser' }];
      },
    });

    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = usersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    const listHandler = subcommands[0];

    await listHandler({ app, _: ['list'], query: '', columns: '', limit: 20 });
    assert.ok(listCalled, 'sdk.list should be called');
    assert.strictEqual(listTable, 'sys_user');
  });

  it('show should find user by user_name', async () => {
    let queriedQuery = '';
    const app = makeApp({
      list: async (table, _params) => {
        queriedQuery = _params.get('sysparm_query');
        return [{ sys_id: 'abc123', user_name: 'john.doe' }];
      },
    });

    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = usersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    const showHandler = subcommands[1];

    await showHandler({ app, identifier: 'john.doe', _: ['show', 'john.doe'] });
    assert.ok(queriedQuery.includes('john.doe'), `should query for john.doe, got: ${queriedQuery}`);
  });

  it('create should require user_name', async () => {
    let thrown = false;
    const app = makeApp();
    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => async (argv) => { try { await fn(argv, argv.app); } catch { thrown = true; } };
    const cmd = usersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    const createHandler = subcommands[2];

    await createHandler({ app, _: ['create'] });
    assert.ok(thrown, 'should error without username');
  });

  it('create should call sdk.create with sys_user', async () => {
    let createTable = '';
    const app = makeApp({
      create: async (table, _data) => {
        createTable = table;
        return { sys_id: 'new123', user_name: 'newuser' };
      },
    });

    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = usersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    const createHandler = subcommands[2];

    await createHandler({ app, _: ['create'], username: 'newuser', name: 'New User', email: 'new@test.com' });
    assert.strictEqual(createTable, 'sys_user');
  });

  it('delete should find by user_name and call sdk.delete', async () => {
    let deletedSysID = '';
    const app = makeApp({
      list: async () => [{ sys_id: 'abc123', user_name: 'todelete' }],
      delete: async (table, sysID) => { deletedSysID = sysID; },
    });

    const { usersCmd } = await import('../src/commands/users.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = usersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    const delHandler = subcommands[4];

    await delHandler({ app, identifier: 'todelete', _: ['delete', 'todelete'] });
    assert.strictEqual(deletedSysID, 'abc123');
  });
});
