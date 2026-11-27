// Instance-wide Basic Auth restriction report: read the switches, then every
// recorded Basic Auth exception row, join it to sys_user and the allowed roles,
// and give each account a verdict at enforcement time.

import { errUsage } from './errors.js';
import { basicAuthPolicy, evaluateBasicAuthAccount, resolveDecision, BASIC_AUTH_PREFIX } from './basic-auth.js';

const TABLE = 'sys_user_basic_auth_exception';
const ROW_FIELDS = 'sys_id,user,decision,source,action_taken,usage_count,last_seen';
const USER_FIELDS = 'sys_id,user_name,name,active,web_service_access_only';
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
const SCAN_CAP = 1000;
const PAGE_SIZE = 1000;

const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const text = value => (value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? ''));
const asBool = value => raw(value) === 'true' || raw(value) === '1' ? true : raw(value) === 'false' || raw(value) === '0' ? false : null;
const asInt = value => /^\d+$/.test(raw(value)) ? Number(raw(value)) : null;
const errorText = error => {
  const message = error?.message || String(error);
  return error?.status && !message.includes(`HTTP ${error.status}`) ? `${message} (HTTP ${error.status})` : message;
};

async function readPolicy(sdk) {
  try {
    const properties = await sdk.listStrict('sys_properties', new URLSearchParams({
      sysparm_query: `nameSTARTSWITH${BASIC_AUTH_PREFIX}`,
      sysparm_fields: 'name,value',
      sysparm_display_value: 'false',
      sysparm_limit: '200',
    }));
    const policy = basicAuthPolicy(properties);
    return { readable: true, ...policy };
  } catch (error) {
    return { readable: false, error: errorText(error), active: null, enforce: null, allowed_roles: null, allowed_users: [], properties: [] };
  }
}

async function readChoices(sdk) {
  try {
    const rows = await sdk.listStrict('sys_choice', new URLSearchParams({
      sysparm_query: `name=${TABLE}^element=decision^language=en^inactive=false`,
      sysparm_fields: 'value,label',
      sysparm_display_value: 'false',
      sysparm_limit: '100',
    }));
    return { readable: true, choices: rows.map(row => ({ value: raw(row.value), label: text(row.label) })) };
  } catch (error) {
    return { readable: false, error: errorText(error), choices: [] };
  }
}

async function readExceptions(sdk) {
  const rows = [];
  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await sdk.listStrict(TABLE, new URLSearchParams({
        sysparm_query: `ORDERBYDESClast_seen^ORDERBYsys_id`,
        sysparm_fields: ROW_FIELDS,
        sysparm_display_value: 'false',
        sysparm_limit: String(PAGE_SIZE),
        ...(offset ? { sysparm_offset: String(offset) } : {}),
      }));
      rows.push(...page);
      if (page.length < PAGE_SIZE || rows.length >= SCAN_CAP) break;
    }
    return { readable: true, rows, truncated: rows.length >= SCAN_CAP && rows.length % PAGE_SIZE === 0 };
  } catch (error) {
    return { readable: false, error: errorText(error), rows: [], truncated: false };
  }
}

async function loadUsers(sdk, ids) {
  const found = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const rows = await sdk.listStrict('sys_user', new URLSearchParams({
      sysparm_query: `sys_idIN${chunk.join(',')}`,
      sysparm_fields: USER_FIELDS,
      sysparm_display_value: 'false',
      sysparm_limit: String(chunk.length),
    }));
    for (const row of rows) found.set(raw(row.sys_id), row);
  }
  return found;
}

async function loadAllowedRoles(sdk, userIds, allowedRoles) {
  const held = new Map();
  if (!allowedRoles.length) return { readable: true, held };
  const filter = allowedRoles.join(',');
  if (/[\^,=]/.test(filter)) return { readable: false, held, error: 'allowed role names contain query characters' };
  for (let index = 0; index < userIds.length; index += 100) {
    const chunk = userIds.slice(index, index + 100);
    try {
      const rows = await sdk.listStrict('sys_user_has_role', new URLSearchParams({
        sysparm_query: `userIN${chunk.join(',')}^role.nameIN${filter}`,
        sysparm_fields: 'user,role.name',
        sysparm_display_value: 'false',
        sysparm_limit: String(chunk.length * Math.max(allowedRoles.length, 1)),
      }));
      for (const row of rows) {
        const userId = raw(row.user);
        held.set(userId, [...(held.get(userId) || []), raw(row['role.name'])]);
      }
    } catch (error) {
      return { readable: false, held, error: errorText(error) };
    }
  }
  return { readable: true, held };
}

/**
 * @param {object} sdk
 * @param {{blocked?: boolean, limit?: number}} options
 */
export async function basicAuthReport(sdk, { blocked = false, limit = DEFAULT_LIMIT } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw errUsage(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);

  const policy = await readPolicy(sdk);
  const decisions = await readChoices(sdk);
  const exceptions = await readExceptions(sdk);
  const defaultDecision = policy.readable ? resolveDecision(policy.default_decision_raw, decisions.choices) : null;

  let records = [];
  const counts = { scanned: exceptions.rows.length, total: exceptions.rows.length, allowed: 0, blocked: 0, unknown: 0, returned: 0 };
  const notes = [];
  if (exceptions.readable) {
    const userIds = exceptions.rows.map(row => raw(row.user)).filter(Boolean);
    const users = await loadUsers(sdk, userIds);
    const roles = await loadAllowedRoles(sdk, userIds, policy.allowed_roles ?? []);
    if (!roles.readable) notes.push(`Allowed-role membership could not be read (${roles.error}); affected verdicts are unknown.`);
    records = exceptions.rows.map(row => {
      const userId = raw(row.user);
      const user = users.get(userId) || null;
      const decision = row.decision === undefined || row.decision === null || raw(row.decision) === ''
        ? null
        : (() => { const resolved = resolveDecision(raw(row.decision), decisions.choices); return { raw: raw(row.decision), value: resolved.value, label: resolved.label }; })();
      const evaluation = evaluateBasicAuthAccount({
        user: user ? {
          sys_id: userId,
          user_name: raw(user.user_name),
          name: text(user.name),
          active: asBool(user.active),
          web_service_access_only: asBool(user.web_service_access_only),
        } : null,
        roleNames: roles.held.get(userId) || [],
        policy, exception: row, choices: decisions.choices,
      });
      counts[evaluation.verdict] += 1;
      return {
        sys_id: raw(row.sys_id),
        user: userId,
        user_name: user ? raw(user.user_name) || null : null,
        name: user ? text(user.name) || null : null,
        active: user ? asBool(user.active) : null,
        web_service_access_only: user ? asBool(user.web_service_access_only) : null,
        decision,
        source: raw(row.source) || null,
        action_taken: asBool(row.action_taken),
        usage_count: asInt(row.usage_count),
        last_seen: raw(row.last_seen) || null,
        verdict: evaluation.verdict,
        reason: evaluation.reason,
        user_readable: Boolean(user),
      };
    });
    if (!users.size && userIds.length) notes.push('Exception rows reference users that this session cannot read; their verdicts are unknown.');
  }

  const filtered = blocked ? records.filter(record => record.verdict === 'blocked') : records;
  const page = filtered.slice(0, limit);
  counts.returned = page.length;

  if (!policy.readable) notes.push(`The Basic Auth restriction policy could not be read (${policy.error}); verdicts are unknown.`);
  if (policy.readable && policy.active === null) notes.push(`The ${BASIC_AUTH_PREFIX}restriction.active/enforce properties were not found; verdicts are unknown.`);
  if (policy.readable && policy.active !== null && !(policy.active && policy.enforce)) {
    notes.push('The Basic Auth restriction is not in effect, so these verdicts show what enforcement would do, not what is blocked now.');
  }
  if (policy.readable && policy.allow_wsao === false) {
    notes.push('glide.authenticate.basic_auth.allow_wsao is false, but web service access only accounts are treated as exempt per documented platform behaviour; verify on this release.');
  }
  if (!decisions.readable) notes.push(`Decision labels could not be read (${decisions.error}); decisions are shown by raw value.`);
  if (exceptions.readable && counts.total > page.length && !blocked) notes.push(`Showing ${page.length} of ${counts.total} exception row(s); raise --limit (max ${MAX_LIMIT}).`);

  return {
    table: TABLE,
    policy: {
      readable: policy.readable,
      ...(policy.error ? { error: policy.error } : {}),
      active: policy.active ?? null,
      enforce: policy.enforce ?? null,
      in_effect: policy.active === true && policy.enforce === true,
      enforcement_date: policy.enforcement_date ?? null,
      allowed_roles: policy.allowed_roles,
      allowed_users: policy.allowed_users ?? [],
      allow_wsao: policy.allow_wsao ?? null,
      allow_snc_external: policy.allow_snc_external ?? null,
      default_decision: defaultDecision,
      properties: policy.properties ?? [],
    },
    decisions: { readable: decisions.readable, ...(decisions.error ? { error: decisions.error } : {}), choices: decisions.choices },
    exception_table: { readable: exceptions.readable, ...(exceptions.error ? { error: exceptions.error } : {}), truncated: exceptions.truncated },
    counts,
    filters: { blocked: Boolean(blocked) },
    columns: ['user_name', 'name', 'active', 'web_service_access_only', 'decision', 'verdict'],
    records: page,
    notes,
    coverage: 'Exception rows are what the platform recorded after Basic Auth calls; accounts that never used Basic Auth have no row. Table and user ACLs can hide rows, so an empty read does not prove no account uses Basic Auth.',
  };
}

const pad = (value, width) => String(value ?? '').padEnd(width);

export function formatBasicAuthReport(data) {
  const policy = data.policy;
  const lines = [];
  if (!policy.readable) {
    lines.push(`Basic Auth restriction: policy not readable (${policy.error}).`);
  } else {
    const switchText = policy.active === null || policy.enforce === null
      ? 'unknown (restriction properties not found)'
      : `active=${policy.active}, enforce=${policy.enforce}${policy.in_effect ? ' — in effect' : ' — not in effect'}`;
    lines.push(`Basic Auth restriction: ${switchText}${policy.enforcement_date ? `; enforcement date ${policy.enforcement_date}` : ''}`);
    lines.push(`Allowed roles: ${policy.allowed_roles === null ? 'not configured' : policy.allowed_roles.join(', ') || '(none)'}; allowed users: ${policy.allowed_users.join(', ') || '(none)'}; WSAO exempt: ${policy.allow_wsao === false ? 'no (property false)' : 'yes'}`);
    lines.push(`Default decision: ${policy.default_decision?.value ? `${policy.default_decision.value} — ${policy.default_decision.label}` : 'unknown'}`);
  }
  lines.push('');
  if (!data.exception_table.readable) {
    lines.push(`Exception table not readable by this session (${data.exception_table.error}). Per-account verdicts are unknown.`);
  } else {
    lines.push(`Exception rows: ${data.counts.total} read${data.exception_table.truncated ? ' (scan capped)' : ''} — ${data.counts.blocked} blocked, ${data.counts.allowed} allowed, ${data.counts.unknown} unknown; showing ${data.counts.returned}`);
    if (data.records.length) {
      const width = Math.max(4, ...data.records.map(record => (record.user_name || record.user || '').length));
      lines.push(`${pad('USER', width)}  ${pad('ACTIVE', 6)}  ${pad('WSAO', 5)}  ${pad('DECISION', 10)}  ${pad('VERDICT', 7)}  REASON`);
      for (const record of data.records) {
        lines.push(`${pad(record.user_name || record.user || '(unreadable)', width)}  ${pad(record.active === null ? 'unknown' : record.active, 6)}  ${pad(record.web_service_access_only === null ? 'unknown' : record.web_service_access_only, 5)}  ${pad(record.decision?.value || '(none)', 10)}  ${pad(record.verdict, 7)}  ${record.reason}`);
      }
    } else {
      lines.push(data.filters.blocked ? 'No exception row has a blocked verdict.' : 'No Basic Auth exception rows the session can read.');
    }
  }
  if (data.notes.length) lines.push('', ...data.notes.map(note => `note: ${note}`));
  return lines.join('\n');
}
