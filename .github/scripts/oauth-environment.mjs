// CI-only refresh: credentials never cross a step-output or diagnostic boundary.
import { getOAuthClientID } from '../../cli/src/auth/oauth.js';

export function validatedOrigin(value, { allowLocal = false } = {}) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_url');
  return url.origin;
}

export async function environmentOAuth(env, { allowLocal = false, timeout = 15000, fetchImpl = fetch, warn = message => console.error(message) } = {}) {
  let origin;
  try { origin = validatedOrigin(env.SERVICENOW_INSTANCE_URL, { allowLocal }); }
  catch { throw new Error('invalid_url'); }
  const refresh = env.SERVICENOW_OAUTH_REFRESH_TOKEN;
  if (!refresh) {
    if (!env.SERVICENOW_OAUTH_TOKEN) throw new Error('not_configured');
    return { accessToken: env.SERVICENOW_OAUTH_TOKEN, source: 'legacy_access_token' };
  }
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.SERVICENOW_OAUTH_CLIENT_ID || getOAuthClientID(), refresh_token: refresh });
    const response = await fetchImpl(new URL('/oauth_token.do', origin), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token) || (data.token_type && data.token_type.toLowerCase() !== 'bearer') || (data.expires_in !== undefined && (!Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0))) throw new Error();
    if (data.refresh_token && data.refresh_token !== refresh) warn('OAuth refresh token rotated; replacement is not persisted. Reconfigure the environment refresh secret before the next run.');
    return { accessToken: data.access_token, source: 'refreshed' };
  } catch { throw new Error('authentication_failed'); }
}
