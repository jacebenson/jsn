// Intent comes from the task, never from the current provider preferences.
import { assertSafeExactMatch, getStringField } from './helpers.js';
import { errUsageHint } from './errors.js';

export function contextFailure(message) {
  return errUsageHint(message, 'Supply --expect-scope and --expect-update-set from the task. Select context explicitly with scopes set / updatesets set, then retry. --force never overrides missing or mismatched intent.');
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
  async function preference(name) {
    const rows = await sdk.list('sys_user_preference', new URLSearchParams({
      sysparm_query: `user=${user.sys_id}^name=${name}`, sysparm_limit: '2', sysparm_fields: 'value',
    }));
    if (rows.length !== 1 || !raw(rows[0], 'value') || raw(rows[0], 'value') === '-') throw contextFailure(`Current ${name} preference is unknown.`);
    return raw(rows[0], 'value');
  }
  const [scopeId, setId] = await Promise.all([preference('apps.current_app'), preference('sys_update_set')]);
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
