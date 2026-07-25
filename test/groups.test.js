// Tests for groups, groupmembers, grouproles commands

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Group helpers ───

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

async function getHandler(mod, commandName) {
  const fn = Object.values(mod)[0]; // first export
  const captured = [];
  const wrap = (fn) => async (argv) => {
    try { captured.push(await fn(argv, argv.app)); }
    catch (e) { captured.push({ error: e }); }
  };
  const cmd = fn(wrap);
  const subcommands = [];
  const mockYargs = {
    command: (c, ...rest) => {
      subcommands.push({
        def: typeof c === 'string' ? c : c.command,
        builder: typeof c === 'object' ? c.builder : (rest[0] || (() => {})),
        handler: typeof c === 'object' ? c.handler : (rest[1] || (async () => {})),
      });
      return mockYargs;
    },
  };
  cmd.builder(mockYargs);
  const found = subcommands.find(s => s.def.startsWith(commandName));
  return { handler: found?.handler, captured, cmd };
}

// ─── Groups ───

describe('Groups Command', () => {
  it('should export groupsCmd', async () => {
    const { groupsCmd } = await import('../src/commands/groups.js');
    assert.strictEqual(typeof groupsCmd, 'function');
  });

  it('should define all CRUD subcommands', async () => {
    const { groupsCmd } = await import('../src/commands/groups.js');
    const wrap = (fn) => fn;
    const cmd = groupsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('show'));
    assert.ok(names.includes('create'));
    assert.ok(names.includes('update'));
    assert.ok(names.includes('delete'));
  });

  it('list should call sdk.list with sys_user_group', async () => {
    let listTable = '';
    const app = makeApp({
      list: async (table) => { listTable = table; return []; },
    });
    const mod = await import('../src/commands/groups.js');
    const { handler } = await getHandler(mod, 'list');
    await handler({ app, _: ['list'], query: '', columns: '', limit: 20 });
    assert.strictEqual(listTable, 'sys_user_group');
  });

  it('create should call sdk.create with sys_user_group', async () => {
    let createTable = '';
    let createData = {};
    const app = makeApp({
      create: async (table, data) => {
        createTable = table;
        createData = data;
        return { sys_id: 'g123', name: 'Test Group' };
      },
    });
    const mod = await import('../src/commands/groups.js');
    const { handler } = await getHandler(mod, 'create');
    await handler({ app, _: ['create'], name: 'Test Group', manager: 'manager.user' });
    assert.strictEqual(createTable, 'sys_user_group');
    assert.strictEqual(createData.name, 'Test Group');
    assert.strictEqual(createData.manager, 'manager.user');
  });
});

// ─── Group Members ───

describe('GroupMembers Command', () => {
  it('should export groupMembersCmd', async () => {
    const { groupMembersCmd } = await import('../src/commands/groupmembers.js');
    assert.strictEqual(typeof groupMembersCmd, 'function');
  });

  it('should define add and remove subcommands', async () => {
    const { groupMembersCmd } = await import('../src/commands/groupmembers.js');
    const wrap = (fn) => fn;
    const cmd = groupMembersCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('add'), 'should have add');
    assert.ok(names.includes('remove'), 'should have remove');
  });
});

// ─── Group Roles ───

describe('GroupRoles Command', () => {
  it('should export groupRolesCmd', async () => {
    const { groupRolesCmd } = await import('../src/commands/grouproles.js');
    assert.strictEqual(typeof groupRolesCmd, 'function');
  });

  it('should define add and remove subcommands', async () => {
    const { groupRolesCmd } = await import('../src/commands/grouproles.js');
    const wrap = (fn) => fn;
    const cmd = groupRolesCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('add'), 'should have add');
    assert.ok(names.includes('remove'), 'should have remove');
  });
});
