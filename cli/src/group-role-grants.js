import { errUsage } from './errors.js';
import { assertSafeExactMatch } from './helpers.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';

// add writes one sys_group_has_role row. Child groups inherit their parent's roles, so the
// preview walks the groups under the target and counts every member of the tree once.
const MAX_GROUPS = 100, MAX_ROWS = 1000;
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const malformed = (table, detail) => Object.assign(new Error(`Malformed ${table} response: ${detail}`), { code: 'malformed_response' });

async function resolveTarget(sdk, table, identifier, resource) {
  const record = await resolveRecord(sdk, { table, identifier, matchField: 'name', resource, fields: ['name'], partial: false });
  const sysId = unwrapSysId(record);
  if (!sysId) throw malformed(table, 'no sys_id in the reply');
  return { sys_id: sysId, name: raw(record.name) };
}

// One request a level, down the parent links; the seen set stops a parent loop.
async function readChildGroups(sdk, rootId) {
  const seen = new Set([rootId]), children = [];
  for (let parents = [rootId]; parents.length;) {
    const rows = await sdk.listStrict('sys_user_group', new URLSearchParams({ sysparm_query: `parentIN${parents.join(',')}`,
      sysparm_fields: 'sys_id,name,parent', sysparm_limit: String(MAX_GROUPS + 1), sysparm_display_value: 'false' }));
    const next = [];
    for (const row of rows) {
      const sysId = unwrapSysId(row);
      if (!row || typeof row !== 'object' || !sysId || !parents.includes(raw(row.parent))) throw malformed('sys_user_group', 'a row is not a child of the groups asked for');
      if (seen.has(sysId)) continue;
      seen.add(sysId);
      next.push(sysId);
      children.push({ sys_id: sysId, name: raw(row.name) });
    }
    if (children.length > MAX_GROUPS) return { children: children.slice(0, MAX_GROUPS), complete: false };
    parents = next;
  }
  return { children, complete: true };
}

async function countMembers(sdk, groupIds) {
  const rows = await sdk.listStrict('sys_user_grmember', new URLSearchParams({ sysparm_query: `groupIN${groupIds.join(',')}`,
    sysparm_fields: 'user,group', sysparm_limit: String(MAX_ROWS + 1), sysparm_display_value: 'false' }));
  const users = new Set();
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (!row || typeof row !== 'object' || !raw(row.user) || !groupIds.includes(raw(row.group))) throw malformed('sys_user_grmember', 'a row is not a membership of these groups');
    users.add(raw(row.user));
  }
  return { members: users.size, complete: rows.length <= MAX_ROWS };
}

// The grant row for this group and role, checked before the write and read back after it.
async function readGrant(sdk, g, r) {
  const rows = await sdk.listStrict('sys_group_has_role', new URLSearchParams({ sysparm_query: `group=${g.sys_id}^role=${r.sys_id}`,
    sysparm_fields: 'sys_id,group,role', sysparm_limit: '2', sysparm_display_value: 'false' }));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !unwrapSysId(row) || raw(row.group) !== g.sys_id || raw(row.role) !== r.sys_id) throw malformed('sys_group_has_role', 'a row is not this group and role');
  }
  return rows;
}

export async function addGroupRole(sdk, { group, role, yes = false }) {
  // Both identifiers are checked before the first request.
  for (const value of [group, role]) {
    assertSafeExactMatch(value);
    if (typeof value !== 'string' || !value.trim()) throw errUsage('--group and --role each need a name or sys_id.');
  }
  const g = await resolveTarget(sdk, 'sys_user_group', group, 'Group');
  const r = await resolveTarget(sdk, 'sys_user_role', role, 'Role');
  if ((await readGrant(sdk, g, r)).length > 0) throw new Error(`Role ${role} is already assigned to group ${group}`);
  if (yes) {
    const record = await sdk.create('sys_group_has_role', { group: g.sys_id, role: r.sys_id });
    // The read-back decides: a create that returned nothing counts only if its row is there.
    return { dry_run: false, group: g, role: r, record, verified: (await readGrant(sdk, g, r)).length > 0 };
  }
  const tree = await readChildGroups(sdk, g.sys_id);
  const count = await countMembers(sdk, [g.sys_id, ...tree.children.map(c => c.sys_id)]);
  return { group: g, role: r, child_groups: tree.children, members: count.members, complete: tree.complete && count.complete, dry_run: true,
    rerun: ['grouproles', 'add', '--group', group, '--role', role, '--yes'] };
}

const label = target => target.name || target.sys_id;
const reach = data => `${data.complete ? '' : 'at least '}${data.members} visible member(s)`;

export function formatGroupRolePreview(data) {
  const [g, r] = [label(data.group), label(data.role)];
  const lead = reach(data);
  return [`Would grant ${r} to ${g}${data.child_groups.length ? ' and the groups under it:' : '.'}`,
    ...data.child_groups.map(c => `  ${label(c)}`),
    `${lead[0].toUpperCase()}${lead.slice(1)} would get ${r} through ${g}; groups and memberships this profile cannot read are not counted.`,
    '', `Run: ${data.rerun}`].join('\n');
}

export function groupRolePreviewSummary(data) {
  const children = data.child_groups.length ? ` and ${data.child_groups.length} child group(s)` : '';
  return `Dry run: would grant ${label(data.role)} to ${label(data.group)}${children}, reaching ${reach(data)}; nothing written`;
}
