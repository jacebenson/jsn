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
const secrets = ['fixture-password-secret', 'fixture-access-secret', 'fixture-refresh-secret', 'fixture-gck-secret', 'fixture-provider-secret'];

test('records commands authenticate directly across methods and output modes without an auth-status preflight', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn direct auth '));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const requests = [];
  let reject = false;
  let requireFresh = false;
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({ method: request.method, path: url.pathname });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/oauth_token.do') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), secrets[2]);
      response.end(JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600 }));
      return;
    }
    if (url.pathname === '/api/now/table/incident') {
      const auth = request.headers.authorization;
      const accepted = !reject && (!requireFresh || auth === 'Bearer refreshed-access') && (auth === `Basic ${Buffer.from(`selected-user:${secrets[0]}`).toString('base64')}`
        || auth === `Bearer ${secrets[1]}` || auth === 'Bearer refreshed-access'
        || request.headers['x-usertoken'] === secrets[3]);
      response.statusCode = accepted ? 200 : 401;
      response.end(JSON.stringify(accepted ? { result: [{ sys_id: 'record-1', number: 'INC001', short_description: 'Fixture' }] }
        : { error: secrets[4] }));
      return;
    }
    // Session bootstrap is allowed; there is no diagnostic sys_user lookup.
    if (url.pathname === '/angular.do') { response.end('{}'); return; }
    if (url.pathname === '/api/now/table/sys_scope') { response.end('{"result":[]}'); return; }
    response.statusCode = 500;
    response.end('{"error":"unexpected endpoint"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, JSN_DATA_HOME: path.join(directory, 'data'),
    PATH: '', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1' });
  const configDir = path.join(directory, 'servicenow');
  const credentialDir = path.join(configDir, 'credentials');
  await fs.mkdir(credentialDir, { recursive: true });
  const selectedFile = path.join(credentialDir, `${credKey(instance, 'selected-user')}.json`);
  const siblingFile = path.join(credentialDir, `${credKey(instance, 'other-user')}.json`);
  const sibling = JSON.stringify({ auth_method: 'oauth', access_token: 'other-access', refresh_token: 'other-refresh' });
  await fs.writeFile(siblingFile, sibling);
  const credentials = method => ({ auth_method: method, username: 'selected-user',
    ...(method === 'basic' ? { password: secrets[0] } : { access_token: method === 'gck' ? secrets[3] : secrets[1] }),
    ...(method === 'oauth' ? { refresh_token: secrets[2] } : {}),
    ...(method === 'gck' ? { cookies: 'JSESSIONID=fixture' } : {}) });
  async function seed(method, creds) {
    requests.length = 0; reject = false; requireFresh = false;
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ default_profile: 'other', profiles: {
      selected: { instance_url: instance, username: 'selected-user', auth_method: method, reauth: 'auto' },
      other: { instance_url: instance, username: 'other-user', auth_method: 'oauth' },
    } }));
    if (creds) await fs.writeFile(selectedFile, JSON.stringify(creds));
    else await fs.rm(selectedFile, { force: true });
  }
  async function run(args, expected = 0) {
    let result;
    try { result = { ...await execute(process.execPath, [cli, ...args], { cwd: directory, env, timeout: 15000 }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, expected, result.stderr || result.message);
    for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(await fs.readFile(siblingFile, 'utf8'), sibling, 'another identity must remain untouched');
    assert.ok(!requests.some(request => request.path.includes('sys_user')), 'ordinary commands must not perform auth-status probes');
    return result;
  }
  const recordCalls = () => requests.filter(request => request.path.endsWith('/incident')).length;
  const refreshCalls = () => requests.filter(request => request.path === '/oauth_token.do').length;
  const command = format => ['records', 'get', '--profile', 'selected', '--table', 'incident', '--sys-id', 'record-1', format];
  for (const format of ['--json', '--styled']) {
    for (const method of ['basic', 'oauth', 'gck']) {
      await t.test(`${method} valid / ${format}`, async () => {
        await seed(method, credentials(method));
        const result = await run(command(format));
        assert.match(result.stdout, /INC001/);
        assert.equal(recordCalls(), 1); assert.equal(refreshCalls(), 0);
      });
      await t.test(`${method} missing / ${format}`, async () => {
        await seed(method, null);
        const result = await run(command(format), 1);
        if (format === '--json') {
          const error = JSON.parse(result.stdout);
          assert.equal(error.ok, false); assert.equal(error.code, 'auth_error');
          assert.equal(error.recovery, 'jsn auth login --profile selected');
          assert.equal(error.profile, 'selected');
          assert.equal(error.status, undefined, 'local validation must not invent an HTTP response');
          assert.match(error.hint, /jsn auth login --profile selected/);
        } else assert.match(result.stderr, /Error \(auth\).*\n[\s\S]*jsn auth login --profile selected/);
        assert.equal(requests.length, 0, 'missing credentials must fail before network access');
      });
      await t.test(`${method} rejected / ${format}`, async () => {
        await seed(method, credentials(method)); reject = true;
        const result = await run(command(format), 1);
        if (format === '--json') {
          const error = JSON.parse(result.stdout);
          assert.equal(error.code, 'auth_error'); assert.equal(error.profile, 'selected');
          assert.equal(error.status, 401); assert.match(error.recovery, /--profile selected/);
        } else assert.match(result.stderr, /profile selected.*401[\s\S]*--profile selected/);
        assert.equal(recordCalls(), method === 'oauth' ? 2 : 1);
        assert.equal(refreshCalls(), method === 'oauth' ? 1 : 0);
      });
    }
    await t.test(`expired OAuth refreshes at point of use / ${format}`, async () => {
      await seed('oauth', { ...credentials('oauth'), expires_at: 1 });
      assert.match((await run(command(format))).stdout, /INC001/);
      assert.equal(recordCalls(), 1); assert.equal(refreshCalls(), 1);
    });
    await t.test(`OAuth rejection recovers within the same command / ${format}`, async () => {
      await seed('oauth', credentials('oauth')); requireFresh = true;
      assert.match((await run(command(format))).stdout, /INC001/);
      assert.equal(recordCalls(), 2); assert.equal(refreshCalls(), 1);
    });
    await t.test(`expired OAuth without renewal is actionable / ${format}`, async () => {
      await seed('oauth', { ...credentials('oauth'), expires_at: 1, refresh_token: undefined });
      const result = await run(command(format), 1);
      assert.match(result.stdout + result.stderr, /Token expired/);
      assert.match(result.stdout + result.stderr, /jsn auth login --profile selected/);
      assert.equal(requests.length, 0);
    });
  }
  await t.test('local diagnostics and saved-report listing remain explicit offline operations', async () => {
    await seed('oauth', null);
    for (const args of [['auth', 'status', '--local', '--json'], ['customizations', 'list', '--json'], ['docs', '--json']]) {
      assert.equal(JSON.parse((await run(args)).stdout).ok, true);
    }
    assert.equal(requests.length, 0);
  });

});
