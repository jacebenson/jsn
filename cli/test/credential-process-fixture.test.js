import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialFixtureArgs } from './helpers/fake-keyring.js';

const storage = new URL('../src/auth/credential-store.js', import.meta.url).href;
test('CLI credential fixture models empty Linux/Windows transports without host executables or implicit plaintext', () => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-credential-process-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { saveCredentials, loadCredentials, deleteCredentials } from ${JSON.stringify(storage)};
      for (const executable of ['powershell.exe', 'pwsh.exe']) {
        for (const operation of ['read', 'delete']) {
          assert.deepEqual(JSON.parse(execFileSync(executable, [], { input: JSON.stringify({ operation }) })), { status: 'missing' });
        }
        assert.throws(() => execFileSync(executable, [], { input: JSON.stringify({ operation: 'write' }) }), /Synthetic secure-store writes unavailable/);
      }
      assert.equal(execFileSync('secret-tool', ['lookup']), '');
      assert.equal(execFileSync('secret-tool', ['clear']), '');
      assert.throws(() => execFileSync('secret-tool', ['store']), /Synthetic secure-store writes unavailable/);
      const instance = 'https://synthetic-fixture.invalid';
      const value = { auth_method: 'oauth', access_token: 'synthetic-fixture-secret' };
      assert.equal(loadCredentials(instance, 'fixture'), null);
      assert.throws(() => saveCredentials(instance, { ...value }, 'fixture'), { code: 'credential_storage_error' });
      process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
      saveCredentials(instance, { ...value }, 'fixture');
      assert.equal(loadCredentials(instance, 'fixture').access_token, value.access_token);
      deleteCredentials(instance, 'fixture');
      assert.equal(loadCredentials(instance, 'fixture'), null);
      process.stdout.write('fixture-contract-ok');
    `;
    const output = execFileSync(process.execPath, [...credentialFixtureArgs, '--input-type=module', '-e', script], {
      cwd: directory, env: { ...process.env, PATH: '', HOME: directory, XDG_CONFIG_HOME: directory, JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE: '0' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    assert.equal(output, 'fixture-contract-ok');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
