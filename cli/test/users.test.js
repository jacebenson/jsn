import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usersCmd } from '../src/commands/users.js';
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
    assert.deepEqual(commands.map(c => c.command).sort(), ['create', 'delete <identifier>', 'list', 'show <identifier>', 'update <identifier>']);
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
