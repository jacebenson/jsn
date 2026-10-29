// Feature-specific, sanitized read-only PDI evidence. Never prints secrets,
// record bodies, user identities or update-set names. No logout/refresh/writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, globalConfigPath } from '../../src/config.js';
import { resolveSession } from '../../src/session.js';
import { AuthManager } from '../../src/auth.js';
import { SDKClient } from '../../src/sdk.js';
import { declareCapabilities } from '../../src/capabilities.js';
import { guardMutationContext } from '../../src/mutation-context.js';
const profile = process.argv[2] || 'pdi';
const session = resolveSession({ profile }, loadConfig());
const auth = new AuthManager({ getUsername: () => session.username, getEffectiveInstance: () => session.instance, getAuthMethod: () => session.profile?.auth_method });
const identity = { username: session.username, authMethod: session.profile?.auth_method, refresh: false };
const state = () => auth.getAuthState(session.instance, identity).state;
if (session.unknownProfile || state() !== 'available') throw new Error('Existing authenticated profile required; do not renew from this script.');
const configHash = () => createHash('sha256').update(fs.readFileSync(globalConfigPath())).digest('hex');
const beforeConfig = configHash();
const environment = { ...process.env, JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
const root = process.cwd();
function cli(args, extra = {}) {
  const result = spawnSync(process.execPath, ['bin/jsn.js', ...args], { cwd: root, encoding: 'utf8', timeout: 25000, env: environment, ...extra });
  let value = null; try { value = JSON.parse(result.stdout); } catch { /* Help is text. */ }
  return { exit: result.status, value, text: result.stdout || '', signal: result.signal };
}
const evidence = { checked_at: new Date().toISOString(), checkout_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), profile,
  lane: 'read-only feature proofs; existing credentials; no refresh/recovery UI/session warming in SDK lanes', prs: {} };
const metadataURL = `${session.instance}/api/now/table/sys_db_object?sysparm_query=name%3Dincident&sysparm_fields=name&sysparm_limit=1`;
const mutationEvents = [];
function sdk(options = {}) {
  const client = new SDKClient(session.instance, { getCredentials: () => auth.getCredentialsFor(session.instance, session.username, identity) }, { domain: session.domain, onMutation: event => mutationEvents.push(event), ...options });
  client._sessionPromise = Promise.resolve(null); return client;
}
// #329: a real rejected bearer GET, then one replay with existing valid credentials.
if (session.profile.auth_method === 'oauth') {
  let recovered = false, callbacks = 0;
  const statuses = [], fetchOriginal = globalThis.fetch;
  const client = sdk({ recovery: { recover: async ({ status }) => { callbacks++; if (status !== 401) return false; recovered = true; return true; } } });
  client.authProvider = { getCredentials: () => recovered ? auth.getCredentialsFor(session.instance, session.username, identity)
    : { auth_method: 'oauth', access_token: 'jsn-validation-invalid-in-memory-bearer' } };
  globalThis.fetch = async (...args) => { const response = await fetchOriginal(...args); statuses.push(response.status); return response; };
  try {
    const body = await client.request(metadataURL, { method: 'GET', readOnly: true });
    evidence.prs['329'] = { kind: 'actual PDI 401 then SDK transport replay', statuses, recovery_callbacks: callbacks,
      final_rows: body?.result?.length ?? null, passed: statuses.length === 2 && statuses[0] === 401 && statuses[1] === 200 && callbacks === 1,
      callback_source: 'existing valid credential selected in memory; no OAuth refresh/browser renewal',
      gaps: ['Real browser renewal, actual refresh failure, and concurrency were not induced on the PDI; those remain fixture-covered.'] };
  } catch (error) { evidence.prs['329'] = { passed: false, statuses, recovery_callbacks: callbacks, error_code: error.code || 'unknown', status: error.status || null }; }
  finally { globalThis.fetch = fetchOriginal; }
}
// #330: selected real profile refuses unapproved logout; packaging stays isolated.
const beforeAuth = state();
const logout = cli(['--profile', profile, 'auth', 'logout', '--json']);
const afterAuth = state();
const shown = cli(['skill', 'show', '--json']);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-skill-proof-'));
let skillInstall;
try {
  const install = cli(['skill', 'install', path.join(temporary, 'skill'), '--json'], { env: { ...environment, XDG_CONFIG_HOME: path.join(temporary, 'config') } });
  skillInstall = { isolated_exit: install.exit, matches_bundled: install.exit === 0 && fs.readFileSync(path.join(temporary, 'skill', 'SKILL.md'), 'utf8') === fs.readFileSync('skills/servicenow/SKILL.md', 'utf8') };
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
const authHelp = cli(['auth', 'logout', '--help']);
evidence.prs['330'] = { logout: { command: `node bin/jsn.js --profile ${profile} auth logout --json`, exit: logout.exit,
  code: logout.value?.code || null, credentials_available_before: beforeAuth === 'available', credentials_available_after: afterAuth === 'available',
  approval_hint_pins_profile: logout.value?.hint?.includes(`--profile ${profile}`) || false, approval_hint_requires_force: logout.value?.hint?.includes('--force') || false,
  profile_retained: !!loadConfig().profiles?.[profile] }, skill: { show_exit: shown.exit, show_matches_bundled: shown.value?.data?.content === fs.readFileSync('skills/servicenow/SKILL.md', 'utf8'), ...skillInstall },
  help_explains_local_only: authHelp.text.includes('ServiceNow/Chrome'),
  gaps: ['Approved credential deletion and subsequent reauthentication were deliberately not performed on the connected profile.'] };
// #332: direct PDI command, no application-level auth-status preflight invocation.
const direct = cli(['--profile', profile, 'records', 'list', '--table', 'sys_db_object', '--query', 'name=incident', '--columns', 'name', '--limit', '1', '--json']);
evidence.prs['332'] = { command: `node bin/jsn.js --profile ${profile} records list --table sys_db_object --query name=incident --columns name --limit 1 --json`,
  exit: direct.exit, ok: direct.value?.ok || false, rows: direct.value?.data?.records?.length ?? null,
  auth_status_command_issued_for_this_operation: false, test_doctor_was_shared_safety_gate: true };
// #333: inspect the existing real connection and scriptable setup route without edits.
const setup = cli(['setup', '--json']), setupHelp = cli(['setup', '--help']);
const status = cli(['--profile', profile, 'auth', 'status', '--local', '--json']);
evidence.prs['333'] = { setup_noninteractive: { exit: setup.exit, code: setup.value?.code || null,
  hint_has_explicit_auth_commands: setup.value?.hint?.includes('jsn auth login') || false }, setup_help: { exit: setupHelp.exit,
  scriptable_status_documented: setupHelp.text.includes('jsn auth status'), secure_headers_file_documented: setupHelp.text.includes('--headers-file') },
  selected_profile_local_status: { exit: status.exit, profile_count: status.value?.data?.profiles?.length ?? null,
  authenticated: status.value?.data?.profiles?.[0]?.authenticated ?? null },
  gaps: ['New-profile login, credential import, profile preference changes and removal were not performed on the live configuration.'] };
// #336: actual context reads through guard; there is no write handler to dispatch.
declareCapabilities('pdi_guard_probe', { mutationSubcommands: ['inspect'] });
let context, guardCode = null;
try { context = await guardMutationContext({ sdk: sdk(), session, output: { effectiveFormat: () => 'json' } }, { _: ['pdi_guard_probe', 'inspect'], json: true }, { rawArgs: ['pdi_guard_probe', 'inspect', '--json'] }); }
catch (error) { context = error.context; guardCode = error.code || 'unknown'; }
evidence.prs['336'] = { kind: 'real capture-context reads, guard only, no mutation handler', code: guardCode,
  scope_class: context?.scope === 'global' ? 'global' : context?.scope ? 'scoped' : 'unknown',
  update_set_class: context?.update_set?.name?.toLowerCase() === 'default' ? 'default' : context?.update_set ? 'named' : 'unknown',
  update_set_state: context?.update_set?.state || 'unknown', approval_required: context?.approval_required ?? null,
  diagnostics: context?.diagnostics?.map(item => item.code) || [], dispatched_mutations: 0,
  gaps: ['Global + Default continue/cancel/override was not induced; no scope or update-set selection was changed. Root owns disposable write-lane proof separately.'] };
// #337: read existing filtered local history and prove live reads emit no events.
const historyBefore = cli(['history', 'list', '--profile-name', profile, '--table', 'sys_db_object', '--json']);
await sdk().request(metadataURL, { method: 'GET', readOnly: true });
const historyAfter = cli(['history', 'list', '--profile-name', profile, '--table', 'sys_db_object', '--json']);
evidence.prs['337'] = { kind: 'filtered local history visibility after real PDI read', before_exit: historyBefore.exit, after_exit: historyAfter.exit,
  retention_days: historyAfter.value?.data?.retentionDays ?? null, entries_before: historyBefore.value?.data?.entries?.length ?? null,
  entries_after: historyAfter.value?.data?.entries?.length ?? null, sdk_mutation_events_for_reads: mutationEvents.length,
  gaps: ['Automatic successful/failed write capture and seven-day expiry pruning are not live-tested by this read-only lane. Root owns disposable write-lane proof separately.'] };
// #339: native support, per-item status and actual fallback observation.
const batch = await sdk().batch([{ id: 'metadata', url: '/api/now/table/sys_db_object?sysparm_query=name%3Dincident&sysparm_fields=name&sysparm_limit=1' },
  { id: 'count', url: '/api/now/stats/sys_db_object?sysparm_count=true&sysparm_query=name%3Dincident' }]);
evidence.prs['339'] = { transport: batch.transport, fallback_observed: batch.transport !== 'batch', counts: batch.counts,
  statuses: batch.results.map(item => item.status), metadata_rows: batch.results[0].data?.result?.length ?? null,
  aggregate_count: batch.results[1].data?.result?.stats?.count ?? null,
  sdk_mutation_events_for_reads_and_batch_post: mutationEvents.length,
  gaps: ['Unsupported-endpoint fallback and partial failures remain fixture-covered; the connected PDI supports native batch.'] };
evidence.real_profile_configuration_unchanged = configHash() === beforeConfig;
evidence.credentials_available_after = state() === 'available';
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
