// #561: ServiceNow represents the Global application selection as the ABSENCE
// of the `apps.current_app` preference row, so the write guard could never
// verify Global. A Global selection made through the session picker must
// establish context the guard accepts — but absence alone must never be read as
// Global unless a fresh application picker read says so.
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
const GLOBAL = 'global';
const APP_ID = 'a'.repeat(32);
const SET_ID = 'b'.repeat(32);
const USER_ID = 'c'.repeat(32);
const appScope = { sys_id: APP_ID, scope: 'x_fixture', name: 'Fixture App' };
const globalScope = { sys_id: GLOBAL, scope: GLOBAL, name: 'Global' };

// One stateful fixture per test: the CLI runs in real subprocesses, so the only
// state shared between invocations is what the server records here.
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-global-'));
  const requests = [];
  const state = {
    pickerApplication: APP_ID,
    appsCurrentApp: null,
    updateSetApplication: GLOBAL,
    failApplicationPicker: false,
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fixture.invalid');
    const parsed = body.startsWith('{') ? JSON.parse(body) : body || null;
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams.get('sysparm_query') || '', body: parsed });
    res.setHeader('Content-Type', 'application/json');
    const send = result => res.end(JSON.stringify({ result }));
    if (url.pathname === '/angular.do') return send({});
    if (url.pathname.startsWith('/api/now/stats/')) return send({ stats: { count: '1' } });
    if (url.pathname.endsWith('/concoursepicker/application')) {
      if (req.method === 'PUT') {
        // The picker is the only supported way to select a scope; the platform
        // deliberately writes no apps.current_app row for Global.
        state.pickerApplication = parsed?.app_id;
        return send({ current: state.pickerApplication });
      }
      if (state.failApplicationPicker) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { message: 'picker unavailable' }, status: 'failure' }));
      }
      return send({ current: state.pickerApplication });
    }
    if (url.pathname.endsWith('/concoursepicker/updateset')) {
      return send({ current: { sysId: SET_ID, name: 'Global Feature Set', displayValue: 'Global Feature Set' } });
    }
    const [table, id] = url.pathname.split('/').slice(4);
    const query = url.searchParams.get('sysparm_query') || '';
    if (table === 'sys_user') return send([{ sys_id: USER_ID, user_name: 'fixture-user', name: 'Fixture' }]);
    if (table === 'sys_user_preference') {
      if (query.includes('apps.current_app')) return send(state.appsCurrentApp ? [{ value: state.appsCurrentApp }] : []);
      return send([{ value: SET_ID }]);
    }
    if (table === 'sys_scope') {
      if (id === GLOBAL) return send(globalScope);
      if (id === APP_ID) return send(appScope);
      if (query.includes(`sys_id=${GLOBAL}`) || query.includes(`scope=${GLOBAL}`) || query.includes(`name=${GLOBAL}`)) return send([globalScope]);
      if (query.includes('x_fixture')) return send([appScope]);
      return send([]);
    }
    if (table === 'sys_update_set') {
      const record = { sys_id: SET_ID, name: 'Global Feature Set', application: state.updateSetApplication, state: 'in progress' };
      if (id) return send(id === SET_ID ? record : {});
      return send(query.includes('name=Global Feature Set') ? [record] : []);
    }
    if (table === 'sys_dictionary') {
      const rows = [{ name: 'sys_script', element: 'active', internal_type: 'boolean', reference: '' },
        { name: 'sys_metadata', element: 'sys_id', internal_type: 'string', reference: '' }];
      res.setHeader('X-Total-Count', String(rows.length));
      return send(rows);
    }
    if (table === 'sys_db_object') {
      if (id) return send({ sys_id: USER_ID, name: 'sys_metadata', super_class: '' });
      return send([{ sys_id: USER_ID, name: query.split('=')[1], super_class: USER_ID }]);
    }
    if (table === 'sys_script') {
      const record = { sys_id: USER_ID, name: 'fixture', sys_scope: GLOBAL };
      return send(req.method === 'POST' || id ? record : [record]);
    }
    res.statusCode = 500;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const instance = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(dir, 'servicenow', 'credentials'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'fixture',
    profiles: { fixture: { instance_url: instance, username: 'fixture-user', auth_method: 'basic', skip_confirmations: true } },
  }));
  await fs.writeFile(
    path.join(dir, 'servicenow', 'credentials', `${credKey(instance, 'fixture-user')}.json`),
    JSON.stringify({ auth_method: 'basic', username: 'fixture-user', password: 'fixture-password' }),
    { mode: 0o600 },
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_|JSN_ALWAYS_WARM)/i.test(key)));
  Object.assign(env, {
    HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, PATH: '',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1',
    JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1',
  });
  async function run(args) {
    requests.length = 0;
    try {
      return { ...await execute(process.execPath, [cli, ...args, '--profile', 'fixture'], { cwd: dir, env, timeout: 15000 }), code: 0 };
    } catch (error) {
      return error;
    }
  }
  // Only the picker PUT is a legitimate non-GET request in this fixture; a
  // customization refusal must never reach a table write endpoint.
  const writes = () => requests.filter(r => !['GET', 'HEAD'].includes(r.method) && r.path !== '/angular.do');
  return { state, requests, run, writes };
}

const WRITE = ['records', 'create', '--table', 'sys_script', '--data', '{}', '--force', '--json'];
const INTENT = ['--expect-scope', GLOBAL, '--expect-update-set', 'Global Feature Set'];

test('#561 Global selected through the picker is verified by a later guarded write', async t => {
  const f = await fixture(t);
  // A warmed session currently sits in a non-global application and the user
  // has never had an apps.current_app row — the issue #561 state.
  assert.equal(f.state.appsCurrentApp, null);

  const selected = await f.run(['scopes', 'set', 'global', '--json']);
  assert.equal(selected.code, 0, selected.stdout + selected.stderr);
  const put = f.requests.find(r => r.method === 'PUT' && r.path.endsWith('/concoursepicker/application'));
  assert.equal(put?.body?.app_id, GLOBAL);
  assert.equal(f.state.pickerApplication, GLOBAL);
  assert.equal(f.state.appsCurrentApp ?? null, null, 'Global selection must not invent a preference row');

  // Separate process, same fixture state: the write guard must verify Global
  // from absence plus the session picker instead of rejecting it.
  const created = await f.run([...WRITE, ...INTENT]);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const output = JSON.parse(created.stdout);
  assert.equal(output.context.mutation.verified, true);
  assert.equal(output.context.mutation.scope, GLOBAL);
  assert.equal(output.context.mutation.application_id, GLOBAL);
  assert.equal(output.context.mutation.update_set.sys_id, SET_ID);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.path.endsWith('/sys_script')).length, 1);
});

test('#561 absence of apps.current_app is never assumed to be Global', async t => {
  const f = await fixture(t);
  const result = await f.run([...WRITE, ...INTENT]);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(output.error, /No application scope is selected for fixture-user/);
  assert.match(output.error, new RegExp(`reports ${APP_ID}.*not Global`));
  assert.match(output.hint, /jsn scopes set/);
  assert.deepEqual(f.writes(), []);
});

test('#561 an unreadable application picker cannot prove Global', async t => {
  const f = await fixture(t);
  f.state.appsCurrentApp = null;
  f.state.pickerApplication = GLOBAL;
  f.state.failApplicationPicker = true;
  const result = await f.run([...WRITE, ...INTENT]);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.error, /No application scope is selected for fixture-user/);
  assert.match(output.error, /application picker could not be read/);
  assert.match(output.hint, /jsn scopes set/);
  assert.deepEqual(f.writes(), []);
});

test('#561 a scope/update-set application mismatch still refuses with zero writes', async t => {
  const f = await fixture(t);
  f.state.appsCurrentApp = null;
  f.state.pickerApplication = GLOBAL;
  f.state.updateSetApplication = APP_ID;
  const result = await f.run([...WRITE, ...INTENT]);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /belong to different applications/);
  assert.deepEqual(f.writes(), []);
});

test('#561 wrong --expect-scope and --expect-update-set refuse verified Global with zero writes', async t => {
  const f = await fixture(t);
  f.state.appsCurrentApp = null;
  f.state.pickerApplication = GLOBAL;
  const wrongScope = await f.run([...WRITE, '--expect-scope', 'x_fixture', '--expect-update-set', 'Global Feature Set']);
  assert.notEqual(wrongScope.code, 0, wrongScope.stdout + wrongScope.stderr);
  assert.match(JSON.parse(wrongScope.stdout).error, /Intended scope does not match fresh selected scope/);
  assert.deepEqual(f.writes(), []);
  const wrongSet = await f.run([...WRITE, '--expect-scope', GLOBAL, '--expect-update-set', 'Missing Set']);
  assert.notEqual(wrongSet.code, 0, wrongSet.stdout + wrongSet.stderr);
  assert.match(JSON.parse(wrongSet.stdout).error, /Intended sys_update_set is missing/);
  assert.deepEqual(f.writes(), []);
});
