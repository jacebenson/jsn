import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
const authModule = new URL('../src/auth.js', import.meta.url).href;

function runFixture({ instance, direct = false, override = false, wait = false, projectOverride = false }) {
  const home = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'jsn-print-url-'));
  try {
    const config = path.join(home, 'config');
    mkdirSync(path.join(config, 'servicenow'), { recursive: true });
    writeFileSync(path.join(config, 'servicenow/config.json'), JSON.stringify({
      profiles: { fixture: { instance_url: instance, auth_method: 'oauth', username: 'synthetic-user' } },
      defaultProfile: 'fixture',
    }));
    if (projectOverride) writeFileSync(path.join(home, '.jsnrc.json'), JSON.stringify({ JSN_ALLOW_INSECURE_HTTP: '1', allow_insecure_http: true }));
    const requests = path.join(home, 'requests');
    const guard = path.join(home, 'guard.mjs');
    writeFileSync(guard, `import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const deny = () => { appendFileSync(${JSON.stringify(requests)}, 'request\\n'); throw new Error('Unexpected provider request'); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = deny;
`);
    // An allowlisted environment cannot inherit real credentials, keyring sessions,
    // NODE_OPTIONS, or a developer's insecure-transport override.
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      TMPDIR: home, CI: '1', JSN_NO_PROMPTS: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
      ...(override ? { JSN_ALLOW_INSECURE_HTTP: '1' } : {}),
    };
    const args = direct ? ['--input-type=module', '--eval', `
import { AuthManager } from ${JSON.stringify(authModule)};
const forbidden = () => { throw new Error('Unexpected credential store access'); };
const auth = new AuthManager({ config: {} }, { credentialStore: { load: forbidden, save: forbidden, delete: forbidden } });
try {
  const url = await auth.buildAuthURL(${JSON.stringify(instance)}, ${wait ? JSON.stringify(path.join(home, 'code')) : 'undefined'});
  console.log(JSON.stringify({ url }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
}`] : [cli, 'auth', 'login', '--profile', 'fixture', '--print-url', '--json', ...(wait ? ['--wait-file', path.join(home, 'code')] : [])];
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, ...args], { env, cwd: home, encoding: 'utf8', timeout: 10000 });
    const pkce = path.join(config, 'servicenow/pkce');
    return { ...result, requests: existsSync(requests), pkce: existsSync(pkce) ? readdirSync(pkce) : [] };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const direct of [true, false]) {
  const boundary = direct ? 'public AuthManager.buildAuthURL' : 'real auth login --print-url';
  for (const wait of [false, true]) {
    test(`${boundary} rejects remote HTTP before PKCE, output, network${wait ? ' (wait-file)' : ''}`, () => {
      const result = runFixture({ instance: 'http://oauth-fixture.example', direct, wait, projectOverride: true });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.notEqual(result.stdout.trim(), '', `Expected JSON rejection output; stderr: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.match(JSON.stringify(output), /HTTPS is required/);
      assert.doesNotMatch(result.stdout + result.stderr, /oauth_auth\.do|code_challenge|code_verifier|authorization_url|synthetic-user/);
      assert.deepEqual(result.pkce, []);
      assert.equal(result.requests, false);
    });
  }
  for (const { instance, override = false } of [
    { instance: 'https://oauth-fixture.example' },
    { instance: 'oauth-fixture.example' },
    { instance: 'http://localhost:17891' },
    { instance: 'http://127.0.0.1:17891' },
    { instance: 'http://[::1]:17891' },
    { instance: 'http://oauth-fixture.example', override: true },
  ]) {
    test(`${boundary} allows ${instance}${override ? ' with process override' : ''}`, () => {
      const result = runFixture({ instance, direct, override });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /oauth_auth\.do/);
      assert.equal(result.pkce.length, 1);
      assert.equal(result.requests, false);
    });
  }
}
