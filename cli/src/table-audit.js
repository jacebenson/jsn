// Audit status for one table: what the platform writes to sys_audit and
// sys_audit_delete, from the dictionary, its attribute rows and properties,
// and the switches that change it.
// The platform audits create, update and delete; reads are never audited.

import { errUsage, errUsageHint } from './errors.js';
import { loadHierarchy } from './table-behavior.js';

const NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_ROWS = 2000;
const AUDIT_ATTRIBUTES = ['no_audit', 'audit', 'audit_type', 'no_audit_delete'];
const ENCRYPTED_TYPES = ['password', 'password2', 'glide_encrypted'];
const AUDITED_SYS_FIELDS = ['sys_class_name', 'sys_domain_id'];
const PROPERTIES = ['glide.sys.audit_inserts', 'glide.db.audit.ignore.delete', 'glide.ui.audit_deleted_tables'];
// The documented value of glide.db.audit.ignore.delete while no sys_properties row exists.
export const DEFAULT_IGNORE_DELETE = ['sys_mutex', 'sys_db_cache', 'sys_lucene_block', 'sys_lucene_file', 'sys_lucene_directory', 'sys_user_preference', 'sys_audit', 'sc_cart', 'sc_cart_item', 'sys_trigger', 'wf_context', 'wf_activity', 'wf_condition', 'wf_executing', 'wf_history', 'wf_log', 'wf_transition', 'wf_transition_history', 'cmdb_ci_windows_service', 'cmdb_sam_sw_install', 'cmdb_software_instance', 'cmdb_sam_sw_usage', 'sam_sw_counter_detail'];
// The documented value of glide.ui.audit_deleted_tables while no sys_properties row exists.
export const DEFAULT_AUDIT_DELETED_TABLES = ['sys_user', 'sys_user_group', 'sys_user_role', 'sys_user_has_role', 'sys_user_grmember', 'sys_group_has_role', 'sys_security_acl_role'];
export const EXEMPT = [
  'sys_* fields except sys_class_name and sys_domain_id',
  'encrypted fields',
  'changes made by import sets, update set applies, Import XML and upgrades',
  'reads: the platform audits create, update and delete only',
];

export function parseAttributes(value) {
  const out = {};
  for (const pair of String(value || '').split(',')) {
    const [key, ...rest] = pair.split('=');
    if (key.trim()) out[key.trim()] = rest.length ? rest.join('=').trim() : 'true';
  }
  return out;
}

const raw = (row, field) => {
  const value = row?.[field];
  return String((value && typeof value === 'object' ? value.value : value) ?? '');
};
const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

async function read(sdk, table, query, fields) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(MAX_ROWS + 1) }));
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  if (rows.length > MAX_ROWS) throw errUsage(`More than ${MAX_ROWS} ${table} rows apply to this table; audit status was not computed.`);
  return rows;
}

function fieldVerdict(data, row) {
  const name = raw(row, 'element');
  const owner = raw(row, 'name');
  const attributes = parseAttributes(raw(row, 'attributes'));
  const where = owner === data.table ? name : `${owner}.${name}`;
  if (!data.audited) return { audited: false, reason: `Table auditing is off for ${data.table}${data.parents_audited.length ? `; ${data.parents_audited.join(', ')} audits, but auditing does not inherit` : ''}.` };
  if (name.startsWith('sys_') && !AUDITED_SYS_FIELDS.includes(name)) return { audited: false, reason: 'System fields (sys_*) are never audited, except sys_class_name and sys_domain_id.' };
  if (ENCRYPTED_TYPES.includes(raw(row, 'internal_type'))) return { audited: false, reason: `${where} is an encrypted field (${raw(row, 'internal_type')}); encrypted fields are never audited.` };
  if (data.mode === 'whitelist') {
    return attributes.audit === 'true'
      ? { audited: true, reason: `${data.table} is in whitelist mode and ${where} carries audit=true.` }
      : { audited: false, reason: `${data.table} is in whitelist mode (audit_type=whitelist) and ${where} does not carry audit=true.` };
  }
  if ('no_audit' in attributes) return { audited: false, reason: `${where} carries the no_audit attribute.` };
  return { audited: true, reason: `${data.table} is audited and nothing excludes ${name}.` };
}

export async function readTableAudit(sdk, table, { field } = {}) {
  if (typeof table !== 'string' || !NAME.test(table)) throw errUsage('Provide a table name (letters, digits and underscores).');
  if (field !== undefined && (typeof field !== 'string' || !NAME.test(field))) throw errUsage('--field must be a column name (letters, digits and underscores).');
  const names = (await loadHierarchy(sdk, table)).map(node => node.name);
  table = names[0]; // The instance matches a name in any case; judge it under the instance's spelling.
  const chain = `nameIN${names.join(',')}`;
  const definitions = await read(sdk, 'sys_schema_attribute', `nameIN${AUDIT_ATTRIBUTES.join(',')}`, 'sys_id,name');
  const attributeName = new Map(definitions.map(row => [raw(row, 'sys_id'), raw(row, 'name')]).filter(([, name]) => AUDIT_ATTRIBUTES.includes(name)));
  const links = attributeName.size ? await read(sdk, 'sys_schema_attribute_m2m', `attributeIN${[...attributeName.keys()].join(',')}^schema.${chain}`, 'sys_id,schema,attribute,value') : [];
  // Every row in the chain: CMDB child tables carry their own rows for inherited columns.
  const rows = (await read(sdk, 'sys_dictionary', chain, 'sys_id,name,element,internal_type,audit,attributes')).filter(row => names.includes(raw(row, 'name')));
  const properties = new Map((await read(sdk, 'sys_properties', `nameIN${PROPERTIES.join(',')}`, 'name,value')).map(row => [raw(row, 'name'), raw(row, 'value')]));
  // A stock instance carries glide.sys.audit_inserts; none at all is an ACL-filtered read, not proof the defaults apply.
  if (!properties.size) throw errUsage('No audit properties were readable in sys_properties (reading them needs admin); audit status was not computed.');

  const linked = new Map(links.filter(link => attributeName.has(raw(link, 'attribute'))).map(link => [`${raw(link, 'schema')}:${attributeName.get(raw(link, 'attribute'))}`, raw(link, 'value')]));
  const disagreements = [];
  for (const row of rows) {
    const attributes = parseAttributes(raw(row, 'attributes'));
    for (const attribute of attributeName.values()) {
      const inString = attributes[attribute];
      const inRows = linked.get(`${raw(row, 'sys_id')}:${attribute}`);
      if (inString !== inRows) disagreements.push({ table: raw(row, 'name'), field: raw(row, 'element') || null, attribute, attributes_string: inString ?? null, attribute_row: inRows ?? null });
    }
  }
  const collections = new Map(rows.filter(row => !raw(row, 'element')).map(row => [raw(row, 'name'), row]));
  const own = collections.get(table);
  if (!own) throw errUsage(`No readable collection row for ${table} in sys_dictionary; audit status was not computed.`);
  const ownAttributes = parseAttributes(raw(own, 'attributes'));
  // Nearest table wins when a column has rows on the table and a parent.
  const columns = new Map();
  for (const name of [...names].reverse()) for (const row of rows) if (raw(row, 'name') === name && raw(row, 'element')) columns.set(raw(row, 'element'), row);
  const columnList = [...columns.values()].sort((a, b) => raw(a, 'element').localeCompare(raw(b, 'element')));
  const entry = row => ({ field: raw(row, 'element'), table: raw(row, 'name') });

  const audited = raw(own, 'audit') === 'true';
  const insertsValue = properties.get('glide.sys.audit_inserts');
  const ignoreDelete = properties.has('glide.db.audit.ignore.delete') ? list(properties.get('glide.db.audit.ignore.delete')) : DEFAULT_IGNORE_DELETE;
  const deletedTables = properties.has('glide.ui.audit_deleted_tables') ? list(properties.get('glide.ui.audit_deleted_tables')) : DEFAULT_AUDIT_DELETED_TABLES;
  const deletes = 'no_audit_delete' in ownAttributes ? { recorded: false, reason: `${table} carries the no_audit_delete attribute.` }
    : ignoreDelete.includes(table) ? { recorded: false, reason: `${table} is listed in glide.db.audit.ignore.delete${properties.has('glide.db.audit.ignore.delete') ? '' : ' (its default list; no sys_properties row)'}.` }
      : table.startsWith('sys_') && !deletedTables.includes(table) ? { recorded: false, reason: `${table} is a sys_ table not listed in glide.ui.audit_deleted_tables${properties.has('glide.ui.audit_deleted_tables') ? '' : ' (its default list; no sys_properties row)'}.` }
        : { recorded: true, reason: `Deleted ${table} records are kept in sys_audit_delete${audited ? '' : ', even though table auditing is off'}.` };
  const data = {
    table,
    ancestors: names.slice(1),
    audited,
    parents_audited: names.slice(1).filter(name => raw(collections.get(name), 'audit') === 'true'),
    mode: ownAttributes.audit_type === 'whitelist' ? 'whitelist' : 'all',
    inserts: {
      audited: audited && insertsValue === 'true',
      property: { name: 'glide.sys.audit_inserts', value: insertsValue ?? null, default: insertsValue === undefined },
    },
    updates: { audited },
    deletes: {
      ...deletes,
      no_audit_delete: 'no_audit_delete' in ownAttributes,
      ignore_delete: { value: properties.get('glide.db.audit.ignore.delete') ?? null, default: !properties.has('glide.db.audit.ignore.delete') },
      audit_deleted_tables: { value: properties.get('glide.ui.audit_deleted_tables') ?? null, default: !properties.has('glide.ui.audit_deleted_tables') },
    },
    reads: { audited: false },
    excluded_fields: columnList.filter(row => 'no_audit' in parseAttributes(raw(row, 'attributes'))).map(entry),
    included_fields: columnList.filter(row => parseAttributes(raw(row, 'attributes')).audit === 'true').map(entry),
    encrypted_fields: columnList.filter(row => ENCRYPTED_TYPES.includes(raw(row, 'internal_type'))).map(row => ({ ...entry(row), type: raw(row, 'internal_type') })),
    exempt: EXEMPT,
    attribute_rows: {
      compared: [...attributeName.values()].sort(),
      string_only: AUDIT_ATTRIBUTES.filter(name => ![...attributeName.values()].includes(name)),
      disagreements,
    },
  };
  data.inserts.reason = !audited ? `Table auditing is off for ${table}.`
    : insertsValue === 'true' ? 'glide.sys.audit_inserts is true.'
      : `glide.sys.audit_inserts is ${insertsValue === undefined ? 'not set (default false)' : insertsValue}; inserts are not audited on any table.`;
  if (field) {
    const row = columns.get(field);
    if (!row) throw errUsage(`Field ${field} was not found on ${table} or its parents.`);
    const mismatch = disagreements.filter(item => item.field === field);
    const verdict = fieldVerdict(data, row);
    data.field = { name: field, table: raw(row, 'name'), ...verdict, ...(mismatch.length ? { attribute_disagreements: mismatch } : {}) };
  }
  // The rows a switch writes to, kept off the JSON output.
  Object.defineProperty(data, 'source', { value: { own, columns, attributeIds: new Map([...attributeName].map(([sysId, name]) => [name, sysId])) } });
  return data;
}

// Switch verbs are checked before any request; a bad value writes and reads nothing.
export const FIELD_NAME = NAME;
export function auditSwitchValue(value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw errUsage(`A field must be a column name (letters, digits and underscores); got ${JSON.stringify(value)}. No change was made.`);
  return value;
}

const carries = (row, key) => key === 'audit' ? parseAttributes(raw(row, 'attributes')).audit === 'true' : key in parseAttributes(raw(row, 'attributes'));
const editAttributes = (text, key, add) => [...String(text || '').split(',').map(part => part.trim()).filter(part => part && part.split('=')[0].trim() !== key), ...(add ? [`${key}=true`] : [])].join(',');

// What one switch writes: the dictionary row, its new value, and the attribute row to bring in line.
export function planAuditChange(data, { name, value }) {
  const { own, columns, attributeIds } = data.source;
  const target = row => ({ table: 'sys_dictionary', sys_id: raw(row, 'sys_id'), name: raw(row, 'name'), element: raw(row, 'element') || null });
  if (name === 'on' || name === 'off') {
    return data.audited === (name === 'on') ? { target: target(own), already: `Table auditing is already ${name} for ${data.table}.` } : { target: target(own), set: { audit: String(name === 'on') } };
  }
  const attribute = (row, key, add) => {
    const where = raw(row, 'element') ? `${raw(row, 'name')}.${raw(row, 'element')}` : raw(row, 'name');
    if (carries(row, key) === add) return { target: target(row), already: `${where} ${add ? 'already carries' : 'does not carry'} ${key}${key === 'audit' ? '=true' : ''}.` };
    return { target: target(row), set: { attributes: editAttributes(raw(row, 'attributes'), key, add) }, attribute: key, present: add, attribute_id: attributeIds.get(key) ?? null };
  };
  if (name === 'deletes') return attribute(own, 'no_audit_delete', value === 'off');
  const row = columns.get(value);
  if (!row) throw errUsage(`Field ${value} was not found on ${data.table} or its parents. No change was made.`);
  const owner = raw(row, 'name');
  if (owner !== data.table) throw errUsageHint(`${value} is defined on ${owner}; changing it there changes every table that extends ${owner}. No change was made.`, `To change it for all of them: jsn tables audit ${name} ${owner} ${value}`);
  const whitelist = data.mode === 'whitelist';
  return attribute(row, whitelist ? 'audit' : 'no_audit', (name === 'include') === whitelist);
}

// The string first, then the attribute row, unless the platform already brought it in line.
export async function applyAuditChange(sdk, plan, written = []) {
  await sdk.update('sys_dictionary', plan.target.sys_id, plan.set);
  written.push({ action: 'update', table: 'sys_dictionary', sys_id: plan.target.sys_id, ...plan.set });
  if (!plan.attribute_id) return written;
  const rows = await read(sdk, 'sys_schema_attribute_m2m', `schema=${plan.target.sys_id}^attribute=${plan.attribute_id}`, 'sys_id,schema,attribute');
  if (rows.some(row => raw(row, 'schema') !== plan.target.sys_id || raw(row, 'attribute') !== plan.attribute_id)) throw new Error(`sys_schema_attribute_m2m returned rows for another record or attribute; no attribute row was changed.`);
  if (plan.present && !rows.length) {
    const created = await sdk.create('sys_schema_attribute_m2m', { schema: plan.target.sys_id, attribute: plan.attribute_id, value: 'true' });
    written.push({ action: 'create', table: 'sys_schema_attribute_m2m', sys_id: raw(created, 'sys_id') || null });
  }
  if (!plan.present) {
    for (const row of rows) {
      await sdk.delete('sys_schema_attribute_m2m', raw(row, 'sys_id'));
      written.push({ action: 'delete', table: 'sys_schema_attribute_m2m', sys_id: raw(row, 'sys_id') });
    }
  }
  return written;
}

// Whether a re-read shows the change, with the string and the attribute rows agreeing.
export function auditChangeHolds(after, plan) {
  if (plan.set.audit !== undefined) return after.audited === (plan.set.audit === 'true');
  const row = plan.target.element ? after.source.columns.get(plan.target.element) : after.source.own;
  return carries(row, plan.attribute) === plan.present
    && !after.attribute_rows.disagreements.some(item => item.table === plan.target.name && item.field === plan.target.element && item.attribute === plan.attribute);
}

export function describeAuditChange(plan) {
  if (plan.set.audit !== undefined) return `turn table auditing ${plan.set.audit === 'true' ? 'on' : 'off'} for ${plan.target.name}`;
  const where = plan.target.element ? `${plan.target.name}.${plan.target.element}` : plan.target.name;
  return `${plan.present ? 'add' : 'remove'} ${plan.attribute}${plan.attribute === 'audit' ? '=true' : ''} ${plan.present ? 'to' : 'from'} ${where}`;
}

const fieldsLine = (items, table) => items.length ? items.map(item => item.table === table ? item.field : `${item.field} (${item.table})`).join(', ') : 'none';

export function formatTableAudit(data) {
  const lines = [
    `Audit status: ${data.table}${data.ancestors.length ? ` (extends ${data.ancestors.join(' > ')})` : ''}`,
    `  Table audit      ${data.audited ? 'on' : 'off'} (Audit tick on the ${data.table} collection row; not inherited)`,
  ];
  if (!data.audited && data.parents_audited.length) lines.push(`                   ${data.parents_audited.join(', ')} audits, but ${data.table} does not`);
  lines.push(
    `  Mode             ${data.mode === 'whitelist' ? 'whitelist: only fields with audit=true' : 'all fields'}`,
    `  Inserts          ${data.inserts.audited ? 'audited' : 'not audited'}: ${data.inserts.reason}`,
    `  Updates          ${data.updates.audited ? 'audited' : 'not audited'}`,
    `  Deletes          ${data.deletes.recorded ? 'recorded' : 'not recorded'}: ${data.deletes.reason}`,
    '  Reads            never audited',
    `  Excluded         ${fieldsLine(data.excluded_fields, data.table)} (no_audit)`,
  );
  if (data.mode === 'whitelist' || data.included_fields.length) lines.push(`  Included         ${fieldsLine(data.included_fields, data.table)} (audit=true)`);
  lines.push(`  Encrypted        ${fieldsLine(data.encrypted_fields, data.table)}`, `  Never audited    ${data.exempt.join('; ')}`);
  for (const item of data.attribute_rows.disagreements) {
    lines.push(`  Disagreement     ${item.field ? `${item.table}.${item.field}` : item.table} ${item.attribute}: attributes string ${item.attributes_string ?? 'absent'}, sys_schema_attribute_m2m ${item.attribute_row ?? 'absent'}`);
  }
  if (data.field) lines.push('', `Field ${data.field.name}: ${data.field.audited ? 'audited' : 'not audited'}`, `  ${data.field.reason}`);
  return lines.join('\n');
}
