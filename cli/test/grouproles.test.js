import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupRolesCmd } from '../src/commands/grouproles.js';
import { isMutationCommand } from '../src/mutations.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const add = findHandler(captureCommands(groupRolesCmd(wrapHandler)), 'add');
const id = c => c.repeat(32);
const GROUP = id('e'), L2 = id('c'), L3 = id('d'), ROLE = id('f'), BETH = id('b'), ABEL = id('a');
const field = (value, display = value) => ({ value, display_value: display });

// A fake instance: Service Desk with L2 under it and L3 under L2, the itil role, and their memberships.
function fixture({ groups = 1, granted = false, children = { [GROUP]: [[L2, 'Service Desk L2']], [L2]: [[L3, 'Service Desk L3']] },
  members = [[BETH, GROUP], [BETH, L2], [ABEL, L3]] } = {}) {
  const calls = [];
  const sdk = {
    list: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['list', table, p]);
      if (table === 'sys_user_group' && p.sysparm_query === 'name=Service Desk') return Array.from({ length: groups }, (_, i) => ({ sys_id: field(i ? id('9') : GROUP), name: field('Service Desk') }));
      if (table === 'sys_user_role' && p.sysparm_query === 'name=itil') return [{ sys_id: field(ROLE), name: field('itil') }];
      return [];
    },
    listStrict: async (table, params) => {
      const p = Object.fromEntries(params);
      calls.push(['listStrict', table, p]);
      const q = p.sysparm_query;
      if (table === 'sys_group_has_role') return granted ? [{ sys_id: id('7') }] : [];
      if (table === 'sys_user_group') return q.slice('parentIN'.length).split(',').flatMap(parent => (children[parent] || []).map(([sysId, name]) => ({ sys_id: sysId, name, parent })));
      if (table === 'sys_user_grmember') return members.map(([user, group]) => ({ user, group }));
      return [];
    },
    create: async (table, data) => { calls.push(['create', table, data]); return { sys_id: id('8'), group: field(GROUP), role: field(ROLE) }; },
  };
  return { calls, app: makeApp({ sdk }) };
}
const writes = calls => calls.filter(c => c[0] === 'create');
const lookups = [
  ['list', 'sys_user_group', { sysparm_query: 'name=Service Desk', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }],
  ['list', 'sys_user_role', { sysparm_query: 'name=itil', sysparm_limit: '2', sysparm_display_value: 'all', sysparm_fields: 'sys_id,name' }],
  ['listStrict', 'sys_group_has_role', { sysparm_query: `group=${GROUP}^role=${ROLE}`, sysparm_fields: 'sys_id', sysparm_limit: '1' }],
];
const level = parents => ['listStrict', 'sys_user_group', { sysparm_query: `parentIN${parents.join(',')}`, sysparm_fields: 'sys_id,name,parent', sysparm_limit: '101', sysparm_display_value: 'false' }];
const membersRead = groups => ['listStrict', 'sys_user_grmember', { sysparm_query: `groupIN${groups.join(',')}`, sysparm_fields: 'user,group', sysparm_limit: '1001', sysparm_display_value: 'false' }];
const argv = { group: 'Service Desk', role: 'itil', _: ['grouproles', 'add'], profile: 'dev' };

describe('grouproles add', () => {
  it('stays a mutation, so read-only profiles refuse it', () => {
    assert.equal(isMutationCommand({ _: ['grouproles', 'add'] }), true);
  });

  it('previews by default: walks the child groups, counts each member once, and writes nothing', async () => {
    const { calls, app } = fixture();
    await add({ app, ...argv, yes: false });
    assert.deepEqual(calls, [...lookups, level([GROUP]), level([L2]), level([L3]), membersRead([GROUP, L2, L3])]);
    const { data, opts } = app.lastOk;
    assert.deepEqual({ ...data }, {
      group: { sys_id: GROUP, name: 'Service Desk' }, role: { sys_id: ROLE, name: 'itil' },
      child_groups: [{ sys_id: L2, name: 'Service Desk L2' }, { sys_id: L3, name: 'Service Desk L3' }],
      members: 2, complete: true, dry_run: true,
      rerun: "jsn grouproles add --group 'Service Desk' --role itil --yes --profile dev",
    });
    assert.equal(opts.summary, 'Dry run: would grant itil to Service Desk and 2 child group(s), reaching 2 member(s); nothing written');
    assert.equal(data._formatted, [
      'Would grant itil to Service Desk and the groups under it:',
      '  Service Desk L2',
      '  Service Desk L3',
      '2 member(s) would get itil through Service Desk.',
      '',
      "Run: jsn grouproles add --group 'Service Desk' --role itil --yes --profile dev",
    ].join('\n'));
  });

  it('--yes writes one sys_group_has_role row by raw sys_ids, without the preview reads', async () => {
    const { calls, app } = fixture();
    await add({ app, ...argv, yes: true });
    assert.deepEqual(calls, [...lookups, ['create', 'sys_group_has_role', { group: GROUP, role: ROLE }]]);
    assert.equal(app.lastOk.opts.summary, 'Added role itil to Service Desk');
    assert.deepEqual(app.lastOk.data.sys_id, id('8'));
  });

  it('refuses a group name two groups share, even with --yes, and writes nothing', async () => {
    const { calls, app } = fixture({ groups: 2 });
    await assert.rejects(() => add({ app, ...argv, yes: true }), (err) => {
      assert.equal(err.code, 'ambiguous');
      assert.match(err.message, /Multiple Group found matching exact name: Service Desk/);
      return true;
    });
    assert.deepEqual(calls, [lookups[0]]);
    assert.deepEqual(app.outputCalls, []);
  });

  it('refuses a grant the group already has, before any preview read or write', async () => {
    const { calls, app } = fixture({ granted: true });
    await assert.rejects(() => add({ app, ...argv, yes: true }), { message: 'Role itil is already assigned to group Service Desk' });
    assert.deepEqual(calls, lookups);
  });

  it('says "at least" when the member rows pass the read cap', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => [String(i).padStart(32, '0'), GROUP]);
    const { app } = fixture({ children: {}, members: many });
    await add({ app, ...argv, yes: false });
    const { data, opts } = app.lastOk;
    assert.equal(data.members, 1000);
    assert.equal(data.complete, false);
    assert.equal(opts.summary, 'Dry run: would grant itil to Service Desk, reaching at least 1000 member(s); nothing written');
    assert.match(data._formatted, /^Would grant itil to Service Desk\.\nAt least 1000 member\(s\) would get itil through Service Desk\./);
  });

  it('stops walking at 100 child groups and says "at least"', async () => {
    const wide = Array.from({ length: 101 }, (_, i) => [String(i).padStart(32, 'a'), `Team ${i}`]);
    const { calls, app } = fixture({ children: { [GROUP]: wide }, members: [] });
    await add({ app, ...argv, yes: false });
    const { data } = app.lastOk;
    assert.equal(data.child_groups.length, 100);
    assert.equal(data.complete, false);
    assert.deepEqual(calls.filter(c => c[1] === 'sys_user_group' && c[0] === 'listStrict'), [level([GROUP])]);
    assert.deepEqual(calls.at(-1), membersRead([GROUP, ...wide.slice(0, 100).map(([sysId]) => sysId)]));
    assert.deepEqual(writes(calls), []);
  });

  it('refuses a membership row outside the group tree as malformed', async () => {
    const { calls, app } = fixture({ members: [[BETH, id('5')]] });
    await assert.rejects(() => add({ app, ...argv, yes: false }), { code: 'malformed_response' });
    assert.deepEqual(writes(calls), []);
    assert.deepEqual(app.outputCalls, []);
  });

  it('refuses a child group row whose parent was not asked for as malformed', async () => {
    const { app } = fixture({ children: { [GROUP]: [[L2, 'Service Desk L2']] } });
    app.sdk.listStrict = async (table) => table === 'sys_user_group' ? [{ sys_id: L2, name: 'Service Desk L2', parent: id('5') }] : [];
    await assert.rejects(() => add({ app, ...argv, yes: false }), { code: 'malformed_response' });
  });
});
