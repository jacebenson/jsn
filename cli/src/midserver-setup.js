import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertSafeExactMatch, getStringField } from './helpers.js';

// Read-only: never create parents, chmod existing paths or adopt installations.
export function validateMidInstallDirectory(directory, { allowEmpty = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || path.parse(directory).root === directory) throw new Error('MID installation directory must be an absolute non-root path');
  const resolved = path.resolve(directory);
  let current = resolved;
  let destination = true;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe MID directory component: ${current}`);
      if (destination && (!allowEmpty || fs.readdirSync(current).length)) throw new Error(`MID installation directory already exists: ${resolved}`);
      if (process.platform !== 'win32') {
        if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new Error(`MID directory parent is writable by other users: ${current}`);
        if (destination && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error(`MID installation directory must be private and owned by the current user: ${current}`);
        if (stat.uid !== process.getuid() && stat.uid !== 0) throw new Error(`MID directory parent has another owner: ${current}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    destination = false;
  }
  return resolved;
}

const value = (record, field) => getStringField(record, field);
const bool = text => text === 'true' || text === '1';

export async function diagnoseMidAccount(sdk, instanceURL, username) {
  assertSafeExactMatch(username);
  const list = (table, query, fields, limit = '1000') => sdk.list(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: limit, sysparm_display_value: 'false' }));
  let users;
  try { users = await list('sys_user', `user_name=${username}`, 'sys_id,user_name,active,locked_out,web_service_access_only', '2'); }
  catch { throw new Error('Cannot inspect MID account using the current authenticated session; authorization is unknown (no account or policy changes made)'); }
  if (users.length !== 1) throw new Error(`Expected exactly one sys_user record for MID username '${username}'; inspect sys_user.user_name`);
  const user = users[0], id = value(user, 'sys_id');
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('MID account lookup returned no trustworthy sys_user identifier');
  const recordURL = new URL(`/sys_user.do?sys_id=${id}`, instanceURL).href;
  let roles, properties;
  try {
    roles = await list('sys_user_has_role', `user=${id}`, 'role.name');
    properties = await list('sys_properties', 'nameSTARTSWITHglide.authenticate.basic_auth.', 'name,value');
  } catch { throw new Error(`Cannot inspect MID roles or Basic Auth policy using the current session; authorization is unknown. Inspect ${recordURL}`); }
  if (roles.length >= 1000 || properties.length >= 1000) throw new Error('MID account diagnostics exceeded the read limit; authorization is unknown');
  const policy = Object.fromEntries(properties.map(p => [value(p, 'name'), value(p, 'value')]));
  const roleNames = new Set(roles.map(r => value(r, 'role.name')));
  const issues = [];
  for (const [field, expected] of [['active', true], ['locked_out', false], ['web_service_access_only', true]]) {
    const actual = value(user, field);
    if (!['true', 'false', '1', '0'].includes(actual)) issues.push(`cannot verify sys_user.${field}`);
    else if (bool(actual) !== expected) issues.push(`set sys_user.${field}=${expected}`);
  }
  if (!roleNames.has('mid_server')) issues.push(`missing role mid_server (inspect sys_user_has_role user=${id})`);
  const prefix = 'glide.authenticate.basic_auth.';
  const enforced = bool(policy[`${prefix}restriction.enforce`]);
  const active = bool(policy[`${prefix}restriction.active`]);
  if (policy[`${prefix}restriction.enforce`] === undefined || policy[`${prefix}restriction.active`] === undefined) issues.push('cannot verify Basic Auth restriction active/enforce properties');
  if (active && enforced) {
    const configured = policy[`${prefix}allowed_roles`];
    if (configured === undefined) issues.push('cannot verify configured Basic Auth allowed_roles');
    else {
      const allowed = configured.split(',').map(r => r.trim()).filter(Boolean);
      if (!allowed.some(role => roleNames.has(role))) {
        let exceptions;
        try { exceptions = await list('sys_user_basic_auth_exception', `user=${id}`, 'sys_id,user', '2'); }
        catch { throw new Error(`Cannot inspect sys_user_basic_auth_exception for user=${id}; Basic Auth authorization is unknown. Inspect ${recordURL}`); }
        // A row alone does not establish applicability (expiry/scope vary by release).
        issues.push(exceptions.length
          ? `Basic Auth exception exists but applicability is unknown; inspect sys_user_basic_auth_exception user=${id} and configured allowed roles: ${allowed.join(', ') || '(none)'}`
          : `missing configured Basic Auth role (${allowed.join(', ') || '(none)'}) and no sys_user_basic_auth_exception user=${id}`);
      }
    }
  }
  if (issues.length) throw new Error(`MID account diagnostics: ${issues.join('; ')}. Inspect ${recordURL}. No roles or authentication policies were changed.`);
  return { userSysId: id, policy, roles: [...roleNames], recordURL };
}
