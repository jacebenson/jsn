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

describe('groups delete', () => {
  const run = (sdk, argv) => {
    const app = makeApp({ sdk });
    return { app, done: findHandler(groupsCmd(wrapHandler), 'delete')({ app, _: ['groups', 'delete'], ...argv }) };
  };

  it('looks the name up exactly, asks for at most two rows and deletes the raw sys_id with --force', async () => {
    const calls = [];
    const { app, done } = run({
      list: async (table, params) => { calls.push(['list', table, Object.fromEntries(params)]); return [{ sys_id: { value: 'g1', display_value: 'g1' }, name: 'Team A' }]; },
      delete: async (...args) => { calls.push(['delete', ...args]); },
    }, { name: 'Team A', force: true });
    await done;
    assert.deepStrictEqual(calls, [
      ['list', 'sys_user_group', { sysparm_query: 'name=Team A', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }],
      ['delete', 'sys_user_group', 'g1'],
    ]);
    assert.deepStrictEqual(app.outputCalls, [{ data: { identifier: 'Team A', message: 'Group deleted' }, opts: { summary: 'Deleted group Team A' } }]);
  });

  it('refuses a name that matches two groups, even with --force, and deletes nothing', async () => {
    let deletes = 0;
    const { app, done } = run({
      list: async () => [{ sys_id: 'g1', name: 'Team A' }, { sys_id: 'g2', name: 'Team A' }],
      delete: async () => { deletes++; },
    }, { name: 'Team A', force: true });
    await assert.rejects(done, (err) => {
      assert.strictEqual(err.code, 'ambiguous');
      assert.match(err.message, /Multiple Group found matching exact name: Team A/);
      return true;
    });
    assert.strictEqual(deletes, 0);
    assert.deepStrictEqual(app.outputCalls, []);
  });

  for (const [label, name, prompt, hint] of [
    ['a name', 'Team A', /^Delete group Team A .+confirmation required/, /jsn groups delete 'Team A' --force/],
    ['a sys_id, naming the group it found', 'a'.repeat(32), new RegExp(`^Delete group Team A \\(${'a'.repeat(32)}\\) .+confirmation required`), new RegExp(`jsn groups delete ${'a'.repeat(32)} --force`)],
  ]) {
    it(`without --force refuses ${label} with a rerun line and deletes nothing`, async () => {
      const previous = process.env.JSN_NO_PROMPTS;
      process.env.JSN_NO_PROMPTS = '1';
      try {
        let deletes = 0;
        const { app, done } = run({
          list: async () => [{ sys_id: 'g1', name: { value: 'Team A', display_value: 'Team A' } }],
          delete: async () => { deletes++; },
        }, { name });
        await assert.rejects(done, (err) => {
          assert.strictEqual(err.code, 'confirmation_required');
          assert.match(err.message, prompt);
          assert.match(err.hint, hint);
          return true;
        });
        assert.strictEqual(deletes, 0);
        assert.deepStrictEqual(app.outputCalls, []);
      } finally {
        if (previous === undefined) delete process.env.JSN_NO_PROMPTS; else process.env.JSN_NO_PROMPTS = previous;
      }
    });
  }

  it('reports a missing group as not found without a sys_id prefix match, and deletes nothing', async () => {
    let deletes = 0;
    const queries = [];
    const { done } = run({ list: async (_table, params) => { queries.push(params.get('sysparm_query')); return []; }, delete: async () => { deletes++; } }, { name: 'Nobody', force: true });
    await assert.rejects(done, { code: 'not_found', message: 'Group not found: Nobody' });
    assert.deepStrictEqual(queries, ['name=Nobody', 'sys_id=Nobody']);
    assert.strictEqual(deletes, 0);
  });
});

describe('GroupRoles bare help', () => {
  it('names sys_group_has_role, the table every subcommand reads and writes', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    groupRolesCmd(wrapHandler).handler();
    assert.strictEqual(lines[0], 'Manage group roles in sys_group_has_role.');
  });
});
