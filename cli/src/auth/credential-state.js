const AUTH_METHODS = new Set(['oauth', 'basic', 'gck']);
const AUTH_SOURCES = new Set(['env_token', 'env_basic', 'gck', 'keyring', 'file', 'unavailable']);

export function normalizeAuthMethod(value, fallback = 'unconfigured') {
  return AUTH_METHODS.has(value) ? value : fallback;
}

export function normalizeAuthSource(value, fallback = 'unavailable') {
  return AUTH_SOURCES.has(value) ? value : fallback;
}

export function sourceMethod(source) {
  return { env_token: 'oauth', env_basic: 'basic', gck: 'gck' }[source] || null;
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

export function probeFailure(code, status = 'failed') {
  return { status, code, classification: PROBE_CLASSIFICATIONS[code] || 'unknown', ...PROBE_FAILURES[code] };
}

export function classifyProbeError(error, method) {
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
    if (now >= (expiresAt - 300) * 1000) return credentials.refresh_token ? 'refreshable' : 'expired';
  }
  return 'available';
}

