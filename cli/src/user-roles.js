import { errUsage } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';

const API = '/api/global/user_role_inheritance';
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const malformed = (source, detail) => Object.assign(new Error(`Malformed ${source} response: ${detail}`), { code: 'malformed_response' });

// Both identities resolve to raw sys_ids before the roles are read; unsafe input makes no request.
async function resolveTargets(sdk, identifier, roleName) {
  assertSafeExactMatch(identifier);
  if (roleName !== undefined && (typeof roleName !== 'string' || !roleName.trim())) throw errUsage('--role needs a role name or sys_id.');
  if (roleName !== undefined) assertSafeExactMatch(roleName);
  const user = await resolveRecord(sdk, { table: 'sys_user', identifier, matchField: 'user_name', resource: 'User', fields: ['user_name'] });
  const role = roleName === undefined ? null
    : await resolveRecord(sdk, { table: 'sys_user_role', identifier: roleName, matchField: 'name', resource: 'Role', fields: ['name'], partial: false });
  return { user: { sys_id: unwrapSysId(user), user_name: raw(user.user_name) }, ...(role ? { role: { sys_id: unwrapSysId(role), name: raw(role.name) } } : {}) };
}

export async function listUserRoles(sdk, identifier, { role, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw errUsage('--limit must be an integer from 1 to 1000.');
  const target = await resolveTargets(sdk, identifier, role);
  const query = `user=${target.user.sys_id}${target.role ? `^role=${target.role.sys_id}` : ''}^ORDERBYrole^ORDERBYsys_id`;
  const rows = await sdk.listStrict('sys_user_has_role', new URLSearchParams({ sysparm_query: query, sysparm_fields: 'sys_id,user,role,role.name,inherited,inh_count,state', sysparm_limit: String(limit + 1), sysparm_display_value: 'all' }));
  if (rows.some(row => !row || typeof row !== 'object' || raw(row.user) !== target.user.sys_id || (target.role && raw(row.role) !== target.role.sys_id))) {
    throw malformed('sys_user_has_role', 'a row belongs to a different user or role');
  }
  const records = rows.slice(0, limit).map(row => ({ role: text(row['role.name']) || text(row.role), inherited: raw(row.inherited), inh_count: raw(row.inh_count), state: raw(row.state), role_sys_id: raw(row.role), sys_id: unwrapSysId(row) }));
  return { ...target, table: 'sys_user_has_role', count: records.length, columns: ['role', 'inherited', 'inh_count', 'state', 'role_sys_id'], records, pagination: { limit, has_more: rows.length > limit },
    coverage: 'visible_rows_only', visibility: 'Subject to row ACLs; an empty list does not prove the user lacks a role.' };
}

// "/a/b" is a direct grant of a that contains b; "[Group]/a/b" is the same through Group.
// Role names hold no "/" or "]", so a group name ends at the last "]/".
export function parseRolePath(path, from) {
  let group;
  let roles = path;
  if (from === 'from_group') {
    const end = path.lastIndexOf(']/');
    if (!path.startsWith('[') || end < 2) throw malformed(API, `unexpected group path ${JSON.stringify(path)}`);
    group = path.slice(1, end);
    roles = path.slice(end + 1);
  }
  if (!/^(\/[^/\]]+)+$/.test(roles)) throw malformed(API, `unexpected path ${JSON.stringify(path)}`);
  const chain = roles.slice(1).split('/');
  return { via: group !== undefined ? 'group' : chain.length > 1 ? 'role' : 'direct', ...(group !== undefined ? { group } : {}), chain, path };
}

export async function explainUserRoles(sdk, identifier, { role } = {}) {
  const target = await resolveTargets(sdk, identifier, role);
  let reply;
  try {
    reply = await sdk.request(`${sdk.baseURL}${API}?${new URLSearchParams({ user_sysid: target.user.sys_id })}`, { method: 'GET', readOnly: true });
  } catch (error) {
    if (error?.status === 403) error.hint = 'The User Role Inheritance API needs the user_admin role (admin overrides).';
    throw error;
  }
  const result = reply?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw malformed(API, 'no result object');
  // The script answers a null user_name when it finds no such user; never read that as "no roles".
  if (typeof result.user_name !== 'string' || !result.user_name) throw malformed(API, 'no user_name, so the API did not find the user');
  if (result.user_name !== target.user.user_name) throw malformed(API, `the reply is for ${JSON.stringify(result.user_name)}, not ${target.user.user_name}`);
  const byRole = new Map();
  for (const from of ['from_role', 'from_group']) {
    if (!Array.isArray(result[from])) throw malformed(API, `${from} is not an array`);
    for (const path of result[from]) {
      if (typeof path !== 'string') throw malformed(API, `${from} holds a non-string entry`);
      if (!path) continue;
      const parsed = parseRolePath(path, from);
      const name = parsed.chain.at(-1);
      byRole.set(name, [...(byRole.get(name) || []), parsed]);
    }
  }
  const order = (a, b) => a.chain.length - b.chain.length || Number('group' in a) - Number('group' in b) || a.path.localeCompare(b.path);
  const roles = [...byRole].filter(([name]) => !target.role || name === target.role.name)
    .map(([name, paths]) => ({ name, paths: paths.sort(order) })).sort((a, b) => a.name.localeCompare(b.name));
  return { ...target, source: `GET ${API}`, count: roles.length, path_count: roles.reduce((n, r) => n + r.paths.length, 0), roles };
}

const describePath = p => p.via === 'direct' ? 'direct' : `${p.via === 'group' ? `group [${p.group}]: ` : 'contained: '}${p.chain.join(' > ')}`;

export function formatUserRoleWhy(data, identifier) {
  const who = data.user.user_name || data.user.sys_id;
  if (data.role && !data.count) return `${who} does not hold ${data.role.name}: no path in the User Role Inheritance API reply.`;
  const lines = [`${who} holds ${data.count} role(s) through ${data.path_count} path(s) (User Role Inheritance API).`];
  for (const role of data.roles) {
    lines.push('', role.name);
    const shown = data.role ? role.paths : role.paths.slice(0, 3);
    for (const p of shown) lines.push(`  ${describePath(p)}`);
    if (shown.length < role.paths.length) lines.push(`  and ${role.paths.length - shown.length} more: jsn users roles ${identifier} --why --role ${role.name}`);
  }
  return lines.join('\n');
}
