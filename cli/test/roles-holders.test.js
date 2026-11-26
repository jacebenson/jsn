import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rolesCmd } from '../src/commands/roles.js';
import { classifyHolder, formatRoleHolders } from '../src/role-holders.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findCommand, findHandler, wrapHandler } from './support/command-test-helpers.js';

const command = rolesCmd(wrapHandler);
const commands = captureCommands(command);
const handler = name => findHandler(commands, name);
const ROLE_ID = '282bf1fac6112285017366cb5f867469';
const USER_A = '46d44a23a9fe19810012d100cca80666';
const USER_B = '46e1c2f0a9fe1981005c9d1f2a2b3c4d';

const roleRow = { sys_id: 'role-row', user: USER_A, role: ROLE_ID, granted_by: 'not-applicable', included_in_role: '', included_in_role_instance: '', inherited: 'false', inh_count: '', state: 'active' };
const users = [
  { sys_id: USER_A, user_name: 'beth.anglin', name: 'Beth Anglin', active: 'true', web_service_access_only: 'false', locked_out: 'false' },
  { sys_id: USER_B, user_name: 'fred.luddy', name: 'Fred Luddy', active: 'false', web_service_access_only: 'true', locked_out: 'false' },
];

function sdk({ rows = [roleRow], users: userRows = users, groups = [], counts, strictCalls = [], listCalls = [] } = {}) {
  return {
    list: async (table, params) => {
      listCalls.push([table, Object.fromEntries(params)]);
      return table === 'sys_user_role' ? [{ sys_id: ROLE_ID, name: 'itil', description: 'ITIL', elevated_privilege: 'false', sys_scope: 'Global' }] : [];
    },
    listStrict: async (table, params) => {
      const query = Object.fromEntries(params);
      strictCalls.push([table, query]);
      if (table === 'sys_user') return userRows.filter(user => query.sysparm_query.slice('sys_idIN'.length).split(',').includes(user.sys_id));
      if (table === 'sys_user_group') return groups;
      return rows.slice(0, Number(query.sysparm_limit));
    },
    aggregate: async () => {
      if (counts instanceof Error) throw counts;
      return counts ?? {
        groups: rows.length ? [{ stats: { count: String(rows.length) }, groupby_fields: [{ field: 'user', value: rows[0].user }] }] : [],
      };
    },
  };
}

describe('roles holders', () => {
  it('registers holders alongside the generic role commands', () => {
    assert.equal(command.command, 'roles [subcommand]');
    assert.ok(commands.some(entry => entry.command === 'holders <role>'));
    assert.ok(commands.some(entry => entry.command === 'list'));
    const holders = findCommand(commands, 'holders');
    assert.equal(typeof holders.handler, 'function');
    assert.ok(holders.builder);
  });

  it('rejects a bad limit before any instance request or role lookup', async () => {
    const calls = [];
    const app = makeApp({ sdk: { list: async () => { calls.push('list'); return []; }, aggregate: async () => { calls.push('aggregate'); return { groups: [] }; }, listStrict: async () => { calls.push('listStrict'); return []; } } });
    for (const limit of [0, 1001, 2.5, '5']) {
      await assert.rejects(handler('holders')({ app, role: 'itil', limit }), /--limit must be an integer from 1 to 1000/);
    }
    assert.deepEqual(calls, []);
  });

  it('refuses an unsafe role identifier before any request', async () => {
    const calls = [];
    const app = makeApp({ sdk: { list: async () => { calls.push('list'); return []; }, aggregate: async () => { calls.push('aggregate'); return { groups: [] }; }, listStrict: async () => { calls.push('listStrict'); return []; } } });
    await assert.rejects(handler('holders')({ app, role: 'itil^active=true', limit: 10 }), /Unsafe identifier/);
    assert.deepEqual(calls, []);
  });

  it('reads role rows by raw role sys_id, joins users and reports the grouped distinct count', async () => {
    const strictCalls = [];
    const app = makeApp({ sdk: sdk({ strictCalls, rows: [roleRow, { ...roleRow, sys_id: 'second-row', user: USER_B }], counts: { groups: [{ stats: { count: '1' } }, { stats: { count: '2' } }] } }) });
    await handler('holders')({ app, role: 'itil', limit: 1 });
    const [holderCall, userCall] = strictCalls;
    assert.equal(holderCall[0], 'sys_user_has_role');
    assert.equal(holderCall[1].sysparm_query, `role=${ROLE_ID}^ORDERBYuser^ORDERBYsys_id`);
    assert.equal(holderCall[1].sysparm_limit, '2', 'fetches one extra row to detect more');
    assert.equal(holderCall[1].sysparm_display_value, 'false');
    assert.equal(userCall[0], 'sys_user');
    assert.equal(userCall[1].sysparm_query, `sys_idIN${USER_A}`);
    const data = app.lastOk.data;
    assert.equal(data.mode, 'rows');
    assert.deepEqual(data.counts, { total_rows: 3, distinct_users: 2, source: 'stats_api_grouped_by_user' });
    assert.equal(data.count, 1);
    assert.equal(data.records[0].user_name, 'beth.anglin');
    assert.equal(data.records[0].via, 'direct');
    assert.equal(data.records[0].user_readable, true);
    assert.equal(data.pagination.has_more, true);
    assert.match(app.lastOk.opts.summary, /2 distinct user\(s\) hold itil; showing 1 row\(s\), more match/);
    assert.ok(data.notes.some(note => note.includes('not billable subscription seats')));
  });

  it('applies --direct as a server-side filter and counts only direct grants', async () => {
    const aggregates = [];
    const base = sdk({ strictCalls: [] });
    const app = makeApp({ sdk: { ...base, aggregate: async (table, options) => { aggregates.push(options.query); return { groups: [{ stats: { count: '1' } }] }; } } });
    await handler('holders')({ app, role: 'itil', direct: true, limit: 10 });
    assert.equal(aggregates[0], `role=${ROLE_ID}^inherited=false^included_in_roleISEMPTY`);
    assert.equal(app.lastOk.data.filters.direct, true);
  });

  it('collapses rows to one entry per user with --effective and paginates users', async () => {
    const rows = [
      { ...roleRow, sys_id: 'a', user: USER_A, inherited: 'true' },
      { ...roleRow, sys_id: 'b', user: USER_A, inherited: 'false' },
      { ...roleRow, sys_id: 'c', user: USER_B, inherited: 'false', granted_by: 'group-1' },
    ];
    const strictCalls = [];
    const app = makeApp({ sdk: sdk({ rows, strictCalls, groups: [{ sys_id: 'group-1', name: 'Service Desk' }] }) });
    await handler('holders')({ app, role: 'itil', effective: true, limit: 1 });
    const data = app.lastOk.data;
    assert.equal(data.mode, 'effective');
    assert.equal(data.count, 1);
    assert.equal(data.pagination.has_more, true);
    assert.equal(data.users[0].user_name, 'beth.anglin');
    assert.deepEqual(data.users[0].via, ['direct', 'inherited']);
    assert.equal(data.users[0].row_count, 2);
    assert.equal(data.counts.distinct_users, 2);
    assert.ok(data.notes.some(note => note.includes('does not name')));
    assert.ok(strictCalls.every(([table]) => table !== 'sys_user_group'), 'group lookup happens per page, not here');
  });

  it('reads group and contained-role grants from the row references', () => {
    assert.deepEqual(classifyHolder({ inherited: 'true', granted_by: 'g1', included_in_role: '' }), { via: 'group', group: 'g1' });
    assert.deepEqual(classifyHolder({ inherited: 'false', granted_by: 'not-applicable', included_in_role: 'r1', included_in_role_instance: 'i1' }),
      { via: 'contained_role', included_in_role: 'r1', included_in_role_instance: 'i1' });
    assert.deepEqual(classifyHolder({ inherited: 'false', granted_by: 'not-applicable', included_in_role: '' }), { via: 'direct' });
    assert.deepEqual(classifyHolder({ inherited: 'true', granted_by: 'not-applicable', included_in_role: '' }), { via: 'inherited' });
  });

  it('keeps the role answer when the Stats API is unavailable', async () => {
    const app = makeApp({ sdk: sdk({ counts: Object.assign(new Error('HTTP 403'), { status: 403 }) }) });
    await handler('holders')({ app, role: 'itil', limit: 10 });
    const data = app.lastOk.data;
    assert.equal(data.counts.distinct_users, null);
    assert.match(data.counts.error, /HTTP 403/);
    assert.equal(data.count, 1);
    assert.ok(data.notes.some(note => note.includes('Distinct user count unavailable')));
    assert.match(app.lastOk.opts.summary, /unknown distinct user\(s\)/);
  });

  it('rejects rows that belong to another role instead of reporting them', async () => {
    const app = makeApp({ sdk: sdk({ rows: [{ ...roleRow, role: 'a-different-role' }] }) });
    await assert.rejects(handler('holders')({ app, role: 'itil', limit: 10 }), { code: 'malformed_response' });
  });

  it('renders rows and effective views with the count line and notes', async () => {
    const app = makeApp({ sdk: sdk({ counts: { groups: [{ stats: { count: '1' } }] } }) });
    await handler('holders')({ app, role: 'itil', limit: 10 });
    const formatted = formatRoleHolders(app.lastOk.data);
    assert.match(formatted, /^Role itil /);
    assert.match(formatted, /1 distinct user\(s\), 1 role row\(s\); showing 1/);
    assert.match(formatted, /USER\s+USER NAME\s+ACTIVE\s+VIA\s+INHERITED\s+STATE/);
    assert.match(formatted, /beth\.anglin/);
    assert.match(formatted, /note: sys_user_has_role rows are role grants, not billable subscription seats\./);
    assert.equal(Object.keys(app.lastOk.data).includes('_formatted'), false, 'human view stays out of the JSON envelope');
  });
});
