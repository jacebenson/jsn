// OAuth 2.0 with PKCE authentication
// Credentials are stored in the OS keyring (shared with Go version via libsecret/secret-tool)
// Falls back to file-based storage when keyring is unavailable.
// Credentials are keyed by <username>@<instance> so different users on the
// same instance have separate credential slots.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { password as passwordPrompt } from '@inquirer/prompts';
import { globalConfigDir, normalizeInstanceURL } from './config.js';
import { errAuth } from './errors.js';

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
function credKey(instance, username) {
  const normalized = sanitizeKeyPart(instance);
  if (!username) return normalized;
  return `${username.replace(/[^a-zA-Z0-9._@-]/g, '_')}@${normalized}`;
}

// ─── PKCE state persistence (shared with Go version) ───

function pkceStatePath(instance) {
  const dir = path.join(globalConfigDir(), 'pkce');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = sanitizeKeyPart(instance) + '.json';
  return path.join(dir, filename);
}

function savePKCEState(instance, pkce) {
  const filePath = pkceStatePath(instance);
  fs.writeFileSync(filePath, JSON.stringify(pkce, null, 2), { mode: 0o600 });
}

function loadPKCEState(instance) {
  try {
    const data = fs.readFileSync(pkceStatePath(instance), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function removePKCEState(instance) {
  try {
    fs.unlinkSync(pkceStatePath(instance));
  } catch {
    // ignore
  }
}

const DEFAULT_OAUTH_CLIENT_ID = '543e5655f77746a28228c6009a599dfb';
const REDIRECT_URI = '/sdk-oauth.do';

// ─── Basic auth from environment variables ───
// SN_USERNAME / SN_PASSWORD — global credentials
// SN_<INSTANCE>_USERNAME / SN_<INSTANCE>_PASSWORD — instance-specific (e.g. SN_DEV328604_USERNAME)

function envVarName(instance) {
  // Normalize instance URL to an env-var-safe name
  // e.g. https://dev328604.service-now.com → DEV328604
  const host = instance.replace(/https?:\/\//, '').replace(/\/.*$/, '').replace(/\.service-now\.com.*/, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return host;
}

function getBasicAuthFromEnv(instance) {
  if (!instance) {
    // Try global env vars
    const username = process.env.SN_USERNAME;
    const password = process.env.SN_PASSWORD;
    if (username && password) return { auth_method: 'basic', username, password, auth_source: 'env_basic' };
    return null;
  }

  // Try instance-specific env vars first (e.g. SN_DEV328604_USERNAME)
  const host = envVarName(instance);
  const instanceUser = process.env[`SN_${host}_USERNAME`];
  const instancePass = process.env[`SN_${host}_PASSWORD`];
  if (instanceUser && instancePass) return { auth_method: 'basic', username: instanceUser, password: instancePass, auth_source: 'env_basic' };

  // Fall back to global env vars
  const globalUser = process.env.SN_USERNAME;
  const globalPass = process.env.SN_PASSWORD;
  if (globalUser && globalPass) return { auth_method: 'basic', username: globalUser, password: globalPass, auth_source: 'env_basic' };

  return null;
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

function getOAuthClientID() {
  return process.env.SERVICENOW_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { code_verifier: verifier, code_challenge: challenge, state };
}

function buildAuthURL(instanceURL, clientID, pkce) {
  const u = new URL('/oauth_auth.do', instanceURL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', pkce.state);
  u.searchParams.set('code_challenge', pkce.code_challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('scope', 'openid');
  u.searchParams.set('approval_prompt', 'force');
  return u.toString();
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
function loadCredentials(instance, username, injectedStore) {
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
function saveCredentials(instance, creds, username, injectedStore) {
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
function deleteCredentials(instance, username, injectedStore) {
  if (injectedStore) return injectedStore.delete(instance, username);
  const key = username ? credKey(instance, username) : credKey(instance);
  keyringDelete(key);
  try {
    fs.unlinkSync(credentialsPath(key));
  } catch {
    // ignore
  }
}

const defaultCredentialStore = {
  load: loadCredentials,
  save: saveCredentials,
  delete: deleteCredentials,
};

function askHidden(promptText) {
  return passwordPrompt({ message: promptText });
}

/**
 * Extract the browser session token and cookies from pasted DevTools headers
 * or a "Copy as cURL" command. Only these two values are retained.
 */
export function parseBrowserSessionInput(input) {
  const text = String(input || '');
  const tokenMatch = text.match(/(?:x-usertoken|x-user-token)\s*:\s*([^\s'";,]+)/i);
  const cookieArgMatch = text.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])(.*?)\1/s);
  const quotedCookieMatch = text.match(/cookie\s*:\s*(['"])(.*?)\1/i);
  const plainCookieMatch = text.match(/cookie\s*:\s*([^\r\n]+)/i);
  const token = tokenMatch?.[1]?.trim() || '';
  const cookies = (cookieArgMatch?.[2] || quotedCookieMatch?.[2] || plainCookieMatch?.[1] || '')
    .trim()
    .replace(/['"`]\s*(?:\\\s*)?$/, '');
  if (!token) throw errAuth('No X-UserToken header found');
  if (!cookies) throw errAuth('No Cookie header found. Paste the complete request headers or cURL command.');
  return { auth_method: 'gck', access_token: token, cookies, auth_source: 'gck' };
}

const AUTH_METHODS = new Set(['oauth', 'basic', 'gck']);
const AUTH_SOURCES = new Set(['env_token', 'env_basic', 'gck', 'keyring', 'file', 'unavailable']);

function normalizeAuthMethod(value, fallback = 'unconfigured') {
  return AUTH_METHODS.has(value) ? value : fallback;
}

function normalizeAuthSource(value, fallback = 'unavailable') {
  return AUTH_SOURCES.has(value) ? value : fallback;
}

const PROBE_FAILURES = {
  missing_credentials: {
    message: 'Credentials are not available for this profile.',
    hint: 'Run: jsn auth login',
  },
  credentials_expired: {
    message: 'Credentials have expired and cannot be refreshed.',
    hint: 'Run: jsn auth login',
  },
  refresh_required: {
    message: 'Credentials require refresh before probing.',
    hint: 'Run: jsn auth refresh',
  },
  refresh_failed: {
    message: 'Credential refresh failed before the authenticated probe.',
    hint: 'Run: jsn auth login',
  },
  invalid_browser_session: {
    message: 'Browser session credentials are incomplete or invalid.',
    hint: 'Capture a fresh ServiceNow browser request and run: jsn auth login --gck',
  },
  malformed_credentials: {
    message: 'Credentials are malformed for the selected authentication method.',
    hint: 'Run: jsn auth login',
  },
  permission_denied: {
    message: 'The authenticated user lacks permission for the current-user probe.',
    hint: 'Ask an administrator to grant access to the sys_user table/API.',
  },
  unauthorized: {
    message: 'The instance rejected the selected credentials.',
    hint: 'Run: jsn auth login',
  },
  network: {
    message: 'The authenticated probe could not reach the instance.',
    hint: 'Check your internet connection and instance URL.',
  },
  unknown: {
    message: 'The authenticated probe failed for an unknown reason.',
    hint: 'Retry the probe; if it persists, check the instance logs.',
  },
  missing_instance: {
    message: 'No instance is configured for this profile.',
    hint: 'Set an instance URL and run: jsn auth login',
  },
  sdk_construction_failed: {
    message: 'The authenticated probe could not be initialized for this profile.',
    hint: 'Check the profile configuration and run: jsn auth status again',
  },
};

const PROBE_CLASSIFICATIONS = {
  missing_credentials: 'unavailable', credentials_expired: 'expired', refresh_required: 'refresh_required',
  refresh_failed: 'refresh_failed', invalid_browser_session: 'browser_session_invalid',
  malformed_credentials: 'malformed', permission_denied: 'permission_denied', unauthorized: 'unauthorized',
  network: 'network_error', unknown: 'unknown',
  missing_instance: 'unavailable', sdk_construction_failed: 'configuration_error',
};

function probeFailure(code, status = 'failed') {
  return { status, code, classification: PROBE_CLASSIFICATIONS[code] || 'unknown', ...PROBE_FAILURES[code] };
}

function classifyProbeError(error, method) {
  if (error?.status === 401 || error?.status === 403) {
    return error.status === 403 ? 'permission_denied' : 'unauthorized';
  }
  if (error?.code === 'network_error' || ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code)) {
    return 'network';
  }
  const text = String(error?.message || '').toLowerCase();
  if (error?.code === 'auth_error' && text.includes('refresh')) return 'refresh_failed';
  if (method === 'gck' && error?.code === 'auth_error') return 'invalid_browser_session';
  return 'unknown';
}

/**
 * Classify credentials without returning or logging any credential material.
 * This is deliberately pure so diagnostics cannot refresh, persist, or probe.
 */
export function classifyCredentialState(credentials, method, now = Date.now()) {
  if (!credentials) return 'missing';
  if (!AUTH_METHODS.has(method)) return 'malformed';

  if (method === 'basic') {
    const hasUser = typeof credentials.username === 'string' && credentials.username.length > 0;
    const hasPassword = typeof credentials.password === 'string' && credentials.password.length > 0;
    return hasUser && hasPassword ? 'available' : 'malformed';
  }

  if (method === 'gck') {
    const hasToken = typeof credentials.access_token === 'string' && credentials.access_token.length > 0;
    const hasCookies = typeof credentials.cookies === 'string' && credentials.cookies.length > 0;
    return hasToken && hasCookies ? 'available' : 'malformed';
  }

  if (credentials.access_token !== undefined && typeof credentials.access_token !== 'string') return 'malformed';
  if (credentials.refresh_token !== undefined && typeof credentials.refresh_token !== 'string') return 'malformed';

  const hasToken = typeof credentials.access_token === 'string' && credentials.access_token.length > 0;
  if (!hasToken) return credentials.refresh_token ? 'refreshable' : 'missing';
  if (credentials.expires_at !== undefined && credentials.expires_at !== null && credentials.expires_at !== 0) {
    const expiresAt = Number(credentials.expires_at);
    if (!Number.isFinite(expiresAt)) return 'malformed';
    if (now >= expiresAt * 1000) return credentials.refresh_token ? 'refreshable' : 'expired';
  }
  return 'available';
}

export class AuthManager {
  /**
   * @param {object} identity — the resolved-identity provider. Production
   *   wiring (src/app.js) hands an adapter over app.session:
   *   { getUsername(), getEffectiveInstance() }. AuthManager no longer
   *   reaches into config.profiles itself — the session owns "who am I".
   *
   *   Transitional back-compat: a legacy configProvider ({ config, ...
   *   getEffectiveInstance() }) is adapted to the identity surface, so the
   *   existing test fixtures (which predate the session) keep working.
   * @param {object} options
   * @param {object} options.credentialStore — optional load/save/delete adapter;
   *   defaults to the OS keyring with file fallback.
   */
  constructor(identity, { credentialStore = defaultCredentialStore } = {}) {
    if (identity && identity.config && typeof identity.getUsername !== 'function') {
      const provider = identity;
      this.identity = {
        getUsername: () => {
          const cfg = provider.config;
          const name = cfg.activeProfile || cfg.defaultProfile;
          return (name && cfg.profiles?.[name]?.username) || null;
        },
        getEffectiveInstance: () => provider.getEffectiveInstance(),
        getAuthMethod: () => {
          const cfg = provider.config;
          const name = cfg.activeProfile || cfg.defaultProfile;
          return cfg.profiles?.[name]?.auth_method || null;
        },
      };
    } else {
      this.identity = identity;
    }
    this.credentialStore = credentialStore;
    this.httpClient = { timeout: 30000 };
  }

  /**
   * The username for credential keying, from the resolved session identity.
   * Returns null when no profile is configured — callers fall back to bare
   * instance key for backward compatibility with legacy / no-profile usage.
   */
  _activeUsername() {
    return this.identity.getUsername() || null;
  }

  loadCredentials(instance, username) {
    return this.credentialStore.load(instance, username);
  }

  saveCredentials(instance, credentials, username) {
    return this.credentialStore.save(instance, credentials, username);
  }

  deleteCredentials(instance, username) {
    return this.credentialStore.delete(instance, username);
  }

  getLastSeen(instance, options = {}) {
    const creds = this.loadCredentials(instance, options.username ?? this._activeUsername());
    return creds?.last_seen || null;
  }

  touchLastSeen(instance, options = {}) {
    const username = options.username ?? this._activeUsername();
    const creds = this.credentialStore.load(instance, username);
    if (!creds) return;
    creds.last_seen = Math.floor(Date.now() / 1000);
    this.credentialStore.save(instance, creds, username);
  }

  /**
   * Check if legacy bare-instance credentials exist (stored before
   * user@instance keying). Returns true when old-style creds are found
   * but wouldn't be picked up by the current username-scoped lookup.
   */
  hasLegacyCredentials(instance, options = {}) {
    if (!instance) return false;
    const bareCreds = this.credentialStore.load(instance);
    if (!bareCreds) return false;
    // If active profile has a username, the bare key won't be found
    // by loadCredentials(instance, username). That's the legacy case.
    const username = options.username ?? this._activeUsername();
    if (!username) return false; // No username set — bare key IS the active path
    const userCreds = this.credentialStore.load(instance, username);
    return !!bareCreds && !userCreds;
  }

  /**
   * Return the auth source for an instance without throwing.
   * Mirrors the auth resolution order in getCredentials().
   * For older stored credentials without auth_source, falls back
   * to the saved auth_method field.
   */
  getAuthSource(instance, options = {}) {
    const method = this._selectedMethod(options);
    if (method !== 'gck' && method !== 'basic' && process.env.SERVICENOW_OAUTH_TOKEN) return 'env_token';
    if (method !== 'gck' && method !== 'oauth' && getBasicAuthFromEnv(instance)) return 'env_basic';
    const creds = this.credentialStore.load(instance, options.username ?? this._activeUsername());
    if (!creds) return null;
    // New creds have auth_source; older ones only have auth_method
    const source = normalizeAuthSource(creds.auth_source, '');
    if (source) return source;
    return normalizeAuthMethod(creds.auth_method, '') || 'unavailable';
  }

  probeUnavailable(code) {
    return probeFailure(code, 'not_attempted');
  }

  _selectedMethod(options = {}) {
    const value = options.authMethod !== undefined ? options.authMethod
      : typeof this.identity.getAuthMethod === 'function' ? this.identity.getAuthMethod() : null;
    return normalizeAuthMethod(value, 'unconfigured');
  }

  createProfileProvider(instance, options = {}) {
    return {
      getCredentials: () => this.getCredentialsFor(instance, options.username, options),
      touchLastSeen: () => this.touchLastSeen(instance, options),
    };
  }

  /**
   * Return only safe metadata about the selected auth method and credentials.
   * Unlike getCredentialsFor(), this never refreshes or mutates credentials.
   */
  getAuthState(instance = this.identity.getEffectiveInstance(), options = {}) {
    const configuredValue = options.authMethod !== undefined
      ? options.authMethod
      : typeof this.identity.getAuthMethod === 'function'
      ? this.identity.getAuthMethod() : null;
    const configuredMethod = normalizeAuthMethod(configuredValue);
    const isConfigured = configuredMethod !== 'unconfigured';
    let method = configuredMethod;
    let classificationMethod = isConfigured ? configuredMethod : null;
    let source = 'unavailable';
    let credentials = null;
    let malformedMetadata = configuredValue != null && !isConfigured;

    if (process.env.SERVICENOW_OAUTH_TOKEN && (!isConfigured || configuredMethod === 'oauth')) {
      source = 'env_token';
      classificationMethod = 'oauth';
      credentials = { access_token: process.env.SERVICENOW_OAUTH_TOKEN };
    } else {
      const basicCredentials = getBasicAuthFromEnv(instance);
      if (basicCredentials && (!isConfigured || configuredMethod === 'basic')) {
        source = 'env_basic';
        classificationMethod = 'basic';
        credentials = basicCredentials;
      } else if (instance) {
        credentials = this.credentialStore.load(instance, options.username ?? this._activeUsername());
        if (credentials) {
          if (credentials.auth_method != null) {
            const storedMethod = normalizeAuthMethod(credentials.auth_method, '');
            if (!storedMethod) malformedMetadata = true;
            else if (isConfigured && storedMethod !== configuredMethod) malformedMetadata = true;
            else if (!isConfigured) classificationMethod = storedMethod;
          }
          if (credentials.auth_source != null) {
            const storedSource = normalizeAuthSource(credentials.auth_source, '');
            if (storedSource) source = storedSource;
            else {
              source = 'unavailable';
              malformedMetadata = true;
            }
          }
        }
      }
    }

    const state = malformedMetadata
      ? 'malformed'
      : classificationMethod
        ? classifyCredentialState(credentials, classificationMethod)
        : credentials ? 'malformed' : 'missing';
    return {
      auth_method: method,
      auth_source: normalizeAuthSource(source, 'unavailable'),
      state,
    };
  }

  /**
   * Perform one read-only authenticated current-user request and classify only
   * safe lifecycle outcomes. The SDK is injected to keep this seam independent
   * of command wiring and to make the selected auth path explicit.
   */
  async probeCurrentUser(instance = this.identity.getEffectiveInstance(), sdk, options = {}) {
    const authState = this.getAuthState(instance, options);
    const method = authState.auth_method === 'unconfigured' ? null : authState.auth_method;
    const stateFailures = {
      missing: 'missing_credentials',
      expired: 'credentials_expired',
      refreshable: 'refresh_required',
      malformed: method === 'gck' ? 'invalid_browser_session' : 'malformed_credentials',
    };
    if (stateFailures[authState.state]) return probeFailure(stateFailures[authState.state], 'not_attempted');
    if (!sdk || typeof sdk.getCurrentUser !== 'function') return probeFailure('unknown', 'not_attempted');

    try {
      await sdk.getCurrentUser({ touchLastSeen: false });
      return { status: 'succeeded', classification: 'authenticated' };
    } catch (error) {
      return probeFailure(classifyProbeError(error, method));
    }
  }

  isAuthenticated() {
    const instance = this.identity.getEffectiveInstance();
    if (!instance) return false;
    try {
      this.getCredentialsFor(instance);
      return true;
    } catch {
      return false;
    }
  }

  isAuthenticatedFor(instance, options = {}) {
    if (!instance) return false;
    return this.getAuthState(instance, options).state === 'available';
  }

  async getCredentials() {
    const instance = this.identity.getEffectiveInstance();
    if (!instance) {
      throw errAuth('No instance configured');
    }
    return this.getCredentialsFor(instance);
  }

  getCredentialsFor(instance, username = this._activeUsername(), options = {}) {
    const method = this._selectedMethod(options);
    if (method === 'oauth' && process.env.SERVICENOW_OAUTH_TOKEN) {
      return { auth_method: 'oauth', access_token: process.env.SERVICENOW_OAUTH_TOKEN, auth_source: 'env_token' };
    }
    if (method === 'basic') {
      const basicCreds = getBasicAuthFromEnv(instance);
      if (basicCreds) return basicCreds;
    }
    const creds = this.credentialStore.load(instance, username);
    if (!creds) {
      throw errAuth(`Not authenticated for ${instance}`);
    }
    if (method !== 'unconfigured' && creds.auth_method != null && creds.auth_method !== method) {
      throw errAuth(`Stored credentials do not match configured ${method} authentication`);
    }
    const resolved = method !== 'unconfigured' && !creds.auth_method ? { ...creds, auth_method: method } : creds;
    if (method === 'gck' && (!resolved.access_token || !resolved.cookies)) throw errAuth('Invalid browser session credentials');
    if (method === 'basic' && (!resolved.username || !resolved.password)) throw errAuth('Invalid basic auth credentials');
    if (method === 'oauth' && !resolved.access_token) throw errAuth('Invalid OAuth credentials');
    // Check expiry — refresh if less than 5 minutes remaining
    if (resolved.expires_at && Date.now() >= (resolved.expires_at - 300) * 1000) {
      if (resolved.refresh_token) return this.refreshToken(instance, resolved);
      throw errAuth('Token expired, please login again');
    }
    return resolved;
  }

  async login(instanceURL) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = generatePKCE();
    const authURL = buildAuthURL(instanceURL, clientID, pkce);

    console.log();
    console.log('Open this URL in your browser to authenticate:');
    console.log(authURL);
    console.log();
    console.log('(The browser is not opened automatically — if a browser tab opens,');
    console.log(' use the URL above if the opened page shows an error.)');
    console.log();

    console.log('After authenticating in the browser, copy the authorization code shown on the page.');
    console.log('(input is hidden for security — just paste and press Enter)');
    console.log();

    const authCode = await askHidden('Authorization code (hidden on paste for security): ');
    const code = authCode.trim();
    if (!code) {
      throw errAuth('Authorization code is required');
    }

    console.log('\nExchanging authorization code for tokens...');
    const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
    // Save with username for per-user credential keying
    this.saveCredentials(instanceURL, newCreds, newCreds.username);
    return newCreds;
  }

  /**
   * Build an OAuth authorization URL and persist PKCE state for later use.
   * After calling this, the user can visit the URL in a browser and then
   * call loginWithCode() with the resulting authorization code.
   * If waitFile is provided, the method will read the code from that file
   * (waits for file to appear, polling every 2 seconds, up to 5 minutes).
   */
  buildAuthURL(instanceURL, waitFile) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = generatePKCE();
    savePKCEState(instanceURL, pkce);
    const url = buildAuthURL(instanceURL, clientID, pkce);
    if (waitFile) {
      console.log(url);
      console.log();
      console.log(`Waiting for authorization code in file: ${waitFile}`);
      console.log('(polling every 2 seconds — write the code to the file to complete login)');
      return this._waitForCodeFile(instanceURL, clientID, pkce, waitFile);
    }
    return url;
  }

  async _waitForCodeFile(instanceURL, clientID, pkce, filePath, timeout = 300000) {
    const start = Date.now();
    const pollInterval = 2000;
    while (Date.now() - start < timeout) {
      try {
        const code = fs.readFileSync(filePath, 'utf-8').trim();
        if (code) {
          console.log(`\nAuthorization code found in ${filePath}`);
          removePKCEState(instanceURL);
          const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
          this.saveCredentials(instanceURL, newCreds, newCreds.username);
          console.log('Token exchange successful!\n');
          return newCreds;
        }
      } catch {
        // File not ready yet
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    throw errAuth(`Timed out waiting for authorization code in ${filePath} (${timeout / 1000}s)`);
  }

  /**
   * Authenticate with basic auth via environment variables.
   * Reads SN_USERNAME/SN_PASSWORD (or SN_<INSTANCE>_USERNAME/SN_<INSTANCE>_PASSWORD).
   * Stores the basic auth credentials so they persist across sessions.
   */
  async loginWithPassword(instanceURL, username = this._activeUsername()) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const envCreds = getBasicAuthFromEnv(instanceURL);
    const storedCreds = this.loadCredentials(instanceURL, username);
    const creds = envCreds || storedCreds;
    if (!creds || creds.auth_method !== 'basic' || !creds.username || !creds.password) {
      throw errAuth(
        `No basic auth credentials found in environment or stored profile.\n\n` +
        `Set the following environment variables:\n` +
        `  SN_USERNAME=admin           (or SN_${envVarName(instanceURL)}_USERNAME)\n` +
        `  SN_PASSWORD=<password>      (or SN_${envVarName(instanceURL)}_PASSWORD)\n\n` +
        `Then run:\n` +
        `  jsn auth login --basic ${instanceURL}`
      );
    }
    this.saveCredentials(instanceURL, creds, creds.username);
    console.log(`✓ Basic auth credentials saved for ${instanceURL}`);
    return creds;
  }

  /**
   * Complete login using an authorization code obtained from a prior buildAuthURL() call.
   * The PKCE state must have been saved by an earlier buildAuthURL() call.
   */
  async loginWithGck(instanceURL, input, username = this._activeUsername()) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const creds = parseBrowserSessionInput(input);
    this.saveCredentials(instanceURL, { ...creds, username: username || undefined }, username || undefined);
    return { ...creds, username: username || undefined };
  }

  async loginWithCode(instanceURL, code) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = loadPKCEState(instanceURL);
    if (!pkce) {
      throw errAuth(
        `No pending login session for ${instanceURL}.\n\n` +
        'Run without --code first to generate one:\n' +
        `  jsn auth login ${instanceURL} --print-url\n\n` +
        'This generates the PKCE challenge and saves it. Then call:\n' +
        `  jsn auth login ${instanceURL} --code CODE`
      );
    }
    removePKCEState(instanceURL);

    const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
    this.saveCredentials(instanceURL, newCreds, newCreds.username);
    return newCreds;
  }

  async exchangeCode(instanceURL, clientID, code, pkce) {
    const tokenURL = `${instanceURL.replace(/\/$/, '')}/oauth_token.do`;
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', clientID);
    body.set('code', code);
    body.set('redirect_uri', REDIRECT_URI);
    body.set('code_verifier', pkce.code_verifier);

    const resp = await fetch(tokenURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw errAuth(`Token exchange failed (status ${resp.status}): ${text}`);
    }

    const tokenResp = JSON.parse(text);
    const expiresAt = tokenResp.expires_in ? Math.floor(Date.now() / 1000) + tokenResp.expires_in : 0;
    return {
      auth_method: 'oauth',
      access_token: tokenResp.access_token,
      refresh_token: tokenResp.refresh_token,
      expires_at: expiresAt,
      created_at: Math.floor(Date.now() / 1000),
      // The username will be set after post-login verification in the auth command
      auth_source: 'oauth',
    };
  }

  async refreshToken(instance, creds) {
    const tokenURL = `${instance.replace(/\/$/, '')}/oauth_token.do`;
    const clientID = getOAuthClientID();
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('client_id', clientID);
    body.set('refresh_token', creds.refresh_token);

    const resp = await fetch(tokenURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw errAuth(`Token refresh failed: ${text}`);
    }

    const tokenResp = await resp.json();
    const newCreds = {
      auth_method: 'oauth',
      access_token: tokenResp.access_token,
      refresh_token: tokenResp.refresh_token,
      created_at: Math.floor(Date.now() / 1000),
      auth_source: 'oauth',
    };
    if (tokenResp.expires_in) {
      newCreds.expires_at = Math.floor(Date.now() / 1000) + tokenResp.expires_in;
    }
    this.credentialStore.save(instance, newCreds, creds.username);
    return newCreds;
  }

  logout(instance) {
    if (!instance) {
      throw errAuth('No instance specified');
    }
    this.credentialStore.delete(instance, this._activeUsername());
  }

  /**
   * Migrate legacy bare-instance-keyed credentials to <user>@<instance>
   * keying after an OAuth login verifies the username. Re-saves under the
   * compound key and removes the bare key. Returns true when a migration
   * happened. Credential-store internals (key shapes, legacy bare keys)
   * live behind this seam — command handlers must not import
   * loadCredentials/saveCredentials/deleteCredentials to do this themselves.
   */
  migrateLegacyCredential(instance, username) {
    if (!instance || !username) return false;
    const stored = this.credentialStore.load(instance);
    if (!stored || !stored.access_token) return false;
    stored.username = username;
    this.credentialStore.save(instance, stored, username);
    this.credentialStore.delete(instance); // remove bare-instance legacy key
    return true;
  }
}

export { saveCredentials, loadCredentials, deleteCredentials, askHidden };
