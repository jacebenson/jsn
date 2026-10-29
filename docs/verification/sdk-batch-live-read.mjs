// Explicit read-only proof: no login, refresh, recovery, last-seen writes, or
// UI-session warming. Prints only statuses/counts; never credential/record bodies.
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../src/config.js';
import { resolveSession } from '../../src/session.js';
import { AuthManager } from '../../src/auth.js';
import { SDKClient } from '../../src/sdk.js';
const profile = process.argv[2] || 'pdi';
const session = resolveSession({ profile }, loadConfig());
const auth = new AuthManager({ getUsername: () => session.username,
  getEffectiveInstance: () => session.instance, getAuthMethod: () => session.profile?.auth_method });
const identity = { username: session.username, authMethod: session.profile?.auth_method, refresh: false };
const state = auth.getAuthState(session.instance, identity);
if (session.unknownProfile || state.state !== 'available') {
  process.stdout.write(JSON.stringify({ ok: false, profile, auth_state: state.state, requests_sent: 0 }) + '\n');
  process.exitCode = 2;
} else {
  const observations = [];
  const sdk = new SDKClient(session.instance, {
    getCredentials: () => auth.getCredentialsFor(session.instance, session.username, identity),
  }, { domain: session.domain, timeout: 15000 });
  // Select existing bearer/basic credentials without initiating a UI session.
  sdk._sessionPromise = Promise.resolve(null);
  const authenticatedRequest = sdk._withAuthenticatedRequest.bind(sdk);
  sdk._withAuthenticatedRequest = (endpoint, options, policy, consume) => authenticatedRequest(endpoint, options, policy, response => {
    observations.push({ method: options.method || 'GET', path: new URL(endpoint).pathname, status: response.status });
    return consume(response);
  });
  try {
    const result = await sdk.batch([
      { id: 'metadata', url: '/api/now/table/sys_db_object?sysparm_query=name%3Dincident&sysparm_fields=name&sysparm_limit=1' },
      { id: 'count', url: '/api/now/stats/sys_db_object?sysparm_count=true&sysparm_query=name%3Dincident' },
    ], { fallback: true });
    process.stdout.write(JSON.stringify({ ok: result.counts.failed === 0, checked_at: new Date().toISOString(),
      implementation_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      profile, auth_method: session.profile?.auth_method, lane: 'existing credentials; no refresh/recovery/UI-session warming',
      transport: result.transport, fallback_observed: result.transport !== 'batch', observations,
      counts: result.counts, results: result.results.map(item => ({ id: item.id, ok: item.ok, status: item.status,
        serviced: item.serviced, result_rows: Array.isArray(item.data?.result) ? item.data.result.length : null,
        aggregate_count: item.id === 'count' ? item.data?.result?.stats?.count ?? null : null,
        error_code: item.error?.code ?? null })) }, null, 2) + '\n');
    if (result.counts.failed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, profile, observations, error_code: error.code || 'unknown', status: error.status || null }) + '\n');
    process.exitCode = 1;
  }
}
