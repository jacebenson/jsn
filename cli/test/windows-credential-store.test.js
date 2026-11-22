import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { windowsCredentialOperation, legacyWindowsKey } from '../src/auth/windows-credential-store.js';
import { credKey, saveCredentials, loadCredentials, deleteCredentials, writePrivateState } from '../src/auth/credential-store.js';

const secret = 'synthetic-雪-🔐-$(not-code)`"\n';
test('Windows process protocol keeps secrets and identities exclusively on stdin', () => {
  const entries = new Map();
  const run = (exe, args, options) => {
    assert.equal(exe, 'powershell.exe');
    assert.equal(args[args.length - 2], '-File');
    assert.ok(args.at(-1).endsWith('windows-credential-store.ps1'));
    assert.ok(!args.join(' ').includes(secret));
    assert.equal(options.timeout, 20000);
    const request = JSON.parse(options.input);
    if (request.operation === 'write') entries.set(request.target, request.value);
    if (request.operation === 'delete') entries.delete(request.target);
    return JSON.stringify({ status: request.operation === 'read' && !entries.has(request.target) ? 'missing' : 'ok', value: entries.get(request.target) });
  };
  for (const key of ['alice@https_a.invalid', 'bob@https_a.invalid', 'alice@https_b.invalid']) {
    windowsCredentialOperation('write', key, secret + key, run);
    assert.equal(windowsCredentialOperation('read', key, undefined, run), secret + key);
  }
  windowsCredentialOperation('delete', 'alice@https_a.invalid', undefined, run);
  assert.equal(entries.size, 2);
  assert.equal(windowsCredentialOperation('read', 'alice@https_a.invalid', undefined, run), null);
});

test('missing/old/policy-blocked/native failures are actionable and redact child diagnostics', () => {
  for (const reason of ['unsupported', 'capability', 'native']) {
    assert.throws(() => windowsCredentialOperation('read', 'synthetic', undefined,
      () => JSON.stringify({ status: 'error', reason })), error => error.code === 'credential_storage_error' && !error.message.includes(secret));
  }
  for (const code of ['ENOENT', 'ETIMEDOUT', undefined]) {
    let calls = 0;
    assert.throws(() => windowsCredentialOperation('write', 'synthetic', secret, () => {
      calls++;
      throw Object.assign(new Error(secret), { code, stderr: secret, stdout: secret });
    }), error => error.code === 'credential_storage_error' && !error.message.includes(secret));
    assert.equal(calls, code === 'ENOENT' ? 2 : 1);
  }
  assert.throws(() => windowsCredentialOperation('read', 'synthetic', undefined, () => secret), /FullLanguage/);
  const calls = [];
  assert.equal(windowsCredentialOperation('read', 'synthetic', undefined, exe => {
    calls.push(exe);
    if (exe === 'powershell.exe') throw Object.assign(new Error(), { code: 'ENOENT' });
    return '{"status":"missing"}';
  }), null);
  assert.deepEqual(calls, ['powershell.exe', 'pwsh.exe']);
});

test('oversized single entries reject before any native operation (UTF-8 bytes)', () => {
  for (const value of ['x'.repeat(2561), '雪'.repeat(854)]) {
    assert.throws(() => windowsCredentialOperation('write', 'synthetic', value, () => assert.fail('must not replace existing entry')), /2560 UTF-8 bytes/);
  }
  assert.equal(windowsCredentialOperation('write', 'synthetic', 'x'.repeat(2560), () => '{"status":"ok"}'), true);
});

test('Windows frontend verifies readback, isolates usernames/instances, preserves plaintext on failure and reads exact Go identity', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const env = { ...process.env };
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-win-storage-'));
  const entries = new Map();
  let mode = 'ok';
  const instance = 'https://synthetic.invalid';
  const creds = { auth_method: 'oauth', access_token: secret };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
    mock.method(childProcess, 'execFileSync', (_exe, _args, options) => {
      const request = JSON.parse(options.input);
      if (mode === 'fail') throw new Error(secret);
      if (request.operation === 'write') entries.set(request.target, request.value);
      if (request.operation === 'delete') entries.delete(request.target);
      return JSON.stringify({ status: request.operation === 'read' && !entries.has(request.target) ? 'missing' : 'ok',
        value: mode === 'mismatch' ? '{}' : entries.get(request.target) });
    });
    syncBuiltinESMExports();
    const file = user => path.join(root, 'servicenow', 'credentials', credKey(instance, user) + '.json');
    writePrivateState('credentials', credKey(instance, 'alice'), creds);
    writePrivateState('credentials', credKey(instance, 'bob'), creds);
    const original = fs.readFileSync(file('alice'));
    mode = 'mismatch';
    assert.throws(() => saveCredentials(instance, { ...creds }, 'alice'), /readback failed/);
    assert.deepEqual(fs.readFileSync(file('alice')), original);
    mode = 'fail';
    assert.throws(() => loadCredentials(instance, 'alice'), /FullLanguage/);
    assert.throws(() => saveCredentials(instance, { ...creds }, 'alice'), /FullLanguage/);
    assert.throws(() => deleteCredentials(instance, 'alice'), /FullLanguage/);
    assert.deepEqual(fs.readFileSync(file('alice')), original);
    mode = 'ok';
    saveCredentials(instance, { ...creds }, 'alice');
    assert.equal(fs.existsSync(file('alice')), false);
    assert.equal(fs.existsSync(file('bob')), true);
    saveCredentials(instance, { ...creds, access_token: 'bob' }, 'bob');
    saveCredentials('https://other.invalid', { ...creds, access_token: 'other' }, 'alice');
    assert.equal(loadCredentials(instance, 'alice').access_token, secret);
    assert.equal(loadCredentials(instance, 'bob').access_token, 'bob');
    assert.equal(loadCredentials('https://other.invalid', 'alice').access_token, 'other');
    deleteCredentials(instance, 'alice');
    assert.equal(loadCredentials(instance, 'alice'), null);
    assert.equal(loadCredentials(instance, 'bob').access_token, 'bob');
    assert.equal(legacyWindowsKey('synthetic.invalid/'), 'https://synthetic.invalid');
    entries.set('servicenow-cli:https://synthetic.invalid', JSON.stringify({ AccessToken: 'go-token' }));
    assert.equal(loadCredentials(instance).access_token, 'go-token');
    assert.equal(loadCredentials(instance, 'alice'), null, 'never borrow Go instance-wide identity for a named user');
    deleteCredentials(instance);
    assert.equal(entries.has('servicenow-cli:https://synthetic.invalid'), false);
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
