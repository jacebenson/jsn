// Bounded read-only supplementary-count proof. No record bodies or identities
// are printed; existing credentials cannot refresh or initiate UI sessions.
import { loadConfig } from '../../src/config.js';
import { resolveSession } from '../../src/session.js';
import { AuthManager } from '../../src/auth.js';
import { SDKClient } from '../../src/sdk.js';
import { createRecordMetadataReader } from '../../src/metadata/records.js';
import { createRelatedListReader } from '../../src/related-lists.js';
const profile = process.argv[2] || 'pdi';
const session = resolveSession({ profile }, loadConfig());
const auth = new AuthManager({ getUsername: () => session.username,
  getEffectiveInstance: () => session.instance, getAuthMethod: () => session.profile?.auth_method });
const identity = { username: session.username, authMethod: session.profile?.auth_method, refresh: false };
if (session.unknownProfile || auth.getAuthState(session.instance, identity).state !== 'available') {
  process.stdout.write(JSON.stringify({ ok: false, profile, requests_sent: 0, reason: 'Existing authentication unavailable' }) + '\n');
  process.exitCode = 2;
} else {
  const observations = [];
  const sdk = new SDKClient(session.instance, { getCredentials: () => auth.getCredentialsFor(session.instance, session.username, identity) }, { domain: session.domain, timeout: 15000 });
  sdk._sessionPromise = Promise.resolve(null);
  const request = sdk._withAuthenticatedRequest.bind(sdk);
  sdk._withAuthenticatedRequest = (endpoint, options, policy, consume) => request(endpoint, options, policy, response => {
    observations.push({ method: options.method || 'GET', path: new URL(endpoint).pathname, status: response.status });
    return consume(response);
  });
  try {
    const lookup = await sdk.request(`${sdk.baseURL}/api/now/table/sys_db_object?sysparm_query=name%3Dincident&sysparm_fields=sys_id&sysparm_limit=2`, { method: 'GET', readOnly: true });
    if (!Array.isArray(lookup?.result) || lookup.result.length !== 1) throw new Error('Metadata identity was not unambiguous');
    const metadataReader = createRecordMetadataReader(sdk, { limit: 100, maxDepth: 8 });
    const reader = createRelatedListReader(sdk, { metadataReader, maxLists: 5 });
    const output = await reader.read({ table: 'sys_db_object', recordId: lookup.result[0].sys_id, profile, instance: session.instance });
    const aggregateCalls = observations.filter(item => item.path.startsWith('/api/now/stats/'));
    process.stdout.write(JSON.stringify({ ok: aggregateCalls.length <= 5, checked_at: new Date().toISOString(), profile,
      lane: 'existing credentials; no refresh/recovery/UI-session warming', table: 'sys_db_object', metadata_match_count: 1,
      configured_descriptor_limit: 5, configured_metadata_limit: 100, descriptors_considered: output.lists.length,
      available_counts: output.lists.filter(list => list.count !== null).length,
      unavailable_counts: output.lists.filter(list => list.count === null).length,
      nonempty_hints: output.nonempty.length, coverage: output.coverage.state,
      warning_count: output.coverage.warnings.length, aggregate_request_count: aggregateCalls.length,
      aggregate_statuses: aggregateCalls.map(item => item.status),
      aggregate_counts: output.lists.filter(list => list.count !== null).map(list => list.count),
      record_body_fetches: 0, refreshes: 0, writes: 0 }, null, 2) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, profile, error_code: error.code || 'unknown', status: error.status || null, requests_observed: observations.length }) + '\n');
    process.exitCode = 1;
  }
}
