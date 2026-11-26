// macOS Keychain backend (issue #571). Darwin-only: the point is the real
// /usr/bin/security round trip, so these run on the macOS CI lane against a
// throwaway keychain and are skipped everywhere else.
//
// A successful browser login used to authenticate and then fail to store, so
// the assertions are the ones a user cares about: the credential comes back,
// `auth status` sees it, and nothing lands in a plaintext file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const darwin = process.platform === 'darwin';
const skip = darwin ? false : 'macOS Keychain only';
const security = (args) => execFileSync('/usr/bin/security', args, { encoding: 'utf8' });
const unquoted = (value) => String(value).trim().replace(/^"|"$/g, '');
// A hosted runner can have no default keychain at all; there is then nothing to
// restore, and refusing here would hide the real assertions below.
function currentDefaultKeychain() {
  try { return unquoted(security(['default-keychain', '-d'])); } catch { return null; }
}

test('Keychain stores, reads back, probes and deletes a credential', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-keychain-'));
  const keychain = path.join(dir, 'jsn-test.keychain-db');
  const password = 'jsn-test-keychain';
  const original = currentDefaultKeychain();

  security(['create-keychain', '-p', password, keychain]);
  security(['unlock-keychain', '-p', password, keychain]);
  security(['set-keychain-settings', '-lut', '21600', keychain]);
  security(['default-keychain', '-s', keychain]);
  security(['list-keychains', '-s', keychain]);
  t.after(() => {
    if (original) { try { security(['default-keychain', '-s', original]); } catch { /* best effort */ } }
    try { security(['delete-keychain', keychain]); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = await import('../src/auth/credential-store.js');
  const instance = 'https://example.service-now.com';
  const creds = { auth_method: 'basic', username: 'fixture', password: 'secret-value' };

  store.saveCredentials(instance, { ...creds }, 'fixture');

  const loaded = store.loadCredentials(instance, 'fixture');
  assert.equal(loaded.username, 'fixture');
  assert.equal(loaded.password, 'secret-value');
  assert.equal(loaded.auth_source, 'keyring');

  // The preflight must see the same backend, or setup would refuse to start on
  // a Mac that can store credentials perfectly well.
  const status = store.credentialStorageStatus();
  assert.equal(status.available, true, JSON.stringify(status));
  assert.equal(status.platform, 'darwin');

  // No plaintext copy: the secure store answered, so nothing is written to disk.
  const credentialFiles = fs.existsSync(path.join(os.homedir(), '.jsn'))
    ? fs.readdirSync(path.join(os.homedir(), '.jsn'), { recursive: true }).filter(name => String(name).includes('credentials'))
    : [];
  assert.deepEqual(credentialFiles, []);

  store.deleteCredentials(instance, 'fixture');
  assert.equal(store.loadCredentials(instance, 'fixture'), null);
});

test('the Keychain item is discoverable by the documented service and account', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-keychain-item-'));
  const keychain = path.join(dir, 'jsn-test.keychain-db');
  const password = 'jsn-test-keychain';
  const original = currentDefaultKeychain();
  security(['create-keychain', '-p', password, keychain]);
  security(['unlock-keychain', '-p', password, keychain]);
  security(['default-keychain', '-s', keychain]);
  security(['list-keychains', '-s', keychain]);
  t.after(() => {
    if (original) { try { security(['default-keychain', '-s', original]); } catch { /* best effort */ } }
    try { security(['delete-keychain', keychain]); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { keychainStore } = await import('../src/auth/darwin-keychain.js');
  keychainStore('fixture@https_example.service-now.com', '{"probe":true}');
  const item = security(['find-generic-password', '-s', 'servicenow-cli', '-a', 'fixture@https_example.service-now.com', '-w']);
  assert.equal(item.trim(), '{"probe":true}');
});
