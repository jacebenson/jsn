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
const keychains = (output) => String(output).split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);

// The test keychain becomes the user's default and heads their search list, and t.after puts back
// what it found before deleting it: on a developer's Mac, replacing the list hides login.keychain
// from every app (gh, browsers, password managers) until it is restored by hand.
function throwawayKeychain(t, prefix, run = security) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keychain = path.join(dir, 'jsn-test.keychain-db');
  const password = 'jsn-test-keychain';
  // A hosted runner can have no default keychain at all; there is then no default to restore.
  let original = null;
  try { [original = null] = keychains(run(['default-keychain', '-d', 'user'])); } catch { /* none */ }
  const searchList = keychains(run(['list-keychains', '-d', 'user']));
  t.after(() => {
    try { run(['list-keychains', '-d', 'user', '-s', ...searchList]); } catch { /* best effort */ }
    if (original) { try { run(['default-keychain', '-d', 'user', '-s', original]); } catch { /* best effort */ } }
    try { run(['delete-keychain', keychain]); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  run(['create-keychain', '-p', password, keychain]);
  run(['unlock-keychain', '-p', password, keychain]);
  run(['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
  run(['default-keychain', '-d', 'user', '-s', keychain]);
  return keychain;
}

test('Keychain stores, reads back, probes and deletes a credential', { skip }, async (t) => {
  const keychain = throwawayKeychain(t, 'jsn-keychain-');
  security(['set-keychain-settings', '-lut', '21600', keychain]);

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
  throwawayKeychain(t, 'jsn-keychain-item-');

  const { keychainStore } = await import('../src/auth/darwin-keychain.js');
  keychainStore('fixture@https_example.service-now.com', '{"probe":true}');
  const item = security(['find-generic-password', '-s', 'servicenow-cli', '-a', 'fixture@https_example.service-now.com', '-w']);
  assert.equal(item.trim(), '{"probe":true}');
});

// Runs everywhere: a recording stand-in for /usr/bin/security proves the throwaway keychain gives
// back the default and search list it found. The real round trips above cannot show it, because a
// CI runner's keychains are thrown away with the runner.
test('the throwaway keychain puts back the default keychain and search list it found', async (t) => {
  const login = '/Users/fixture/Library/Keychains/login.keychain-db';
  const system = '/Library/Keychains/System.keychain';
  const replies = { 'default-keychain -d user': `    "${login}"\n`, 'list-keychains -d user': `    "${login}"\n    "${system}"\n` };
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return replies[args.join(' ')] ?? ''; };
  let keychain;
  await t.test('set up and torn down', (st) => { keychain = throwawayKeychain(st, 'jsn-keychain-stub-', run); });
  assert.deepEqual(calls, [
    'default-keychain -d user',
    'list-keychains -d user',
    `create-keychain -p jsn-test-keychain ${keychain}`,
    `unlock-keychain -p jsn-test-keychain ${keychain}`,
    `list-keychains -d user -s ${keychain} ${login} ${system}`,
    `default-keychain -d user -s ${keychain}`,
    `list-keychains -d user -s ${login} ${system}`,
    `default-keychain -d user -s ${login}`,
    `delete-keychain ${keychain}`,
  ]);
});
