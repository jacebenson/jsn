import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authHubMenu } from '../src/commands/setup.js';

const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));

test('setup advertises every management action and browser-session files/stdin share the canonical auth workflow', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn setup parity '));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let requests = 0;
  const secrets = ['fixture-session-secret', 'fixture-cookie-secret', 'fixture-provider-secret'];
  server = http.createServer((request, response) => {
    requests++;
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['x-usertoken'] !== secrets[0] || request.headers.cookie !== `JSESSIONID=${secrets[1]}`) {
      response.writeHead(401); response.end(JSON.stringify({ error: secrets[2] })); return;
    }
    const url = new URL(request.url, 'http://fixture.invalid');
    const result = url.pathname.endsWith('/sys_user') ? [{ sys_id: 'user-1', user_name: 'browser-user', name: 'Browser User' }] : [];
    response.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const instance = `http://127.0.0.1:${server.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SN_|SERVICENOW_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, PATH: '',
    JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' });
  async function run(args, { input = '', expected = 0 } = {}) {
    const result = await new Promise(resolve => {
      const child = execFile(process.execPath, [cli, ...args], { cwd: directory, env, timeout: 15000 },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      child.stdin.end(input);
    });
    assert.equal(result.code, expected, result.stderr || result.stdout);
    for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret), 'output must not reveal session data');
    return result;
  }
  const configFile = path.join(directory, 'servicenow', 'config.json');
  const readConfig = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));
  const help = (await run(['setup', '--help'])).stdout;
  let actions;
  await authHubMenu({ promptFn: async ({ choices }) => { actions = choices; } });
  for (const action of actions) {
    assert.ok(help.includes(action.name), `help must explain ${action.name}`);
    assert.ok(help.includes(action.command));
  }
  assert.match(help, /--headers-file/); assert.match(help, /--wait-file/);
  assert.match(help, /SN_USERNAME and SN_PASSWORD/);
  const usage = JSON.parse((await run(['setup', '--json'], { expected: 2 })).stdout);
  assert.equal(usage.code, 'usage_error');
  for (const action of actions) assert.ok(usage.hint.includes(action.command));
  assert.equal(requests, 0);
  await assert.rejects(fs.readFile(configFile), { code: 'ENOENT' });

  const session = `X-UserToken: ${secrets[0]}\nCookie: JSESSIONID=${secrets[1]}\n`;
  const sessionFile = path.join(directory, 'captured session.txt');
  await fs.writeFile(sessionFile, session, { mode: 0o600 });
  const login = JSON.parse((await run(['auth', 'login', instance, '--name', 'browser', '--headers-file', sessionFile,
    '--read-only', '--confirm-deletes', '--no-include-counts', '--make-default', '--json'])).stdout);
  assert.equal(login.ok, true);
  const before = await readConfig();
  assert.equal(before.profiles.browser.auth_method, 'gck');
  assert.equal(before.profiles.browser.read_only, true);
  assert.equal(before.profiles.browser.skip_confirmations, false);
  assert.equal(before.profiles.browser.include_counts, false);
  assert.equal(before.default_profile, 'browser');

  const refreshed = JSON.parse((await run(['auth', 'refresh', '--profile', 'browser', '--headers-file', '-', '--json'], { input: session })).stdout);
  assert.equal(refreshed.ok, true);
  assert.deepEqual((await readConfig()).profiles.browser, before.profiles.browser);
  const modified = JSON.parse((await run(['auth', 'modify', '--profile', 'browser', '--no-read-only', '--no-confirm-deletes', '--include-counts', '--json'])).stdout);
  assert.equal(modified.data.read_only, false); assert.equal(modified.data.confirm_deletes, false); assert.equal(modified.data.include_counts, true);
  await run(['auth', 'switch', 'browser', '--json']);
  assert.equal((await readConfig()).default_profile, 'browser');
  await run(['auth', 'status', '--profile', 'browser', '--details', '--json']);

  const empty = path.join(directory, 'empty.txt'); await fs.writeFile(empty, '');
  const malformed = path.join(directory, 'invalid.txt'); await fs.writeFile(malformed, `invalid ${secrets[1]}`);
  const configured = await readConfig();
  configured.profiles.oauth = { instance_url: instance, auth_method: 'oauth', username: 'other-user' };
  await fs.writeFile(configFile, JSON.stringify(configured));
  const unchanged = await fs.readFile(configFile, 'utf8');
  const count = requests;
  for (const flags of [
    ['--headers-file', sessionFile, '--basic'], ['--headers-file', sessionFile, '--oauth'],
    ['--headers-file', sessionFile, '--browser'], ['--headers-file', sessionFile, '--headers', 'inline'],
    ['--headers-file', path.join(directory, 'absent')], ['--headers-file', empty], ['--headers-file', '-'],
  ]) {
    await run(['auth', 'login', '--profile', 'browser', ...flags, '--json'], { expected: 2 });
  }
  await run(['auth', 'login', '--profile', 'browser', '--headers-file', malformed, '--json'], { expected: 1 });
  for (const flags of [['--headers-file', path.join(directory, 'absent')], ['--headers-file', '-', '--browser'], ['--headers', 'inline']]) {
    const error = JSON.parse((await run(['auth', 'refresh', '--profile', 'oauth', ...flags, '--json'], { expected: 2 })).stdout);
    assert.equal(error.code, 'usage_error');
    assert.doesNotMatch(error.error, /Could not read/, 'reject the target/selector mismatch before reading input');
  }
  assert.equal(requests, count, 'invalid inputs must fail before authentication/network changes');
  assert.equal(await fs.readFile(configFile, 'utf8'), unchanged);

  await run(['auth', 'logout', '--profile', 'browser', '--json'], { expected: 1 });
  const logout = JSON.parse((await run(['auth', 'logout', '--profile', 'browser', '--force', '--json'])).stdout);
  assert.equal(logout.data.credentials_cleared, true); assert.ok((await readConfig()).profiles.browser);
  // Reconnect through the same operation, retaining preferences, then remove.
  await run(['auth', 'login', '--profile', 'browser', '--headers-file', sessionFile, '--json']);
  assert.equal((await readConfig()).profiles.browser.include_counts, true);
  const removed = JSON.parse((await run(['auth', 'remove', 'browser', '--json'])).stdout);
  assert.equal(removed.data.removed, 'browser'); assert.equal((await readConfig()).profiles?.browser, undefined);
});
