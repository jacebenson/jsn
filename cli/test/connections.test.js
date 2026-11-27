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
import { listConnections, showConnection, formatConnections } from '../src/connections.js';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

const id = n => n.toString(16).padStart(32, '0');
const field = (value, display = value) => ({ value, display_value: display });
const SECRET = 'synthetic-secret-never-shown';
// Each fixture row also carries the secret columns its real table has; the fixture returns only requested fields.
const conn = (n, name, cred, extra = {}) => ({ sys_id: field(id(n)), name: field(name), active: field('true'), connection_alias: field(id(n + 50), `x_syn.alias_${n}`), connection_url: field(`https://api${n}.example.test`), host: field(`api${n}.example.test`), credential: cred ? field(cred, 'Wrong label, not a join key') : field(''), extended_attributes: field(SECRET), ...extra });
const tables = {
  http_connection: [conn(1, 'Alpha', id(20)), conn(2, 'Beta', id(21), { active: field('false') }), conn(3, 'Gamma', '')],
  discovery_credentials: [
    { sys_id: field(id(20)), name: field('Alpha basic'), type: field('basic_auth', 'Basic Auth'), sys_class_name: field('basic_auth_credentials', 'Basic Auth Credentials'), user_name: field('svc'), password: field(SECRET), ssh_private_key: field(SECRET) },
    { sys_id: field(id(21)), name: field('Beta OAuth'), type: field('oauth_2_0', 'OAuth 2.0'), sys_class_name: field('oauth_2_0_credentials', 'OAuth 2.0 Credentials'), password: field(SECRET) },
  ],
  oauth_2_0_credentials: [{ sys_id: field(id(21)), oauth_entity_profile: field(id(30), 'Wrong profile label'), password: field(SECRET) }],
  oauth_entity_profile: [{ sys_id: field(id(30)), name: field('Beta profile'), grant_type: field('client_credentials', 'Client Credentials'), oauth_entity: field(id(40), 'Beta registry') }],
  oauth_entity: [{ sys_id: field(id(40)), name: field('Beta registry'), client_secret: field(SECRET) }],
};
function fixtureSdk(overrides = {}) {
  const calls = [];
  return { calls, listStrict: async (table, params) => {
    calls.push({ table, params });
    let rows = overrides[table] ?? tables[table] ?? [];
    const query = params.get('sysparm_query');
    if (query.startsWith('sys_id=')) rows = rows.filter(row => row.sys_id.value === query.slice(7));
    else if (query.startsWith('sys_idIN')) rows = rows.filter(row => query.slice(8).split(',').includes(row.sys_id.value));
    else if (query.startsWith('name=')) rows = rows.filter(row => row.name.value === query.slice(5).split('^')[0]);
    const fields = params.get('sysparm_fields')?.split(',');
    if (fields) rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))));
    const offset = Number(params.get('sysparm_offset') || 0);
    return rows.slice(offset, offset + Number(params.get('sysparm_limit')));
  } };
}
const SECRET_FIELD = /pass|secret|token|key|cert|attributes/i;
function assertNoSecretRequested(calls) {
  assert.ok(calls.length);
  for (const { table, params } of calls) {
    assert.ok(params.get('sysparm_fields'), `${table} read without a field list would return every column`);
    assert.deepEqual(params.get('sysparm_fields').split(',').filter(name => SECRET_FIELD.test(name)), [], `${table} requested a secret field`);
    assert.ok(!['oauth_entity', 'oauth_credential'].includes(table), `${table} holds client secrets or tokens and is never read`);
  }
}

test('list joins each connection to its credential by raw sys_id with bounded, deterministic reads', async () => {
  const sdk = fixtureSdk();
  const data = await listConnections(sdk, { limit: 2 });
  assert.equal(sdk.calls[0].table, 'http_connection');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), 'ORDERBYname^ORDERBYsys_id');
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '3');
  assert.equal(sdk.calls[0].params.get('sysparm_display_value'), 'all');
  assert.equal(sdk.calls[1].table, 'discovery_credentials');
  assert.equal(sdk.calls[1].params.get('sysparm_query'), `sys_idIN${id(20)},${id(21)}`);
  assert.equal(sdk.calls[1].params.get('sysparm_limit'), '2');
  assert.deepEqual(data.pagination, { limit: 2, offset: 0, has_more: true, next_offset: 2 });
  assert.deepEqual(data.records[0], { sys_id: id(1), name: 'Alpha', active: true, alias: 'x_syn.alias_1', alias_sys_id: id(51), url: 'https://api1.example.test', host: 'api1.example.test',
    credential: { sys_id: id(20), name: 'Wrong label, not a join key', type: 'basic_auth', table: 'basic_auth_credentials' } });
  assert.equal(data.records[1].active, false);
  assert.equal(data.records[1].credential.type, 'oauth_2_0');
  const human = formatConnections(data, 'list');
  assert.match(human, /Alpha \[0+1\]\n {2}URL: https:\/\/api1\.example\.test\n {2}Alias: x_syn\.alias_1[\s\S]*basic_auth, in basic_auth_credentials/);
  assert.match(human, /Beta \[0+2\] \(inactive\)/);
  assert.match(human, /more available, next offset 2/);
  const last = await listConnections(fixtureSdk(), { offset: 2 });
  assert.equal(last.records[0].credential, null);
  assert.match(formatConnections(last, 'list'), /Credential: \(none\)/);
  assert.equal(last.pagination.has_more, false);
});

test('show by name or sys_id names the credential, its table and, for OAuth, the profile and application registry', async () => {
  const sdk = fixtureSdk();
  const data = await showConnection(sdk, 'Beta');
  assert.equal(sdk.calls[0].params.get('sysparm_query'), 'name=Beta^ORDERBYsys_id');
  assert.equal(sdk.calls[0].params.get('sysparm_limit'), '2');
  assert.deepEqual(sdk.calls.map(call => [call.table, call.params.get('sysparm_query')]).slice(1), [
    ['discovery_credentials', `sys_id=${id(21)}`], ['oauth_2_0_credentials', `sys_id=${id(21)}`], ['oauth_entity_profile', `sys_id=${id(30)}`]]);
  assert.deepEqual(data.credential, { sys_id: id(21), name: 'Wrong label, not a join key', type: 'oauth_2_0', table: 'oauth_2_0_credentials',
    oauth: { profile: 'Beta profile', profile_sys_id: id(30), grant_type: 'client_credentials', application_registry: 'Beta registry', application_registry_sys_id: id(40) } });
  const human = formatConnections(data, 'show');
  assert.match(human, /OAuth profile: Beta profile \[0+1e\] \(grant type client_credentials\)\n {2}Application registry: Beta registry \[0+28\]/);
  const basic = fixtureSdk();
  const byId = await showConnection(basic, id(1));
  assert.equal(basic.calls[0].params.get('sysparm_query'), `sys_id=${id(1)}`);
  assert.equal(basic.calls.length, 2, 'a basic credential needs no OAuth reads');
  assert.equal(Object.hasOwn(byId.credential, 'oauth'), false);
  assert.doesNotMatch(formatConnections(byId, 'show'), /OAuth/);
});

test('no read ever requests a secret field or touches the token and client-secret tables', async () => {
  const sdk = fixtureSdk();
  const listed = await listConnections(sdk);
  const shown = [await showConnection(sdk, 'Alpha'), await showConnection(sdk, 'Beta'), await showConnection(sdk, id(3))];
  assertNoSecretRequested(sdk.calls);
  for (const data of [listed, ...shown]) {
    assert.ok(!JSON.stringify(data).includes(SECRET));
    assert.ok(!formatConnections(data, data.records ? 'list' : 'show').includes(SECRET));
  }
});

test('invalid identifiers and bounds reject before any request', async () => {
  const sdk = fixtureSdk();
  for (const invalid of ['', 'name^ORactive=true', 'line\nbreak', undefined, 123]) await assert.rejects(showConnection(sdk, invalid), /connection name or 32-character sys_id/);
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(listConnections(sdk, options), /--limit|--offset/);
  }
  assert.equal(sdk.calls.length, 0);
});

test('missing, ambiguous, denied, unreadable and malformed answers are never reported as a connection or its credential', async () => {
  await assert.rejects(showConnection(fixtureSdk(), 'Nobody'), /HTTP connection not found: Nobody/);
  await assert.rejects(showConnection(fixtureSdk({ http_connection: [conn(1, 'Twin', id(20)), conn(2, 'Twin', id(21))] }), 'Twin'), new RegExp(`More than one HTTP connection is named Twin \\(${id(1)}, ${id(2)}\\)`));
  for (const status of [403, 404]) {
    const error = Object.assign(new Error('Synthetic read denied'), { status });
    await assert.rejects(listConnections({ listStrict: async () => { throw error; } }), e => e === error);
    await assert.rejects(showConnection({ listStrict: async () => { throw error; } }, 'Alpha'), e => e === error);
    // A denied credential or OAuth read fails the command too; only a row hidden by ACLs leaves the type unknown.
    const denying = table => ({ listStrict: async (name, params) => { if (name === table) throw error; return fixtureSdk().listStrict(name, params); } });
    await assert.rejects(listConnections(denying('discovery_credentials')), e => e === error);
    for (const [table, name] of [['discovery_credentials', 'Alpha'], ['oauth_2_0_credentials', 'Beta'], ['oauth_entity_profile', 'Beta']]) await assert.rejects(showConnection(denying(table), name), e => e === error);
  }
  await assert.rejects(listConnections({ listStrict: async () => [{ name: field('No sys_id') }] }), /Malformed http_connection/);
  const answering = (table, rows) => ({ listStrict: async (name, params) => name === table ? rows : fixtureSdk().listStrict(name, params) });
  await assert.rejects(showConnection(answering('discovery_credentials', [{ sys_id: field(id(99)) }]), 'Alpha'), /discovery_credentials returned a different record/);
  await assert.rejects(showConnection(answering('http_connection', [conn(9, 'Other', '')]), id(1)), /http_connection returned a different record/);
  await assert.rejects(showConnection(answering('oauth_entity_profile', [{ sys_id: field(id(99)) }]), 'Beta'), /oauth_entity_profile returned a different record/);

  const hidden = await listConnections(fixtureSdk({ discovery_credentials: [] }));
  assert.deepEqual(hidden.records[0].credential, { sys_id: id(20), name: 'Wrong label, not a join key', type: null, table: null });
  assert.match(formatConnections(hidden, 'list'), /record not readable, so its type is unknown/);
  const untyped = await listConnections(answering('discovery_credentials', [{ sys_id: field(id(20)), name: field('Alpha cred'), type: field(''), sys_class_name: field('basic_auth_credentials') }]));
  assert.deepEqual(untyped.records[0].credential, { sys_id: id(20), name: 'Wrong label, not a join key', type: null, table: 'basic_auth_credentials' });
  assert.match(formatConnections(untyped, 'list'), /\(no type, in basic_auth_credentials\)/);
  assert.doesNotMatch(formatConnections(untyped, 'list').split('\n').find(line => line.includes(id(20))), /not readable/);
  const noOauth = await showConnection(fixtureSdk({ oauth_2_0_credentials: [] }), 'Beta');
  assert.equal(noOauth.credential.oauth, null);
  assert.match(formatConnections(noOauth, 'show'), /OAuth profile: unknown \(the OAuth credential record is not readable\)/);
  const noProfile = await showConnection(fixtureSdk({ oauth_entity_profile: [] }), 'Beta');
  assert.equal(noProfile.credential.oauth.profile, null);
  assert.match(formatConnections(noProfile, 'show'), new RegExp(`OAuth profile: ${id(30)} \\(not readable\\)`));
  const empty = await listConnections(fixtureSdk({ http_connection: [] }));
  assert.equal(empty.count, 0);
  assert.match(formatConnections(empty, 'list'), /does not prove there are none/);
});

test('real CLI runs read-only with JSON, --get, human output, strict validation and no secret field on the wire', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, pathname: url.pathname, table: url.pathname.split('/').pop(), params: url.searchParams });
    res.setHeader('Content-Type', 'application/json');
    if (!url.pathname.startsWith('/api/now/table/')) return res.end(JSON.stringify({ result: [] }));
    Promise.resolve(fixtureSdk().listStrict(url.pathname.split('/').pop(), url.searchParams)).then(rows => res.end(JSON.stringify({ result: rows })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-connections-'));
  fs.mkdirSync(path.join(dir, 'servicenow'));
  fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
  const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
  const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const execute = promisify(execFile);
  const run = args => execute(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
  try {
    const listed = JSON.parse((await run(['connections', 'list', '--json'])).stdout);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.data.records.map(row => row.credential?.type ?? null), ['basic_auth', 'oauth_2_0', null]);
    const shown = JSON.parse((await run(['connections', 'show', 'Beta', '--json'])).stdout);
    assert.equal(shown.data.credential.oauth.application_registry, 'Beta registry');
    const styled = await run(['connections', 'show', 'Beta', '--format', 'styled']);
    assert.match(styled.stdout, /HTTP connections \(read-only; secrets are never read\)[\s\S]*Application registry: Beta registry/);
    assert.equal(JSON.parse((await run(['connections', 'show', id(1), '--get', 'data.credential.table'])).stdout), 'basic_auth_credentials');
    const human = await run(['connections', 'list', '--format', 'styled']);
    assert.match(human.stdout, /Beta \[0+2\] \(inactive\)[\s\S]*Page: 3 connection\(s\)/);
    assert.ok(![JSON.stringify(listed), JSON.stringify(shown), styled.stdout, human.stdout].some(out => out.includes(SECRET)));
    const before = calls.length;
    for (const args of [['show', 'bad^name'], ['show'], ['list', '--limit', '0'], ['list', '--offset', '-1'], ['list', '--typo'], ['credentials']]) {
      await assert.rejects(run(['connections', ...args, '--json']), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, before);
    const help = await run(['connections', '--help']);
    for (const name of ['list', 'show']) assert.ok(help.stdout.includes(name));
    const tableCalls = calls.filter(call => call.pathname.startsWith('/api/now/table/'));
    assert.ok(tableCalls.every(call => call.method === 'GET'));
    assertNoSecretRequested(tableCalls);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
