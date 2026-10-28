// OAuth 2.0 with PKCE authentication
// Credentials are stored in the OS keyring (shared with Go version via libsecret/secret-tool)
// Falls back to file-based storage when keyring is unavailable.
// Credentials are keyed by <username>@<instance> so different users on the
// same instance have separate credential slots.

import fs from 'node:fs';
import { password as passwordPrompt } from './prompts.js';
import { normalizeInstanceURL } from './config.js';
import { errAuth } from './errors.js';
import { pendingBrowserLogin } from './browser-auth.js';
import { defaultCredentialStore } from './auth/credential-store.js';
import { savePKCEState, loadPKCEState, removePKCEState, getOAuthClientID, generatePKCE, buildAuthURL, REDIRECT_URI } from './auth/oauth.js';
import { parseBrowserSessionInput } from './auth/browser-session.js';
import { normalizeAuthMethod, normalizeAuthSource, sourceMethod, probeFailure, classifyProbeError, classifyCredentialState } from './auth/credential-state.js';

// Preserve the public auth module API while implementation stays separated.
export { sanitizeKeyPart } from './auth/credential-store.js';
export { parseBrowserSessionInput } from './auth/browser-session.js';
export { classifyCredentialState } from './auth/credential-state.js';


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

function askHidden(promptText) {
  return passwordPrompt({ message: promptText });
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
    return typeof this.identity.getUsername === 'function' ? this.identity.getUsername() || null : null;
  }

  // An options object with a username property is an explicit identity,
  // including `username: undefined` which intentionally selects bare creds.
  // Omitted options retain the legacy active-user fallback.
  _usernameForOptions(options = {}) {
    return Object.hasOwn(options, 'username') ? options.username : this._activeUsername();
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
    const creds = this.loadCredentials(instance, this._usernameForOptions(options));
    return creds?.last_seen || null;
  }

  touchLastSeen(instance, options = {}) {
    const username = this._usernameForOptions(options);
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
    const username = this._usernameForOptions(options);
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
    const creds = this.credentialStore.load(instance, this._usernameForOptions(options));
    if (!creds) return null;
    // A configured method is authoritative at this public boundary. Stored
    // metadata from another method must not be reported as usable source.
    if (method !== 'unconfigured') {
      const storedMethod = normalizeAuthMethod(creds.auth_method, '');
      if (creds.auth_method != null && (!storedMethod || storedMethod !== method)) return 'unavailable';
      const source = normalizeAuthSource(creds.auth_source, '');
      if (!source) return 'unavailable';
      const sourceMethod = { env_token: 'oauth', env_basic: 'basic', gck: 'gck' }[source];
      if (sourceMethod && sourceMethod !== method) return 'unavailable';
      return source;
    }
    // New creds have auth_source; older ones only have auth_method
    const source = normalizeAuthSource(creds.auth_source, '');
    if (source) return source;
    return normalizeAuthMethod(creds.auth_method, '') || 'unavailable';
  }

  probeUnavailable(code) {
    return probeFailure(code, 'not_attempted');
  }

  _selectedMethod(options = {}) {
    const value = Object.hasOwn(options, 'authMethod') ? options.authMethod
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
    const configuredValue = Object.hasOwn(options, 'authMethod')
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
        credentials = this.credentialStore.load(instance, this._usernameForOptions(options));
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
            if (storedSource && isConfigured && sourceMethod(storedSource)
              && sourceMethod(storedSource) !== configuredMethod) {
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
    return this.getAuthState(instance).state === 'available';
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

  getCredentialsFor(instance, username, options = {}) {
    const method = this._selectedMethod(options);
    // With no configured method, preserve the legacy environment precedence:
    // OAuth token first, then Basic credentials, then stored credentials.
    if ((method === 'unconfigured' || method === 'oauth') && process.env.SERVICENOW_OAUTH_TOKEN) {
      return { auth_method: 'oauth', access_token: process.env.SERVICENOW_OAUTH_TOKEN, auth_source: 'env_token' };
    }
    if (method === 'unconfigured' || method === 'basic') {
      const basicCreds = getBasicAuthFromEnv(instance);
      if (basicCreds) return basicCreds;
    }
    const credentialUsername = Object.hasOwn(options, 'username') ? options.username : (username ?? this._activeUsername());
    const creds = this.credentialStore.load(instance, credentialUsername);
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
    if (options.refresh !== false && resolved.expires_at && Date.now() >= (resolved.expires_at - 300) * 1000) {
      if (resolved.refresh_token) return this.refreshToken(instance, resolved, credentialUsername);
      throw errAuth('Token expired, please login again');
    }
    return resolved;
  }

  async login(instanceURL, username = this._activeUsername()) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = generatePKCE();
    const authURL = buildAuthURL(instanceURL, clientID, pkce);

    console.error();
    console.error('Open this URL in your browser to authenticate:');
    console.error(authURL);
    console.error();
    console.error('(The browser is not opened automatically — if a browser tab opens,');
    console.error(' use the URL above if the opened page shows an error.)');
    console.error();

    console.error('After authenticating in the browser, copy the authorization code shown on the page.');
    console.error('(input is hidden for security — just paste and press Enter)');
    console.error();

    const authCode = await askHidden('Authorization code (hidden on paste for security): ');
    const code = authCode.trim();
    if (!code) {
      throw errAuth('Authorization code is required');
    }

    console.error('\nExchanging authorization code for tokens...');
    const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
    // Save with the selected profile username when one is already known.
    this.saveCredentials(instanceURL, newCreds, username || newCreds.username);
    return newCreds;
  }

  /**
   * Build an OAuth authorization URL and persist PKCE state for later use.
   * After calling this, the user can visit the URL in a browser and then
   * call loginWithCode() with the resulting authorization code.
   * If waitFile is provided, the method will read the code from that file
   * (waits for file to appear, polling every 2 seconds, up to 5 minutes).
   */
  buildAuthURL(instanceURL, waitFile, username = this._activeUsername()) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = generatePKCE();
    savePKCEState(instanceURL, pkce, username);
    const url = buildAuthURL(instanceURL, clientID, pkce);
    if (waitFile) {
      console.error(url);
      console.error();
      console.error(`Waiting for authorization code in file: ${waitFile}`);
      console.error('(polling every 2 seconds — write the code to the file to complete login)');
      return this._waitForCodeFile(instanceURL, clientID, pkce, waitFile, 300000, username);
    }
    return url;
  }

  async _waitForCodeFile(instanceURL, clientID, pkce, filePath, timeout = 300000, username) {
    const start = Date.now();
    const pollInterval = 2000;
    while (Date.now() - start < timeout) {
      let code = '';
      try { code = fs.readFileSync(filePath, 'utf-8').trim(); } catch { /* File not ready yet. */ }
      if (code) {
        console.error(`\nAuthorization code found in ${filePath}`);
        const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
        removePKCEState(instanceURL, username);
        this.saveCredentials(instanceURL, newCreds, username || newCreds.username);
        console.error('Token exchange successful!\n');
        return newCreds;
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
  async loginWithPassword(instanceURL, username = this._activeUsername(), suppliedCredentials) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const envCreds = getBasicAuthFromEnv(instanceURL);
    const storedCreds = this.loadCredentials(instanceURL, username);
    const creds = suppliedCredentials
      ? { auth_method: 'basic', ...suppliedCredentials }
      : envCreds || storedCreds;
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
    if (username && creds.username !== username) {
      throw errAuth('The Basic credentials do not match the selected profile user. Use matching credentials or create a new named profile.');
    }
    this.saveCredentials(instanceURL, creds, creds.username);
    return creds;
  }

  /**
   * Complete login using an authorization code obtained from a prior buildAuthURL() call.
   * The PKCE state must have been saved by an earlier buildAuthURL() call.
   */
  async loginWithGck(instanceURL, input, username = this._activeUsername()) {
    return this._loginWithBrowserSession(instanceURL, parseBrowserSessionInput(input), username);
  }

  async loginWithBrowser(instanceURL, options = {}, username = this._activeUsername()) {
    if (options.launch) {
      const { launchBrowserSession } = await import('./browser-launch.js');
      const credentials = await launchBrowserSession(instanceURL, {
        ...options,
        verify: (creds, verification) => this._verifyBrowserSession(instanceURL, creds, username, { ...verification, requireIdentity: true }),
      });
      this.saveCredentials(normalizeInstanceURL(instanceURL), credentials, credentials.username);
      return credentials;
    }
    const { readBrowserSession } = await import('./browser-auth.js');
    const creds = await readBrowserSession(instanceURL, options);
    return this._loginWithBrowserSession(instanceURL, creds, username, { requireIdentity: true });
  }

  async _loginWithBrowserSession(instanceURL, creds, username, { requireIdentity = false } = {}) {
    const credentials = await this._verifyBrowserSession(instanceURL, creds, username, { requireIdentity });
    this.saveCredentials(normalizeInstanceURL(instanceURL), credentials, credentials.username);
    return credentials;
  }

  async _verifyBrowserSession(instanceURL, creds, username, { requireIdentity = false, signal, timeout = this.httpClient.timeout } = {}) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const query = new URLSearchParams({
      sysparm_limit: '1',
      sysparm_fields: 'user_name',
      sysparm_query: 'user_name=javascript:gs.getUserName()',
    });
    let response;
    try {
      response = await fetch(`${instanceURL}/api/now/table/sys_user?${query}`, {
        method: 'GET',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        headers: {
          Accept: 'application/json',
          'X-UserToken': creds.access_token,
          Cookie: creds.cookies,
        },
      });
    } catch {
      throw errAuth(`Could not test the browser session against ${instanceURL}. Nothing was saved. Retry browser-session login.`);
    }
    if (!response.ok) {
      if (requireIdentity && [401, 403].includes(response.status)) {
        throw pendingBrowserLogin('The session is not authorized for current-user verification. Finish signing in, or check current-user API access.');
      }
      throw errAuth(`Browser session rejected by ${instanceURL} (HTTP ${response.status}). Nothing was saved. Retry with: jsn auth login ${instanceURL} --gck`);
    }
    let body;
    try { body = await response.json(); } catch { throw errAuth('Browser session verification did not return JSON. Nothing was saved.'); }
    const user = body?.result?.[0];
    const verifiedUsername = typeof user?.user_name === 'string' ? user.user_name : username;
    if (requireIdentity && verifiedUsername === 'guest') throw pendingBrowserLogin('Waiting for browser login.');
    if (requireIdentity && (!user?.user_name || typeof user.user_name !== 'string')) {
      throw pendingBrowserLogin('Could not verify the browser account. Nothing was saved. Check current-user API access.');
    }
    if (requireIdentity && username && username !== verifiedUsername) {
      throw errAuth('The browser account does not match the selected profile. Nothing was saved. Use the matching account or create a new profile.');
    }
    return { ...creds, username: verifiedUsername || undefined };
  }

  async loginWithCode(instanceURL, code, username = this._activeUsername()) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = loadPKCEState(instanceURL, username);
    if (!pkce) {
      throw errAuth(
        `No pending login session for ${instanceURL}.\n\n` +
        'Run without --code first to generate one:\n' +
        `  jsn auth login ${instanceURL} --print-url\n\n` +
        'This generates the PKCE challenge and saves it. Then call:\n' +
        `  jsn auth login ${instanceURL} --code CODE`
      );
    }
    removePKCEState(instanceURL, username);

    const newCreds = await this.exchangeCode(instanceURL, clientID, code, pkce);
    this.saveCredentials(instanceURL, newCreds, username || newCreds.username);
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
      throw errAuth(`Token exchange failed (status ${resp.status})`);
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

  async refreshToken(instance, creds, targetUsername = undefined) {
    if (creds.auth_method !== 'oauth') {
      throw errAuth(`Cannot refresh ${creds.auth_method || 'unconfigured'} credentials; only OAuth credentials support refresh`);
    }
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
      await resp.text();
      throw errAuth(`Token refresh failed (status ${resp.status})`);
    }

    const tokenResp = await resp.json();
    // An explicitly supplied target (including null for a username-less
    // non-active target) must not fall back to the active identity. Preserve
    // the legacy fallback only for callers that omit the third argument.
    const username = targetUsername !== undefined
      ? (targetUsername || creds.username || null)
      : (creds.username || this._activeUsername());
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
    this.credentialStore.save(instance, newCreds, username);
    return newCreds;
  }

  logout(instance, username = this._activeUsername()) {
    if (!instance) {
      throw errAuth('No instance specified');
    }
    this.credentialStore.delete(instance, username);
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

export { saveCredentials, loadCredentials, deleteCredentials } from './auth/credential-store.js';
export { askHidden };
