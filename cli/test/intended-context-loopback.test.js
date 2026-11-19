import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { credKey } from '../src/auth/credential-store.js';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const scope = 'a'.repeat(32), set = 'b'.repeat(32), other = 'c'.repeat(32);

test('real CLI verifies intended customization context and never writes on refusal', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-intent-'));
  const requests = [];
  let mode = 'valid';
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('sysparm_query'), body: body.startsWith('{') ? JSON.parse(body) : body || null, domain: req.headers['x-now-domain'] });
    res.setHeader('Content-Type', 'application/json');
    const send = result => res.end(JSON.stringify({ result }));
    if (url.pathname === '/angular.do') return send({});
    if (url.pathname.startsWith('/api/now/stats/')) return send({ stats: { count: '1' } });
    if (url.pathname.endsWith('/concoursepicker/application')) return send({ current: mode === 'session' ? other : scope });
    if (url.pathname.endsWith('/concoursepicker/updateset')) return send({ current: { sysId: set } });
    const [table, id] = url.pathname.split('/').slice(4);
    const query = url.searchParams.get('sysparm_query') || '';
    if (table === 'sys_user') return send([{ sys_id: other, user_name: 'fixture-user', name: 'Fixture' }]);
    if (table === 'sys_user_preference') return send(mode === 'unknown' ? [] : [{ value: query.includes('apps.current_app') ? scope : set }]);
    if (table === 'sys_scope' && req.method === 'POST') return send({ sys_id: other, ...JSON.parse(body) });
    if (table === 'sys_scope' && query.startsWith('scope=x_new_')) return send([]);
    if (table === 'sys_scope') {
      const record = { sys_id: scope, scope: mode === 'global' ? 'global' : 'x_fixture', name: 'Fixture App' };
      return send(id ? record : query.includes('wrong') ? [{ ...record, sys_id: other }] : [record]);
    }
    if (table === 'sys_update_set') {
      const record = { sys_id: set, name: mode === 'global' ? 'Default' : 'Feature', application: mode === 'scope-mismatch' ? other : scope, state: mode === 'complete' ? 'complete' : mode === 'incomplete' ? '' : 'in progress' };
      return send(id ? record : mode === 'ambiguous' ? [record, { ...record, sys_id: other }] : query.includes('wrong') ? [{ ...record, sys_id: other }] : [record]);
    }
    if (table === 'sys_db_object') {
      if (id) return send({ sys_id: other, name: 'sys_metadata', super_class: '' });
      return send([{ sys_id: other, name: query.split('=')[1], super_class: query.includes('incident') ? '' : other }]);
    }
    if (['sys_script', 'incident', 'sys_hub_action_type_definition', 'sys_hub_flow', 'sys_decision'].includes(table)) {
      const record = { sys_id: other, name: 'fixture', sys_scope: mode === 'foreign' ? other : scope };
      return send(req.method === 'POST' || id ? record : [record]);
    }
    res.statusCode = 500; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(dir, 'servicenow', 'credentials'), { recursive: true, mode: 0o700 });
  const profile = { instance_url: instance, username: 'fixture-user', auth_method: 'basic', skip_confirmations: true };
  async function configure(extra = {}) { await fs.writeFile(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { ...profile, ...extra } } })); }
  await configure();
  await fs.writeFile(path.join(dir, 'servicenow', 'credentials', `${credKey(instance, 'fixture-user')}.json`), JSON.stringify({ auth_method: 'basic', username: 'fixture-user', password: 'fixture-password' }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_ALWAYS_WARM)/i.test(key)));
  Object.assign(env, { HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, PATH: '', JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' });
  async function run(args) {
    requests.length = 0;
    try { return { ...await execute(process.execPath, [cli, ...args, '--profile', 'fixture'], { cwd: dir, env, timeout: 15000 }), code: 0 }; }
    catch (error) { return error; }
  }
  const write = ['records', 'create', '--table', 'sys_script', '--data', '{}', '--json'];
  const intent = ['--expect-scope', 'x_fixture', '--expect-update-set', 'Feature'];
  function noWrites() { assert.deepEqual(requests.filter(r => !['GET', 'HEAD'].includes(r.method) && r.path !== '/angular.do'), []); }
  for (const [label, args, fixtureMode] of [
    ['missing', ['--force'], 'valid'], ['scope mismatch', ['--expect-scope', 'wrong', '--expect-update-set', 'Feature', '--force'], 'valid'],
    ['set mismatch', ['--expect-scope', 'x_fixture', '--expect-update-set', 'wrong'], 'valid'],
    ...['unknown', 'complete', 'incomplete', 'scope-mismatch', 'session', 'ambiguous'].map(m => [m, intent, m]),
    ['domain refusal', [...intent, '--expect-domain', 'Customer'], 'valid'],
    ['quiet refusal', [...intent, '--expect-domain', 'Customer', '--quiet'], 'valid'],
  ]) {
    mode = fixtureMode;
    const result = await run([...write, ...args]);
    assert.notEqual(result.code, 0, `${label}: ${result.stdout} ${result.stderr}`);
    assert.ok(result.stdout, `${label}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, false, label); noWrites();
  }
  mode = 'foreign';
  for (const args of [
    ['actions', 'update', other, '--data', '{}'], ['actions', 'delete', other, '--force'],
    ['flows', 'update', other, '--data', '{}', '--force'], ['flows', 'delete', other, '--force'],
    ['flows', 'publish', other, '--force'], ['flows', 'clone', other, '--name', 'Copy', '--force'],
    ['flows', 'create', '--data', JSON.stringify({ scope: other })],
    ['decisiontables', 'delete', other, '--force'],
    ['decisiontables', 'update', other, '--data', '{}'],
    ['records', 'update', '--table', 'sys_script', '--sys-id', other, '--data', '{}'],
    ['records', 'delete', '--table', 'sys_script', '--sys-id', other, '--force'],
    ['records', 'bulk', '--table', 'sys_script', '--query', 'active=true', '-f', 'name=changed', '--execute', '--force'],
    ['records', 'create', '--table', 'sys_script', '--data', JSON.stringify({ sys_scope: other })],
  ]) {
    const rejected = await run([...args, ...intent, '--json']);
    assert.notEqual(rejected.code, 0, rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).error, /scope/i, rejected.stdout); noWrites();
  }
  mode = 'valid';
  for (const explicit of [true, false]) {
    const created = await run(['scopes', 'create', '--name', 'New Feature', ...(explicit ? ['--scope', 'x_new_explicit'] : []), ...intent, '--json']);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const post = requests.find(r => r.method === 'POST' && r.path.endsWith('/sys_scope'));
    assert.equal(post.body.scope, explicit ? 'x_new_explicit' : 'x_new_feature');
    assert.equal(JSON.parse(created.stdout).context.mutation.application_id, scope);
  }
  mode = 'global';
  let approval = await run([...write, '--expect-scope', scope, '--expect-update-set', set]);
  assert.equal(JSON.parse(approval.stdout).code, 'confirmation_required'); noWrites();
  approval = await run([...write, '--expect-scope', scope, '--expect-update-set', set, '--force']);
  assert.equal(approval.code, 0, approval.stdout);
  assert.equal(JSON.parse(approval.stdout).context.mutation.approved, true);
  mode = 'valid';
  let result = await run([...write, ...intent]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.context.mutation.verified, true);
  assert.equal(output.context.mutation.update_set.sys_id, set);
  assert.equal(requests.filter(r => r.method === 'POST' && r.path.endsWith('/sys_script')).length, 1);
  result = await run([...write, ...intent, '--get', 'context.mutation.application_id']);
  assert.equal(JSON.parse(result.stdout), scope);
  result = await run(['records', 'create', '--table', 'incident', '--data', '{}', '--json']);
  assert.equal(result.code, 0, result.stdout); assert.equal(JSON.parse(result.stdout).context?.mutation, undefined);
  assert.equal(requests.filter(r => /sys_user|concoursepicker|sys_scope/.test(r.path)).length, 0);
  for (const flags of [['--json'], ['--get', 'data.name'], ['--quiet'], ['--styled']]) {
    result = await run(['records', 'get', '--table', 'incident', '--sys-id', other, ...flags]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(requests.filter(r => /sys_user|concoursepicker|sys_scope/.test(r.path)).length, 0);
    assert.doesNotMatch(result.stderr, /PROFILE|Mutation context/); noWrites();
  }
  result = await run(['auth', 'status', '--context', '--local', '--json']);
  assert.equal(result.code, 0, result.stdout); assert.equal(requests.length, 0);
  assert.equal(JSON.parse(result.stdout).data.profiles[0].context.verified, false);
  result = await run(['auth', 'status', '--context', '--json']);
  assert.equal(result.code, 0, result.stdout);
  output = JSON.parse(result.stdout).data.profiles[0];
  assert.equal(output.context.user.user_name, 'fixture-user'); assert.equal(output.context.scope, 'x_fixture'); assert.equal(output.context.domain.verified, false); noWrites();
  await fs.mkdir(path.join(dir, '.servicenow'));
  const saved = { profile: 'wrong', instance_url: instance, scope: 'x_fixture', update_set: 'Feature' };
  async function local() { await fs.writeFile(path.join(dir, '.servicenow', 'config.json'), JSON.stringify({ write_context: saved })); }
  await local(); result = await run([...write, ...intent]); assert.notEqual(result.code, 0); noWrites();
  saved.profile = 'fixture'; await local(); result = await run(write); assert.equal(result.code, 0, result.stdout);
  result = await run([...write, '--expect-scope', 'wrong']); assert.notEqual(result.code, 0); noWrites();
  saved.instance_url = 'https://wrong.invalid'; await local(); result = await run(write); assert.notEqual(result.code, 0); noWrites();
  saved.instance_url = instance; await local();
  await configure({ domain: other }); result = await run([...write, ...intent]); assert.notEqual(result.code, 0);
  assert.match(JSON.parse(result.stdout).error, /Effective domain cannot be proven/); noWrites();
  result = await run(['records', 'create', '--table', 'incident', '--data', '{}', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(requests.find(r => r.method === 'POST' && r.path.endsWith('/incident')).domain, other);
  await configure({ read_only: true }); result = await run([...write, ...intent]); assert.equal(JSON.parse(result.stdout).code, 'read_only'); noWrites();
});
