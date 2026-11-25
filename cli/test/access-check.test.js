import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAccess, formatAccessCheck } from '../src/access-check.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const USER = id(2), RECORD = id(9), RULE = id(30);
const checks = (value, overrides = {}) => ({ applies_to: value, roles: value, condition: value, script: value, security_attribute: value, reference: value, ...overrides });
// The shape getDebugLogs gave on a live instance (25 Nov 2026), reduced by the script to the fields used.
const acls = allowed => [
  { sys_id: id(40), path: 'record/incident/read', decision_type: 'DENY_UNLESS', roles: [], checks: checks('TRUE') },
  { sys_id: id(41), path: 'record/incident/read', decision_type: 'ALLOW_IF', roles: ['itil'], checks: allowed ? checks('TRUE') : checks('NOT_EVALUATED', { applies_to: 'TRUE', roles: 'FALSE' }) },
  { sys_id: id(42), path: 'record/incident/read', decision_type: 'ALLOW_IF', roles: [], checks: checks('NOT_EVALUATED') },
  { sys_id: id(43), path: 'record/incident/read', decision_type: 'ALLOW_IF', roles: ['admin'], checks: checks('NOT_EVALUATED', { applies_to: 'FALSE' }) },
];
// status is the analyzer's overall decision; results are its ACL verdicts, one SecurityRulesInfo entry each.
const evaluation = ({ allowed = true, blocked = !allowed, result = blocked ? 'blocked' : 'passed', ops = ['read', 'write', 'delete'], ...rest } = {}) => ({
  tables: ['incident', 'task'], error: 0, errorMessage: '',
  ops: Object.fromEntries(ops.map(op => [op, { status: allowed, results: [result], rules: [RULE], acls: acls(!blocked) }])), ...rest,
});
const printed = body => `*** Script: JSN_ACCESS_CHECK:${typeof body === 'string' ? body : JSON.stringify(body)}`;

function fixture({ output = printed(evaluation()), users = [{ sys_id: USER, user_name: 'abel.tuter' }], rules = [{ sys_id: RULE, name: 'incident query', collection: 'incident', order: '100', condition: '' }], read = [{ sys_id: RECORD }] } = {}) {
  const calls = [], reads = [];
  const sdk = {
    async listStrict(table, params) {
      calls.push({ table, params });
      return table === 'sys_user' ? users : rules;
    },
    async executeScript(script, scope, opts) {
      calls.push({ script, scope, opts });
      return output;
    },
  };
  const asSdk = { async listStrict(table, params) { reads.push({ table, params }); if (read instanceof Error) throw read; return read; } };
  const asUser = async (sysId, fn) => { reads.push({ as: sysId }); return fn(asSdk); };
  return { sdk, asUser, calls, reads };
}
const input = (overrides = {}) => ({ user: 'abel.tuter', table: 'incident', record: RECORD, ...overrides });

test('evaluates live, lists before-query rules on the table and its parents, then reads as the user', async () => {
  const f = fixture();
  const data = await checkAccess(f.sdk, input(), f);
  assert.equal(f.calls[0].table, 'sys_user');
  assert.equal(f.calls[0].params.sysparm_query, 'user_name=abel.tuter');
  assert.equal(f.calls[1].scope, 'global');
  assert.equal(f.calls[1].opts.rollback, false, 'no rollback context is recorded');
  for (const part of [`new GlideRecord('incident')`, `gr.get('${RECORD}')`, `entitySysId: '${USER}'`, `targetRecord: '${RECORD}'`, 'targetOperations: ["read","write","delete"]', 'shouldPersistResult: false', 'results.push(String(l.returnCodeDisplayValue))']) assert.ok(f.calls[1].script.includes(part), part);
  assert.equal(f.calls[2].table, 'sys_script');
  assert.equal(f.calls[2].params.get('sysparm_query'), 'when=before^action_query=true^active=true^collectionINincident,task,global^ORDERBYorder^ORDERBYname');
  assert.equal(f.calls[2].params.get('sysparm_limit'), '51');
  assert.deepEqual(f.reads[0], { as: USER });
  assert.equal(f.reads[1].table, 'incident');
  assert.equal(f.reads[1].params.get('sysparm_query'), `sys_id=${RECORD}`);
  assert.equal(data.verdict, 'abel.tuter can read this record.');
  assert.deepEqual(data.operations.map(op => [op.operation, op.allowed]), [['read', true], ['write', true], ['delete', true]]);
  assert.deepEqual(data.before_query_rules[0], { sys_id: RULE, name: 'incident query', collection: 'incident', order: '100', condition: '', ran_in_evaluation: true });
  const human = formatAccessCheck(data);
  assert.equal(data.read_as_user, 'returned');
  assert.match(human, /read: allowed\n/);
  assert.match(human, /incident query \(incident, order 100\), ran during the evaluation/);
  assert.match(human, /Read as abel\.tuter: the record was returned/);
});

test('a blocked read names the ACL that failed and the check it failed on', async () => {
  const f = fixture({ output: printed(evaluation({ allowed: false })), read: [] });
  const data = await checkAccess(f.sdk, input(), f);
  assert.equal(data.verdict, 'ACLs block abel.tuter from reading this record.');
  assert.deepEqual(data.operations[0].acls.map(acl => [acl.result, acl.failed_checks]), [['passed', []], ['failed', ['roles']], ['not_evaluated', []], ['not_applicable', []]]);
  assert.match(formatAccessCheck(data), new RegExp(`ALLOW_IF record/incident/read, roles itil: failed on roles \\[${id(41)}\\]`));
  assert.match(formatAccessCheck(data), new RegExp(`ALLOW_IF record/incident/read, roles admin: not applicable \\[${id(43)}\\]`));
});

test('ACLs that allow a read the user cannot make point at the before-query rules', async () => {
  const hidden = await checkAccess(fixture({ read: [] }).sdk, input(), fixture({ read: [] }));
  assert.match(hidden.verdict, /ACLs allow abel\.tuter to read this record, but a read as abel\.tuter does not return it; a before-query rule listed is the likely cause\./);
  const none = fixture({ read: [], rules: [] });
  assert.match((await checkAccess(none.sdk, input(), none)).verdict, /no active before-query rule is on these tables/);
  // The analyzer's overall decision counts query rules; with every ACL passing it is no ACL block.
  const denied = fixture({ output: printed(evaluation({ allowed: false, blocked: false })), read: [] });
  const byRule = await checkAccess(denied.sdk, input(), denied);
  assert.match(byRule.verdict, /^ACLs allow abel\.tuter to read this record, but .* a before-query rule listed is the likely cause\.$/);
  assert.match(formatAccessCheck(byRule), /read: denied by the analyzer, though no ACL blocks it[\s\S]*incident query \(incident, order 100\), ran during the evaluation/);
  const forbidden = () => Object.assign(new Error('Access forbidden (HTTP 403).'), { status: 403 });
  const refused = fixture({ read: forbidden() });
  const refusedData = await checkAccess(refused.sdk, input(), refused);
  assert.equal(refusedData.read_as_user, 'refused');
  assert.equal(refusedData.verdict, 'ACLs allow abel.tuter to read this record, but the instance refused a read as abel.tuter.', 'a refusal is not blamed on a query rule');
  assert.match(formatAccessCheck(refusedData), /Read as abel\.tuter: refused \(HTTP 403\)/);
  const refusedBlocked = fixture({ output: printed(evaluation({ allowed: false })), read: forbidden() });
  assert.equal((await checkAccess(refusedBlocked.sdk, input(), refusedBlocked)).verdict, 'ACLs block abel.tuter from reading this record.');
  // A skipped or undefined ACL step is undecided, never read as ACLs allowing.
  const skipped = fixture({ output: printed(evaluation({ allowed: false, blocked: false, result: 'Skipped' })), read: [] });
  const skippedData = await checkAccess(skipped.sdk, input(), skipped);
  assert.equal(skippedData.verdict, 'The analyzer did not decide the ACLs (skipped), and a read as abel.tuter does not return this record; check the before-query rules listed.');
  assert.match(formatAccessCheck(skippedData), /read: denied by the analyzer, ACL check skipped/);
  const undecidedRefused = fixture({ output: printed(evaluation({ allowed: false, blocked: false, result: 'undefined' })), read: forbidden() });
  assert.equal((await checkAccess(undecidedRefused.sdk, input(), undecidedRefused)).verdict, 'The analyzer did not decide the ACLs (undefined), and the instance refused a read as abel.tuter.');
  const contradicted = fixture({ output: printed(evaluation({ allowed: false })) });
  assert.equal((await checkAccess(contradicted.sdk, input(), contradicted)).verdict, 'ACLs block abel.tuter from reading this record, yet a read as abel.tuter returned it.');
  const write = fixture({ output: printed(evaluation({ ops: ['write'] })), read: [] });
  const data = await checkAccess(write.sdk, input({ operations: 'write' }), write);
  assert.ok(write.calls[1].script.includes('targetOperations: ["write"]'));
  assert.equal(data.verdict, 'A read as abel.tuter does not return this record.');
});

test('every invalid input rejects before any request', async () => {
  const f = fixture();
  for (const bad of [{ user: '' }, { user: '-x' }, { user: 'a^NQb' }, { user: 'a\nb' }, { table: 'Incident' }, { table: "incident'" }, { table: '' }, { record: 'bad' }, { record: `${id(9).slice(1)}'` }, { operations: 'create' }, { operations: 'read,' }]) {
    await assert.rejects(checkAccess(f.sdk, input(bad), f), { code: 'usage_error' }, JSON.stringify(bad));
  }
  assert.equal(f.calls.length + f.reads.length, 0);
  const browser = fixture();
  browser.sdk.authProvider = { getCredentials: async () => ({ auth_method: 'gck' }) };
  await assert.rejects(checkAccess(browser.sdk, input(), browser), { code: 'usage_error', message: /browser-session profile/ });
  assert.equal(browser.calls.length + browser.reads.length, 0, 'a browser-session profile is refused before any request');
});

test('a missing, refused or malformed answer is never reported as allowed', async () => {
  const cases = [
    [{ users: [] }, /user not found/],
    [{ users: [{ sys_id: USER, user_name: 'a' }, { sys_id: id(3), user_name: 'b' }] }, /exactly one/],
    [{ output: 'no marker here' }, /no readable result/],
    [{ output: printed('{"tables":') }, /no readable result/],
    [{ output: printed({ missing: 'table' }) }, /table not found: incident/],
    [{ output: printed({ missing: 'record' }) }, /incident record not found/],
    [{ output: printed({ missing: 'analyzer' }) }, /Access Analyzer API not found/],
    [{ output: printed(evaluation({ error: 1, errorMessage: 'Invalid target' })) }, /could not evaluate access: Invalid target/],
    [{ output: printed(evaluation({ ops: ['read', 'write'] })) }, /no readable result/],
    [{ output: printed({ ...evaluation(), ops: { ...evaluation().ops, read: { status: 'true', results: ['passed'], rules: [], acls: [] } } }) }, /no readable result/],
    [{ output: printed({ ...evaluation(), ops: { ...evaluation().ops, read: { status: true, results: ['passed'], rules: [], acls: [{ sys_id: 'x', checks: {} }] } } }) }, /no readable result/],
    [{ output: printed({ ...evaluation(), ops: { ...evaluation().ops, read: { status: true, results: [], rules: [], acls: [] } } }) }, /no readable result/],
    [{ output: printed({ ...evaluation(), ops: { ...evaluation().ops, read: { status: true, results: ['unknown'], rules: [], acls: [] } } }) }, /no readable result/],
    [{ output: printed(evaluation({ tables: ['incident^ORsys_id!=x'] })) }, /no readable result/],
    [{ rules: [{ sys_id: 'not-a-sys-id' }] }, /no readable result/],
  ];
  for (const [options, message] of cases) {
    const f = fixture(options);
    await assert.rejects(checkAccess(f.sdk, input(), f), message, JSON.stringify(options).slice(0, 80));
    assert.equal(f.reads.length, 0, 'no read as the user after a bad answer');
  }
  for (const read of [[{ sys_id: id(99) }], { result: [] }, Object.assign(new Error('server error'), { status: 500 })]) {
    const f = fixture({ read });
    await assert.rejects(checkAccess(f.sdk, input(), f), JSON.stringify(read));
  }
});

test('real CLI checks on a read-only profile through the impersonated session, and refuses bad input with no request', async () => {
  const COOKIE = 'JSESSIONID=fixture-session-cookie';
  const users = { fixture: id(1), 'abel.tuter': USER };
  const state = { current: 'fixture', loggedOut: false };
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const call = { method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query'), authorization: Boolean(req.headers.authorization), as: state.current };
    calls.push(call);
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const onSession = (req.headers.cookie || '').includes(COOKIE) && !state.loggedOut;
    if (url.pathname === '/angular.do' && url.searchParams.get('sysparm_type') === 'view_form.login') { state.loggedOut = false; return json(200, {}, { 'Set-Cookie': `${COOKIE}; Path=/; HttpOnly` }); }
    if (url.pathname === '/angular.do') return json(200, {}, { 'X-UserToken-Response': 'fixture-token' });
    if (url.pathname === '/logout.do') { state.loggedOut = true; res.writeHead(302, { Location: 'logout_success.do' }); return res.end(); }
    if (url.pathname === '/sys.scripts.do' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<input name="sysparm_ck" type="hidden" value="ck">'); }
    if (url.pathname === '/sys.scripts.do') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<PRE>${printed(evaluation({ allowed: false })).replace(/"/g, '&quot;')}<BR></PRE>`); }
    if (url.pathname.startsWith('/api/now/') && !onSession && !req.headers.authorization) return json(401, { error: { message: 'User Not Authenticated' } });
    if (url.pathname === '/api/now/sg/impersonation/session') return json(200, { OriginalUser: 'fixture', CurrentUser: state.current, SessionToken: 'fixture-token', CanImpersonate: true });
    if (url.pathname.startsWith('/api/now/ui/impersonate/')) { state.current = Object.keys(users).find(name => url.pathname.endsWith(users[name])) || state.current; return json(201, { result: {} }); }
    if (url.pathname === '/api/now/table/sys_user') {
      const [field, value] = (call.query || '').split('=');
      const name = field === 'sys_id' ? Object.keys(users).find(key => users[key] === value) : value;
      return json(200, { result: users[name] ? [{ sys_id: users[name], user_name: name }] : [] });
    }
    if (url.pathname === '/api/now/table/sys_script') return json(200, { result: [{ sys_id: RULE, name: 'incident query', collection: 'incident', order: '100', condition: '' }] });
    if (url.pathname === '/api/now/table/incident') return json(200, { result: state.current === 'abel.tuter' ? [] : [{ sys_id: RECORD }] });
    return json(404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-access-check-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  const check = ['access-analyzer', 'check', '--user', 'abel.tuter', '--table', 'incident', '--record', RECORD];
  try {
    const envelope = JSON.parse((await run([...check, '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.verdict, 'ACLs block abel.tuter from reading this record.');
    assert.equal(envelope.data.read_as_user, 'not_returned');
    const read = calls.filter(call => call.pathname === '/api/now/table/incident');
    assert.equal(read.length, 1);
    assert.equal(read[0].as, 'abel.tuter', 'the record is read as the user');
    assert.equal(read[0].authorization, false, 'by session only, which keeps the impersonation');
    assert.deepEqual(calls.slice(-3).map(call => `${call.method} ${call.pathname}`), [`POST /api/now/ui/impersonate/${users.fixture}`, 'GET /logout.do', 'GET /api/now/sg/impersonation/session'], 'the session is reverted and ended');
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/table/')).every(call => call.method === 'GET'));
    const human = await run([...check, '--format', 'styled']);
    assert.match(human.stdout, /read: blocked by ACL[\s\S]*incident query[\s\S]*Read as abel\.tuter: the record was not returned/);
    const before = calls.length;
    for (const args of [['--record', 'bad'], ['--table', 'Incident'], ['--operations', 'create'], ['--impersonate', 'abel.tuter']]) {
      await assert.rejects(run([...check, ...args, '--json']), undefined, args.join(' '));
    }
    const missing = await run(['access-analyzer', 'check', '--table', 'incident', '--record', RECORD, '--json']).catch(error => error);
    assert.equal(JSON.parse(missing.stdout).error, 'Missing required argument: --user');
    assert.equal(calls.length, before, 'refused input sends nothing');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
