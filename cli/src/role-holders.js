// Reverse of `jsn users roles`: who holds a role, by any path.
//
// sys_user_has_role already carries one row per (user, role) pair however the
// role was obtained, so a single table read finds group and contained-role
// holders too. The distinct-user count comes from the Stats API grouped by
// `user`, so it does not depend on how many rows this command downloads.

import { errUsage } from './errors.js';
import { resolveRecord, unwrapSysId } from './resolve-record.js';

const TABLE = 'sys_user_has_role';
const ROW_FIELDS = 'sys_id,user,role,granted_by,included_in_role,included_in_role_instance,inherited,inh_count,state';
const USER_FIELDS = 'sys_id,user_name,name,active,web_service_access_only,locked_out';
const GROUP_FIELDS = 'sys_id,name';
const COLUMNS = ['user_name', 'name', 'active', 'via', 'inherited', 'state'];
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const PAGE_SIZE = 1000;
// --effective collapses rows per user, so it needs every row for the role.
// The cap keeps a pathological role from becoming an unbounded download; the
// command refuses rather than reporting a silently partial answer.
const EFFECTIVE_SCAN_CAP = 5000;
// ServiceNow stores an empty reference as the literal "not-applicable" on the
// instances this was verified against; treat it (and a real empty value) as no
// reference.
const NOT_APPLICABLE = 'not-applicable';

const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const text = value => (value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? ''));
const truthy = value => raw(value) === 'true' || raw(value) === '1';
const refId = value => {
  const id = raw(value);
  return id && id !== NOT_APPLICABLE ? id : '';
};
const integer = value => {
  const textValue = raw(value);
  return /^\d+$/.test(textValue) ? Number(textValue) : null;
};
const malformed = detail => Object.assign(new Error(`Malformed ${TABLE} response: ${detail}`), { code: 'malformed_response' });
const userLabel = record => record.user_name || record.name || record.sys_id;

/**
 * How one role row grants the role. `inherited=true` without a group or
 * contained-role reference means the row says the role is inherited but does
 * not name the path.
 */
export function classifyHolder(row) {
  const group = refId(row.granted_by);
  const contained = refId(row.included_in_role);
  if (group) return { via: 'group', group };
  if (contained) {
    return {
      via: 'contained_role',
      included_in_role: contained,
      ...(refId(row.included_in_role_instance) ? { included_in_role_instance: refId(row.included_in_role_instance) } : {}),
    };
  }
  return { via: truthy(row.inherited) ? 'inherited' : 'direct' };
}

function holderQuery(roleSysId, direct) {
  return `role=${roleSysId}${direct ? '^inherited=false^included_in_roleISEMPTY' : ''}`;
}

const groupCount = group => {
  const count = group?.stats?.count;
  return typeof count === 'number' ? count : /^\d+$/.test(String(count ?? '')) ? Number(count) : null;
};

async function readCounts(sdk, query) {
  try {
    const grouped = await sdk.aggregate(TABLE, { query, groupBy: ['user'], count: true });
    // An empty role answers `{ result: [] }`, which the SDK hands back as `{}`.
    // That is zero rows, not an unavailable API; the `{ result: { stats: [...] } }`
    // shape some releases return is accepted too.
    const groups = Array.isArray(grouped?.groups) ? grouped.groups
      : Array.isArray(grouped?.stats) ? grouped.stats
        : grouped && typeof grouped === 'object' ? []
          : null;
    if (groups === null) throw new Error('grouped Stats reply has no groups array');
    // Some releases return a top-level total; others only the per-group counts.
    const reported = grouped?.stats?.count;
    const reportedRows = typeof reported === 'number' ? reported : /^\d+$/.test(String(reported ?? '')) ? Number(reported) : null;
    const counts = groups.map(groupCount);
    const summed = counts.every(count => count !== null) ? counts.reduce((total, count) => total + count, 0) : null;
    const totalRows = reportedRows ?? summed ?? (groups.length ? null : 0);
    if (totalRows === null) throw new Error('grouped Stats reply has no usable record count');
    return { total_rows: totalRows, distinct_users: groups.length, source: 'stats_api_grouped_by_user' };
  } catch (error) {
    return { total_rows: null, distinct_users: null, source: null, error: `Stats API unavailable (${error?.message || String(error)})` };
  }
}

async function loadBySysId(sdk, table, ids, fields) {
  const found = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const rows = await sdk.listStrict(table, new URLSearchParams({
      sysparm_query: `sys_idIN${chunk.join(',')}`,
      sysparm_fields: fields,
      sysparm_display_value: 'false',
      sysparm_limit: String(chunk.length),
    }));
    for (const row of rows) found.set(refId(row.sys_id), row);
  }
  return found;
}

async function readRowPage(sdk, query, { limit, offset = 0 }) {
  const rows = await sdk.listStrict(TABLE, new URLSearchParams({
    sysparm_query: `${query}^ORDERBYuser^ORDERBYsys_id`,
    sysparm_fields: ROW_FIELDS,
    sysparm_display_value: 'false',
    sysparm_limit: String(limit),
    ...(offset ? { sysparm_offset: String(offset) } : {}),
  }));
  if (!Array.isArray(rows)) throw malformed('expected an array of rows');
  return rows;
}

async function readAllRows(sdk, query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await readRowPage(sdk, query, { limit: PAGE_SIZE, offset });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    if (rows.length > EFFECTIVE_SCAN_CAP) return rows;
  }
}

function projectRow(row, roleSysId, users, groups) {
  const userId = refId(row.user);
  if (refId(row.role) !== roleSysId) throw malformed('a row belongs to a different role');
  if (!userId) throw malformed('a row has no user reference');
  const user = users.get(userId);
  const how = classifyHolder(row);
  return {
    sys_id: unwrapSysId(row),
    user: userId,
    user_name: user ? raw(user.user_name) || null : null,
    name: user ? text(user.name) || null : null,
    active: user ? truthy(user.active) : null,
    web_service_access_only: user ? truthy(user.web_service_access_only) : null,
    via: how.via,
    ...(how.group ? { group: how.group, group_name: groups.get(how.group) ? raw(groups.get(how.group).name) || null : null } : {}),
    ...(how.included_in_role ? { included_in_role: how.included_in_role, included_in_role_instance: how.included_in_role_instance || null } : {}),
    inherited: truthy(row.inherited),
    inh_count: integer(row.inh_count),
    state: raw(row.state) || null,
    role_sys_id: roleSysId,
    user_readable: Boolean(user),
  };
}

async function resolveRole(sdk, identifier) {
  const record = await resolveRecord(sdk, {
    table: 'sys_user_role', identifier, matchField: 'name', resource: 'Role',
    fields: ['name', 'description', 'elevated_privilege', 'sys_scope'], partial: false,
  });
  return {
    sys_id: unwrapSysId(record),
    name: raw(record.name),
    description: text(record.description) || null,
    elevated_privilege: truthy(record.elevated_privilege),
    scope: text(record.sys_scope) || null,
  };
}

function notesFor(data, missingUsers) {
  const notes = ['sys_user_has_role rows are role grants, not billable subscription seats.'];
  if (data.counts.error) notes.push(`Distinct user count unavailable: ${data.counts.error}.`);
  if (data.mode === 'effective' && data.users.some(user => user.via.includes('inherited'))) {
    notes.push('Some holders are inherited through a group or contained role that the role row does not name.');
  }
  if (missingUsers) notes.push('Some users referenced by role rows were not readable; their name and active state are unknown.');
  return notes;
}

/**
 * Read-only inventory of the users holding one role.
 *
 * @param {object} sdk
 * @param {string} identifier role name or sys_id
 * @param {{effective?: boolean, direct?: boolean, limit?: number}} options
 */
export async function listRoleHolders(sdk, identifier, { effective = false, direct = false, limit = DEFAULT_LIMIT } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw errUsage(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  const role = await resolveRole(sdk, identifier);
  const query = holderQuery(role.sys_id, direct);
  const counts = await readCounts(sdk, query);
  const common = {
    role, table: TABLE, query, filters: { direct: Boolean(direct) },
    coverage: 'Visible rows only: row ACLs can hide role grants, so an empty result does not prove nobody holds this role.',
  };

  if (!effective) {
    const rows = await readRowPage(sdk, query, { limit: limit + 1 });
    const shown = rows.slice(0, limit);
    const users = await loadBySysId(sdk, 'sys_user', shown.map(row => refId(row.user)), USER_FIELDS);
    const groupIds = shown.map(row => refId(row.granted_by)).filter(Boolean);
    const groups = groupIds.length ? await loadBySysId(sdk, 'sys_user_group', groupIds, GROUP_FIELDS) : new Map();
    const records = shown.map(row => projectRow(row, role.sys_id, users, groups))
      .sort((a, b) => userLabel(a).localeCompare(userLabel(b)) || a.sys_id.localeCompare(b.sys_id));
    const data = {
      ...common, mode: 'rows', counts, count: records.length, columns: COLUMNS, records,
      pagination: {
        limit,
        has_more: rows.length > limit || (counts.total_rows !== null && counts.total_rows > limit),
      },
    };
    data.notes = notesFor(data, records.some(record => !record.user_readable));
    return data;
  }

  const rows = await readAllRows(sdk, query);
  if (rows.length > EFFECTIVE_SCAN_CAP) {
    throw errUsage(`--effective needs every role row and ${TABLE} has more than ${EFFECTIVE_SCAN_CAP} for this role; narrow with --direct or read rows with --limit.`);
  }
  const byUser = new Map();
  for (const row of rows) {
    const userId = refId(row.user);
    if (!userId) throw malformed('a row has no user reference');
    if (refId(row.role) !== role.sys_id) throw malformed('a row belongs to a different role');
    const how = classifyHolder(row);
    byUser.set(userId, [...(byUser.get(userId) || []), how]);
  }
  const users = await loadBySysId(sdk, 'sys_user', [...byUser.keys()], USER_FIELDS);
  const entries = [...byUser].map(([userId, paths]) => {
    const user = users.get(userId);
    return {
      sys_id: userId,
      user_name: user ? raw(user.user_name) || null : null,
      name: user ? text(user.name) || null : null,
      active: user ? truthy(user.active) : null,
      web_service_access_only: user ? truthy(user.web_service_access_only) : null,
      locked_out: user ? truthy(user.locked_out) : null,
      row_count: paths.length,
      via: [...new Set(paths.map(path => path.via))].sort(),
      paths,
      user_readable: Boolean(user),
    };
  }).sort((a, b) => userLabel(a).localeCompare(userLabel(b)) || a.sys_id.localeCompare(b.sys_id));
  const page = entries.slice(0, limit);
  const data = {
    ...common, mode: 'effective', counts: { ...counts, distinct_users: entries.length },
    count: page.length, columns: ['user_name', 'name', 'active', 'via', 'row_count'], users: page,
    pagination: { limit, has_more: entries.length > limit },
  };
  data.notes = notesFor(data, page.some(entry => !entry.user_readable));
  return data;
}

const pad = (value, width) => String(value ?? '').padEnd(width);

export function formatRoleHolders(data) {
  const who = `${data.role.name} (${data.role.sys_id})`;
  const distinct = data.counts.distinct_users === null ? 'unknown' : data.counts.distinct_users;
  const totalRows = data.counts.total_rows === null ? 'unknown' : data.counts.total_rows;
  const lines = [
    `Role ${who}${data.filters.direct ? ' — direct grants only' : ''}`,
    `${distinct} distinct user(s), ${totalRows} role row(s)${data.counts.error ? ' (count unavailable)' : ''}; showing ${data.count}`,
    '',
  ];
  if (data.mode === 'effective') {
    const width = Math.max(4, ...data.users.map(user => userLabel(user).length));
    lines.push(`${pad('USER', width)}  ${pad('USER NAME', 24)}  ${pad('ACTIVE', 6)}  ${pad('ROWS', 4)}  HOW`);
    for (const user of data.users) {
      lines.push(`${pad(userLabel(user), width)}  ${pad(user.user_name || '(unreadable)', 24)}  ${pad(user.active === null ? 'unknown' : user.active, 6)}  ${pad(user.row_count, 4)}  ${user.via.join(', ')}`);
    }
  } else {
    const width = Math.max(4, ...data.records.map(record => userLabel(record).length));
    lines.push(`${pad('USER', width)}  ${pad('USER NAME', 24)}  ${pad('ACTIVE', 6)}  ${pad('VIA', 14)}  ${pad('INHERITED', 9)}  STATE`);
    for (const record of data.records) {
      lines.push(`${pad(userLabel(record), width)}  ${pad(record.user_name || '(unreadable)', 24)}  ${pad(record.active === null ? 'unknown' : record.active, 6)}  ${pad(record.via, 14)}  ${pad(record.inherited, 9)}  ${record.state || '(unknown)'}`);
    }
  }
  if (!data.count) lines.push('No visible role rows. Row ACLs can hide grants; this does not prove nobody holds the role.');
  if (data.pagination.has_more) lines.push('', `More match; raise --limit (max ${MAX_LIMIT})${data.mode === 'effective' ? ' or narrow with --direct' : ''}.`);
  if (data.notes.length) lines.push('', ...data.notes.map(note => `note: ${note}`));
  return lines.join('\n');
}
