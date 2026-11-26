import { errUsage } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';

// Direct grants are sys_user_has_role rows with inherited=false. Rows the platform adds for a
// group or a containing role are separate rows (inherited=true); these commands never write them.
const TABLE = 'sys_user_has_role';
const MAX_USERS = 100, MAX_ROWS = 1000;
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const malformed = detail => Object.assign(new Error(`Malformed ${TABLE} response: ${detail}`), { code: 'malformed_response' });
const who = u => u.user_name || u.sys_id;

function userNames(values) {
  const names = [...new Set([values].flat().flatMap(v => String(v ?? '').split(',')).map(s => s.trim()).filter(Boolean))];
  if (!names.length) throw errUsage('--user needs at least one user name or sys_id.');
  if (names.length > MAX_USERS) throw errUsage(`At most ${MAX_USERS} users per run; got ${names.length}.`);
  names.forEach(n => assertSafeExactMatch(n));
  return names;
}

// Every user name is checked before the first request (resolveRecord checks the role); then the
// role, each user, and their rows for the role.
async function readTargets(sdk, role, users) {
  const names = userNames(users);
  const roleRecord = await resolveRecord(sdk, { table: 'sys_user_role', identifier: role, matchField: 'name', resource: 'Role', fields: ['name'], partial: false });
  const roleOut = { sys_id: unwrapSysId(roleRecord), name: raw(roleRecord.name) };
  const byId = new Map();
  for (const name of names) {
    const record = await resolveRecord(sdk, { table: 'sys_user', identifier: name, matchField: 'user_name', resource: 'User', fields: ['user_name'], partial: false });
    const sysId = unwrapSysId(record);
    if (!sysId || !roleOut.sys_id) throw Object.assign(new Error('Malformed lookup response: no sys_id in the reply'), { code: 'malformed_response' });
    if (!byId.has(sysId)) byId.set(sysId, { sys_id: sysId, user_name: raw(record.user_name) });
  }
  const targets = [...byId.values()];
  return { role: roleOut, users: targets, rows: await readRows(sdk, roleOut.sys_id, targets.map(u => u.sys_id)) };
}

async function readRows(sdk, roleId, userIds) {
  const rows = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: `role=${roleId}^userIN${userIds.join(',')}`,
    sysparm_fields: 'sys_id,user,role,inherited', sysparm_limit: String(MAX_ROWS + 1), sysparm_display_value: 'all' }));
  if (rows.length > MAX_ROWS) throw errUsage(`More than ${MAX_ROWS} ${TABLE} rows for these users and role; pass fewer users. Nothing written.`);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !unwrapSysId(row) || raw(row.role) !== roleId || !userIds.includes(raw(row.user)) || !['true', 'false'].includes(raw(row.inherited))) {
      throw malformed('a row is not a grant of this role to one of these users');
    }
  }
  return rows;
}

const direct = rows => rows.filter(r => raw(r.inherited) === 'false');

export async function addUserRoles(sdk, { role, user, yes = false }) {
  const t = await readTargets(sdk, role, user);
  const held = new Set(direct(t.rows).map(r => raw(r.user)));
  const grant = t.users.filter(u => !held.has(u.sys_id));
  const skipped = t.users.filter(u => held.has(u.sys_id)).map(u => ({ ...u, reason: 'holds_directly' }));
  const base = { role: t.role, grant, skipped };
  if (!yes) return { ...base, dry_run: true, ...(grant.length ? { rerun: ['userroles', 'add', '--role', t.role.name || t.role.sys_id, '--user', grant.map(who).join(','), '--yes'] } : {}) };
  if (!grant.length) return { ...base, dry_run: false, granted: [], failed: [], unconfirmed: [], verified: true };
  const failed = [], empty = new Set();
  for (const u of grant) {
    try { if (!(await sdk.create(TABLE, { user: u.sys_id, role: t.role.sys_id }))?.sys_id) empty.add(u.sys_id); }
    catch (error) { failed.push({ ...u, error: error.message || String(error) }); }
  }
  const now = new Set(direct(await readRows(sdk, t.role.sys_id, grant.map(u => u.sys_id))).map(r => raw(r.user)));
  const tried = grant.filter(u => !failed.some(f => f.sys_id === u.sys_id));
  // The platform silently aborts a second direct insert and returns no row, so a direct row after an empty reply was already held.
  const held2 = tried.filter(u => empty.has(u.sys_id) && now.has(u.sys_id));
  const granted = tried.filter(u => now.has(u.sys_id) && !empty.has(u.sys_id)), unconfirmed = tried.filter(u => !now.has(u.sys_id));
  return { ...base, skipped: [...skipped, ...held2.map(u => ({ ...u, reason: 'holds_directly' }))], dry_run: false, granted, failed, unconfirmed, verified: !failed.length && !unconfirmed.length };
}

export async function removeUserRoles(sdk, { role, user, yes = false, expectCount }) {
  if (yes && (!Number.isSafeInteger(expectCount) || expectCount < 0)) throw errUsage('remove --yes needs --expect-count <n>, the number of direct rows its preview listed. Nothing removed.');
  const t = await readTargets(sdk, role, user);
  const remove = direct(t.rows).map(r => ({ sys_id: unwrapSysId(r), user: t.users.find(u => u.sys_id === raw(r.user)) }));
  const hasRow = new Set(t.rows.map(r => raw(r.user)));
  const skipped = t.users.filter(u => !remove.some(r => r.user.sys_id === u.sys_id)).map(u => ({ ...u, reason: hasRow.has(u.sys_id) ? 'inherited_only' : 'no_visible_row' }));
  const base = { role: t.role, remove, skipped };
  const users = [...new Set(remove.map(r => who(r.user)))];
  if (!yes) return { ...base, dry_run: true, ...(remove.length ? { rerun: ['userroles', 'remove', '--role', t.role.name || t.role.sys_id, '--user', users.join(','), '--expect-count', String(remove.length), '--yes'] } : {}) };
  if (remove.length !== expectCount) throw errUsage(`Count mismatch: --expect-count ${expectCount}, but ${remove.length} direct row(s) match now. Nothing removed.`);
  if (!remove.length) return { ...base, dry_run: false, removed: [], failed: [], remaining: [], verified: true };
  const failed = [];
  for (const row of remove) {
    try { await sdk.delete(TABLE, row.sys_id); }
    catch (error) { failed.push({ ...row, error: error.message || String(error) }); }
  }
  const ids = remove.map(r => r.sys_id);
  const left = await sdk.listStrict(TABLE, new URLSearchParams({ sysparm_query: `sys_idIN${ids.join(',')}`, sysparm_fields: 'sys_id', sysparm_limit: String(ids.length + 1) }));
  if (left.some(row => !row || typeof row !== 'object' || !ids.includes(unwrapSysId(row)))) throw malformed('the read-back returned a row that was not asked for');
  const remaining = left.map(unwrapSysId);
  const removed = remove.filter(r => !remaining.includes(r.sys_id) && !failed.some(f => f.sys_id === r.sys_id));
  return { ...base, dry_run: false, removed, failed, remaining, verified: !failed.length && !remaining.length };
}

const SKIP = { holds_directly: r => `already holds ${r} directly`, no_visible_row: r => `has no visible ${r} row; row ACLs can hide one`,
  inherited_only: r => `holds ${r} only through a group or a containing role; inherited rows are never removed` };

function section(title, lines) { return lines.length ? [title, ...lines.map(l => `  ${l}`)] : []; }

export function formatUserRoles(data, op) {
  const r = data.role.name || data.role.sys_id;
  const rows = op === 'add' ? data.grant.map(who) : data.remove.map(row => `${who(row.user)}  ${row.sys_id}`);
  const verb = op === 'add' ? `grant ${r} directly to` : `remove the direct ${r} grant from`;
  const done = op === 'add' ? (data.granted || []).map(who) : (data.removed || []).map(row => `${who(row.user)}  ${row.sys_id}`);
  const lines = data.dry_run ? section(`Would ${verb}:`, rows)
    : [...section(op === 'add' ? `Granted ${r} directly to:` : `Removed the direct ${r} grant from:`, done),
      ...section('Failed:', data.failed.map(f => `${who(f.user || f)}  ${f.error}`)),
      ...section('Not confirmed on the read-back:', (data.unconfirmed || []).map(who)),
      ...section('Still present after the delete:', data.remaining || [])];
  const out = [...lines, ...section('Skipped:', data.skipped.map(u => `${who(u)}  ${SKIP[u.reason](r)}`))];
  if (!rows.length) out.unshift(op === 'add' ? `Nothing to grant: every user already holds ${r} directly.` : `Nothing to remove: no visible direct ${r} row for these users.`);
  return [...out, ...(data.rerun ? ['', `Run: ${data.rerun}`] : [])].join('\n');
}

export function userRolesSummary(data, op) {
  const r = data.role.name || data.role.sys_id;
  const todo = op === 'add' ? data.grant.length : data.remove.length;
  const skipped = data.skipped.length ? `, ${data.skipped.length} skipped` : '';
  if (!todo) return op === 'add' ? `Nothing to grant: every user already holds ${r} directly` : `Nothing to remove: no visible direct ${r} row for these users`;
  if (data.dry_run) return op === 'add' ? `Dry run: would grant ${r} directly to ${todo} user(s)${skipped}; nothing written` : `Dry run: would remove ${todo} direct ${r} grant(s)${skipped}; nothing written`;
  if (op === 'add') return data.verified ? `Granted ${r} directly to ${data.granted.length} user(s)${skipped.replace(',', ';')}` : `Grant incomplete or unverified: ${data.granted.length} granted, ${data.failed.length} failed, ${data.unconfirmed.length} unconfirmed`;
  return data.verified ? `Removed ${data.removed.length} direct ${r} grant(s)${skipped.replace(',', ';')}` : `Removal incomplete or unverified: ${data.removed.length} removed, ${data.failed.length} failed, ${data.remaining.length} still present`;
}
