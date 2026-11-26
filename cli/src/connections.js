// HTTP(s) connections (http_connection) and the credential each one uses, read-only.
// Secrets are never requested: discovery_credentials keeps password, ssh_private_key and other secret columns on the
// base table, and api_key_credentials adds api_key, so every read names its fields. oauth_entity (client_secret) and
// oauth_credential (tokens) are never read; the Application Registry name comes from the profile's reference.
import { errNotFound, errUsage } from './errors.js';

const SYS_ID = /^[0-9a-f]{32}$/;
export const CONNECTION_FIELDS = {
  http_connection: 'sys_id,name,active,connection_alias,connection_url,host,credential',
  discovery_credentials: 'sys_id,name,type,sys_class_name',
  oauth_2_0_credentials: 'sys_id,oauth_entity_profile',
  oauth_entity_profile: 'sys_id,name,grant_type,oauth_entity',
};
// Display labels are presentation only; every join below uses raw sys_ids.
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const EMPTY = 'No readable HTTP connections on this page. ACLs can hide rows, so an empty page does not prove there are none.';

async function read(sdk, table, query, limit, offset = 0) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: CONNECTION_FIELDS[table], sysparm_display_value: 'all', sysparm_limit: String(limit), sysparm_offset: String(offset) }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !SYS_ID.test(raw(row.sys_id)))) {
    throw Object.assign(new Error(`Malformed ${table} response: expected rows with sys_ids`), { code: 'malformed_response' });
  }
  return rows;
}
async function one(sdk, table, id) {
  const [row] = await read(sdk, table, `sys_id=${id}`, 1);
  if (row && raw(row.sys_id) !== id) throw Object.assign(new Error(`${table} returned a different record than ${id}`), { code: 'malformed_response' });
  return row || null;
}

// A credential that is set but not returned (ACL-denied or deleted) keeps its id and name with type and table null.
function connection(row, cred) {
  const credId = raw(row.credential);
  return { sys_id: raw(row.sys_id), name: raw(row.name), active: raw(row.active) === 'true',
    alias: shown(row.connection_alias) || null, alias_sys_id: raw(row.connection_alias) || null,
    url: raw(row.connection_url) || null, host: raw(row.host) || null,
    credential: credId ? { sys_id: credId, name: shown(row.credential), type: cred ? raw(cred.type) || null : null, table: cred ? raw(cred.sys_class_name) || null : null } : null };
}

export async function listConnections(sdk, { limit = 50, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 201) throw errUsage('--offset must be a nonnegative safe integer.');
  const rows = await read(sdk, 'http_connection', 'ORDERBYname^ORDERBYsys_id', limit + 1, offset);
  const page = rows.slice(0, limit);
  const ids = [...new Set(page.map(row => raw(row.credential)).filter(id => SYS_ID.test(id)))];
  const creds = new Map(ids.length ? (await read(sdk, 'discovery_credentials', `sys_idIN${ids.join(',')}`, ids.length)).map(row => [raw(row.sys_id), row]) : []);
  const records = page.map(row => connection(row, creds.get(raw(row.credential))));
  const hasMore = rows.length > limit;
  return { records, count: records.length, pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null } };
}

export async function showConnection(sdk, identifier) {
  if (typeof identifier !== 'string' || !identifier || /[\^\r\n]/.test(identifier)) throw errUsage('Provide an HTTP connection name or 32-character sys_id, with no ^ or line breaks.');
  const bySysId = SYS_ID.test(identifier);
  const rows = await read(sdk, 'http_connection', bySysId ? `sys_id=${identifier}` : `name=${identifier}^ORDERBYsys_id`, 2);
  if (!rows.length) throw errNotFound('HTTP connection', identifier);
  if (rows.length > 1) throw errUsage(`More than one HTTP connection is named ${identifier} (${rows.map(row => raw(row.sys_id)).join(', ')}). Pass a sys_id.`);
  if (bySysId && raw(rows[0].sys_id) !== identifier) throw Object.assign(new Error(`http_connection returned a different record than ${identifier}`), { code: 'malformed_response' });
  const credId = raw(rows[0].credential);
  const data = connection(rows[0], SYS_ID.test(credId) ? await one(sdk, 'discovery_credentials', credId) : null);
  if (data.credential?.type === 'oauth_2_0') {
    // null when the OAuth credential row is not returned; a null profile_sys_id means the credential names no profile.
    const oauth = await one(sdk, 'oauth_2_0_credentials', credId);
    const profileId = raw(oauth?.oauth_entity_profile);
    const profile = SYS_ID.test(profileId) ? await one(sdk, 'oauth_entity_profile', profileId) : null;
    data.credential.oauth = oauth && { profile: profile ? raw(profile.name) : null, profile_sys_id: profileId || null, grant_type: profile ? raw(profile.grant_type) : null,
      application_registry: profile ? shown(profile.oauth_entity) || null : null, application_registry_sys_id: profile ? raw(profile.oauth_entity) || null : null };
  }
  return data;
}

function oauthLines(o) {
  if (!o) return ['  OAuth profile: unknown (the OAuth credential record is not readable)'];
  if (!o.profile_sys_id) return ['  OAuth profile: (none)'];
  if (!o.profile) return [`  OAuth profile: ${o.profile_sys_id} (not readable)`];
  return [`  OAuth profile: ${o.profile} [${o.profile_sys_id}] (grant type ${o.grant_type || 'unknown'})`,
    `  Application registry: ${o.application_registry ? `${o.application_registry} [${o.application_registry_sys_id}]` : '(none)'}`];
}

function credentialLine(c) {
  if (!c) return 'Credential: (none)';
  return `Credential: ${c.name || c.sys_id} [${c.sys_id}] ${c.table ? `(${c.type || 'no type'}, in ${c.table})` : '(record not readable, so its type is unknown)'}`;
}
function connectionLines(c) {
  return [`${c.name} [${c.sys_id}]${c.active ? '' : ' (inactive)'}`, `  URL: ${c.url || c.host || '(none)'}`,
    `  Alias: ${c.alias ? `${c.alias} [${c.alias_sys_id}]` : '(none)'}`, `  ${credentialLine(c.credential)}`];
}
export function formatConnections(data, mode) {
  const lines = ['HTTP connections (read-only; secrets are never read)'];
  if (mode === 'show') {
    lines.push(...connectionLines(data));
    if (data.credential?.type === 'oauth_2_0') lines.push(...oauthLines(data.credential.oauth));
    return lines.join('\n');
  }
  for (const c of data.records) lines.push(...connectionLines(c));
  if (!data.count) lines.push(EMPTY);
  lines.push(`Page: ${data.count} connection(s), offset ${data.pagination.offset}${data.pagination.has_more ? `; more available, next offset ${data.pagination.next_offset}` : '; no further readable rows'}.`);
  return lines.join('\n');
}
