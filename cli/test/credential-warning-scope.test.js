// The plaintext warning belongs to the write that stores a secret, not to the
// bookkeeping save that re-stamps last_seen after every successful call.
// This file runs in its own process, so the module's once-per-process flag is
// unset and the assertions below are meaningful.
import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { saveCredentials, loadCredentials } from '../src/auth/credential-store.js';

const instance = 'https://synthetic.invalid';
const secret = { auth_method: 'oauth', access_token: 'first-token', refresh_token: 'first-refresh' };
let root, savedEnv, warnings;

beforeEach(() => {
  savedEnv = { ...process.env };
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jsn-warning-scope-'));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  // No keyring helper on PATH, so the secure store reports unavailable and the
  // explicit plaintext opt-in decides the write.
  process.env.PATH = path.join(root, 'bin');
  fs.mkdirSync(process.env.PATH, { mode: 0o700 });
  process.env.JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE = '1';
  warnings = [];
  mock.method(process.stderr, 'write', text => { warnings.push(String(text)); return true; });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

it('reading and re-stamping is silent; only a stored secret warns', () => {
  saveCredentials(instance, { ...secret }, 'fixture');
  assert.match(warnings.join(''), /portable.*backups/, 'storing the secret warns');

  const afterFirstSave = warnings.length;
  const loaded = loadCredentials(instance, 'fixture');
  assert.equal(loaded.auth_source, 'file');
  assert.equal(warnings.length, afterFirstSave, 'reading plaintext credentials is silent');

  saveCredentials(instance, { ...loaded, last_seen: Math.floor(Date.now() / 1000) + 60 }, 'fixture');
  assert.equal(warnings.length, afterFirstSave, 're-stamping last_seen is bookkeeping, not a storage decision');
});

it('later writes never repeat the warning', () => {
  // The module warns once per process, so this test tolerates a warning already
  // emitted by an earlier test in this file and asserts only that no further
  // copies appear.
  const before = warnings.length;
  saveCredentials(instance, { ...secret }, 'fixture');
  saveCredentials(instance, { ...secret, access_token: 'rotated-token' }, 'fixture');
  saveCredentials(instance, { ...secret, access_token: 'rotated-again' }, 'fixture');
  assert.ok(warnings.length - before <= 1, `warned ${warnings.length - before} more time(s)`);
  assert.equal(loadCredentials(instance, 'fixture').access_token, 'rotated-again');
});
