import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

it('Basic and OAuth CLI workflows preserve credentials, settings, defaults, PKCE, and JSON output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-auth-e2e-'));
  const requests = [];
  let expectedChallenge;
  const server = http.createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({ method: request.method, path: url.pathname });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/oauth_token.do') {
      const form = new URLSearchParams(Buffer.concat(body).toString());
      if (form.get('code') === 'bad-code') {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'fixture-provider-secret' }));
        return;
      }
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier');
        if (!verifier || (expectedChallenge && crypto.createHash('sha256').update(verifier).digest('base64url') !== expectedChallenge)) {
          response.writeHead(400); response.end('{}'); return;
        }
      }
      response.end(JSON.stringify({ access_token: 'fixture-oauth-secret', refresh_token: 'fixture-refresh-secret', expires_in: 3600 }));
    } else if (url.pathname === '/api/now/table/sys_user') {
      const header = request.headers.authorization;
      const user = header === 'Bearer fixture-oauth-secret' ? 'oauth-user'
        : header === `Basic ${Buffer.from('basic-user:fixture-password').toString('base64')}` ? 'basic-user' : null;
      if (!user) { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify({ result: [{ sys_id: 'fixture-id', user_name: user, name: user }] }));
    } else response.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SN_') && !key.startsWith('SERVICENOW_')));
  Object.assign(env, {
    XDG_CONFIG_HOME: directory, PATH: '', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1',
    SN_USERNAME: 'basic-user', SN_PASSWORD: 'fixture-password',
  });
  async function run(args, expected = 0) {
    let output;
    try { output = { ...await execute(process.execPath, [cli, ...args], { cwd: directory, env, timeout: 15000 }), code: 0 }; }
    catch (error) { output = error; }
    assert.equal(output.code, expected, output.stderr || output.message);
    assert.doesNotMatch(output.stdout, /fixture-password|fixture-oauth-secret|fixture-refresh-secret|fixture-provider-secret/);
    assert.doesNotMatch(output.stderr, /fixture-password|fixture-oauth-secret|fixture-refresh-secret|fixture-provider-secret/);
    return JSON.parse(output.stdout);
  }
  const readConfig = async () => JSON.parse(await fs.readFile(path.join(directory, 'servicenow/config.json'), 'utf8'));
  try {
    const basic = await run(['auth', 'login', instance, '--name', 'basic', '--basic', '--read-only', '--no-include-counts', '--confirm-deletes', '--make-default', '--json']);
    assert.equal(basic.data.username, 'basic-user');
    let config = await readConfig();
    assert.equal(config.default_profile, 'basic');
    assert.equal(config.profiles.basic.read_only, true);
    assert.equal(config.profiles.basic.include_counts, false);
    assert.equal(config.profiles.basic.skip_confirmations, false);

    const before = requests.length;
    const settings = ['auth', 'modify', 'basic', '--no-read-only', '--confirm-deletes', '--no-include-counts', '--json'];
    await run(settings); const first = (await readConfig()).profiles.basic;
    await run(settings); assert.deepEqual((await readConfig()).profiles.basic, first);
    assert.equal(first.read_only, false);
    assert.equal(requests.length, before);
    const missing = await run(['auth', 'modify', 'basic', '--json'], 2);
    assert.equal(missing.code, 'usage_error');

    const authorization = await run(['auth', 'login', instance, '--name', 'oauth', '--oauth', '--print-url', '--json']);
    const authURL = new URL(authorization.data.authorization_url);
    expectedChallenge = authURL.searchParams.get('code_challenge');
    assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.breadcrumbs[0].cmd, /--name oauth --code/);
    const oauth = await run(['auth', 'login', instance, '--name', 'oauth', '--oauth', '--code', 'fixture-code', '--read-only', '--no-make-default', '--json']);
    assert.equal(oauth.data.username, 'oauth-user');
    config = await readConfig();
    assert.equal(config.profiles.oauth.auth_method, 'oauth');
    assert.equal(config.profiles.basic.username, 'basic-user');
    assert.equal(config.default_profile, 'basic');

    const noImplicitLogin = await run(['--profile', 'oauth', 'auth', 'login', '--json'], 2);
    assert.equal(noImplicitLogin.code, 'usage_error');
    const localStart = requests.length;
    const local = await run(['auth', 'status', '--local', '--json']);
    assert.equal(requests.length, localStart);
    assert.equal(local.data.profiles.length, 2);
    assert.doesNotMatch(JSON.stringify(local), /basic-user|oauth-user|http:\/\/127\.0\.0\.1/);
    const verified = await run(['--profile', 'oauth', 'auth', 'status', '--details', '--json']);
    assert.equal(verified.data.profiles[0].verified_as, 'oauth-user');
    assert.equal(verified.data.profiles[0].verified, true);

    await run(['auth', 'switch', 'oauth', '--json']);
    assert.equal((await readConfig()).default_profile, 'oauth');
    const refreshBefore = requests.filter(request => request.path === '/oauth_token.do').length;
    await run(['--profile', 'oauth', 'auth', 'refresh', '--json']);
    assert.equal(requests.filter(request => request.path === '/oauth_token.do').length - refreshBefore, 1);

    expectedChallenge = undefined;
    const codePath = path.join(directory, 'code.txt');
    await fs.writeFile(codePath, 'fixture-code');
    const waited = await run(['auth', 'login', instance, '--name', 'waited', '--oauth', '--print-url', '--wait-file', codePath, '--json']);
    assert.equal(waited.data.username, 'oauth-user');
    await fs.writeFile(codePath, 'bad-code');
    const failure = await run(['auth', 'login', instance, '--name', 'failed', '--oauth', '--print-url', '--wait-file', codePath, '--json'], 1);
    assert.equal(failure.code, 'auth_error');
    assert.equal((await readConfig()).profiles.failed, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
