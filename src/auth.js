// OAuth 2.0 with PKCE authentication
// Credentials are stored in the OS keyring (shared with Go version via libsecret/secret-tool)
// Falls back to file-based storage when keyring is unavailable.
// Credentials are keyed by <username>@<instance> so different users on the
// same instance have separate credential slots.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { globalConfigDir, normalizeInstanceURL } from './config.js';
import { errAuth } from './errors.js';

// ─── Credential key helpers ───

/**
 * Build a compound key for credential storage: <username>@<instance>
 * When username is omitted (legacy), just the normalized instance URL is used.
 */
function credKey(instance, username) {
  const normalized = instance.replace(/:\/\//g, '_').replace(/\//g, '_').replace(/:/g, '_');
  if (!username) return normalized;
  return `${username.replace(/[^a-zA-Z0-9._@-]/g, '_')}@${normalized}`;
}

// ─── PKCE state persistence (shared with Go version) ───

function pkceStatePath(instance) {
  const dir = path.join(globalConfigDir(), 'pkce');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = instance.replace(/:\/\//g, '_').replace(/\//g, '_').replace(/:/g, '_') + '.json';
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

function credentialsPath(key) {
  const dir = path.join(globalConfigDir(), 'credentials');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Match Go's filename encoding: replace :// and / and : with _
  const filename = key + '.json';
  return path.join(dir, filename);
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
    const result = execSync(
      `secret-tool lookup ${KEYRING_ATTR_SERVICE} ${KEYRING_SERVICE} ${KEYRING_ATTR_USERNAME} "${key}"`,
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
    };
  } catch {
    return null;
  }
}

function keyringStore(key, creds) {
  try {
    execSync(
      `secret-tool store --label="Password for '${key}' on '${KEYRING_SERVICE}'" ` +
      `${KEYRING_ATTR_SERVICE} ${KEYRING_SERVICE} ${KEYRING_ATTR_USERNAME} "${key}"`,
      { stdio: ['pipe', 'ignore', 'ignore'], input: JSON.stringify(creds) }
    );
    return true;
  } catch {
    return false;
  }
}

function keyringDelete(key) {
  try {
    execSync(
      `secret-tool clear ${KEYRING_ATTR_SERVICE} ${KEYRING_SERVICE} ${KEYRING_ATTR_USERNAME} "${key}"`,
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
function loadCredentials(instance, username) {
  const key = username ? credKey(instance, username) : credKey(instance);
  const keyringCreds = keyringLookup(key);
  if (keyringCreds) {
    return { ...keyringCreds, auth_source: 'keyring' };
  }
  try {
    const data = fs.readFileSync(credentialsPath(key), 'utf-8');
    const creds = JSON.parse(data);
    return { ...creds, auth_source: 'file' };
  } catch {
    return null;
  }
}

/**
 * Save credentials for an instance.
 * Uses <username>@<instance> key when username is available.
 */
function saveCredentials(instance, creds, username) {
  const key = username ? credKey(instance, username) : credKey(instance);
  // Stamp last_seen on every credential save
  creds.last_seen = creds.last_seen || Math.floor(Date.now() / 1000);
  // Try keyring first, fall back to file
  if (!keyringStore(key, creds)) {
    fs.writeFileSync(credentialsPath(key), JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
}

/**
 * Get the last_seen timestamp for an instance, if available.
 */
function getLastSeen(instance, username) {
  const creds = loadCredentials(instance, username);
  if (!creds || !creds.last_seen) return null;
  return creds.last_seen;
}

/**
 * Update the last_seen timestamp for an instance to now.
 */
function touchLastSeen(instance, username) {
  const creds = loadCredentials(instance, username);
  if (!creds) return;
  creds.last_seen = Math.floor(Date.now() / 1000);
  saveCredentials(instance, creds, username);
}

/**
 * Delete credentials for an instance keyed by <username>@<instance>.
 */
function deleteCredentials(instance, username) {
  const key = username ? credKey(instance, username) : credKey(instance);
  keyringDelete(key);
  try {
    fs.unlinkSync(credentialsPath(key));
  } catch {
    // ignore
  }
}

function askHidden(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    return;
  }

    stdout.write(promptText);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    let input = '';
    const onData = (key) => {
      if (key === '\r' || key === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (key === '\u0003') {
        process.exit();
      } else if (key === '\u007f') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        input += key;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export class AuthManager {
  constructor(configProvider) {
    this.configProvider = configProvider;
    this.httpClient = { timeout: 30000 };
  }

  /**
   * Resolve the username for credential keying from the active profile.
   * Returns null when no profile is configured — callers fall back to bare
   * instance key for backward compatibility with legacy / no-profile usage.
   */
  _activeUsername() {
    const cfg = this.configProvider.config;
    const name = cfg.activeProfile || cfg.defaultProfile;
    if (name && cfg.profiles[name] && cfg.profiles[name].username) {
      return cfg.profiles[name].username;
    }
    return null;
  }

  getLastSeen(instance) {
    return getLastSeen(instance, this._activeUsername());
  }

  touchLastSeen(instance) {
    return touchLastSeen(instance, this._activeUsername());
  }

  /**
   * Check if legacy bare-instance credentials exist (stored before
   * user@instance keying). Returns true when old-style creds are found
   * but wouldn't be picked up by the current username-scoped lookup.
   */
  hasLegacyCredentials(instance) {
    if (!instance) return false;
    const bareCreds = loadCredentials(instance);
    if (!bareCreds) return false;
    // If active profile has a username, the bare key won't be found
    // by loadCredentials(instance, username). That's the legacy case.
    const username = this._activeUsername();
    if (!username) return false; // No username set — bare key IS the active path
    const userCreds = loadCredentials(instance, username);
    return !!bareCreds && !userCreds;
  }

  /**
   * Return the auth source for an instance without throwing.
   * Mirrors the auth resolution order in getCredentials().
   * For older stored credentials without auth_source, falls back
   * to the saved auth_method field.
   */
  getAuthSource(instance) {
    if (process.env.SERVICENOW_OAUTH_TOKEN) return 'env_token';
    if (getBasicAuthFromEnv(instance)) return 'env_basic';
    const creds = loadCredentials(instance, this._activeUsername());
    if (!creds) return null;
    // New creds have auth_source; older ones only have auth_method
    return creds.auth_source || creds.auth_method || 'stored';
  }

  isAuthenticated() {
    if (process.env.SERVICENOW_OAUTH_TOKEN) return true;
    if (getBasicAuthFromEnv()) return true;
    const instance = this.configProvider.getEffectiveInstance();
    if (!instance) return false;
    try {
      this.getCredentialsFor(instance);
      return true;
    } catch {
      return false;
    }
  }

  isAuthenticatedFor(instance) {
    if (!instance) return false;
    if (getBasicAuthFromEnv(instance)) return true;
    const creds = loadCredentials(instance, this._activeUsername());
    if (!creds) return false;
    if (creds.expires_at && Date.now() >= creds.expires_at * 1000) return false;
    return !!creds.access_token;
  }

  async getCredentials() {
    if (process.env.SERVICENOW_OAUTH_TOKEN) {
      return { auth_method: 'oauth', access_token: process.env.SERVICENOW_OAUTH_TOKEN, auth_source: 'env_token' };
    }
    const instance = this.configProvider.getEffectiveInstance();
    if (!instance) {
      throw errAuth('No instance configured');
    }
    // Check basic auth from env vars first
    const basicCreds = getBasicAuthFromEnv(instance);
    if (basicCreds) return basicCreds;
    return this.getCredentialsFor(instance);
  }

  getCredentialsFor(instance) {
    // Check basic auth from env vars first
    const basicCreds = getBasicAuthFromEnv(instance);
    if (basicCreds) return basicCreds;
    const creds = loadCredentials(instance, this._activeUsername());
    if (!creds) {
      throw errAuth(`Not authenticated for ${instance}`);
    }
    // Check expiry — refresh if less than 5 minutes remaining
    if (creds.expires_at && Date.now() >= (creds.expires_at - 300) * 1000) {
      if (creds.refresh_token) {
        return this.refreshToken(instance, creds);
      }
      throw errAuth('Token expired, please login again');
    }
    return creds;
  }

  async login(instanceURL) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const clientID = getOAuthClientID();
    const pkce = generatePKCE();
    const authURL = buildAuthURL(instanceURL, clientID, pkce);

    console.log();
    console.log('Opening browser for OAuth authentication...');
    console.log('If the browser does not open automatically, visit:');
    console.log(authURL);
    console.log();

    // Try to open browser
    const open = (await import('node:child_process')).spawn;
    const platform = process.platform;
    let cmd, args;
    if (platform === 'darwin') {
      cmd = 'open';
      args = [authURL];
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', authURL];
    } else {
      cmd = 'xdg-open';
      args = [authURL];
    }
    const child = open(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Browser open command not available — user will open the URL manually
    });
    child.unref();

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
    saveCredentials(instanceURL, newCreds, newCreds.username);
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
          saveCredentials(instanceURL, newCreds, newCreds.username);
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
  async loginWithPassword(instanceURL) {
    instanceURL = normalizeInstanceURL(instanceURL);
    const creds = getBasicAuthFromEnv(instanceURL);
    if (!creds) {
      throw errAuth(
        `No basic auth credentials found in environment.\n\n` +
        `Set the following environment variables:\n` +
        `  SN_USERNAME=admin           (or SN_${envVarName(instanceURL)}_USERNAME)\n` +
        `  SN_PASSWORD=<password>      (or SN_${envVarName(instanceURL)}_PASSWORD)\n\n` +
        `Then run:\n` +
        `  jsn auth login --password ${instanceURL}`
      );
    }
    saveCredentials(instanceURL, creds, creds.username);
    console.log(`✓ Basic auth credentials saved for ${instanceURL}`);
    return creds;
  }

  /**
   * Complete login using an authorization code obtained from a prior buildAuthURL() call.
   * The PKCE state must have been saved by an earlier buildAuthURL() call.
   */
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
    saveCredentials(instanceURL, newCreds, newCreds.username);
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
    saveCredentials(instance, newCreds, creds.username);
    return newCreds;
  }

  logout(instance) {
    if (!instance) {
      throw errAuth('No instance specified');
    }
    deleteCredentials(instance, this._activeUsername());
  }
}

export { saveCredentials, loadCredentials, deleteCredentials, askHidden };
