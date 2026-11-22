import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { windowsCredentialOperation, legacyWindowsKey } from '../src/auth/windows-credential-store.js';
import { withSyntheticCredentialCleanup } from './helpers/windows-credential-fixture.js';
import { credKey, saveCredentials, loadCredentials, deleteCredentials, writePrivateState } from '../src/auth/credential-store.js';

const secret = 'synthetic-雪-🔐-$(not-code)`"\n';
test('Windows process protocol keeps secrets and identities exclusively on stdin', () => {
  const entries = new Map();
  const trustedSource = fs.readFileSync(new URL('../src/auth/windows-credential-store.ps1', import.meta.url), 'utf8');
  let firstCommand;
  const run = (exe, args, options) => {
    assert.equal(exe, 'powershell.exe');
    assert.equal(args[args.length - 2], '-EncodedCommand');
    const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.equal(source, trustedSource);
    firstCommand ??= args.at(-1);
    assert.equal(args.at(-1), firstCommand, 'source must be identical across identities, secrets and operations');
    assert.ok(!args.includes('-ExecutionPolicy'));
    assert.ok(!source.includes(secret));
    assert.ok(args.join(' ').length < 30000, 'static encoded source must fit the Windows command line');
    assert.ok(!args.join(' ').includes(secret));
    assert.equal(options.timeout, 20000);
    const request = JSON.parse(options.input);
    if (request.operation === 'write') entries.set(request.target, request.value);
    assert.ok(!source.includes(request.target));
    assert.ok(!args.join(' ').includes(request.target));
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

test('unsupported first host discovers supported PowerShell 7 without changing stdin', () => {
  const calls = [];
  const result = windowsCredentialOperation('read', 'synthetic', undefined, (exe, _args, options) => {
    calls.push({ exe, input: options.input });
    return exe === 'powershell.exe'
      ? '{"status":"error","reason":"unsupported"}'
      : JSON.stringify({ status: 'ok', value: secret });
  });
  assert.equal(result, secret);
  assert.deepEqual(calls.map(call => call.exe), ['powershell.exe', 'pwsh.exe']);
  assert.equal(calls[0].input, calls[1].input);
});

test('PS7 parent module paths are removed only for the Windows PowerShell child environment', () => {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PSMODULEPATH') delete process.env[key];
    process.env.PsMoDuLePaTh = 'synthetic-PS7-module-path';
    process.env.JSN_SYNTHETIC_ENV_SECRET = secret;
    process.env.PSExecutionPolicyPreference = 'Restricted';
    const calls = [];
    assert.equal(windowsCredentialOperation('read', 'synthetic', undefined, (exe, _args, options) => {
      calls.push(exe);
      assert.notEqual(options.env, process.env);
      assert.equal(options.env.JSN_SYNTHETIC_ENV_SECRET, secret);
      assert.equal(options.env.PSExecutionPolicyPreference, 'Restricted', 'never discard an inherited policy preference');
      const moduleKeys = Object.keys(options.env).filter(key => key.toUpperCase() === 'PSMODULEPATH');
      assert.equal(moduleKeys.length, exe === 'powershell.exe' ? 0 : 1);
      if (exe === 'pwsh.exe') assert.equal(options.env[moduleKeys[0]], 'synthetic-PS7-module-path');
      return exe === 'powershell.exe' ? '{"status":"error","reason":"unsupported"}' : '{"status":"missing"}';
    }), null);
    assert.deepEqual(calls, ['powershell.exe', 'pwsh.exe']);
    assert.equal(process.env.PsMoDuLePaTh, 'synthetic-PS7-module-path', 'parent module environment must remain unchanged');
    assert.equal(process.env.PSExecutionPolicyPreference, 'Restricted');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test('host discovery never retries policy, capability or native denial', () => {
  for (const reason of ['policy', 'capability', 'native', 'oversized']) {
    const calls = [];
    assert.throws(() => windowsCredentialOperation('write', 'synthetic', secret, exe => {
      calls.push(exe);
      return JSON.stringify({ status: 'error', reason });
    }), error => error.code === 'credential_storage_error' && !error.message.includes(secret));
    assert.deepEqual(calls, ['powershell.exe'], reason);
  }
  for (const response of ['not-json', 'null', '{"status":"ok"}', '{"status":"other","reason":"unsupported"}']) {
    const calls = [];
    assert.throws(() => windowsCredentialOperation('read', 'synthetic', undefined, exe => {
      calls.push(exe);
      return response;
    }), { code: 'credential_storage_error' });
    assert.deepEqual(calls, ['powershell.exe'], response);
  }
  const calls = [];
  assert.throws(() => windowsCredentialOperation('write', 'synthetic', secret, exe => {
    calls.push(exe);
    throw Object.assign(new Error(secret), { status: 1 });
  }), /FullLanguage/);
  assert.deepEqual(calls, ['powershell.exe'], 'execution-policy process failure must not retry another host');
});

test('static policy gate distinguishes stock defaults and explicit enterprise policy before native/request access', () => {
  // Deliberate security invariant documented in GLOSSARY.md, Windows credential helper:
  // the exact packaged source must gate enterprise and local restrictions before
  // Add-Type/stdin. These are source/protocol checks, not PowerShell execution.
  const source = fs.readFileSync(new URL('../src/auth/windows-credential-store.ps1', import.meta.url), 'utf8');
  assert.match(source, /foreach \(\$scope in @\('MachinePolicy', 'UserPolicy'\)\)/);
  assert.match(source, /if \(\$policy -ne 'Undefined'\)/);
  assert.match(source, /foreach \(\$scope in @\('Process', 'CurrentUser', 'LocalMachine'\)\)/);
  assert.match(source, /\$policy -notin @\('Undefined', 'RemoteSigned', 'Unrestricted', 'Bypass'\)/);
  assert.match(source, /Microsoft\.PowerShell\.Security\\Get-ExecutionPolicy -Scope \$scope -ErrorAction Stop/);
  assert.ok(source.indexOf("'MachinePolicy'") < source.indexOf('Add-Type -TypeDefinition'));
  assert.ok(source.indexOf("'MachinePolicy'") < source.indexOf('[Console]::In.ReadToEnd()'));
  assert.doesNotMatch(source, /^\s*(?:Set-ExecutionPolicy|\$Env:PSExecutionPolicyPreference\s*=)/mi);
  // Response fixtures, not a claim of PowerShell policy evaluation on Linux.
  for (const scenario of ['all-Undefined-stock-Restricted', 'MachinePolicy-Restricted', 'UserPolicy-AllSigned', 'MachinePolicy-RemoteSigned']) {
    const calls = [];
    const run = exe => {
      calls.push(exe);
      return scenario.startsWith('all-Undefined') ? '{"status":"missing"}' : '{"status":"error","reason":"policy"}';
    };
    if (scenario.startsWith('all-Undefined')) assert.equal(windowsCredentialOperation('read', 'synthetic-policy', undefined, run), null);
    else assert.throws(() => windowsCredentialOperation('read', 'synthetic-policy', undefined, run), /execution policy explicitly restricts/);
    assert.deepEqual(calls, ['powershell.exe'], scenario);
  }
});

test('closed helper stages diagnose capability failure without exposing raw diagnostics or retrying', () => {
  for (const stage of ['language_mode', 'machine_policy_query', 'user_policy_query', 'process_policy_query', 'current_user_policy_query', 'local_machine_policy_query', 'input_encoding', 'output_encoding', 'native_compilation']) {
    const calls = [];
    assert.throws(() => windowsCredentialOperation('read', 'synthetic', undefined, exe => {
      calls.push(exe);
      return JSON.stringify({ status: 'error', reason: 'capability', stage, message: secret, stderr: secret, path: secret });
    }), error => error.code === 'credential_storage_error' && error.storageStage === stage && error.message.includes(`Stage: ${stage}.`) && !error.message.includes(secret));
    assert.deepEqual(calls, ['powershell.exe']);
  }
  for (const stage of [secret, 'native_compilation\n' + secret, null, {}, ['native_compilation']]) {
    assert.throws(() => windowsCredentialOperation('read', 'synthetic', undefined,
      () => JSON.stringify({ status: 'error', reason: 'capability', stage })),
    error => error.storageStage === undefined && !error.message.includes('Stage:') && !error.message.includes(secret));
  }
});

test('native fixture keeps primary failure and reports all cleanup failures while attempting every target', () => {
  const keys = ['synthetic-a', 'synthetic-b', 'synthetic-c'];
  const calls = [];
  const primary = new Error('synthetic primary');
  const deleteFailure = new Error('synthetic delete');
  const readFailure = new Error('synthetic readback');
  assert.throws(() => withSyntheticCredentialCleanup(keys, (operation, key) => {
    calls.push([operation, key]);
    if (operation === 'delete' && key === keys[0]) throw deleteFailure;
    if (operation === 'read' && key === keys[1]) throw readFailure;
    return null;
  }, () => { throw primary; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, deleteFailure, readFailure]);
    return true;
  });
  assert.deepEqual(calls, keys.flatMap(key => [['delete', key], ['read', key]]));
});

test('native fixture never turns cleanup failure into a pass and preserves a lone primary', () => {
  const primary = new Error('synthetic primary');
  assert.throws(() => withSyntheticCredentialCleanup(['synthetic'], () => null, () => { throw primary; }), error => error === primary);
  assert.throws(() => withSyntheticCredentialCleanup(['synthetic'], operation => operation === 'read' ? 'still-present' : true, () => {}), error => error instanceof AggregateError && error.errors.length === 1);
  assert.doesNotThrow(() => withSyntheticCredentialCleanup(['synthetic'], () => null, () => {}));
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
      if (mode === 'policy') return '{"status":"error","reason":"policy"}';
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
    mode = 'policy';
    const vaultBeforePolicyDenial = [...entries];
    assert.throws(() => loadCredentials(instance, 'alice'), /execution policy explicitly restricts/);
    assert.throws(() => saveCredentials(instance, { ...creds }, 'alice'), /execution policy explicitly restricts/);
    assert.throws(() => deleteCredentials(instance, 'alice'), /execution policy explicitly restricts/);
    assert.deepEqual([...entries], vaultBeforePolicyDenial);
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
