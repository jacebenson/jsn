// Storage refusal classification. A healthy secure backend with a legacy
// plaintext file must not look like a Windows policy failure, and each refusal
// cause must be distinguishable without exposing backend text or secrets.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCredentials, saveCredentials, credKey,
} from '../src/auth/credential-store.js';
import {
  installWin32CredentialFixture, restoreWin32CredentialFixture, seedSecureEntry, readSecureEntries,
} from './helpers/credential-win32-fixture.js';

const instance = 'https://classification.invalid';
const otherInstance = 'https://other-classification.invalid';
const secretToken = 'synthetic-classification-token';
const freshToken = 'synthetic-fresh-token';
let root;
let previousPlatform;
let savedEnv;

before(() => {
  previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  installWin32CredentialFixture();
});

after(() => {
  restoreWin32CredentialFixture();
  Object.defineProperty(process, 'platform', previousPlatform);
});

beforeEach(() => {
  savedEnv = { ...process.env };
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-classification-'));
  process.env.XDG_CONFIG_HOME = root;
  process.env.JSN_TEST_SECURE_STORE = path.join(root, 'secure-store.json');
  delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
  delete process.env.JSN_TEST_SECURE_FAIL;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

function legacyFile(key) {
  const file = path.join(root, 'servicenow', 'credentials', `${key}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ auth_method: 'oauth', access_token: secretToken, refresh_token: 'old-refresh' }), { mode: 0o600 });
  return file;
}

test('healthy native backend + preserved plaintext file classifies as plaintext_requires_recovery and never opens the file', () => {
  const key = credKey(instance, 'alice');
  const file = legacyFile(key);
  const original = fs.readFileSync(file);
  const opened = [];
  const openSync = fs.openSync;
  const readFileSync = fs.readFileSync;
  fs.openSync = function spy(...args) {
    opened.push(String(args[0]));
    return openSync.apply(this, args);
  };
  fs.readFileSync = function spy(...args) {
    opened.push(String(args[0]));
    return readFileSync.apply(this, args);
  };
  try {
    assert.throws(() => loadCredentials(instance, 'alice'), error => {
      assert.equal(error.code, 'credential_storage_error');
      assert.equal(error.classification, 'plaintext_requires_recovery');
      assert.match(error.message, /Existing plaintext credentials are preserved/);
      // The stored file is not a backend failure and must not be blamed on
      // PowerShell policy, nor advertise a plaintext opt-in as the repair.
      assert.doesNotMatch(error.message, /PowerShell|FullLanguage|Add-Type/);
      assert.doesNotMatch(error.message, /JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE/);
      assert.match(error.recovery, /jsn auth login --profile <name>/);
      return true;
    });
  } finally {
    fs.openSync = openSync;
    fs.readFileSync = readFileSync;
  }
  assert.deepEqual(opened, [], 'the blocked plaintext file must not be opened');
  assert.deepEqual(fs.readFileSync(file), original, 'blocked plaintext bytes must be preserved');
});

test('native backend failures classify as secure_storage_unavailable, distinct from the plaintext block', () => {
  const file = legacyFile(credKey(instance, 'alice'));
  const original = fs.readFileSync(file);
  process.env.JSN_TEST_SECURE_FAIL = 'fail-read';
  assert.throws(() => loadCredentials(instance, 'alice'), error => {
    assert.equal(error.classification, 'secure_storage_unavailable');
    assert.match(error.message, /^Secure credential storage unavailable/);
    // Existing Windows diagnostics remain for a genuine backend failure.
    assert.match(error.message, /FullLanguage/);
    assert.ok(error.recovery.includes('jsn auth login --profile <name>'));
    return true;
  });
  process.env.JSN_TEST_SECURE_FAIL = 'fail-write';
  assert.throws(() => saveCredentials(instance, { auth_method: 'oauth', access_token: freshToken }, 'alice'),
    error => error.classification === 'secure_storage_unavailable');
  assert.deepEqual(fs.readFileSync(file), original);
});

test('secure readback mismatch classifies as secure_readback_failed and preserves every file', () => {
  const target = legacyFile(credKey(instance, 'alice'));
  const sibling = legacyFile(credKey(instance, 'bob'));
  const other = legacyFile(credKey(otherInstance, 'alice'));
  const original = fs.readFileSync(target);
  const siblingBytes = fs.readFileSync(sibling);
  const otherBytes = fs.readFileSync(other);
  process.env.JSN_TEST_SECURE_FAIL = 'readback-mismatch';
  assert.throws(() => saveCredentials(instance, { auth_method: 'oauth', access_token: freshToken }, 'alice'), error => {
    assert.equal(error.classification, 'secure_readback_failed');
    assert.match(error.message, /readback failed/);
    assert.equal(error.recovery, 'Run `jsn auth login --profile <name>` to sign in again and verify secure storage. Existing credential files are preserved.');
    return true;
  });
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(fs.readFileSync(sibling), siblingBytes);
  assert.deepEqual(fs.readFileSync(other), otherBytes);
});

test('an oversized entry fails before any secure write and preserves the original bytes', () => {
  const target = legacyFile(credKey(instance, 'alice'));
  const original = fs.readFileSync(target);
  const oversized = { auth_method: 'oauth', access_token: `snow${'x'.repeat(2600)}` };
  assert.throws(() => saveCredentials(instance, oversized, 'alice'), error => {
    assert.equal(error.code, 'credential_storage_error');
    assert.match(error.message, /2560 UTF-8 bytes/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(readSecureEntries(), {}, 'no entry may be written for a rejected oversized value');
});

test('a malformed secure entry classifies as malformed_secure_entry without the PowerShell diagnosis', () => {
  const key = credKey(instance, 'alice');
  seedSecureEntry(key, '{"auth_method":"oauth"');
  process.env.JSN_TEST_SECURE_FAIL = 'malformed';
  assert.throws(() => loadCredentials(instance, 'alice'), error => {
    assert.equal(error.classification, 'malformed_secure_entry');
    assert.doesNotMatch(error.message, /PowerShell|FullLanguage|Add-Type/);
    assert.match(error.message, /malformed/i);
    return true;
  });
});

test('AuthManager reports a safe state, refuses authenticated calls, and probes nothing on storage refusal', async () => {
  legacyFile(credKey(instance, 'alice'));
  const { AuthManager } = await import('../src/auth.js');
  const manager = new AuthManager({
    getUsername: () => 'alice',
    getEffectiveInstance: () => instance,
    getAuthMethod: () => 'oauth',
  });
  const state = manager.getAuthState(instance, { authMethod: 'oauth', username: 'alice' });
  assert.equal(state.state, 'blocked');
  assert.equal(state.auth_source, 'unavailable');
  assert.deepEqual(state.storage, {
    status: 'blocked',
    classification: 'plaintext_requires_recovery',
    recovery: 'Run `jsn auth login --profile <name>` to sign in again; the verified secure save retires the old credential file.',
  });
  assert.equal(manager.isAuthenticatedFor(instance, { authMethod: 'oauth', username: 'alice' }), false);
  assert.throws(() => manager.getCredentialsFor(instance, 'alice', { authMethod: 'oauth' }),
    error => error.code === 'credential_storage_error' && error.classification === 'plaintext_requires_recovery');
  let sdkCalls = 0;
  const probe = await manager.probeCurrentUser(instance, { getCurrentUser: async () => { sdkCalls++; return { user_name: 'alice' }; } },
    { authMethod: 'oauth', username: 'alice' });
  assert.equal(probe.status, 'not_attempted');
  assert.equal(probe.code, 'storage_blocked');
  assert.equal(probe.classification, 'storage_blocked');
  assert.equal(sdkCalls, 0, 'a storage refusal must not reach the SDK');
});

// Absent credentials must remain "missing", not become a storage state.
test('absent credentials stay missing and unauthenticated without a storage block', async () => {
  const { AuthManager } = await import('../src/auth.js');
  const manager = new AuthManager({
    getUsername: () => 'alice',
    getEffectiveInstance: () => instance,
    getAuthMethod: () => 'oauth',
  });
  const state = manager.getAuthState(instance, { authMethod: 'oauth', username: 'alice' });
  assert.equal(state.state, 'missing');
  assert.equal(state.storage, undefined);
  assert.equal(manager.isAuthenticatedFor(instance, { authMethod: 'oauth', username: 'alice' }), false);
});

test('explicit login recovery saves fresh credentials securely and retires only the selected legacy file', async () => {
  const key = credKey(instance, 'alice');
  const target = legacyFile(key);
  const sibling = legacyFile(credKey(instance, 'bob'));
  const siblingBytes = fs.readFileSync(sibling);
  const { AuthManager } = await import('../src/auth.js');
  const manager = new AuthManager({
    getUsername: () => 'alice',
    getEffectiveInstance: () => instance,
    getAuthMethod: () => 'basic',
  });

  await manager.loginWithPassword(instance, 'alice', { username: 'alice', password: 'fresh-password' });

  assert.equal(fs.existsSync(target), false, 'verified save retires the selected legacy file');
  assert.deepEqual(fs.readFileSync(sibling), siblingBytes, 'unrelated identity bytes are untouched');
  const saved = readSecureEntries()[`servicenow-cli:${key}`];
  assert.match(saved, /fresh-password/);
  assert.doesNotMatch(saved, new RegExp(secretToken), 'the old plaintext content is never promoted');
  assert.equal(manager.loadCredentials(instance, 'alice').password, 'fresh-password');
});

test('failed readback during login recovery leaves the legacy file byte-identical', async () => {
  const target = legacyFile(credKey(instance, 'alice'));
  const original = fs.readFileSync(target);
  process.env.JSN_TEST_SECURE_FAIL = 'readback-mismatch';
  const { AuthManager } = await import('../src/auth.js');
  const manager = new AuthManager({
    getUsername: () => 'alice',
    getEffectiveInstance: () => instance,
    getAuthMethod: () => 'basic',
  });
  await assert.rejects(
    manager.loginWithPassword(instance, 'alice', { username: 'alice', password: 'fresh-password' }),
    error => error.code === 'credential_storage_error' && error.classification === 'secure_readback_failed',
  );
  assert.deepEqual(fs.readFileSync(target), original);
});

test('legacy migration from a plaintext bare key stays advisory and does not abort', async () => {
  legacyFile(credKey(instance));
  const { AuthManager } = await import('../src/auth.js');
  const manager = new AuthManager({
    getUsername: () => 'alice',
    getEffectiveInstance: () => instance,
    getAuthMethod: () => 'oauth',
  });
  assert.equal(manager.migrateLegacyCredential(instance, 'alice'), false);
});
