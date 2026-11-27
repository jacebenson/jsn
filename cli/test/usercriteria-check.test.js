import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUserCriteria, formatUserCriteriaCheck } from '../src/usercriteria-check.js';
import { isMutationCommand } from '../src/mutations.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';
import '../src/command-families.js';

const id = n => n.toString(16).padStart(32, '0');
const USER = id(2), ITEM = id(9), LAPTOP = id(20), STAFF = id(21), CONTRACTORS = id(22);
const criteria = (sysId, name, active = true) => ({ user_criteria: sysId, user_criteria_name: name, active });

// The platform the background script sees. Every method the script reaches is checked against
// the reads it may make; anything else (insert, update, deleteRecord, setValue, gs.setProperty...)
// is recorded as unexpected, which is how these tests prove the script writes nothing.
const READS = { GlideRecord: ['addQuery', 'addNotNullQuery', 'orderBy', 'setLimit', 'query', 'next', 'getValue', 'getDisplayValue'], gs: ['print'],
  GlideUser: ['getUserByID'], user: ['isDefault'], GlideappCatalogItem: ['get'], item: ['canViewCheck'], SNC: ['UserCriteriaLoader'], UserCriteriaLoader: ['getMatchingCriteria'] };
function platform({ available = [criteria(LAPTOP, 'Laptop users'), criteria(STAFF, 'Staff')], notAvailable = [], matching = [], canView = true, guest = false } = {}) {
  const unexpected = [], reads = [], printed = [], userIds = new WeakMap();
  const guard = (label, target) => new Proxy(target, { get(t, name) {
    if (typeof name === 'string' && !READS[label].includes(name)) unexpected.push(`${label}.${name}`);
    return t[name] ?? (() => {});
  } });
  const tables = { sc_cat_item_user_criteria_mtom: available, sc_cat_item_user_criteria_no_mtom: notAvailable };
  function GlideRecord(table) {
    let rows = [], at = -1, activeOnly = false;
    const call = name => (...args) => { reads.push([table, name, ...args]); if (name === 'addQuery' && args[0] === 'user_criteria.active') activeOnly = args[1] === true; };
    return guard('GlideRecord', { addQuery: call('addQuery'), addNotNullQuery: call('addNotNullQuery'), orderBy: call('orderBy'), setLimit: call('setLimit'),
      query() { rows = (tables[table] ?? []).filter(row => !activeOnly || row.active); }, next: () => ++at < rows.length,
      getValue: field => rows[at][field], getDisplayValue: field => rows[at][`${field}_name`] });
  }
  const context = {
    GlideRecord,
    gs: guard('gs', { print: line => printed.push(`*** Script: ${line}`) }),
    GlideUser: guard('GlideUser', { getUserByID: userId => { reads.push(['user', userId]); const record = guard('user', { isDefault: () => guest }); userIds.set(record, userId); return record; } }),
    GlideappCatalogItem: guard('GlideappCatalogItem', { get: itemId => { reads.push(['item', itemId]); return guard('item', { canViewCheck: (force, context, userRecord) => { reads.push(['can_view', userIds.get(userRecord)]); return canView; } }); } }),
    SNC: guard('SNC', { UserCriteriaLoader: guard('UserCriteriaLoader', { getMatchingCriteria: (userId, ids) => { reads.push(['match', userId, [...ids]]); return ids.filter(i => matching.includes(i)); } }) }),
  };
  return { unexpected, reads, run: script => { vm.runInNewContext(script, context); return printed.join('\n'); } };
}

function fixture({ users = [{ sys_id: USER, user_name: 'abel.tuter' }], items = [{ sys_id: ITEM, name: 'Request a laptop', active: 'true' }], output, ...options } = {}) {
  const calls = [], instance = platform(options);
  const sdk = {
    async listStrict(table, params) { calls.push({ table, params: new URLSearchParams(params) }); return table === 'sys_user' ? users : items; },
    async executeScript(script, scope, opts) { calls.push({ script, scope, opts }); return output ?? instance.run(script); },
  };
  return { sdk, calls, instance };
}

test('reads the item\'s active criteria, asks the platform which match, and says whether the user can see it', async () => {
  const f = fixture({ matching: [LAPTOP] });
  const data = await checkUserCriteria(f.sdk, { user: 'abel.tuter', item: 'Request a laptop' });
  assert.equal(f.calls[0].table, 'sys_user');
  assert.equal(f.calls[0].params.get('sysparm_query'), 'user_name=abel.tuter');
  assert.equal(f.calls[1].table, 'sc_cat_item');
  assert.equal(f.calls[1].params.get('sysparm_query'), 'name=Request a laptop');
  assert.equal(f.calls[1].params.get('sysparm_limit'), '2');
  assert.equal(f.calls[2].scope, 'global');
  assert.equal(f.calls[2].opts.rollback, false, 'no rollback context is recorded');
  assert.deepEqual(f.instance.reads.filter(([table]) => table === 'sc_cat_item_user_criteria_mtom'), [
    ['sc_cat_item_user_criteria_mtom', 'addQuery', 'sc_cat_item', ITEM], ['sc_cat_item_user_criteria_mtom', 'addNotNullQuery', 'user_criteria'],
    ['sc_cat_item_user_criteria_mtom', 'addQuery', 'user_criteria.active', true], ['sc_cat_item_user_criteria_mtom', 'orderBy', 'user_criteria.name'],
    ['sc_cat_item_user_criteria_mtom', 'setLimit', 101]]);
  assert.ok(f.instance.reads.some(([table, name, field, value]) => table === 'sc_cat_item_user_criteria_no_mtom' && name === 'addQuery' && field === 'sc_cat_item' && value === ITEM));
  assert.deepEqual(f.instance.reads.find(([kind]) => kind === 'match'), ['match', USER, [LAPTOP, STAFF]]);
  assert.deepEqual(f.instance.reads.find(([kind]) => kind === 'item'), ['item', ITEM]);
  assert.deepEqual(f.instance.reads.find(([kind]) => kind === 'can_view'), ['can_view', USER],
    'canViewCheck is asked about the user the criteria were evaluated for');
  assert.deepEqual(f.instance.unexpected, [], 'the script makes no call outside its reads');
  assert.equal(data.can_view, true);
  assert.deepEqual(data.available_for, [{ sys_id: LAPTOP, name: 'Laptop users', matched: true }, { sys_id: STAFF, name: 'Staff', matched: false }]);
  assert.deepEqual(data.not_available_for, []);
  assert.equal(data.verdict, 'abel.tuter can see Request a laptop. abel.tuter matches Available for: Laptop users.');
  const human = formatUserCriteriaCheck(data);
  assert.match(human, /Available for:\n {2}matches: Laptop users \[0+14\]\n {2}no match: Staff \[0+15\]\nNot available for: none\n/);
});

test('the script writes nothing: a write call anywhere in it is caught', async () => {
  const f = fixture();
  await checkUserCriteria(f.sdk, { user: USER, item: ITEM });
  assert.equal(f.calls[0].params.get('sysparm_query'), `sys_id=${USER}`);
  assert.equal(f.calls[1].params.get('sysparm_query'), `sys_id=${ITEM}`);
  const script = f.calls[2].script;
  assert.deepEqual(f.instance.unexpected, []);
  for (const write of ['gr.update();', 'gr.deleteRecord();', 'gr.setValue(\'active\', false);', 'gs.setProperty(\'x\', \'y\');']) {
    const probe = platform();
    probe.run(script.replace('gr.query();', `gr.query(); ${write}`));
    assert.notDeepEqual(probe.unexpected, [], `${write} is caught`);
  }
  assert.doesNotMatch(script, /\b(insert|update|deleteRecord|deleteMultiple|updateMultiple|setValue|setProperty|eventQueue)\s*\(/);
});

test('Not available for overrides Available for, and a guest with no criteria gets no hint', async () => {
  let data = await checkUserCriteria(fixture({ notAvailable: [criteria(CONTRACTORS, 'Contractors')], matching: [LAPTOP, CONTRACTORS], canView: false }).sdk, { user: 'abel.tuter', item: ITEM });
  assert.deepEqual(data.not_available_for, [{ sys_id: CONTRACTORS, name: 'Contractors', matched: true }]);
  assert.equal(data.verdict, 'abel.tuter cannot see Request a laptop. abel.tuter matches Not available for: Contractors, which overrides Available for.');
  data = await checkUserCriteria(fixture({ matching: [], canView: false }).sdk, { user: 'abel.tuter', item: ITEM });
  assert.equal(data.verdict, 'abel.tuter cannot see Request a laptop. abel.tuter matches none of the Available for criteria.');
  data = await checkUserCriteria(fixture({ available: [], guest: true, canView: false, users: [{ sys_id: id(3), user_name: 'guest' }] }).sdk, { user: 'guest', item: ITEM });
  assert.equal(data.verdict, 'guest cannot see Request a laptop. The item has no active Available for criteria.');
});

// Which criteria match is the platform's answer (proven live); what this code owns is that every kind reaches the evaluator.
test('every kind of active criteria goes to the platform evaluator, and an inactive one is neither listed nor evaluated', async () => {
  const kinds = ['User: abel.tuter', 'Group: Field engineers', 'Role: itil', 'Department: Finance', 'Company: ACME', 'Location: Sydney', 'Script: contractors', 'Match all: role and group', 'Match any: role or group'];
  const available = kinds.map((name, n) => criteria(id(40 + n), name));
  const f = fixture({ available, notAvailable: [criteria(id(60), 'Seasonal staff', false)], matching: [id(40), id(46), id(48), id(60)] });
  const data = await checkUserCriteria(f.sdk, { user: 'abel.tuter', item: ITEM });
  assert.deepEqual(f.instance.reads.find(([kind]) => kind === 'match')[2], available.map(row => row.user_criteria));
  assert.deepEqual(data.not_available_for, []);
  assert.deepEqual(data.available_for.filter(row => row.matched).map(row => row.name), ['User: abel.tuter', 'Script: contractors', 'Match any: role or group']);
  assert.equal(data.verdict, 'abel.tuter can see Request a laptop. abel.tuter matches Available for: User: abel.tuter, Script: contractors, Match any: role or group.');
});

test('an item with no criteria, or only inactive ones, reads as having none and evaluates nothing', async () => {
  for (const options of [{ available: [] }, { available: [criteria(LAPTOP, 'Laptop users', false)], notAvailable: [criteria(CONTRACTORS, 'Contractors', false)], matching: [LAPTOP, CONTRACTORS] }]) {
    const f = fixture({ ...options, canView: true });
    const data = await checkUserCriteria(f.sdk, { user: 'abel.tuter', item: ITEM });
    assert.ok(!f.instance.reads.some(([kind]) => kind === 'match'), 'no evaluator call');
    assert.deepEqual([data.available_for, data.not_available_for], [[], []]);
    assert.equal(data.verdict, 'abel.tuter can see Request a laptop. The item has no active Available for criteria.');
  }
});

// What the instance printed live when a criteria script threw: the platform logs it, counts the criteria as no match and the script goes on.
// As a PDI logs a criteria script that reads a property of null: the Evaluator line carries no criteria sys_id.
const thrown = sysId => `Script execution error: Script Identifier: user_criteria.${sysId}, Error Description: Cannot read property "foo" from null, Script ES Level: 0\nEvaluator: com.glide.script.RhinoEcmaError: Cannot read property "foo" from null\n   script : Line(1) column(0)`;
test('a criteria script that throws is reported as a script error the platform counts as no match, not as a failed check', async () => {
  const f = fixture({ available: [criteria(LAPTOP, 'Laptop users'), criteria(STAFF, 'Staff script')], matching: [LAPTOP] });
  f.sdk.executeScript = async (script, scope, opts) => { f.calls.push({ script, scope, opts }); return `${thrown(STAFF)}\n${f.instance.run(script)}`; };
  const data = await checkUserCriteria(f.sdk, { user: 'abel.tuter', item: ITEM });
  assert.ok(f.calls[2].opts.finished.test(f.instance.run(f.calls[2].script)), 'the completion mark is what the script prints');
  assert.ok(!f.calls[2].opts.finished.test(f.calls[2].script), 'the script source, which an evaluation error echoes, does not count as finished');
  assert.deepEqual(data.available_for, [{ sys_id: LAPTOP, name: 'Laptop users', matched: true }, { sys_id: STAFF, name: 'Staff script', matched: false, script_error: true }]);
  assert.equal(data.verdict, 'abel.tuter can see Request a laptop. abel.tuter matches Available for: Laptop users. The script of Staff script threw an error, which the platform counts as no match.');
  assert.match(formatUserCriteriaCheck(data), /\n {2}script error: Staff script \[0+15\]\n/);
  f.sdk.executeScript = async script => `${thrown(STAFF)}\nScript execution error: Script Identifier: sys_script.${id(30)}, Error Description: TypeError: x is undefined\n${f.instance.run(script)}`;
  await assert.rejects(checkUserCriteria(f.sdk, { user: 'abel.tuter', item: ITEM }), /Background script failed: Script execution error: Script Identifier: sys_script\./, 'an error that is not a criteria script still fails');
});

test('a verdict that user criteria alone do not explain says so, unless a list was cut short', async () => {
  let data = await checkUserCriteria(fixture({ matching: [], canView: true }).sdk, { user: 'admin', item: ITEM });
  assert.match(data.verdict, /User criteria alone would deny this, so something other than user criteria allows it\.$/);
  data = await checkUserCriteria(fixture({ available: [], canView: false, items: [{ sys_id: ITEM, name: 'Request a laptop', active: 'false' }] }).sdk, { user: 'abel.tuter', item: ITEM });
  assert.equal(data.verdict, 'abel.tuter cannot see Request a laptop. The item has no active Available for criteria. The item is inactive. User criteria alone would allow this, so something other than user criteria denies it.');
  const many = Array.from({ length: 101 }, (_, n) => criteria(id(100 + n), `Criteria ${n}`));
  const f = fixture({ available: many, matching: [], canView: true });
  data = await checkUserCriteria(f.sdk, { user: 'abel.tuter', item: ITEM });
  assert.equal(data.available_for.length, 100);
  assert.equal(f.instance.reads.find(([kind]) => kind === 'match')[2].length, 100, 'only the listed criteria are evaluated');
  assert.equal(data.more, true);
  assert.doesNotMatch(data.verdict, /alone/);
  assert.match(formatUserCriteriaCheck(data), /More than 100 criteria in a list; only the first 100 of each were evaluated\./);
});

test('every invalid input rejects before any request', async () => {
  for (const input of [{ user: '', item: ITEM }, { user: '-x', item: ITEM }, { user: 'a^b', item: ITEM }, { user: 'abel.tuter', item: '' },
    { user: 'abel.tuter', item: 'x^ORname=y' }, { user: 'abel.tuter', item: 'two\nlines' }, { user: undefined, item: ITEM }]) {
    const f = fixture();
    await assert.rejects(checkUserCriteria(f.sdk, input), error => error.code === 'usage_error', JSON.stringify(input));
    assert.equal(f.calls.length, 0, JSON.stringify(input));
  }
});

test('a missing user or item, or a name two items share, runs no script', async () => {
  for (const [options, code] of [[{ users: [] }, 'not_found'], [{ items: [] }, 'not_found'],
    [{ items: [{ sys_id: ITEM, name: 'Request a laptop' }, { sys_id: id(10), name: 'Request a laptop' }] }, 'usage_error']]) {
    const f = fixture(options);
    await assert.rejects(checkUserCriteria(f.sdk, { user: 'abel.tuter', item: 'Request a laptop' }), error => error.code === code);
    assert.ok(!f.calls.some(call => call.script), 'no background script');
  }
});

test('a missing or malformed answer is never reported as a verdict', async () => {
  const body = { lists: { available_for: [], not_available_for: [] }, guest: false, can_view: true, matched: [] };
  const printed = value => `*** Script: JSN_UC_CHECK:${typeof value === 'string' ? value : JSON.stringify(value)}`;
  for (const output of ['', '*** Script: something else', printed('{not json'), printed({ ...body, can_view: 'true' }), printed({ ...body, guest: undefined }),
    printed({ ...body, lists: { available_for: [] } }), printed({ ...body, lists: { available_for: [{ sys_id: 'bad', name: 'x' }], not_available_for: [] } }),
    printed({ ...body, matched: ['bad'] }), printed({ ...body, matched: null })]) {
    await assert.rejects(checkUserCriteria(fixture({ output }).sdk, { user: 'abel.tuter', item: ITEM }), error => error.code === 'api_error', output);
  }
  await assert.rejects(checkUserCriteria(fixture({ items: [{ sys_id: 'bad', name: 'x' }] }).sdk, { user: 'abel.tuter', item: 'x' }), error => error.code === 'api_error');
});

test('check is a read to the mutation guard, by either name', () => {
  assert.equal(isMutationCommand({ _: ['usercriteria', 'check'] }), false);
  assert.equal(isMutationCommand({ _: ['uc', 'check'] }), false);
});

test('real CLI runs the posted script on a read-only profile and refuses bad input with no request', async () => {
  const calls = [], instance = platform({ matching: [LAPTOP] });
  let logged = '', finishes = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query') });
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/angular.do') return json(200, {}, { 'Set-Cookie': 'JSESSIONID=fixture; Path=/; HttpOnly', 'X-UserToken-Response': 'fixture-token' });
    if (url.pathname === '/sys.scripts.do' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<input name="sysparm_ck" type="hidden" value="ck">'); }
    if (url.pathname === '/sys.scripts.do') {
      const form = new URLSearchParams(body);
      calls.at(-1).form = Object.fromEntries(form);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const printed = [logged, logged && !finishes ? '' : instance.run(form.get('script'))].filter(Boolean).join('<BR/>');
      return res.end(`<PRE>${printed.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}<BR></PRE>`);
    }
    if (url.pathname === '/api/now/table/sys_user') return json(200, { result: [{ sys_id: USER, user_name: 'abel.tuter' }] });
    if (url.pathname === '/api/now/table/sc_cat_item') return json(200, { result: [{ sys_id: ITEM, name: 'Request a laptop', active: 'true' }] });
    return json(404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-uc-check-')));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const envelope = JSON.parse((await run(['usercriteria', 'check', 'abel.tuter', 'Request a laptop', '--json'])).stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.verdict, 'abel.tuter can see Request a laptop. abel.tuter matches Available for: Laptop users.');
    assert.ok(calls.filter(call => call.pathname.startsWith('/api/now/')).every(call => call.method === 'GET'), 'the REST calls are reads');
    const posted = calls.filter(call => call.pathname === '/sys.scripts.do' && call.method === 'POST');
    assert.equal(posted.length, 1, 'one background script');
    assert.equal(posted[0].form.record_for_rollback, undefined, 'no rollback context');
    assert.equal(posted[0].form.sys_scope, 'global');
    assert.deepEqual(instance.unexpected, []);
    const human = await run(['uc', 'check', 'abel.tuter', 'Request a laptop', '--format', 'styled']);
    assert.match(human.stdout, /User criteria check for abel\.tuter on Request a laptop[\s\S]*matches: Laptop users[\s\S]*abel\.tuter can see Request a laptop\./);
    const before = calls.length;
    for (const args of [['abel.tuter', 'x^ORname=y'], ['a^b', 'Request a laptop'], ['abel.tuter', 'Request a laptop', '--impersonate', 'abel.tuter'], ['abel.tuter']]) {
      await assert.rejects(run(['usercriteria', 'check', ...args, '--json']), undefined, args.join(' '));
    }
    assert.equal(calls.length, before, 'refused input sends nothing');
    logged = thrown(STAFF);
    const ran = JSON.parse((await run(['uc', 'check', 'abel.tuter', 'Request a laptop', '--json'])).stdout);
    assert.deepEqual(ran.data.available_for.find(row => row.sys_id === STAFF), { sys_id: STAFF, name: 'Staff', matched: false, script_error: true });
    finishes = false;
    const failed = await run(['uc', 'check', 'abel.tuter', 'Request a laptop', '--json']).then(() => null, error => error);
    assert.ok(failed, 'a script that never printed its result is a failure');
    assert.match(failed.stderr, /Background script failed: Script execution error: Script Identifier: user_criteria\./);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
