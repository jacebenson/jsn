import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { globalConfigDir } from '../config.js';

// ─── Credential key helpers ───

/**
 * Sanitize an instance URL into a filesystem/arg-safe key part.
 *
 * Whitelist approach (issue #143 findings #2/#3): first map the `://`
 * protocol separator to `_` exactly as the Go version's encoding does
 * (so existing keyring keys like `https_example.service-now.com` keep
 * matching), then drop everything outside [a-zA-Z0-9._-]. Blacklist
 * stripping of just `/` and `:` left quotes, `$()`, backticks, `;`,
 * spaces, and backslashes — which broke out of double-quoted shell args
 * in keyring calls and, on Windows, out of path.join() credential dirs.
 */
export function sanitizeKeyPart(instance) {
  return instance.replace(/:\/\//g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Build a compound key for credential storage: <username>@<instance>
 * When username is omitted (legacy), just the normalized instance URL is used.
 */
export function credKey(instance, username) {
  const normalized = sanitizeKeyPart(instance);
  if (!username) return normalized;
  return `${username.replace(/[^a-zA-Z0-9._@-]/g, '_')}@${normalized}`;
}

// Keychain constants — same as Go version (internal/auth/store.go)
const KEYRING_SERVICE = 'servicenow-cli';
const KEYRING_ATTR_SERVICE = 'service';
const KEYRING_ATTR_USERNAME = 'username';

// Only this process environment can authorize portable plaintext storage.
const PLAINTEXT_ENV = 'JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE';
function plaintextAllowed() { return process.env[PLAINTEXT_ENV] === '1'; }
function storageError(message) {
  const error = new Error(message);
  error.code = 'credential_storage_error';
  return error;
}
let plaintextWarningShown = false;
function warnPlaintext() {
  if (plaintextWarningShown) return;
  plaintextWarningShown = true;
  process.stderr.write('Warning: plaintext credential storage explicitly enabled for this process; credentials are portable and backups can expose them.\n');
}
function refusal() {
  return storageError(`Secure credential storage unavailable or readback failed. Unlock/install secret-tool and retry. Existing plaintext credentials are preserved; to use or migrate them on a headless host, explicitly set ${PLAINTEXT_ENV}=1 for this process. Never commit or share credential files.`);
}

// Validate broad ancestors without chmod: only the leaf secret directory must
// be private. Root-owned sticky temporary ancestors are permitted, not leaves.
function checkPath(target, directory, privateMode = false) {
  const stat = fs.lstatSync(target);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (uid !== undefined && stat.uid !== uid && !(directory && !privateMode && stat.uid === 0)) ||
      (!directory && stat.nlink !== 1) ||
      (privateMode ? (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) :
        ((stat.mode & 0o022) !== 0 && !(directory && stat.uid === 0 && (stat.mode & 0o1000))))) {
    throw storageError('Unsafe credential/PKCE path: require owned regular 0600 files and private 0700 secret directories; reject symlinks, links and writable ancestors. Repair or move the path manually, then retry.');
  }
  return stat;
}
function privateStatePath(kind, key, create = false) {
  if (!['credentials', 'pkce'].includes(kind) || !/^[a-zA-Z0-9._@-]+$/.test(key) || key === '.' || key === '..') {
    throw storageError('Invalid credential/PKCE storage key.');
  }
  // Resolve once so traversal, leaf comparison and IO share the same path,
  // including when the configured XDG directory is relative.
  const dir = path.resolve(globalConfigDir(), kind);
  const parts = dir.split(path.sep).filter(Boolean);
  let current = path.parse(dir).root;
  for (const part of parts) {
    current = path.join(current, part);
    try { checkPath(current, true, current === dir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return path.join(dir, key + '.json');
      fs.mkdirSync(current, { mode: 0o700 });
      checkPath(current, true, current === dir);
    }
  }
  const file = path.join(dir, key + '.json');
  try { checkPath(file, false, true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
export function readPrivateState(kind, key) {
  const file = privateStatePath(kind, key);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = checkPath(file, false, true);
    const opened = fs.fstatSync(fd);
    if (before.ino !== opened.ino || before.dev !== opened.dev) throw storageError('Credential/PKCE path changed while opening.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'credential_storage_error') throw error;
    throw storageError('Unable to read credential/PKCE state safely; original file preserved.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function writePrivateState(kind, key, value) {
  const file = privateStatePath(kind, key, true);
  const temp = path.join(path.dirname(file), `.pending-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    privateStatePath(kind, key);
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function removePrivateState(kind, key) {
  const file = privateStatePath(kind, key);
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// ─── Keyring via secret-tool (libsecret, same backend as Go's go-keyring) ───

function keyringLookup(key) {
  try {
    // execFileSync with an arg array — no shell, so `key` can never
    // break out into command injection (issue #143 finding #2).
    const result = execFileSync(
      'secret-tool',
      ['lookup', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }
    );
    const trimmed = result.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    // Spread all fields from keyring first, then normalize known fields
    // so username, password, and other extras are preserved.
    return {
      ...parsed,
      auth_method: parsed.auth_method || 'oauth',
      access_token: parsed.access_token || parsed.AccessToken || '',
      refresh_token: parsed.refresh_token || parsed.RefreshToken || '',
      expires_at: parsed.expires_at || parsed.ExpiresAt || 0,
      created_at: parsed.created_at || parsed.CreatedAt || 0,
      auth_source: parsed.auth_method === 'gck' ? 'gck' : 'keyring',
    };
  } catch {
    return null;
  }
}

function keyringStore(key, creds) {
  try {
    execFileSync(
      'secret-tool',
      ['store', `--label=Password for '${key}' on '${KEYRING_SERVICE}'`,
        KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['pipe', 'ignore', 'ignore'], input: JSON.stringify(creds) }
    );
    return true;
  } catch {
    return false;
  }
}

function storeVerified(key, creds) {
  if (!keyringStore(key, creds)) return false;
  try {
    const value = execFileSync('secret-tool',
      ['lookup', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return isDeepStrictEqual(JSON.parse(value), JSON.parse(JSON.stringify(creds)));
  } catch { return false; }
}

function keyringDelete(key) {
  try {
    execFileSync(
      'secret-tool',
      ['clear', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: 'ignore' }
    );
  } catch {
    // ignore
  }
}

// ─── File-based storage (fallback) ───

/**
 * Load credentials for an instance keyed by <username>@<instance>.
 * When username is omitted (legacy configs without profile user), uses
 * bare instance key for lookup.
 */
export function loadCredentials(instance, username, injectedStore) {
  if (injectedStore) return injectedStore.load(instance, username);
  const key = username ? credKey(instance, username) : credKey(instance);
  const keyringCreds = keyringLookup(key);
  if (keyringCreds) {
    return {
      ...keyringCreds,
      auth_source: keyringCreds.auth_source || (keyringCreds.auth_method === 'gck' ? 'gck' : 'keyring'),
    };
  }
  const file = privateStatePath('credentials', key);
  if (!fs.existsSync(file)) return null;
  // Reads (including local status) never persist or migrate credentials. A
  // subsequent explicit login/save or token refresh performs verified retirement.
  if (!plaintextAllowed()) throw refusal();
  warnPlaintext();
  const creds = readPrivateState('credentials', key);
  return creds ? { ...creds, auth_source: 'file' } : null;
}

/**
 * Save credentials for an instance.
 * Uses <username>@<instance> key when username is available.
 */
export function saveCredentials(instance, creds, username, injectedStore) {
  if (injectedStore) {
    creds.last_seen = creds.last_seen || Math.floor(Date.now() / 1000);
    return injectedStore.save(instance, creds, username);
  }
  const key = username ? credKey(instance, username) : credKey(instance);
  // Stamp last_seen on every credential save
  creds.last_seen = creds.last_seen || Math.floor(Date.now() / 1000);
  if (storeVerified(key, creds)) {
    // Retire only this identity, and only after exact secure-store readback.
    removePrivateState('credentials', key);
    return;
  }
  if (!plaintextAllowed()) throw refusal();
  warnPlaintext();
  writePrivateState('credentials', key, creds);
}

/**
 * Delete credentials for an instance keyed by <username>@<instance>.
 */
export function deleteCredentials(instance, username, injectedStore) {
  if (injectedStore) return injectedStore.delete(instance, username);
  const key = username ? credKey(instance, username) : credKey(instance);
  keyringDelete(key);
  removePrivateState('credentials', key);
}

export const defaultCredentialStore = {
  load: loadCredentials,
  save: saveCredentials,
  delete: deleteCredentials,
};

