/**
 * macOS Keychain backend (issue #571).
 *
 * The store routed every non-Windows platform through Linux's `secret-tool`, so
 * a browser login on macOS authenticated and then failed to store the
 * credential. macOS ships `/usr/bin/security`, which reads and writes generic
 * passwords in the user's default keychain — no native module, no new
 * dependency, and the same process-boundary shape as the Windows and libsecret
 * backends.
 *
 * Item layout: service `servicenow-cli`, account `<username>@<instance>` (the
 * same credential key the other backends use), password = the credential JSON.
 */
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'servicenow-cli';
const SECURITY = '/usr/bin/security';
const TIMEOUT_MS = 5000;
// errSecItemNotFound: the item does not exist, which is a miss, not a failure.
const ITEM_NOT_FOUND = 44;

/**
 * Write (or replace) one credential item.
 *
 * `-w <value>` puts the secret in this process's argument list for the life of
 * the call. Darwin exposes arguments only to the same user, and the alternative
 * (`security -i` command lines on stdin) has its own quoting hazards, so the
 * documented form is used and the exposure is stated here rather than hidden.
 */
export function keychainStore(key, value) {
  execFileSync(SECURITY, ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', key, '-w', value],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: TIMEOUT_MS });
}

/** Read one credential item, or null when it does not exist. */
export function keychainRead(key) {
  try {
    return execFileSync(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key, '-w'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: TIMEOUT_MS }).trim();
  } catch (error) {
    if (error?.status === ITEM_NOT_FOUND) return null;
    throw error;
  }
}

/** Delete one credential item. Returns false when there was nothing to delete. */
export function keychainDelete(key) {
  try {
    execFileSync(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key],
      { stdio: 'ignore', timeout: TIMEOUT_MS });
    return true;
  } catch (error) {
    if (error?.status === ITEM_NOT_FOUND) return false;
    throw error;
  }
}
