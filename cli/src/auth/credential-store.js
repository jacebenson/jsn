import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { globalConfigDir } from '../config.js';
import { windowsCredentialOperation, windowsCredentialRead, invalidateWindowsCredential, legacyWindowsKey, STORAGE_CLASSIFICATIONS, STORAGE_RECOVERY } from './windows-credential-store.js';
import { keychainDelete, keychainRead, keychainStore } from './darwin-keychain.js';

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
export const PLAINTEXT_ENV = 'JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE';
// A probe must never hang a login behind a wedged keyring daemon.
const PROBE_TIMEOUT_MS = 5000;
function plaintextAllowed() { return process.env[PLAINTEXT_ENV] === '1'; }
function storageError(message, classification = 'secure_storage_unavailable') {
  const safe = STORAGE_CLASSIFICATIONS.includes(classification) ? classification : 'secure_storage_unavailable';
  const error = new Error(message);
  error.code = 'credential_storage_error';
  error.classification = safe;
  error.recovery = STORAGE_RECOVERY[safe];
  return error;
}
/**
 * The plaintext warning belongs to the moment a credential is stored, not to
 * every command that reads one back.
 *
 * It used to fire on the read path too, which meant once per process, which
 * means once per command — every read, list, or search printed it on stderr.
 * That is noise in a terminal and permanently in an agent transcript, and it
 * told nobody anything they could act on at that moment. The storage mode is
 * reported instead by `jsn auth status`, and the warning is emitted when the
 * choice is actually made (login, setup, token save).
 */
let plaintextWarningShown = false;
function warnPlaintext() {
  if (plaintextWarningShown) return;
  plaintextWarningShown = true;
  process.stderr.write('Warning: plaintext credential storage explicitly enabled for this process; credentials are portable and backups can expose them.\n');
}
function refusal(classification = 'secure_storage_unavailable') {
  const repair = process.platform === 'win32'
    ? 'Windows Credential Manager requires Windows PowerShell 5.1 or PowerShell 7+ with FullLanguage/Add-Type and native API access allowed by policy.'
    : process.platform === 'darwin'
      ? 'Unlock the login keychain (Keychain Access, or `security unlock-keychain`) and retry.'
      : 'Unlock/install secret-tool and retry. On Debian/Ubuntu (including WSL), run: sudo apt install libsecret-tools gnome-keyring. If already installed, ensure a running, unlocked keyring is available in your D-Bus session.';
  return storageError(`Secure credential storage unavailable or readback failed. ${repair} Existing plaintext credentials are preserved. No plaintext fallback is enabled automatically. To explicitly allow unencrypted credential files, set ${PLAINTEXT_ENV}=1 in the environment of each jsn process that needs them. Only do this if your security policy permits it; backups can expose credentials.`, classification);
}

/**
 * A stored plaintext file is not a storage failure and must never be reported
 * as one: the secure backend may be perfectly healthy. Reading it needs the
 * exact process-local opt-in, which a status --local read never has, so the
 * file is left untouched and the recovery is a fresh verified login.
 */
function plaintextBlocked() {
  return storageError(
    'Existing plaintext credentials are preserved; this process cannot read them and no plaintext fallback is enabled automatically. ' +
    STORAGE_RECOVERY.plaintext_requires_recovery,
    'plaintext_requires_recovery',
  );
}
function readbackFailure() {
  return storageError(
    `Secure credential storage unavailable or readback failed. The secure entry could not be verified after writing. Existing plaintext credentials are preserved. No plaintext fallback is enabled automatically. To explicitly allow unencrypted credential files, set ${PLAINTEXT_ENV}=1 in the environment of each jsn process that needs them. Only do this if your security policy permits it; backups can expose credentials.`,
    'secure_readback_failed',
  );
}
function malformedSecureEntry() {
  return storageError(
    `Stored secure credential entry is malformed and cannot be used. ${STORAGE_RECOVERY.malformed_secure_entry}`,
    'malformed_secure_entry',
  );
}

// Validate broad ancestors without chmod: only the leaf secret directory must
// be private. Root-owned sticky temporary ancestors are permitted, not leaves.
function checkPath(target, directory, privateMode = false) {
  const stat = fs.lstatSync(target);
  // Windows stat mode/uid fields do not describe DACL access. Retain type,
  // symlink/junction and hardlink checks there; do not claim POSIX privacy.
  // Windows files inherit their parent's ACL; see the documented storage policy.
  const posix = process.platform !== 'win32';
  const uid = posix ? process.getuid?.() : undefined;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (uid !== undefined && stat.uid !== uid && !(directory && !privateMode && stat.uid === 0)) ||
      (!directory && stat.nlink !== 1) ||
      (posix && (privateMode ? (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) :
        ((stat.mode & 0o022) !== 0 && !(directory && stat.uid === 0 && (stat.mode & 0o1000)))))) {
    throw storageError(posix
      ? 'Unsafe credential/PKCE path: require owned regular 0600 files and private 0700 secret directories; reject symlinks, links and writable ancestors. Repair or move the path manually, then retry.'
      : 'Unsafe credential/PKCE path: require regular files/directories without symlinks, junctions or hard links. Windows ACL privacy must be managed separately.', 'storage_path_unsafe');
  }
  return stat;
}
// Enumerate below the parsed root: a drive/UNC prefix is not a component.
export function privateStateDirectories(dir, pathAPI = path) {
  const root = pathAPI.parse(dir).root;
  let current = root;
  return dir.slice(root.length).split(pathAPI.sep).filter(Boolean).map(part => {
    current = pathAPI.join(current, part);
    return current;
  });
}
function privateStatePath(kind, key, create = false) {
  if (!['credentials', 'pkce'].includes(kind) || !/^[a-zA-Z0-9._@-]+$/.test(key) || key === '.' || key === '..') {
    throw storageError('Invalid credential/PKCE storage key.', 'invalid_storage_key');
  }
  // Resolve once so traversal, leaf comparison and IO share the same path,
  // including when the configured XDG directory is relative.
  const dir = path.resolve(globalConfigDir(), kind);
  for (const current of privateStateDirectories(dir)) {
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
    if (before.ino !== opened.ino || before.dev !== opened.dev) throw storageError('Credential/PKCE path changed while opening.', 'storage_path_unsafe');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'credential_storage_error') throw error;
    throw storageError('Unable to read credential/PKCE state safely; original file preserved.', 'storage_path_unsafe');
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

/**
 * Preflight: can this process store a credential right now?
 *
 * Setup and login used to collect six answers and finish the network login
 * before discovering that a headless host has no reachable keyring. The probe
 * runs a real store/readback/clear round trip on a throwaway key, so "looks
 * installed" is never mistaken for "works in this session" (a locked keyring
 * and a missing D-Bus session both pass a binary-existence check).
 *
 * @param {{platform?: string}} [options]
 * @returns {{available: boolean, platform: string, reason?: string,
 *   plaintext_allowed: boolean, repair?: object}}
 */
export function credentialStorageStatus({ platform = process.platform } = {}) {
  const plaintext_allowed = plaintextAllowed();
  const key = `jsn-storage-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  // The probe payload is the shape the store actually writes, so a stand-in
  // store that parses JSON behaves exactly like the real one.
  const payload = JSON.stringify({ probe: `probe-${crypto.randomBytes(8).toString('hex')}` });
  const result = (available, reason) => ({ available, platform, reason, plaintext_allowed, repair: available ? null : storageRepair(platform, reason) });
  // An explicit plaintext opt-in already answers "where does this go"; the
  // keyring is then optional, not required.
  if (plaintext_allowed) return { ...result(true, 'plaintext_storage_allowed'), mode: 'plaintext' };

  if (platform === 'win32') {
    try {
      windowsCredentialOperation('write', key, payload);
    } catch (error) {
      return result(false, 'windows_credential_manager_unavailable', error);
    }
    try {
      if (windowsCredentialOperation('read', key) !== payload) return result(false, 'windows_readback_failed');
      return result(true);
    } catch {
      return result(false, 'windows_readback_failed');
    } finally {
      try { windowsCredentialOperation('delete', key); } catch { /* best effort */ }
    }
  }

  if (platform === 'darwin') {
    const value = JSON.stringify({ probe: `probe-${crypto.randomBytes(8).toString('hex')}` });
    try {
      keychainStore(key, value);
    } catch {
      return result(false, 'keychain_unavailable');
    }
    try {
      const readback = keychainRead(key);
      return readback === value ? result(true) : result(false, 'keychain_readback_mismatch');
    } catch {
      return result(false, 'keychain_readback_failed');
    } finally {
      try { keychainDelete(key); } catch { /* best effort */ }
    }
  }

  try {
    execFileSync('secret-tool',
      ['store', `--label=JSN storage probe on '${KEYRING_SERVICE}'`,
        KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['pipe', 'ignore', 'pipe'], input: payload, timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    return result(false, error.code === 'ENOENT' ? 'secret_tool_missing' : 'keyring_unavailable');
  }
  try {
    const readback = execFileSync('secret-tool',
      ['lookup', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    return readback.trim() === payload ? result(true) : result(false, 'keyring_readback_mismatch');
  } catch {
    return result(false, 'keyring_readback_failed');
  } finally {
    try {
      execFileSync('secret-tool', ['clear', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    } catch { /* best effort */ }
  }
}

/** The exact commands and caveats for repairing an unusable credential store. */
export function storageRepair(platform = process.platform, reason = '') {
  if (platform === 'win32') {
    return {
      install: null,
      notes: ['Windows Credential Manager needs Windows PowerShell 5.1 or PowerShell 7+ with FullLanguage/Add-Type and native API access allowed by policy.',
        `If a policy blocks it, set ${PLAINTEXT_ENV}=1 for the session that runs jsn.`],
    };
  }
  const distro = linuxDistribution();
  const install = {
    'debian': 'sudo apt-get install -y libsecret-tools gnome-keyring',
    'fedora': 'sudo dnf install -y libsecret gnome-keyring',
    'arch': 'sudo pacman -S --needed libsecret gnome-keyring',
    'alpine': 'sudo apk add libsecret gnome-keyring',
  }[distro] || 'install libsecret (the secret-tool binary) with your package manager';
  const notes = [];
  if (platform === 'darwin') {
    notes.push('The login keychain did not accept a write: unlock it (Keychain Access, or `security unlock-keychain`), or run jsn in a session that can reach it.');
  } else if (reason === 'secret_tool_missing') {
    notes.push('secret-tool is not on PATH.');
  } else {
    notes.push('secret-tool is installed but the keyring did not accept a write in this session (no D-Bus session, or the keyring is locked).');
  }
  notes.push('A headless host usually has no unlocked keyring: run jsn inside a session that can unlock one, or opt into plaintext storage for this profile.');
  return { install, notes, distro };
}

function linuxDistribution() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const ids = [text.match(/^ID="?([^"\n]+)"?/m)?.[1], text.match(/^ID_LIKE="?([^"\n]+)"?/m)?.[1]].filter(Boolean).join(' ').toLowerCase();
    for (const name of ['debian', 'fedora', 'arch', 'alpine']) if (ids.includes(name)) return name;
  } catch { /* not a Linux host we can identify */ }
  return null;
}

/**
 * Preserve lazy legacy fallback: an unreadable legacy identity must not mask a
 * valid primary credential. Successful status priming still warms both reads.
 */
function windowsLookup(key, legacyKey) {
  return windowsCredentialOperation('read', key)
    ?? (legacyKey && legacyKey !== key ? windowsCredentialOperation('read', legacyKey) : null);
}

function keyringLookup(key, legacyKey) {
  let result;
  try {
    // execFileSync with an arg array — no shell, so `key` can never
    // break out into command injection (issue #143 finding #2).
    result = process.platform === 'win32'
      ? windowsLookup(key, legacyKey)
      : process.platform === 'darwin'
        ? keychainRead(key)
        : execFileSync(
        'secret-tool',
        ['lookup', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }
      );
  } catch (error) {
    // Preserve the existing process-local plaintext opt-in. Without it, a
    // platform backend failure is a refusal, not a missing entry.
    if (['win32', 'darwin'].includes(process.platform) && !plaintextAllowed()) {
      throw error?.code === 'credential_storage_error' ? error : refusal();
    }
    return null;
  }
  const trimmed = typeof result === 'string' ? result.trim() : result;
  if (!trimmed) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { throw malformedSecureEntry(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw malformedSecureEntry();
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
}

/**
 * Warm the Windows credential read for every identity a command is about to ask
 * for, in one PowerShell launch instead of one per field. `auth status` reads
 * each profile four or five times; unprimed that is a multi-second launch per
 * read on a managed Windows image.
 *
 * Nothing is required of other platforms, where a read is a few milliseconds.
 * A failed prime is not reported here: the following real read re-runs the
 * documented guards and raises its own actionable error.
 *
 * `run` is the injectable process boundary used by offline tests only.
 */
export function primeCredentialReads(identities = [], run) {
  if (process.platform !== 'win32') return;
  const keys = new Set();
  for (const identity of identities) {
    const instance = identity?.instance;
    if (!instance) continue;
    const username = identity.username;
    keys.add(username ? credKey(instance, username) : credKey(instance));
    if (!username) keys.add(legacyWindowsKey(instance));
  }
  if (!keys.size) return;
  try {
    if (run) windowsCredentialRead([...keys], run);
    else windowsCredentialRead([...keys]);
  } catch { /* reported by the next real read */ }
}

function keyringStore(key, creds) {
  if (process.platform === 'darwin') {
    try {
      keychainStore(key, JSON.stringify(creds));
      return true;
    } catch {
      return false;
    }
  }
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

// Returns 'ok', 'readback_failed' (backend accepted the write but the exact
// value did not come back) or 'unavailable' (no secure write happened).
function storeVerified(key, creds) {
  if (process.platform === 'win32') {
    const value = JSON.stringify(creds);
    windowsCredentialOperation('write', key, value);
    let readback;
    try { readback = windowsCredentialOperation('read', key); }
    catch (error) { throw error.code === 'credential_storage_error' ? error : refusal(); }
    let parsed;
    try { parsed = typeof readback === 'string' ? JSON.parse(readback) : null; }
    catch { parsed = null; }
    if (parsed && isDeepStrictEqual(parsed, JSON.parse(value))) return 'ok';
    // The vault does not hold what this process wrote: drop the observation so
    // the next read reports the vault, not this attempt's readback.
    invalidateWindowsCredential(key);
    return 'readback_failed';
  }
  if (process.platform === 'darwin') {
    const value = JSON.stringify(creds);
    if (!keyringStore(key, creds)) return 'unavailable';
    let readback;
    try { readback = keychainRead(key); } catch { throw refusal(); }
    try {
      return readback && isDeepStrictEqual(JSON.parse(readback), JSON.parse(value)) ? 'ok' : 'readback_failed';
    } catch { return 'readback_failed'; }
  }
  if (!keyringStore(key, creds)) return 'unavailable';
  try {
    const value = execFileSync('secret-tool',
      ['lookup', KEYRING_ATTR_SERVICE, KEYRING_SERVICE, KEYRING_ATTR_USERNAME, key],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return isDeepStrictEqual(JSON.parse(value), JSON.parse(JSON.stringify(creds))) ? 'ok' : 'readback_failed';
  } catch { return 'readback_failed'; }
}

function keyringDelete(key) {
  if (process.platform === 'win32') {
    windowsCredentialOperation('delete', key);
    if (windowsCredentialOperation('read', key) !== null) throw refusal();
    return;
  }
  if (process.platform === 'darwin') {
    keychainDelete(key);
    if (keychainRead(key) !== null) throw refusal();
    return;
  }
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
  const keyringCreds = keyringLookup(key, !username ? legacyWindowsKey(instance) : undefined);
  if (keyringCreds) {
    return {
      ...keyringCreds,
      auth_source: keyringCreds.auth_source || (keyringCreds.auth_method === 'gck' ? 'gck' : 'keyring'),
    };
  }
  const file = privateStatePath('credentials', key);
  if (!fs.existsSync(file)) return null;
  // Reads (including local status) never persist, migrate, or open a legacy
  // plaintext file. A subsequent explicit login/save performs verified
  // retirement; the blocked file keeps its exact bytes until then.
  if (!plaintextAllowed()) throw plaintextBlocked();
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
  let status = 'unavailable';
  let secureFailure;
  try { status = storeVerified(key, creds); }
  catch (error) { secureFailure = error.code === 'credential_storage_error' ? error : refusal(); }
  if (status === 'ok') {
    // Retire only this identity, and only after exact secure-store readback.
    removePrivateState('credentials', key);
    return;
  }
  if (!plaintextAllowed()) throw secureFailure || (status === 'readback_failed' ? readbackFailure() : refusal());
  // Re-stamping last_seen after a successful call is bookkeeping, not a storage
  // decision. Warning on it put the message on every command again, which is
  // what this change is meant to stop; only a change to the secret material
  // (a real login or token refresh) is worth the warning.
  if (materialChanged(key, creds)) warnPlaintext();
  writePrivateState('credentials', key, creds);
}

/** True when the incoming credential material differs from what is on disk. */
function materialChanged(key, creds) {
  let previous;
  try { previous = readPrivateState('credentials', key); } catch { return true; }
  if (!previous) return true;
  const material = (value) => {
    // last_seen is bookkeeping; auth_source is derived by the loader and never
    // part of the stored secret.
    const { last_seen: _seen, auth_source: _source, ...rest } = value || {};
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return material(previous) !== material(creds);
}

/**
 * Delete credentials for an instance keyed by <username>@<instance>.
 */
export function deleteCredentials(instance, username, injectedStore) {
  if (injectedStore) return injectedStore.delete(instance, username);
  const key = username ? credKey(instance, username) : credKey(instance);
  keyringDelete(key);
  if (process.platform === 'win32' && !username) keyringDelete(legacyWindowsKey(instance));
  removePrivateState('credentials', key);
}

export const defaultCredentialStore = {
  load: loadCredentials,
  save: saveCredentials,
  delete: deleteCredentials,
  prime: primeCredentialReads,
};

