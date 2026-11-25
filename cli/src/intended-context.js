// Intent comes from the task, never from the current provider preferences.
import { assertSafeExactMatch, getStringField } from './helpers.js';
import { errUsageHint } from './errors.js';
import { readEffectiveApplication, readEffectiveUpdateSet } from './context.js';

const CONTEXT_HINT = 'Supply --expect-scope and --expect-update-set from the task. Select context explicitly with scopes set / updatesets set, then retry. --force never overrides missing or mismatched intent.';
const GLOBAL_APPLICATION = 'global';

export function contextFailure(message, hint = CONTEXT_HINT) {
  return errUsageHint(message, hint);
}

/**
 * Prove Global from the live session when `apps.current_app` is absent.
 *
 * ServiceNow represents the Global application selection as the absence of the
 * preference row, so a missing row is only *evidence* of Global when a fresh
 * read of the session application picker says so. Anything else — a picker
 * reporting another application, or a picker that cannot be read — is reported
 * back as a `note` so the caller refuses instead of silently assuming Global
 * and capturing the write into the wrong application.
 */
async function globalFromSession(sdk) {
  try {
    const effective = await readEffectiveApplication(sdk);
    if (effective.sys_id === GLOBAL_APPLICATION) return { value: GLOBAL_APPLICATION };
    return { note: `\nThe session application picker reports ${effective.sys_id}, not Global, and no apps.current_app preference is persisted for this user — the selection cannot be treated as Global.` };
  } catch (error) {
    return { note: `\nThe session application picker could not be read (${error.message}), so Global cannot be confirmed.` };
  }
}

const raw = (record, key) => record?.[key]?.value ?? record?.[key];
export async function exactContextRecord(sdk, table, field, identifier) {
  if (typeof identifier !== 'string' || !identifier.trim()) throw contextFailure(`Missing intended ${table} identifier.`);
  assertSafeExactMatch(identifier);
  const byId = /^[a-f0-9]{32}$/i.test(identifier) || identifier === 'global';
  const records = await sdk.list(table, new URLSearchParams({
    sysparm_query: `${byId ? 'sys_id' : field}=${identifier}${!byId && table === 'sys_scope' ? `^ORname=${identifier}` : ''}`,
    sysparm_limit: '2', sysparm_display_value: 'all',
  }));
  if (records.length !== 1 || !raw(records[0], 'sys_id')) throw contextFailure(`Intended ${table} is missing, unreadable or ambiguous.`);
  return records[0];
}

export async function readWriteContext(sdk) {
  const users = await sdk.list('sys_user', new URLSearchParams({
    sysparm_query: 'user_name=javascript:gs.getUserName()', sysparm_limit: '2',
    sysparm_fields: 'sys_id,user_name,name', sysparm_display_value: 'all',
  }));
  if (users.length !== 1 || !raw(users[0], 'sys_id') || !getStringField(users[0], 'user_name')) throw contextFailure('Current user is unknown.');
  const user = { sys_id: raw(users[0], 'sys_id'), user_name: getStringField(users[0], 'user_name') };
  /**
   * Read one persisted capture-context preference.
   *
   * A missing row is not the same failure as an unreadable one. On a fresh
   * instance nobody has ever picked an update set, so there is genuinely
   * nothing to verify a customization write against — and the old message
   * ("Current sys_update_set preference is unknown") named an internal
   * preference key and pointed at --expect-* flags that cannot create a
   * selection. An agent following that hint retries the same dead end. Each
   * branch below says what is actually wrong and names the command that fixes
   * it.
   */
  async function preference({ key, label, remediation, sessionTruth, sessionFallback }) {
    let rows;
    try {
      rows = await sdk.list('sys_user_preference', new URLSearchParams({
        sysparm_query: `user=${user.sys_id}^name=${key}`, sysparm_limit: '2', sysparm_fields: 'value',
      }));
    } catch (error) {
      throw contextFailure(
        `Could not read the persisted ${label} for ${user.user_name}: ${error.message}`,
        `Confirm the instance is reachable and retry. Do not retry the write until the selection can be read.`,
      );
    }
    if (rows.length === 0) {
      // Only the documented Global representation (absent row + session picker
      // reporting Global) may recover here; an unproven scope still fails.
      const fallback = sessionFallback ? await sessionFallback() : null;
      if (fallback?.value) return fallback.value;
      throw contextFailure(
        `No ${label} is selected for ${user.user_name}, so there is no capture context to verify this write against.${fallback?.note || ''}${await sessionNote(sessionTruth)}`,
        `Select one first, then rerun the same command: ${remediation}. --expect-scope and --expect-update-set assert an existing selection; they cannot create one.`,
      );
    }
    if (rows.length > 1) {
      throw contextFailure(
        `${rows.length} persisted ${label} preferences exist for ${user.user_name}, so the capture context is ambiguous.`,
        `Resolve the duplicate preferences for this user, then retry: ${remediation}`,
      );
    }
    if (!raw(rows[0], 'value') || raw(rows[0], 'value') === '-') {
      throw contextFailure(
        `The ${label} for ${user.user_name} is saved but empty, so the capture context is unreadable.`,
        `Select one again, then rerun the same command: ${remediation}`,
      );
    }
    return raw(rows[0], 'value');
  }
  // Failure-path diagnostic only: the provider's session picker is a different
  // source from the persisted preference, and saying so stops an agent from
  // assuming a fresh session already has a set selected.
  async function sessionNote(readSession) {
    if (!readSession) return '';
    try {
      const effective = await readSession();
      if (!effective?.sys_id) return '';
      return `\nThe session picker reports "${effective.label || effective.name || effective.sys_id}" (${effective.sys_id}); that selection is not persisted for this user and is not used for a customization write.`;
    } catch {
      return '';
    }
  }
  const [scopeId, setId] = await Promise.all([
    preference({
      key: 'apps.current_app', label: 'application scope',
      remediation: 'jsn scopes set "<scope value or name>"',
      sessionFallback: () => globalFromSession(sdk),
    }),
    preference({
      key: 'sys_update_set', label: 'update set',
      remediation: 'jsn updatesets set "<update set name>"',
      sessionTruth: () => readEffectiveUpdateSet(sdk),
    }),
  ]);
  const [scope, set] = await Promise.all([sdk.get('sys_scope', scopeId), sdk.get('sys_update_set', setId)]);
  const applicationId = raw(set, 'application');
  if (!getStringField(scope || {}, 'scope') || !getStringField(set || {}, 'name') || !applicationId || !getStringField(set || {}, 'state')) throw contextFailure('Capture context is incomplete or unreadable.');
  return {
    user, scope: getStringField(scope, 'scope'), application_id: scopeId,
    update_set: { sys_id: setId, name: getStringField(set, 'name'), state: getStringField(set, 'state'), application_id: applicationId },
    source: 'fresh_preferences', domain: { verified: false, status: 'unverified', reason: 'X-Now-Domain is a request header, not proof of effective domain.' },
  };
}

export function assertMutationScope(context, value, label = 'Mutation target') {
  if (!context?.verified) return;
  const scope = value?.value ?? value;
  if (!scope || scope !== context.application_id) throw contextFailure(`${label} scope is unknown or differs from verified intended scope.`);
}

export async function assertMutationRecordScope(app, table, id) {
  if (!app.mutationContext?.verified) return;
  const record = await app.sdk.get(table, id);
  assertMutationScope(app.mutationContext, record?.sys_scope, 'Resolved target');
}

export function intendedContext(app, argv) {
  const saved = app.config.writeContext;
  if (saved !== undefined) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || !saved.profile || saved.profile !== app.session?.profileName
      || !saved.instance_url || saved.instance_url !== app.session?.instance) {
      throw contextFailure('Task-local write_context must bind the selected profile and exact instance_url.');
    }
  }
  return { scope: argv.expectScope ?? saved?.scope, update_set: argv.expectUpdateSet ?? saved?.update_set, domain: argv.expectDomain ?? saved?.domain };
}
