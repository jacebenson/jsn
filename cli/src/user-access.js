import { errUsage } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';

const FLAGS = ['active', 'locked_out', 'password_needs_reset', 'failed_attempts', 'last_login_time', 'web_service_access_only', 'internal_integration_user'];
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const malformed = (source, detail) => Object.assign(new Error(`Malformed ${source} response: ${detail}`), { code: 'malformed_response' });

// What each sys_user flag does to sign-in, in the order they are reported.
const CHECKS = [
  ['active', 'false', 'blocks', 'inactive', 'Inactive: every sign-in is refused.'],
  ['locked_out', 'true', 'blocks', 'locked out', 'Locked out: every sign-in is refused until locked_out is cleared, and attempts while locked write no login.failed events.'],
  ['password_needs_reset', 'true', 'blocks_api', 'password needs reset', 'Password needs reset: the UI asks for a new password at the next sign-in, and API calls are refused while glide.authenticate.api.user.reset_password.mandatory is true (the default).'],
  ['web_service_access_only', 'true', 'blocks_ui', 'web services only', 'Web service access only: API calls can sign in; the UI and portals refuse it.'],
  ['internal_integration_user', 'true', 'info', 'internal integration user', 'Internal integration user: internal SOAP calls (MID Server, ODBC) skip WS-Security; this does not block sign-in.'],
];

const NOT_CHECKED = ['password', 'SSO', 'MFA', 'IP access rules'];
const HEADS = { blocked: 'cannot sign in', web_services_only: 'can sign in to web services only, not the UI',
  new_password_required: 'must set a new password at the next UI sign-in; API calls are refused until then' };

export async function explainUserAccess(sdk, identifier, { limit = 10 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw errUsage('--limit must be an integer from 1 to 100.');
  const record = await resolveRecord(sdk, { table: 'sys_user', identifier, matchField: 'user_name', resource: 'User', fields: ['user_name', 'name', ...FLAGS] });
  const missing = FLAGS.filter(f => record[f] === undefined);
  // A flag the reply leaves out is unknown, never "not set".
  if (missing.length) throw malformed('sys_user', `no ${missing.join(', ')} in the reply`);
  const fields = Object.fromEntries(FLAGS.map(f => [f, raw(record[f])]));
  const userName = raw(record.user_name);
  // An empty name would join every login.failed row with a blank parm1 to this user.
  if (!userName || !unwrapSysId(record)) throw malformed('sys_user', 'no user_name or sys_id in the reply');
  const findings = CHECKS.filter(([f, value]) => fields[f] === value).map(([field, , effect, label, message]) => ({ field, effect, label, message }));
  const attempts = Number(fields.failed_attempts) || 0;
  if (attempts > 0 && fields.locked_out !== 'true') {
    findings.push({ field: 'failed_attempts', effect: 'info', label: 'failed attempts', message: `${attempts} failed sign-in attempt(s) since the last successful one; an active lockout script action locks the account at glide.user.max_unlock_attempts (5 by default).` });
  }
  const effects = new Set(findings.map(f => f.effect));
  const ui = !effects.has('blocks') && !effects.has('blocks_ui'), api = !effects.has('blocks') && !effects.has('blocks_api');
  const sign_in = ui && api ? 'not_blocked' : ui ? 'new_password_required' : api ? 'web_services_only' : 'blocked';
  // login.failed rows carry the name as typed in parm1 and no user sys_id, so the name is the only join.
  assertSafeExactMatch(userName);
  const rows = await sdk.listStrict('sysevent', new URLSearchParams({ sysparm_query: `name=login.failed^parm1=${userName}^ORDERBYDESCsys_created_on`,
    sysparm_fields: 'sys_id,name,parm1,parm2,sys_created_on', sysparm_limit: String(limit + 1), sysparm_display_value: 'all' }));
  if (rows.some(row => !row || typeof row !== 'object' || raw(row.name) !== 'login.failed' || raw(row.parm1).toLowerCase() !== userName.toLowerCase())) {
    throw malformed('sysevent', 'a row is not a login.failed event for this user');
  }
  const records = rows.slice(0, limit).map(row => ({ created: raw(row.sys_created_on), source: raw(row.parm2), sys_id: unwrapSysId(row) }));
  return { user: { sys_id: unwrapSysId(record), user_name: userName, name: raw(record.name) }, sign_in, findings, fields, not_checked: NOT_CHECKED,
    login_failures: { table: 'sysevent', event: 'login.failed', count: records.length, records, pagination: { limit, has_more: rows.length > limit },
      coverage: 'retained_visible_rows_only', visibility: "Event rows rotate out after a few days, a locked-out user's attempts write none, and row ACLs can hide rows, so an empty list does not prove there were no failures." } };
}

export function userAccessSummary(data) {
  const who = data.user.user_name || data.user.sys_id;
  if (data.sign_in === 'blocked') return `${who} cannot sign in: ${data.findings.filter(f => f.effect !== 'info').map(f => f.label).join(', ')}`;
  return HEADS[data.sign_in] ? `${who} ${HEADS[data.sign_in]}` : `${who}: no sys_user flag blocks sign-in`;
}

export function formatUserAccess(data) {
  const who = `${data.user.user_name || data.user.sys_id}${data.user.name ? ` (${data.user.name})` : ''}`;
  const head = HEADS[data.sign_in] ? `${who} ${HEADS[data.sign_in]}.` : `${who}: no sys_user flag blocks sign-in. The password itself, SSO, MFA and IP rules are not checked.`;
  const lines = [head, ...data.findings.map(f => `  ${f.message}`), '', 'sys_user (times UTC):'];
  for (const [f, value] of Object.entries(data.fields)) lines.push(`  ${f.padEnd(26)} ${value || '-'}`);
  const { records, pagination } = data.login_failures;
  lines.push('');
  if (!records.length) lines.push("No login.failed events found. Event rows rotate out after a few days, and a locked-out user's attempts write none.");
  else {
    lines.push(`login.failed events, newest first (sysevent, UTC): ${records.length}`);
    for (const r of records) lines.push(`  ${r.created}  from ${r.source || '-'}`);
    if (pagination.has_more) lines.push('  older events not shown (raise --limit, up to 100)');
  }
  return lines.join('\n');
}
