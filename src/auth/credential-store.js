import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { globalConfigDir } from '../config.js';

// ─── Credential key helpers ───

/**
 * Sanitize an instance URL into a filesystem/arg-safe key part.
 *
 * Whitelist approach (issue #143 findings #2/#3): first map the `://`
 * protocol separator to `_` exactly as the Go version's encoding does
 * (so existing keyring keys like `https_dev437538.service-now.com` keep
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

function credentialsFilePath(key) {
  const dir = path.join(globalConfigDir(), 'credentials');
  // Match Go's filename encoding: replace :// and / and : with _
  const filename = key + '.json';
  return path.join(dir, filename);
}

function credentialsPath(key) {
  const filePath = credentialsFilePath(key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return filePath;
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
      auth_source: ['oauth', 'env_token', 'env_basic', undefined].includes(parsed.auth_source)
        ? (parsed.auth_method === 'gck' ? 'gck' : 'keyring')
        : parsed.auth_source,
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
  try {
    const data = fs.readFileSync(credentialsFilePath(key), 'utf-8');
    const creds = JSON.parse(data);
    return {
      ...creds,
      auth_source: ['oauth', 'env_token', 'env_basic', undefined].includes(creds.auth_source)
        ? (creds.auth_method === 'gck' ? 'gck' : 'file')
        : creds.auth_source,
    };
  } catch {
    return null;
  }
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
  // Try keyring first, fall back to file
  if (!keyringStore(key, creds)) {
    fs.writeFileSync(credentialsPath(key), JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
}

/**
 * Delete credentials for an instance keyed by <username>@<instance>.
 */
export function deleteCredentials(instance, username, injectedStore) {
  if (injectedStore) return injectedStore.delete(instance, username);
  const key = username ? credKey(instance, username) : credKey(instance);
  keyringDelete(key);
  try {
    fs.unlinkSync(credentialsPath(key));
  } catch {
    // ignore
  }
}

export const defaultCredentialStore = {
  load: loadCredentials,
  save: saveCredentials,
  delete: deleteCredentials,
};

