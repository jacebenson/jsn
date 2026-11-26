import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usersCmd } from '../src/commands/users.js';
import { basicAuthPolicy, evaluateBasicAuthAccount, resolveDecision } from '../src/basic-auth.js';
import { basicAuthReport, formatBasicAuthReport } from '../src/basic-auth-report.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findCommand, findHandler, wrapHandler } from './support/command-test-helpers.js';

const command = usersCmd(wrapHandler);
const commands = captureCommands(command);
const handler = name => findHandler(commands, name);
const USER_A = '46d44a23a9fe19810012d100cca80666';
const USER_B = '46e1c2f0a9fe1981005c9d1f2a2b3c4d';

const properties = [
  { name: 'glide.authenticate.basic_auth.restriction.active', value: 'true' },
  { name: 'glide.authenticate.basic_auth.restriction.enforce', value: 'true' },
  { name: 'glide.authenticate.basic_auth.restriction.enforcement_date', value: '2026-10-15 14:38:12' },
  { name: 'glide.authenticate.basic_auth.restriction.default_decision', value: 'Maintain current login - Basic Auth API and UI login allowed' },
  { name: 'glide.authenticate.basic_auth.allowed_roles', value: 'snc_basic_auth_api_access' },
  { name: 'glide.authenticate.basic_auth.allowed_users', value: '' },
  { name: 'glide.authenticate.basic_auth.allow_wsao', value: 'true' },
];
const choices = [
  { value: 'grant', label: 'Maintain current login - Basic Auth API and UI login allowed' },
  { value: 'no_grant', label: 'Revoke Basic Auth API login - Basic Auth API login blocked; UI login allowed' },
  { value: 'converted', label: 'Convert to web service access only account - Basic Auth API login allowed; UI login blocked' },
  { value: 'global', label: 'Apply default from system property' },
];
const userA = { sys_id: USER_A, user_name: 'service.api', name: 'Service API', active: 'true', web_service_access_only: 'false' };
const userB = { sys_id: USER_B, user_name: 'wsao.account', name: 'WSAO Account', active: 'true', web_service_access_only: 'true' };
const rowA = { sys_id: 'exc-a', user: USER_A, decision: 'no_grant', source: 'tracking', action_taken: 'false', usage_count: '4', last_seen: '2026-11-01 10:00:00' };
const rowB = { sys_id: 'exc-b', user: USER_B, decision: 'global', source: 'tracking', action_taken: 'true', usage_count: '1', last_seen: '2026-11-02 10:00:00' };

function sdk(overrides = {}) {
  const calls = [];
  const userRows = overrides.users ?? [userA, userB];
  const exceptionRows = overrides.exceptions ?? [rowA, rowB];
  return {
    calls,
    listStrict: async (table, params) => {
      const query = Object.fromEntries(params);
      calls.push({ table, query });
      if (table === 'sys_properties') return overrides.properties ?? properties;
      if (table === 'sys_choice') return overrides.choices ?? choices;
      if (table === 'sys_user_basic_auth_exception') {
        if (overrides.exceptionError) throw overrides.exceptionError;
        const limit = Number(query.sysparm_limit);
        const offset = Number(query.sysparm_offset || 0);
        return exceptionRows.slice(offset, offset + limit);
      }
      if (table === 'sys_user') {
        const ids = query.sysparm_query.slice('sys_idIN'.length).split(',');
        return userRows.filter(user => ids.includes(user.sys_id));
      }
      if (table === 'sys_user_has_role') return overrides.roles ?? [];
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('Basic Auth policy rules', () => {
  it('reads switches, lists and the default decision without turning missing values into false', () => {
    const policy = basicAuthPolicy(properties);
    assert.equal(policy.active, true);
    assert.equal(policy.enforce, true);
    assert.equal(policy.enforcement_date, '2026-10-15 14:38:12');
    assert.deepEqual(policy.allowed_roles, ['snc_basic_auth_api_access']);
    assert.deepEqual(policy.allowed_users, []);
    assert.equal(policy.allow_wsao, true);
    const missing = basicAuthPolicy([]);
    assert.equal(missing.active, null);
    assert.equal(missing.enforce, null);
    assert.equal(missing.allowed_roles, null);
  });

  it('resolves decision values, labels and unknown text', () => {
    assert.equal(resolveDecision('no_grant', choices).value, 'no_grant');
    assert.equal(resolveDecision('Maintain current login - Basic Auth API and UI login allowed', choices).value, 'grant');
    assert.deepEqual(resolveDecision('something else', choices), { value: null, label: null, raw: 'something else' });
  });

  const base = { sys_id: USER_A, user_name: 'service.api', active: true, web_service_access_only: false };
  const policy = basicAuthPolicy(properties);

  for (const [label, args, verdict, reason] of [
    ['WSAO exemption', { user: { ...base, web_service_access_only: true } }, 'allowed', /web service access only/],
    ['allowed role', { user: base, roleNames: ['snc_basic_auth_api_access'] }, 'allowed', /allowed role snc_basic_auth_api_access/],
    ['allowed user list', { user: base, policy: { ...policy, allowed_users: ['service.api'] } }, 'allowed', /allowed_users/],
    ['no exception row', { user: base }, 'blocked', /no exception row/],
    ['grant decision', { user: base, exception: { decision: 'grant' } }, 'allowed', /decision grant/],
    ['converted decision', { user: base, exception: { decision: 'converted' } }, 'allowed', /converted/],
    ['no_grant decision', { user: base, exception: { decision: 'no_grant' } }, 'blocked', /no_grant/],
    ['apply default resolved from its label', { user: base, exception: { decision: 'global' } }, 'allowed', /system default grants/],
    ['unknown decision', { user: base, exception: { decision: 'mystery' } }, 'unknown', /not a known choice/],
    ['unknown default', { user: base, exception: { decision: 'global' }, policy: { ...policy, default_decision_raw: 'mystery' } }, 'unknown', /default decision is not a known choice/],
    ['unreadable switches', { user: base, policy: basicAuthPolicy([]) }, 'unknown', /switches are not readable/],
    ['missing allowed roles', { user: base, policy: { ...policy, allowed_roles: null } }, 'unknown', /allowed_roles is not configured/],
    ['unreadable user', { user: null }, 'unknown', /not readable/],
  ]) {
    it(`gives ${verdict} for ${label}`, () => {
      const result = evaluateBasicAuthAccount({ policy, choices, ...args });
      assert.equal(result.verdict, verdict);
      assert.match(result.reason, reason);
    });
  }
});

describe('users basic-auth', () => {
  it('registers the read-only basic-auth report on the users family', () => {
    const entry = findCommand(commands, 'basic-auth');
    assert.ok(entry, 'basic-auth is registered');
    assert.equal(typeof entry.handler, 'function');
    assert.deepEqual(commands.map(c => c.command).sort(), ['basic-auth', 'create', 'delete <identifier>', 'list', 'roles <identifier>', 'show <identifier>', 'update <identifier>']);
  });

  it('rejects an invalid limit before reading anything', async () => {
    const s = sdk();
    for (const limit of [0, 1001, 1.5]) {
      await assert.rejects(basicAuthReport(s, { limit }), /--limit must be an integer from 1 to 1000/);
    }
    assert.deepEqual(s.calls, []);
  });

  it('joins every exception row to its user and roles and counts verdicts', async () => {
    const s = sdk({ roles: [{ user: USER_A, 'role.name': 'snc_basic_auth_api_access' }] });
    const data = await basicAuthReport(s, {});
    assert.equal(data.policy.active, true);
    assert.equal(data.policy.in_effect, true);
    assert.deepEqual(data.policy.default_decision, { value: 'grant', label: 'Maintain current login - Basic Auth API and UI login allowed', raw: 'Maintain current login - Basic Auth API and UI login allowed' });
    assert.equal(data.counts.total, 2);
    assert.equal(data.counts.allowed, 2, 'role exemption and WSAO exemption both allowed');
    assert.equal(data.counts.blocked, 0);
    assert.equal(data.counts.unknown, 0);
    const record = data.records.find(entry => entry.user === USER_B);
    assert.equal(record.web_service_access_only, true);
    assert.equal(record.verdict, 'allowed');
    assert.equal(record.decision.value, 'global');
    assert.equal(record.usage_count, 1);
    const roleQuery = s.calls.find(call => call.table === 'sys_user_has_role');
    assert.equal(roleQuery.query.sysparm_query, `userIN${USER_A},${USER_B}^role.nameINsnc_basic_auth_api_access`);
  });

  it('reports a recorded no_grant account as blocked and filters with --blocked', async () => {
    const s = sdk({ roles: [], users: [userA] });
    const all = await basicAuthReport(s, {});
    assert.equal(all.records[0].verdict, 'blocked');
    assert.equal(all.counts.blocked, 1);
    const filtered = await basicAuthReport(sdk({ roles: [], users: [userA] }), { blocked: true });
    assert.equal(filtered.records.length, 1);
    assert.equal(filtered.filters.blocked, true);
  });

  it('keeps the policy answer when the exception table refuses the read', async () => {
    const error = Object.assign(new Error('Access forbidden (HTTP 403).'), { status: 403 });
    const s = sdk({ exceptionError: error });
    const data = await basicAuthReport(s, {});
    assert.equal(data.exception_table.readable, false);
    assert.match(data.exception_table.error, /HTTP 403/);
    assert.deepEqual(data.records, []);
    assert.equal(data.counts.total, 0);
    assert.equal(data.policy.active, true);
  });

  it('prints switches, counts and reasons for a human', async () => {
    const data = await basicAuthReport(sdk({ roles: [] }), {});
    const formatted = formatBasicAuthReport(data);
    assert.match(formatted, /Basic Auth restriction: active=true, enforce=true — in effect/);
    assert.match(formatted, /Allowed roles: snc_basic_auth_api_access/);
    assert.match(formatted, /Default decision: grant — Maintain current login/);
    assert.match(formatted, /1 blocked, 1 allowed, 0 unknown/);
    assert.match(formatted, /service\.api/);
    assert.match(formatted, /no_grant/);
  });

  it('warns when enforcement is off while still showing what enforcement would do', async () => {
    const disabled = properties.map(property => property.name.endsWith('restriction.enforce') ? { ...property, value: 'false' } : property);
    const data = await basicAuthReport(sdk({ properties: disabled, roles: [], users: [userA] }), {});
    assert.equal(data.policy.in_effect, false);
    assert.ok(data.notes.some(note => note.includes('not in effect')));
    assert.equal(data.records[0].verdict, 'blocked', 'verdict is the enforcement outcome, not the current state');
  });

  it('runs the command handler and returns the report through app.ok', async () => {
    const app = makeApp({ sdk: sdk({ roles: [] }) });
    await handler('basic-auth')({ app, blocked: false, limit: 200 });
    const data = app.lastOk.data;
    assert.equal(data.table, 'sys_user_basic_auth_exception');
    assert.equal(app.lastOk.opts.summary, 'Basic Auth restriction active=true, enforce=true; 2 exception row(s): 1 blocked, 1 allowed, 0 unknown');
    assert.equal(Object.keys(data).includes('_formatted'), false);
  });
});
