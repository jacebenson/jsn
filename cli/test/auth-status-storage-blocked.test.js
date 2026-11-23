// Public CLI evidence for credential-storage refusals: one blocked legacy
// profile must not hide a healthy profile, claim verification, contact the
// instance, or write anything under --local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credKey } from '../src/auth/credential-store.js';
import { seedSecureEntry } from './helpers/credential-win32-fixture.js';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const helper = new URL('./helpers/credential-win32-fixture.js', import.meta.url).href;
const blockedInstance = 'https://blocked-status.invalid';
const healthyInstance = 'https://healthy-status.invalid';
let root;
let env;
let storeFile;
let httpCount;

function credentialFile(instance, username) {
  return path.join(root, 'servicenow', 'credentials', `${credKey(instance, username)}.json`);
}

function snapshot(dir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    entries.push([name, fs.readFileSync(file).toString('base64'), stat.mtimeMs]);
  }
  return entries;
}

before(() => {
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-status-storage-'));
  storeFile = path.join(root, 'secure-store.json');
  httpCount = path.join(root, 'http-calls.log');
  fs.mkdirSync(path.join(root, 'servicenow', 'credentials'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'servicenow', 'config.json'), JSON.stringify({
    default_profile: 'healthy',
    profiles: {
      blocked: { instance_url: blockedInstance, username: 'alice', auth_method: 'oauth' },
      healthy: { instance_url: healthyInstance, username: 'bob', auth_method: 'oauth' },
    },
  }), { mode: 0o600 });
  fs.writeFileSync(credentialFile(blockedInstance, 'alice'),
    JSON.stringify({ auth_method: 'oauth', access_token: 'blocked-legacy-token', refresh_token: 'blocked-legacy-refresh' }),
    { mode: 0o600 });
  process.env.JSN_TEST_SECURE_STORE = storeFile;
  seedSecureEntry(credKey(healthyInstance, 'bob'), {
    auth_method: 'oauth', access_token: 'healthy-token', refresh_token: 'healthy-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  });
  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    JSN_DATA_HOME: path.join(root, 'data'),
    PATH: '',
    JSN_NO_VERSION_CHECK: '1',
    JSN_NO_SKILL_CHECK: '1',
    JSN_NO_PROMPTS: '1',
    JSN_NO_HEADER: '1',
    JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '0',
    JSN_TEST_WIN32_FIXTURE: '1',
    JSN_TEST_SECURE_STORE: storeFile,
    JSN_TEST_HTTP_COUNT: httpCount,
  };
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args) {
  const result = spawnSync(process.execPath, ['--import', helper, path.join(cliRoot, 'bin/jsn.js'), ...args], {
    cwd: root, encoding: 'utf8', env, timeout: 30000,
  });
  return result;
}

test('auth status --details --local shows the blocked and healthy profiles without readback, HTTP, or writes', () => {
  const credentialDir = path.join(root, 'servicenow', 'credentials');
  const beforeFiles = snapshot(credentialDir);
  const beforeStore = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null;
  const beforeStoreStat = fs.existsSync(storeFile) ? fs.statSync(storeFile).mtimeMs : null;

  const result = run(['auth', 'status', '--details', '--local', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  const profiles = Object.fromEntries(envelope.data.profiles.map(profile => [profile.name, profile]));

  assert.deepEqual(Object.keys(profiles).sort(), ['blocked', 'healthy'], 'every profile must still be reported');
  assert.equal(envelope.data.authenticated, true, 'the healthy selected profile still reports authenticated');

  const blocked = profiles.blocked;
  assert.equal(blocked.authenticated, false);
  assert.equal(blocked.verified, null);
  assert.equal(blocked.auth_source, undefined);
  assert.equal(blocked.diagnostics.state, 'blocked');
  assert.equal(blocked.storage.status, 'blocked');
  assert.equal(blocked.storage.classification, 'plaintext_requires_recovery');
  assert.match(blocked.storage.recovery, /jsn auth login --profile <name>/);

  const healthy = profiles.healthy;
  assert.equal(healthy.authenticated, true);
  assert.equal(healthy.auth_source, 'keyring');
  assert.equal(healthy.diagnostics.state, 'available');
  assert.equal(healthy.storage, undefined, 'healthy profile JSON contract is unchanged');

  const text = result.stdout + result.stderr;
  assert.doesNotMatch(text, /PowerShell|FullLanguage|Add-Type/);
  assert.doesNotMatch(text, /Warning: plaintext/);
  assert.doesNotMatch(text, /blocked-legacy-token|blocked-legacy-refresh|healthy-token|healthy-refresh/);

  assert.deepEqual(snapshot(credentialDir), beforeFiles, '--local must not write or re-timestamp credential files');
  assert.deepEqual(fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null, beforeStore, '--local must not write the secure store');
  assert.equal(fs.existsSync(storeFile) ? fs.statSync(storeFile).mtimeMs : null, beforeStoreStat);
  assert.equal(fs.existsSync(httpCount), false, '--local must not make any HTTP request');
});

test('human status renders a storage-blocked line and the login recovery command, never "Verified"', () => {
  const result = run(['auth', 'status', '--details', '--local', '--format', 'styled']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = result.stdout;
  assert.match(text, /Storage blocked/);
  assert.match(text, /jsn auth login --profile blocked/);
  assert.match(text, /healthy/);
  // The footer legend mentions the CONNECTION column; the blocked row itself
  // must never claim verification.
  assert.doesNotMatch(text, /^\s*blocked\b.*Verified/m);
  assert.doesNotMatch(text, /PowerShell|FullLanguage|Add-Type/);
  assert.doesNotMatch(text, /blocked-legacy-token|healthy-token/);
});

test('a blocked profile without --local reports a not-attempted storage probe and contacts nothing', () => {
  const result = run(['auth', 'status', '--profile', 'blocked', '--details', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { data } = JSON.parse(result.stdout);
  assert.equal(data.profiles.length, 1);
  const blocked = data.profiles[0];
  assert.equal(blocked.authenticated, false);
  assert.equal(blocked.storage.classification, 'plaintext_requires_recovery');
  assert.equal(blocked.diagnostics.probe.status, 'not_attempted');
  assert.equal(blocked.diagnostics.probe.code, 'storage_blocked');
  assert.equal(blocked.verified, null);
  assert.equal(fs.existsSync(httpCount), false, 'a storage refusal must not build an SDK or contact the instance');
});
