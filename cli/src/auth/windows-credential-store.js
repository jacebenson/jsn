import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-credential-store.ps1', import.meta.url));
const reasons = {
  unsupported: 'Windows PowerShell 5.1 or PowerShell 7+ on Windows is required.',
  capability: 'PowerShell FullLanguage, Add-Type and the Windows Credential Manager native API must be permitted by system policy.',
  policy: 'PowerShell execution policy explicitly restricts embedded credential operations. Ask your administrator for an approved storage route; no alternate host or plaintext fallback is selected automatically.',
  oversized: 'Credential exceeds the Windows Credential Manager single-entry limit (2560 UTF-8 bytes); existing credentials were not replaced.',
  native: 'Windows Credential Manager operation failed; check vault access and system policy.',
};
const stages = new Set([
  'host_check', 'language_mode', 'machine_policy_query', 'user_policy_query',
  'process_policy_query', 'current_user_policy_query', 'local_machine_policy_query',
  'input_encoding', 'output_encoding', 'native_compilation', 'request_decode',
  'native_read', 'native_write', 'native_delete',
]);

// Closed vocabulary for credential storage failures. Every storage error
// carries one of these so callers can tell an unavailable backend, an invalid
// secure entry, a failed readback and a deliberately blocked legacy plaintext
// file apart instead of seeing the one generic backend message.
export const STORAGE_CLASSIFICATIONS = Object.freeze([
  'plaintext_requires_recovery',
  'secure_storage_unavailable',
  'secure_readback_failed',
  'malformed_secure_entry',
  'storage_path_unsafe',
  'invalid_storage_key',
]);
export const STORAGE_RECOVERY = Object.freeze({
  plaintext_requires_recovery: 'Run `jsn auth login --profile <name>` to sign in again; the verified secure save retires the old credential file.',
  secure_storage_unavailable: 'Restore the OS credential store for this account, then run `jsn auth login --profile <name>` to sign in again. Existing credential files are preserved.',
  secure_readback_failed: 'Run `jsn auth login --profile <name>` to sign in again and verify secure storage. Existing credential files are preserved.',
  malformed_secure_entry: 'Run `jsn auth login --profile <name>` to replace the unusable secure entry with fresh credentials. Existing credential files are preserved.',
  storage_path_unsafe: 'Repair or move the credential path manually, then run `jsn auth login --profile <name>` to sign in again.',
  invalid_storage_key: 'Select a profile whose username and instance produce a valid credential key, then run `jsn auth login --profile <name>`.',
});
function failure(reason, stage) {
  const safeStage = stages.has(stage) ? stage : undefined;
  const diagnostic = safeStage ? ` Stage: ${safeStage}.` : '';
  const error = new Error(`Secure credential storage unavailable or readback failed. ${reason}${diagnostic} Existing plaintext credentials are preserved. No plaintext fallback is enabled automatically.`);
  error.code = 'credential_storage_error';
  error.classification = 'secure_storage_unavailable';
  error.recovery = STORAGE_RECOVERY.secure_storage_unavailable;
  if (safeStage) error.storageStage = safeStage;
  return error;
}

/**
 * Every Windows Credential Manager operation costs one PowerShell launch: a process startup
 * and compilation cost, dominated by process start and the
 * Add-Type compilation of the native wrapper. One command asks for the same
 * identity repeatedly — `auth status` reads each profile four or five times —
 * so reads are cached for this process only.
 *
 * The cache holds raw credential JSON, never mutable parsed objects, so a caller
 * that mutates its copy cannot corrupt a later read. Writes and deletes through
 * this module invalidate the identity before the native operation, so a failed
 * write can never leave a stale value readable, and every write readback is a
 * fresh native read. Nothing is persisted: the cache dies with the process.
 */
const READ_CACHE_LIMIT = 256;
let readCaches = new WeakMap();
function cacheFor(run) {
  if (!readCaches.has(run)) readCaches.set(run, new Map());
  return readCaches.get(run);
}
function cacheRead(readCache, key, value) {
  if (readCache.size >= READ_CACHE_LIMIT && !readCache.has(key)) {
    readCache.delete(readCache.keys().next().value);
  }
  readCache.set(key, value);
}
function invalidateRead(_key, run) {
  // Credential Manager targets are case-insensitive. Clear all observations on
  // mutation rather than approximating Windows Unicode comparison in JS.
  cacheFor(run).clear();
}
// Tests and callers that observed a value the vault did not confirm drop it.
export function invalidateWindowsCredential(key, run = execFileSync) { invalidateRead(key, run); }
// Tests may start from a known cache; production never calls this.
export function resetWindowsCredentialCache() { readCaches = new WeakMap(); }

const MAX_BATCH = 64;
const target = (key) => `servicenow-cli:${key}`;

/**
 * One PowerShell launch, with the documented host discovery rule: only an
 * unavailable host (ENOENT) or an explicitly unsupported host/version may try
 * the other executable. Policy, capability and native denial never retry.
 */
function invoke(request, run) {
  const input = JSON.stringify(request);
  let command;
  try {
    // Trusted installed code only. Command text is identical for every request;
    // neither request data nor a caller-supplied script path enters the source.
    // EncodedCommand is UTF-16LE on both supported PowerShell hosts.
    command = Buffer.from(readFileSync(helper, 'utf8'), 'utf16le').toString('base64');
  } catch { throw failure(reasons.capability); }
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    const env = { ...process.env };
    if (executable === 'powershell.exe') {
      // PS7 normalizes PSModulePath only for a directly launched PS5.1 child,
      // not PS7 -> Node -> PS5.1. Let Windows PowerShell construct its own
      // default module paths instead of autoloading incompatible PS7 modules.
      // Preserve every other variable, including execution-policy preferences.
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    }
    let output;
    try {
      output = run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
        input, env, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Never expose child stdout/stderr, exception message or input. In
      // particular policy/parser errors can quote the source or request.
      if (error.code === 'ENOENT') continue;
      throw failure(reasons.capability);
    }
    let response;
    try { response = JSON.parse(output.replace(/^\uFEFF/, '')); }
    catch { throw failure(reasons.capability); }
    // Only an explicit unsupported host/version (or ENOENT above) permits
    // discovery of another host. Never retry policy/capability/native denial.
    if (response?.status === 'error' && response.reason === 'unsupported') continue;
    return response;
  }
  throw failure(reasons.unsupported);
}

// A process boundary injectable for offline tests; production never accepts a
// script/executable override from configuration or credential content.
export function windowsCredentialOperation(operation, key, value, run = execFileSync) {
  if (!['read', 'write', 'delete'].includes(operation)) throw failure(reasons.native);
  if (operation === 'write' && Buffer.byteLength(value, 'utf8') > 2560) throw failure(reasons.oversized);
  // Invalidate before the native call: a write that lands but fails readback, or
  // a delete that partially succeeds, must not leave a cached value readable.
  const readCache = cacheFor(run);
  if (operation !== 'read') invalidateRead(key, run);
  else if (readCache.has(key)) return readCache.get(key);
  const response = invoke({ operation, target: target(key), username: key, value }, run);
  if (response?.status === 'missing' && operation !== 'write') {
    if (operation === 'read') cacheRead(readCache, key, null);
    return null;
  }
  if (response?.status !== 'ok') throw failure(reasons[response?.reason] || reasons.native, response?.stage);
  if (operation === 'read') {
    if (typeof response.value !== 'string') throw failure(reasons.native);
    cacheRead(readCache, key, response.value);
    return response.value;
  }
  // A write is never cached: the caller's verified readback must hit the vault.
  return true;
}

/**
 * Read several identities, launching PowerShell at most once for the misses.
 * Cached identities cost nothing; a single miss reuses the plain read protocol.
 * Returns a Map keyed by identity with the stored value or null when absent.
 */
export function windowsCredentialRead(keys, run = execFileSync) {
  const result = new Map();
  if (!Array.isArray(keys)) throw failure(reasons.native);
  const unique = [...new Set(keys)];
  if (!unique.length) return result;
  for (const key of unique) {
    if (typeof key !== 'string' || !key) throw failure(reasons.native);
  }
  const readCache = cacheFor(run);
  for (const key of unique) if (readCache.has(key)) result.set(key, readCache.get(key));
  const pending = unique.filter(key => !result.has(key));
  // Validate every response before publishing any observation to the cache.
  // Keep results separately so cache eviction cannot turn a large read into
  // fabricated misses, including requests larger than READ_CACHE_LIMIT.
  const observations = new Map();
  for (let start = 0; start < pending.length; start += MAX_BATCH) {
    const chunk = pending.slice(start, start + MAX_BATCH);
    const single = chunk.length === 1;
    const response = invoke(single
      ? { operation: 'read', target: target(chunk[0]), username: chunk[0] }
      : { operation: 'read_many', targets: chunk.map(target) }, run);
    if (single && response?.status === 'missing') {
      observations.set(chunk[0], null);
      continue;
    }
    if (response?.status !== 'ok') throw failure(reasons[response?.reason] || reasons.native, response?.stage);
    if (single && typeof response.value !== 'string') throw failure(reasons.native);
    const values = single ? [{ target: target(chunk[0]), value: response.value }] : response.values;
    if (!Array.isArray(values) || values.length !== chunk.length) throw failure(reasons.native);
    for (let index = 0; index < chunk.length; index++) {
      const entry = values[index];
      if (!entry || entry.target !== target(chunk[index])) throw failure(reasons.native);
      if (entry.value !== null && typeof entry.value !== 'string') throw failure(reasons.native);
      observations.set(chunk[index], entry.value);
    }
  }
  for (const [key, value] of observations) cacheRead(readCache, key, value);
  for (const key of unique) result.set(key, observations.has(key) ? observations.get(key) : result.get(key));
  return new Map(unique.map(key => [key, result.get(key)]));
}

// Go v1 used normalizeURL(instance), not the sanitized file name. Only
// username-less legacy profiles may consult that identity: never borrow an
// instance-wide credential for a different named account.
export function legacyWindowsKey(instance) {
  const trimmed = instance.replace(/\/$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
