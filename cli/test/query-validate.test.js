import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEncodedQuery, validateReadQuery, assertWriteQuery, queryDiagnostics, metadataIdentity } from '../src/query-validate.js';
import { recordsCmd } from '../src/commands/records.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn549-validate-'));
process.env.XDG_CACHE_HOME = cacheHome;
after(() => fs.rmSync(cacheHome, { recursive: true, force: true }));
const id = letter => letter.repeat(32);

function metadataSdk({ deny = false, fields } = {}) {
  const calls = [];
  const rows = fields || {
    x_case: [
      { sys_id: id('a'), name: 'x_case', element: 'short_description', internal_type: 'string', reference: '' },
      { sys_id: id('b'), name: 'x_case', element: 'assigned_to', internal_type: 'reference', reference: 'sys_user' },
    ],
    task: [
      { sys_id: id('c'), name: 'task', element: 'number', internal_type: 'string', reference: '' },
      { sys_id: id('d'), name: 'task', element: 'active', internal_type: 'boolean', reference: '' },
    ],
    sys_user: [{ sys_id: id('e'), name: 'sys_user', element: 'user_name', internal_type: 'string', reference: '' }],
  };
  return {
    calls,
    async list(table, params, opts = {}) {
      calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit') });
      if (deny) throw Object.assign(new Error('denied'), { status: 403 });
      if (table === 'sys_db_object') {
        const query = params.get('sysparm_query') || '';
        if (query === `sys_id=${id('f')}`) return [{ sys_id: id('f'), name: 'task', super_class: '' }];
        const name = query.replace(/^name=/, '');
        if (name === 'x_case') return [{ sys_id: id('9'), name: 'x_case', super_class: { value: id('f') } }];
        if (name === 'sys_user') return [{ sys_id: id('1'), name: 'sys_user', super_class: '' }];
        if (name === 'task') return [{ sys_id: id('f'), name: 'task', super_class: '' }];
        return [];
      }
      if (table === 'sys_dictionary') {
        const owners = (params.get('sysparm_query').match(/^nameIN([^^]+)\^/) || [])[1]?.split(',') || [];
        const result = owners.flatMap(owner => rows[owner] || []);
        if (opts.responseMetadata) opts.responseMetadata.total = result.length;
        return result;
      }
      return [];
    },
  };
}

function appFor(sdk, { profile, username = 'alice' } = {}) {
  profile = profile || `p${++appFor.counter}`;
  return {
    sdk: { ...sdk, username },
    session: { username, profileName: profile },
    config: { activeProfile: profile, defaultProfile: profile, profiles: {} },
    getEffectiveInstance: () => 'https://dev1.service-now.com',
    requireInstance() {},
    ok() {},
  };
}

appFor.counter = 0;
const identity = { instance: 'https://dev1.service-now.com', profile: 'work', principal: 'alice' };
let identityCounter = 0;
const ident = () => ({ ...identity, profile: `work-${++identityCounter}` });

test('valid query uses inherited fields and reference dot-walks', async () => {
  const verdict = await validateEncodedQuery({ sdk: metadataSdk(), identity: ident(), table: 'x_case',
    query: 'numberSTARTSWITHINC^assigned_to.user_name=alice' });
  assert.equal(verdict.state, 'valid');
  assert.equal(verdict.query, 'numberSTARTSWITHINC^assigned_to.user_name=alice');
  assert.equal(verdict.diagnostics.length, 0);
});

test('unknown field and invalid dot-walk are invalid with actionable suggestions', async () => {
  const unknown = await validateEncodedQuery({ sdk: metadataSdk(), identity: ident(), table: 'x_case', query: 'short_descripitonLIKEfoo' });
  assert.equal(unknown.state, 'incomplete');
  const diagnostic = unknown.diagnostics.find(d => d.code === 'unknown_field');
  assert.ok(diagnostic);
  assert.ok(diagnostic.suggestions.includes('short_description'));
  const walk = await validateEncodedQuery({ sdk: metadataSdk(), identity: ident(), table: 'x_case', query: 'short_description.foo=1' });
  assert.equal(walk.state, 'invalid');
  assert.equal(walk.diagnostics.find(d => d.code === 'invalid_dot_walk').field, 'short_description');
});

test('operator typo is rejected using visible field metadata', async () => {
  const sdk = metadataSdk();
  const verdict = await validateEncodedQuery({ sdk, identity, table: 'x_case', query: 'short_descriptionSTARTWITHfoo' });
  assert.equal(verdict.state, 'invalid');
  assert.ok(sdk.calls.length > 0);
  assert.equal(verdict.query, 'short_descriptionSTARTWITHfoo');
});

test('dynamic syntax is unsupported and performs no metadata download', async () => {
  const sdk = metadataSdk();
  const verdict = await validateEncodedQuery({ sdk, identity, table: 'x_case', query: 'user_name=javascript:gs.getUserName()' });
  assert.equal(verdict.state, 'unsupported');
  assert.equal(sdk.calls.length, 0);
});

test('denied metadata is reported, reads proceed, writes fail closed', async () => {
  const app = appFor(metadataSdk({ deny: true }));
  const verdict = await validateReadQuery(app, { table: 'x_case', query: 'active=true' });
  assert.equal(verdict.state, 'denied');
  assert.match(verdict.diagnostics[0].message, /not visible/);
  await assert.rejects(assertWriteQuery(app, { table: 'x_case', query: 'active=true' }), /denied/i);
});

test('diagnostics carry limits and byte-identical query for unverified reads', async () => {
  const app = appFor(metadataSdk({ deny: true }));
  const verdict = await validateReadQuery(app, { table: 'x_case', query: 'active=true^ORnameLIKEa^^b^ORDERBYnumber' });
  assert.equal(verdict.query, 'active=true^ORnameLIKEa^^b^ORDERBYnumber');
  const data = queryDiagnostics(verdict);
  assert.equal(data.query_validation.state, 'denied');
  assert.equal(data.query_validation.limits.ttl_seconds, 300);
  assert.ok(data.warnings.length > 0);
});

test('configured usernames alone do not verify a principal', () => {
  assert.equal(metadataIdentity(appFor(metadataSdk())).principal, '');
  assert.equal(metadataIdentity(appFor(metadataSdk(), { username: 'alice' }) && { ...appFor(metadataSdk()), sdk: { username: 'bob' } }).principal, '');
  assert.equal(metadataIdentity({ getEffectiveInstance: () => 'https://x' }).principal, '');
});

function commandHandler(name, app, { table = 'x_case', query = 'active=true' } = {}) {
  const commands = [];
  const builder = { command(entry) { commands.push(entry); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(entry => entry.command === name).handler;
  return handler({ table, query, limit: 200 }, app);
}

function writeFixture({ deny = false } = {}) {
  const base = metadataSdk({ deny });
  const state = { counts: 0, deletes: [], updates: [], recordLists: 0 };
  const app = appFor(base);
  app.sdk.aggregateCount = async () => { state.counts++; return 0; };
  app.sdk.delete = async (table, idValue) => { state.deletes.push(idValue); };
  app.sdk.update = async (table, idValue) => { state.updates.push(idValue); };
  app.sdk.list = async (table, params, opts) => {
    if (table === 'sys_db_object' || table === 'sys_dictionary') return base.list(table, params, opts);
    state.recordLists++;
    return [];
  };
  return { app, state };
}

test('delete-many denied metadata performs zero counts, reads and deletes', async () => {
  const { app, state } = writeFixture({ deny: true });
  await assert.rejects(commandHandler('delete-many', app, { query: 'short_description=printer' }), /denied|not visible/i);
  assert.deepEqual(state, { counts: 0, deletes: [], updates: [], recordLists: 0 });
});

test('delete-many invalid operator performs zero writes', async () => {
  const { app, state } = writeFixture();
  await assert.rejects(commandHandler('delete-many', app, { query: 'short_descriptionSTARTWITHprinter' }), /validation state is invalid/);
  assert.deepEqual(state, { counts: 0, deletes: [], updates: [], recordLists: 0 });
});

test('bulk unverified filter performs zero writes before confirmation or count', async () => {
  const { app, state } = writeFixture({ deny: true });
  await assert.rejects(commandHandler('bulk', app, { query: 'short_description=printer' }), /denied|not visible/i);
  assert.deepEqual(state, { counts: 0, deletes: [], updates: [], recordLists: 0 });
});

test('delete-many still validates legitimate filters and proceeds', async () => {
  const { app, state } = writeFixture();
  await commandHandler('delete-many', app, { query: 'short_description=printer' });
  assert.equal(state.counts, 1);
  assert.deepEqual(state.deletes, []);
});
