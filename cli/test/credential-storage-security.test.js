import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AuthManager } from '../src/auth.js';
import { credKey, saveCredentials, loadCredentials, deleteCredentials } from '../src/auth/credential-store.js';
import { savePKCEState, loadPKCEState, removePKCEState } from '../src/auth/oauth.js';

const instance = 'https://synthetic.invalid';
const secret = { auth_method: 'oauth', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' };
let root, savedEnv, warnings;
const file = (kind = 'credentials', user = 'fixture') => path.join(process.env.XDG_CONFIG_HOME, 'servicenow', kind, credKey(instance, user) + '.json');
const save = () => saveCredentials(instance, { ...secret }, 'fixture');
const load = () => loadCredentials(instance, 'fixture');
function legacy(user = 'fixture') {
  const target = file('credentials', user);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(secret), { mode: 0o600 });
  return target;
}
beforeEach(() => {
  savedEnv = { ...process.env };
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-storage-test-'));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.PATH = path.join(root, 'bin');
  process.env.FAKE_KEYRING = path.join(root, 'fake-keyring.json');
  process.env.FAKE_KEYRING_MODE = 'fail';
  delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
  fs.mkdirSync(process.env.PATH, { mode: 0o700 });
  // Inject the process boundary, not a Unix executable: works on Windows too
  // and cannot reach the real keyring, even if a test changes PATH.
  mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'secret-tool');
    const mode = process.env.FAKE_KEYRING_MODE;
    if (mode === 'fail') throw new Error('synthetic-backend-secret');
    const file = process.env.FAKE_KEYRING;
    if (args[0] === 'store') fs.writeFileSync(file, options.input);
    if (args[0] === 'lookup') {
      if (!fs.existsSync(file)) throw new Error('missing synthetic entry');
      return mode === 'mismatch' ? '{}' : fs.readFileSync(file, 'utf8');
    }
    if (args[0] === 'clear' && fs.existsSync(file)) fs.unlinkSync(file);
    return '';
  });
  syncBuiltinESMExports();
  warnings = [];
  mock.method(process.stderr, 'write', text => { warnings.push(String(text)); return true; });
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

it('fails closed without creating plaintext; missing credentials still return null', () => {
  assert.equal(load(), null);
  assert.throws(save, error => /Secure credential storage unavailable/.test(error.message) && !error.message.includes('synthetic-backend-secret'));
  assert.equal(fs.existsSync(file()), false);
  assert.equal(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME, 'servicenow')), false);
  assert.equal(warnings.length, 0);
});
it('only exact process-local opt-in permits portable plaintext, warns, and reports file source', () => {
  process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = 'true';
  assert.throws(save, /Secure credential storage unavailable/);
  process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
  save();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file())).mode & 0o777, 0o700);
  const copied = path.join(root, 'copied');
  fs.cpSync(process.env.XDG_CONFIG_HOME, copied, { recursive: true });
  process.env.XDG_CONFIG_HOME = copied;
  assert.equal(load().refresh_token, secret.refresh_token);
  assert.equal(load().auth_source, 'file');
  assert.match(warnings.join(''), /portable.*backups/);
  assert.ok(!warnings.join('').includes(secret.refresh_token));
  delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
  assert.throws(load, /Existing plaintext credentials are preserved/);
});
it('project configuration and an existing file cannot authorize fallback', () => {
  legacy();
  fs.mkdirSync(path.join(root, '.servicenow'));
  fs.writeFileSync(path.join(root, '.servicenow/config.json'), JSON.stringify({ JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '1', allow_plaintext_credential_storage: true }));
  const cwd = process.cwd();
  try { process.chdir(root); assert.throws(load, /explicitly set JSN_ALLOW_PLAINTEXT/); }
  finally { process.chdir(cwd); }
  assert.deepEqual(JSON.parse(fs.readFileSync(file())), secret);
});
it('verified recovery migrates the selected identity only, with no opt-in required', () => {
  const target = legacy();
  const other = legacy('other');
  process.env.FAKE_KEYRING_MODE = 'ok';
  assert.throws(load, /Existing plaintext credentials are preserved/);
  process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
  const original = load();
  assert.equal(original.auth_source, 'file');
  assert.equal(fs.existsSync(process.env.FAKE_KEYRING), false, 'read-only load must not persist');
  delete process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE;
  saveCredentials(instance, original, 'fixture');
  assert.equal(load().auth_source, 'keyring');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(other), true);
  const migrated = JSON.parse(fs.readFileSync(process.env.FAKE_KEYRING));
  assert.equal(migrated.refresh_token, secret.refresh_token);
});
it('failed migration readback retains the exact original file and suppresses secrets', () => {
  const target = legacy();
  const original = fs.readFileSync(target);
  process.env.FAKE_KEYRING_MODE = 'mismatch';
  let message;
  try { saveCredentials(instance, JSON.parse(original), 'fixture'); } catch (error) { message = error.message; }
  assert.match(message, /readback failed/);
  assert.ok(!message.includes(secret.access_token));
  assert.deepEqual(fs.readFileSync(target), original);
});
it('verified save retires a stale selected file, and never other identities', () => {
  legacy(); const other = legacy('other');
  process.env.FAKE_KEYRING_MODE = 'ok';
  save();
  assert.equal(fs.existsSync(file()), false);
  assert.equal(fs.existsSync(other), true);
  assert.equal(load().access_token, secret.access_token);
});
it('save readback failure refuses and preserves a stale original', () => {
  legacy(); const original = fs.readFileSync(file());
  process.env.FAKE_KEYRING_MODE = 'mismatch';
  assert.throws(save, /readback failed/);
  assert.deepEqual(fs.readFileSync(file()), original);
});
it('PKCE atomic replacement remains 0600 under permissive umask and removes only its slot', () => {
  const old = process.platform === 'win32' ? undefined : process.umask(0);
  try {
    savePKCEState(instance, { code_verifier: 'synthetic-one' }, 'fixture');
    const ino = fs.statSync(file('pkce')).ino;
    savePKCEState(instance, { code_verifier: 'synthetic-two' }, 'fixture');
    assert.notEqual(fs.statSync(file('pkce')).ino, ino);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file('pkce')).mode & 0o777, 0o600);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file('pkce'))).mode & 0o777, 0o700);
    assert.equal(loadPKCEState(instance, 'fixture').code_verifier, 'synthetic-two');
    removePKCEState(instance, 'fixture');
    assert.equal(loadPKCEState(instance, 'fixture'), null);
  } finally { if (old !== undefined) process.umask(old); }
});
for (const kind of ['credentials', 'pkce']) {
  it(`${kind} refuses weak POSIX files/directories without modifying them`, { skip: process.platform === 'win32' ? 'POSIX modes are not Windows ACLs' : false }, () => {
    process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
    const write = kind === 'credentials' ? save : () => savePKCEState(instance, { state: 'synthetic' }, 'fixture');
    write(); const target = file(kind); const original = fs.readFileSync(target);
    fs.chmodSync(target, 0o644);
    assert.throws(write, /Unsafe credential\/PKCE path/);
    assert.deepEqual(fs.readFileSync(target), original);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    fs.chmodSync(target, 0o600); fs.chmodSync(path.dirname(target), 0o755);
    assert.throws(write, /Unsafe credential\/PKCE path/);
    assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o755);
  });
  it(`${kind} refuses symlink files and directories without following them`, () => {
    process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
    const target = file(kind);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'synthetic-untouched', { mode: 0o600 });
    fs.symlinkSync(outside, target);
    const write = kind === 'credentials' ? save : () => savePKCEState(instance, {}, 'fixture');
    assert.throws(write, /Unsafe credential\/PKCE path/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic-untouched');
    fs.unlinkSync(target); fs.rmdirSync(path.dirname(target));
    fs.symlinkSync(root, path.dirname(target), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(write, /Unsafe credential\/PKCE path/);
  });
}
it('rejects unexpected ownership, hard links and writable ancestors', () => {
  legacy();
  if (process.platform !== 'win32') {
    const lstat = fs.lstatSync;
    mock.method(fs, 'lstatSync', target => {
      const stat = lstat(target);
      if (target === file()) Object.defineProperty(stat, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
      return stat;
    });
    assert.throws(load, /Unsafe credential\/PKCE path/);
    fs.lstatSync.mock.restore();
  }
  fs.linkSync(file(), path.join(root, 'hardlink'));
  assert.throws(load, /Unsafe credential\/PKCE path/);
  fs.unlinkSync(path.join(root, 'hardlink'));
  if (process.platform !== 'win32') {
    fs.chmodSync(process.env.XDG_CONFIG_HOME, 0o777);
    assert.throws(load, /Unsafe credential\/PKCE path/);
  }
});
it('explicit deletion removes only selected synthetic credentials', () => {
  legacy(); const other = legacy('other');
  deleteCredentials(instance, 'fixture');
  assert.equal(fs.existsSync(file()), false);
  assert.equal(fs.existsSync(other), true);
});

it('environment-only OAuth and Basic resolution need no persistence or keyring', () => {
  for (const key of Object.keys(process.env)) if (/^(SN_|SERVICENOW_)/.test(key)) delete process.env[key];
  const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => instance });
  process.env.SERVICENOW_OAUTH_TOKEN = 'synthetic-env-token';
  assert.equal(auth.getCredentialsFor(instance).auth_source, 'env_token');
  delete process.env.SERVICENOW_OAUTH_TOKEN;
  process.env.SN_USERNAME = 'synthetic-user';
  process.env.SN_PASSWORD = 'synthetic-env-password';
  assert.equal(auth.getCredentialsFor(instance).auth_source, 'env_basic');
  assert.equal(fs.existsSync(process.env.XDG_CONFIG_HOME), false);
  assert.equal(fs.existsSync(process.env.FAKE_KEYRING), false);
});

it('default refusal does not open an existing plaintext credential', () => {
  legacy();
  const open = fs.openSync;
  mock.method(fs, 'openSync', (...args) => {
    assert.notEqual(args[0], file(), 'plaintext must not be opened without opt-in');
    return open(...args);
  });
  assert.throws(load, /Existing plaintext credentials are preserved/);
});
it('failed atomic replacement preserves the original PKCE state and cleans its temporary file', () => {
  savePKCEState(instance, { state: 'synthetic-original' }, 'fixture');
  const original = fs.readFileSync(file('pkce'));
  mock.method(fs, 'renameSync', () => { throw new Error('synthetic-rename-failure'); });
  assert.throws(() => savePKCEState(instance, { state: 'synthetic-new' }, 'fixture'), /synthetic-rename-failure/);
  assert.deepEqual(fs.readFileSync(file('pkce')), original);
  assert.deepEqual(fs.readdirSync(path.dirname(file('pkce'))), [path.basename(file('pkce'))]);
});
