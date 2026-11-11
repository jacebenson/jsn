import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { BASE_ENV, CLI, PTY_DRIVER, ptySkipReason, runPty } from './support/welcome-harness.js';

const skip = ptySkipReason();
test('fresh terminal welcome is a short local-only front door; explicit help stays complete', { skip }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-front-door-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { JSN_DATA_HOME: directory, NODE_OPTIONS: `--import=${path.resolve('test/support/welcome-no-operations.js')}` };
  const welcome = runPty(directory, [], { env, unset: ['JSN_NO_VERSION_CHECK', 'JSN_NO_SKILL_CHECK'] });
  assert.equal(welcome.status, 0, welcome.output);
  assert.match(welcome.output, /jsn setup\s+connect to ServiceNow/);
  assert.match(welcome.output, /jsn --help/);
  assert.doesNotMatch(welcome.output, /Usage:|CORE|FLAGS|jsn auth/);
  assert.ok(welcome.output.trim().split('\n').length <= 8);
  const normalized = welcome.output.replace(/Welcome to jsn [^ ]+ /, 'Welcome to jsn <version> ')
    .replace(/^Config: .*$/m, 'Config: <config-file>');
  assert.equal(normalized, fs.readFileSync('test/fixtures/first-run/compact-welcome.txt', 'utf8'));
  const help = runPty(directory, ['--help'], { env });
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /CORE/); assert.match(help.output, /FLAGS/);
  if (process.env.JSN_ONBOARDING_PROOF) fs.writeFileSync(`${process.env.JSN_ONBOARDING_PROOF}-welcome.txt`, welcome.output);
});

test('real setup terminal accepts one preset, saves first profile and asks no global settings', { skip }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-setup-terminal-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.method + ' ' + request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/api/now/table/domain')) {
      response.writeHead(404); response.end(JSON.stringify({ error: { message: 'Table not found' } })); return;
    }
    const result = request.url.includes('/sys_user') ? [{ sys_id: 'fixture-user', user_name: 'fixture', name: 'Fixture User' }] : [];
    response.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const instance = `http://127.0.0.1:${server.address().port}`;
  const spec = { command: [process.execPath, CLI, 'setup'], cwd: directory,
    env: { ...BASE_ENV, XDG_CONFIG_HOME: directory, JSN_DATA_HOME: directory, XDG_CACHE_HOME: directory, TERM: 'xterm-256color' },
    columns: 120, timeout: 20,
    steps: [
      { wait: 'ServiceNow instance name or URL:', send: instance + '\r' },
      { wait: 'Profile name:', send: 'fixture\r' },
      { wait: 'Authentication method:', send: '\x1b[B\x1b[B\r' },
      { wait: 'Accept defaults?', send: '\r' },
      { wait: 'Username:', send: 'fixture\r' },
      { wait: 'Password:', send: 'offline-fixture-password\r' },
    ] };
  const result = await new Promise((resolve, reject) => execFile('python3', [PTY_DRIVER, JSON.stringify(spec)], { timeout: 30000 },
    (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))));
  const output = stripVTControlCharacters(result.output).replaceAll('\r', '');
  if (process.env.JSN_ONBOARDING_PROOF) {
    fs.writeFileSync(`${process.env.JSN_ONBOARDING_PROOF}-setup-raw.txt`, result.output);
    fs.writeFileSync(`${process.env.JSN_ONBOARDING_PROOF}-setup.txt`, output);
  }
  assert.equal(result.status, 0, output);
  const completed = output.match(/✔[^\n]*/g) || [];
  assert.equal(completed.length, 6, completed.join('\n'));
  assert.match(completed[0], /ServiceNow instance/);
  assert.match(completed[1], /Profile name/);
  assert.match(completed[2], /Authentication method/);
  assert.match(completed[3], /Accept defaults\? writes allowed · delete confirmations on · result totals on/);
  assert.match(completed[4], /Username/); assert.match(completed[5], /Password/);
  assert.doesNotMatch(output, /Read-only connections|Use JSN-hosted|Use this profile by default/);
  assert.match(output, /Connection preset: writes allowed · deletes ask first · totals on/);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'servicenow/config.json'), 'utf8'));
  assert.equal(config.default_profile, 'fixture');
  assert.deepEqual(config.connection_defaults, { read_only: false, skip_confirmations: false, include_counts: true });
  assert.equal(config.docs, undefined);
  assert.equal(config.profiles.fixture.read_only, false);
  assert.equal(config.profiles.fixture.skip_confirmations, false);
  assert.equal(config.profiles.fixture.include_counts, true);
  assert.ok(requests.length > 0); assert.ok(requests.every(request => request.startsWith('GET ')));
  t.diagnostic(completed.join('\n'));
});
