// Tests for groups, groupmembers, grouproles commands
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupsCmd } from '../src/commands/groups.js';
import { groupMembersCmd } from '../src/commands/groupmembers.js';
import { groupRolesCmd } from '../src/commands/grouproles.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

for (const [name, factory, expected] of [
  ['Groups', groupsCmd, ['list', 'show', 'create', 'update', 'delete']],
  ['GroupMembers', groupMembersCmd, ['list', 'add', 'remove']],
  ['GroupRoles', groupRolesCmd, ['list', 'add', 'remove']],
]) {
  describe(`${name} Command`, () => {
    it('defines the expected subcommands', () => {
      const names = captureCommands(factory(wrapHandler)).map(s => s.command.split(' ')[0]);
      for (const name of expected) assert.ok(names.includes(name), `should have ${name}`);
    });
  });
}

describe('Groups handlers', () => {
  it('list should call sdk.list with sys_user_group', async () => {
    let listTable = '';
    const app = makeApp({ sdk: {
      list: async (table) => { listTable = table; return []; },
    } });
    await findHandler(groupsCmd(wrapHandler), 'list')({ app, _: ['list'], query: '', columns: '', limit: 20 });
    assert.strictEqual(listTable, 'sys_user_group');
  });

  it('create should call sdk.create with sys_user_group', async () => {
    let createTable = '';
    let createData = {};
    const app = makeApp({ sdk: {
      create: async (table, data) => {
        createTable = table;
        createData = data;
        return { sys_id: 'g123', name: 'Test Group' };
      },
    } });
    await findHandler(groupsCmd(wrapHandler), 'create')({ app, _: ['create'], name: 'Test Group', manager: 'manager.user' });
    assert.strictEqual(createTable, 'sys_user_group');
    assert.strictEqual(createData.name, 'Test Group');
    assert.strictEqual(createData.manager, 'manager.user');
  });
});
