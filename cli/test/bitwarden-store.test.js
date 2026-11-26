// Bitwarden backend contract. The suite never touches a real vault: a `bw` shim
// speaks the documented CLI subset (status/get item/create item/edit item/delete
// item/encode) against a JSON file, and the adapter is exercised through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A developer's own BW_SESSION must never leak into these tests: the shim is the
// only vault they may touch.
delete process.env.BW_SESSION;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-bw-'));
const vault = path.join(dir, 'vault.json');
fs.writeFileSync(vault, JSON.stringify({ items: [] }));

// The shim is real code in test/support (no inline escaping); this launcher just
// points node at it with the vault file in the environment.
const launcher = `#!${process.execPath}\nimport(${JSON.stringify(new URL('./support/bw-shim.mjs', import.meta.url).href)});\n`;
fs.writeFileSync(path.join(dir, 'bw'), launcher, { mode: 0o755 });
process.env.JSN_BW_VAULT = vault;
process.env.JSN_BW_BIN = path.join(dir, 'bw');

const { bitwardenCredentialStore, bitwardenItemName, bitwardenStatus, parseCredentialNotes } =
  await import('../src/auth/bitwarden-store.js');

const instance = 'https://example.service-now.com';
const creds = { auth_method: 'oauth', access_token: 'a1', refresh_token: 'r1', expires_at: 99 };

test('without BW_SESSION the store refuses instead of hanging on a prompt', (t) => {
  const saved = process.env.BW_SESSION;
  delete process.env.BW_SESSION;
  t.after(() => { if (saved !== undefined) process.env.BW_SESSION = saved; });
  assert.throws(() => bitwardenCredentialStore.load(instance, 'fixture'), /BW_SESSION/);
  const status = bitwardenStatus();
  assert.equal(status.state, 'locked');
  assert.match(status.detail, /bw unlock --raw/);
});

test('save, load, overwrite and delete round trip through the vault', (t) => {
  process.env.BW_SESSION = 'session-token';
  t.after(() => { delete process.env.BW_SESSION; });

  bitwardenCredentialStore.save(instance, { ...creds }, 'fixture');
  const loaded = bitwardenCredentialStore.load(instance, 'fixture');
  assert.equal(loaded.access_token, 'a1');
  assert.equal(loaded.refresh_token, 'r1');

  bitwardenCredentialStore.save(instance, { ...creds, access_token: 'a2' }, 'fixture');
  assert.equal(bitwardenCredentialStore.load(instance, 'fixture').access_token, 'a2');
  const items = JSON.parse(fs.readFileSync(vault, 'utf8')).items;
  assert.equal(items.filter(item => item.name === bitwardenItemName(instance, 'fixture')).length, 1);

  bitwardenCredentialStore.save(instance, { ...creds, access_token: 'b1' }, 'other');
  assert.equal(bitwardenCredentialStore.load(instance, 'other').access_token, 'b1');

  bitwardenCredentialStore.delete(instance, 'fixture');
  assert.equal(bitwardenCredentialStore.load(instance, 'fixture'), null);
  assert.equal(bitwardenCredentialStore.load(instance, 'other').access_token, 'b1', 'deletion is per identity');
});

test('an item without a usable notes document reads as missing, not as garbage', () => {
  assert.equal(parseCredentialNotes({ notes: '' }), null);
  assert.equal(parseCredentialNotes({ notes: 'not json' }), null);
  assert.equal(parseCredentialNotes({ notes: '["array"]' }), null);
  assert.deepEqual(parseCredentialNotes({ notes: '{"a":1}' }), { a: 1 });
});

test('the item name is stable and prefixed', () => {
  assert.equal(bitwardenItemName('https://x.service-now.com/', 'me'), 'servicenow-cli:me@https://x.service-now.com');
  assert.equal(bitwardenItemName('https://x.service-now.com', null), 'servicenow-cli:https://x.service-now.com');
});

test('a profile selects the store, and an unknown name is a configuration error', async () => {
  const { credentialStoreFor } = await import('../src/auth.js');
  const { defaultCredentialStore } = await import('../src/auth/credential-store.js');
  assert.equal(credentialStoreFor(undefined), defaultCredentialStore, 'no field means the OS keyring');
  assert.equal(credentialStoreFor({}), defaultCredentialStore);
  assert.equal(credentialStoreFor({ credential_store: 'keyring' }), defaultCredentialStore);
  assert.equal(credentialStoreFor({ credential_store: 'bitwarden' }).load, bitwardenCredentialStore.load);
  assert.throws(() => credentialStoreFor({ credential_store: '1password' }), /Unknown credential_store/);
});
