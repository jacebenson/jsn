import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { windowsCredentialOperation } from '../src/auth/windows-credential-store.js';

const required = process.env.JSN_REQUIRE_WINDOWS_CREDENTIAL_TEST === '1';
test('real Windows Credential Manager: UTF-8 roundtrip, independent entries, oversize preservation and exact cleanup', {
  skip: process.platform !== 'win32' && !required ? 'Native Windows API requires a Windows host; mandatory in Windows CI' : false,
  timeout: 180000,
}, () => {
  assert.equal(process.platform, 'win32', 'mandatory native lane must not run on a mock/non-Windows host');
  const executable = process.env.JSN_TEST_WINDOWS_POWERSHELL || 'powershell.exe';
  assert.ok(['powershell.exe', 'pwsh.exe'].includes(executable));
  const run = (_exe, args, options) => execFileSync(executable, args, options);
  const prefix = `jsn-530-native-${randomUUID()}`;
  const keys = [`alice@${prefix}`, `bob@${prefix}`, `alice@${prefix}-other`];
  const values = keys.map((key, i) => JSON.stringify({ auth_method: 'oauth', access_token: 'synthetic-' + i + '-雪-🔐-"-$()`\n', username: key }));
  try {
    for (let i = 0; i < keys.length; i++) {
      assert.equal(windowsCredentialOperation('read', keys[i], undefined, run), null);
      windowsCredentialOperation('write', keys[i], values[i], run);
    }
    for (let i = 0; i < keys.length; i++) assert.equal(windowsCredentialOperation('read', keys[i], undefined, run), values[i]);
    assert.throws(() => windowsCredentialOperation('write', keys[0], '雪'.repeat(854), run), /2560 UTF-8 bytes/);
    assert.equal(windowsCredentialOperation('read', keys[0], undefined, run), values[0]);
    windowsCredentialOperation('delete', keys[0], undefined, run);
    assert.equal(windowsCredentialOperation('read', keys[0], undefined, run), null);
    assert.equal(windowsCredentialOperation('read', keys[1], undefined, run), values[1]);
  } finally {
    // Never enumerate the vault or remove another test/user's credential.
    for (const key of keys) {
      windowsCredentialOperation('delete', key, undefined, run);
      assert.equal(windowsCredentialOperation('read', key, undefined, run), null);
    }
  }
});
