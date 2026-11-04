// Read-only table behavior discovery.
//
// Inventories accessible configuration associated with a table and its
// ancestors. It does NOT execute scripts, evaluate conditions, or predict
// which artifact runs for a record. See docs/decisions and GLOSSARY.md.
//
// Design informed by now-sdk-ext-core's TableBehaviorDiscovery (MIT,
// Copyright (c) 2026 SoniSoft Inc). This implementation is written for jsn's
// authenticated readers and output envelope; no source is copied verbatim.

import { createHash } from 'node:crypto';
import { getStringField } from './helpers.js';
import { errUsage } from './errors.js';

export const BEHAVIOR_CATEGORIES = [
  'business_rules',
  'client_scripts',
  'ui_actions',
  'ui_policies',
  'data_policies',
  'dictionary_entries',
  'dictionary_overrides',
  'notifications',
  'access_controls',
  'styles',
  'view_rules',
  'flows',
];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_MAX_BYTES = 524288;
const MIN_MAX_BYTES = 4096;
const MAX_MAX_BYTES = 1048576;
const TABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
// ServiceNow sys_ids are normally 32 hex characters, but some platform records
// (for example sysverb_query/sysverb_post_update) use bounded word ids. Allow
// only characters that cannot change encoded-query structure.
const SAFE_SYS_ID = /^[A-Za-z0-9_]{1,64}$/;
const CATEGORY_ALIASES = new Map([
  ['business_rules', 'business_rules'], ['business-rules', 'business_rules'], ['businessrules', 'business_rules'], ['rules', 'business_rules'],
  ['client_scripts', 'client_scripts'], ['client-scripts', 'client_scripts'], ['clientscripts', 'client_scripts'],
  ['ui_actions', 'ui_actions'], ['ui-actions', 'ui_actions'], ['uiactions', 'ui_actions'], ['actions', 'ui_actions'],
  ['ui_policies', 'ui_policies'], ['ui-policies', 'ui_policies'], ['uipolicies', 'ui_policies'],
  ['data_policies', 'data_policies'], ['data-policies', 'data_policies'], ['datapolicies', 'data_policies'],
  ['dictionary_entries', 'dictionary_entries'], ['dictionary-entries', 'dictionary_entries'], ['dictionaryentries', 'dictionary_entries'], ['dictionary', 'dictionary_entries'], ['columns', 'dictionary_entries'],
  ['dictionary_overrides', 'dictionary_overrides'], ['dictionary-overrides', 'dictionary_overrides'], ['dictionaryoverrides', 'dictionary_overrides'], ['dictionary_overide', 'dictionary_overrides'], ['overrides', 'dictionary_overrides'],
  ['notifications', 'notifications'], ['notification', 'notifications'], ['email_notifications', 'notifications'], ['email-notifications', 'notifications'],
  ['access_controls', 'access_controls'], ['access-controls', 'access_controls'], ['accesscontrols', 'access_controls'], ['acls', 'access_controls'], ['acl', 'access_controls'],
  ['styles', 'styles'], ['style', 'styles'],
  ['view_rules', 'view_rules'], ['view-rules', 'view_rules'], ['viewrules', 'view_rules'], ['viewrule', 'view_rules'],
  ['flows', 'flows'], ['flow', 'flows'], ['record_triggers', 'flows'], ['record-triggers', 'flows'],
]);

const COMMON_FIELDS = ['sys_id', 'sys_class_name', 'name', 'short_description', 'description', 'active', 'sys_scope', 'sys_updated_on', 'order', 'sys_overrides'];

/**
 * Category sources. `target` is the field holding the associated table.
 * `inherit` is the artifact's opt-in inheritance flag for ancestor records;
 * categories without one inherit to descendants through the platform.
 */
const SOURCES = {
  business_rules: {
    label: 'Business rules', layer: 'server', enforcement: 'server',
    summary: 'Server-side rules. Client-side requirements are not proof of server enforcement.',
    sources: [{
      table: 'sys_script', target: 'collection', inherit: null, includeGlobal: true,
      sortPhases: [
        { query: 'when=before', order: ['order', 'name'] },
        { query: 'when=after', order: ['order', 'name'] },
        { query: 'when=async', order: ['order', 'name'] },
        { query: 'when=display', order: ['order', 'name'] },
        { query: 'whenNOT INbefore,after,async,display^whenISNOTEMPTY', order: ['when', 'order', 'name'] },
        { query: 'whenISEMPTY', order: ['order', 'name'] },
      ],
      fields: ['when', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'condition', 'advanced', 'abort_action', 'add_message', 'message', 'change_fields', 'role_conditions'],
      scripts: ['script'],
    }],
  },
  client_scripts: {
    label: 'Client scripts', layer: 'client', enforcement: 'client',
    summary: 'Browser-side scripts. They shape the form but do not enforce server data.',
    sources: [{
      table: 'sys_script_client', target: 'table', inherit: 'applies_extended', sort: ['name', 'order'],
      fields: ['type', 'field', 'ui_type', 'view', 'global', 'applies_extended', 'isolate_script', 'condition'],
      scripts: ['script'],
    }],
  },
  ui_actions: {
    label: 'UI actions', layer: 'client', enforcement: 'client',
    summary: 'Form/list actions. Button visibility and conditions are client-side configuration.',
    sources: [{
      table: 'sys_ui_action', target: 'table', inherit: null, includeGlobal: true, sort: ['order', 'name'],
      fields: ['action_name', 'condition', 'client', 'roles', 'form_button', 'form_link', 'form_context_menu', 'list_button', 'list_link', 'list_context_menu', 'list_banner_button', 'list_choice', 'show_insert', 'show_update', 'sys_overrides', 'ui_type', 'form_button_v2', 'form_menu_button_v2', 'format_for_configurable_workspace'],
      scripts: ['script', 'onclick', 'client_script_v2'],
    }],
  },
  ui_policies: {
    label: 'UI policies', layer: 'client', enforcement: 'client',
    summary: 'Client-side field behavior. Mandatory/read-only actions here are not server enforcement.',
    sources: [{
      table: 'sys_ui_policy', target: 'table', inherit: 'inherit', sort: ['order', 'name'],
      fields: ['conditions', 'on_load', 'reverse_if_false', 'inherit', 'global', 'view', 'run_scripts', 'ui_type'],
      scripts: ['script_true', 'script_false'],
      related: {
        table: 'sys_ui_policy_action', foreignKey: 'ui_policy',
        fields: ['field', 'mandatory', 'disabled', 'visible', 'cleared', 'value_action', 'value', 'field_message_type', 'field_message'],
      },
    }],
  },
  data_policies: {
    label: 'Server data policies', layer: 'server', enforcement: 'server',
    summary: 'Server-side field requirements (mandatory/read-only) from data policies.',
    sources: [{
      table: 'sys_data_policy2', target: 'model_table', inherit: 'inherit', sort: ['order', 'name'],
      fields: ['conditions', 'reverse_if_false', 'inherit', 'apply_import_set', 'apply_soap', 'enforce_ui'],
      related: {
        table: 'sys_data_policy_rule', foreignKey: 'sys_data_policy',
        fields: ['field', 'mandatory', 'disabled'],
      },
    }],
  },
  dictionary_entries: {
    label: 'Dictionary entries', layer: 'schema', enforcement: 'schema',
    summary: 'Column and table dictionary rows. Table-level rows have no element and are labelled explicitly; field labels and types are metadata, not effective UI behavior.',
    sources: [{
      table: 'sys_dictionary', target: 'name', inherit: null, includeGlobal: false, sort: ['element'], filterField: 'element',
      fields: ['element', 'column_label', 'internal_type', 'max_length', 'mandatory', 'reference', 'default_value', 'active', 'sys_scope', 'sys_overrides'],
    }],
  },
  dictionary_overrides: {
    label: 'Dictionary overrides', layer: 'schema', enforcement: 'schema',
    summary: 'Raw sys_dictionary_override rows for this table and its ancestors. Override fields are preserved as stored; effective dictionary resolution is not computed.',
    sources: [{
      table: 'sys_dictionary_override', target: 'name', inherit: null, includeGlobal: false, sort: ['element'], filterField: 'element', activeField: 'active',
      fields: ['element', 'base_table', 'mandatory', 'mandatory_override', 'read_only', 'read_only_override', 'read_only_option', 'default_value', 'default_value_override', 'reference_qual', 'reference_qual_override', 'calculation', 'calculation_override', 'attributes', 'attributes_override', 'dependent', 'display_override'],
    }],
  },
  notifications: {
    label: 'Email notifications', layer: 'server', enforcement: 'server',
    summary: 'Email notification actions. Message bodies are measured only; they are never returned inline.',
    sources: [{
      table: 'sysevent_email_action', target: 'collection', inherit: null, includeGlobal: false, sort: ['name'],
      fields: ['event_name', 'type', 'condition', 'advanced_condition', 'subject', 'weight', 'recipient_fields', 'event_parm_1', 'event_parm_2', 'template', 'item', 'item_table', 'category', 'importance', 'digestable'],
      scripts: ['message', 'message_html', 'message_text'],
    }],
  },
  access_controls: {
    label: 'Access controls', layer: 'server', enforcement: 'server',
    summary: 'ACL rows matching global, table and field clauses. Rows are configuration evidence, not proof of effective access.',
    sources: [{
      table: 'sys_security_acl', target: 'name', inherit: null, includeGlobal: false, sort: ['name', 'operation'],
      associationQuery: ({ table, ancestors, directOnly }) => {
        const clauses = [];
        if (!directOnly) clauses.push('name=*', 'nameSTARTSWITH*.');
        clauses.push(`name=${table}`, `nameSTARTSWITH${table}.`);
        if (!directOnly) {
          for (const ancestor of ancestors) clauses.push(`name=${ancestor}`, `nameSTARTSWITH${ancestor}.`);
        }
        return clauses.join('^OR');
      },
      fields: ['operation', 'type', 'admin_overrides', 'decision_type', 'condition', 'applies_to', 'description'],
      scripts: ['script'],
    }],
  },
  styles: {
    label: 'UI styles', layer: 'client', enforcement: 'client',
    summary: 'Field style definitions for this table and its ancestors. Style values are shipped to the browser, not server enforcement.',
    sources: [{
      table: 'sys_ui_style', target: 'name', inherit: null, includeGlobal: false, sort: ['name', 'element'], activeField: 'active',
      fields: ['element', 'value', 'style', 'alt', 'themed_style'],
    }],
  },
  view_rules: {
    label: 'View rules', layer: 'client', enforcement: 'client',
    summary: 'List view rules. An empty result is a real accessible-empty inventory; inaccessible or malformed reads are reported separately.',
    sources: [{
      table: 'sysrule_view', target: 'table', inherit: null, includeGlobal: false, sort: ['view'], filterField: 'view',
      fields: ['view', 'advanced', 'condition', 'script', 'match_conditions', 'device_type', 'overrides_user_preference'],
    }],
  },
  flows: {
    label: 'Flow record triggers', layer: 'server', enforcement: 'server',
    summary: 'Record-triggered flows. Only sys_flow_record_trigger rows are inventoried; template and other trigger types are unsupported and are never guessed by text joins.',
    triggerSupport: {
      supported: ['record'],
      unsupported: [
        { type: 'template', table: 'sys_hub_trigger_template', reason: 'Template triggers attach to trigger templates, not a table field; no text join is guessed.' },
        { type: 'catalog', table: 'sys_flow_catalog_trigger', reason: 'Catalog triggers are request/catalog scoped, not record triggers.' },
        { type: 'email', table: 'sys_flow_email_trigger', reason: 'Email triggers are inbound-event scoped, not table-field scoped.' },
        { type: 'knowledge', table: 'sys_flow_knowledge_trigger', reason: 'Knowledge triggers are article-event scoped, not table-field scoped.' },
        { type: 'rest', table: 'sys_flow_rest_trigger', reason: 'REST triggers are endpoint scoped, not table-field scoped.' },
        { type: 'timer', table: 'sys_flow_timer_trigger', reason: 'Timer triggers are schedule scoped, not table-field scoped.' },
        { type: 'enhanced_timer', table: 'sys_flow_enhanced_timer_trigger', reason: 'Enhanced timer triggers are schedule scoped, not table-field scoped.' },
      ],
    },
    sources: [{
      table: 'sys_flow_record_trigger', target: 'table', inherit: null, includeGlobal: false, sort: ['name'], activeField: 'active',
      fields: ['on_insert', 'on_update', 'on_delete', 'condition', 'run_flow_in', 'run_on_extended', 'run_when_user_list', 'run_when_setting'],
    }],
  },
};

function rawValue(record, field) {
  if (!record || typeof record !== 'object') return undefined;
  const value = record[field];
  if (value && typeof value === 'object') return value.value ?? value.display_value;
  return value;
}

function text(record, field) {
  return getStringField(record, field);
}

function bool(record, field) {
  const value = rawValue(record, field);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

function integer(record, field) {
  const value = text(record, field);
  if (!value) return undefined;
  const parsed = parseInt(value.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function tableName(value) {
  const name = String(value || '');
  if (!name) return name;
  if (name.length > 160 || !TABLE_NAME.test(name)) {
    throw errUsage(`Invalid table name: ${name}`, 'Use a table name such as incident or x_custom_table.');
  }
  return name;
}

export function normalizeCategories(input) {
  const requested = input === undefined || input === null || input === ''
    ? [...BEHAVIOR_CATEGORIES]
    : (Array.isArray(input) ? input : [input])
      .flatMap(value => String(value).split(','))
      .map(value => value.trim())
      .filter(Boolean);
  const categories = [];
  for (const value of requested) {
    const category = CATEGORY_ALIASES.get(value.toLowerCase());
    if (!category) {
      throw errUsage(`Unknown behavior category: ${value}`, `Use one of: ${BEHAVIOR_CATEGORIES.join(', ')}`);
    }
    if (!categories.includes(category)) categories.push(category);
  }
  if (!categories.length) throw errUsage('Select at least one behavior category.');
  return categories;
}

async function loadHierarchy(sdk, requested) {
  const nodes = [];
  const seen = new Set();
  let query = `name=${requested}`;
  for (let depth = 0; depth < 32; depth++) {
    const rows = await sdk.listStrict('sys_db_object', new URLSearchParams({
      sysparm_query: query,
      sysparm_limit: '1',
      sysparm_fields: 'sys_id,name,label,super_class,sys_scope',
      sysparm_display_value: 'all',
    }));
    if (!rows.length) {
      throw errUsage(`Table hierarchy not found or not accessible: ${requested}`,
        'Check the table name and the account\'s access to sys_db_object.');
    }
    const row = rows[0];
    const name = text(row, 'name');
    if (!TABLE_NAME.test(name) || seen.has(name)) {
      throw new Error(`Invalid or cyclic table hierarchy while resolving ${requested}.`);
    }
    seen.add(name);
    nodes.push({ name, sys_id: text(row, 'sys_id'), label: text(row, 'label') || undefined });
    const parent = rawValue(row, 'super_class');
    if (!parent) return nodes;
    if (!SAFE_SYS_ID.test(String(parent))) throw new Error(`Invalid parent table reference while resolving ${requested}.`);
    query = `sys_id=${parent}`;
  }
  throw new Error(`Table hierarchy exceeds 32 levels: ${requested}`);
}

function categorySignature(table, category, options, ancestors) {
  return createHash('sha256').update(JSON.stringify({
    table, category, directOnly: options.directOnly, includeInactive: options.includeInactive,
    name: options.name || null, limit: options.limit, ancestors,
  })).digest('hex').slice(0, 16);
}

function decodeCursor(token, category, signature) {
  if (!token) return { phase: 0, offset: 0 };
  if (typeof token !== 'string' || token.length > 512) throw errUsage('Invalid cursor token.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw errUsage('Invalid cursor token.');
  }
  const version = parsed?.v;
  const phase = version === 1 ? 0 : parsed?.p;
  if (!parsed || ![1, 2].includes(version) || parsed.c !== category || parsed.s !== signature
    || !Number.isInteger(parsed.o) || parsed.o < 0 || parsed.o > 1000000
    || !Number.isInteger(phase) || phase < 0 || phase > 16) {
    throw errUsage('Cursor does not match this table, category, or filter set.',
      'Restart discovery without a cursor or keep the original filters.');
  }
  return { phase, offset: parsed.o };
}

function encodeCursor(category, phase, offset, signature) {
  return Buffer.from(JSON.stringify({ v: 2, c: category, p: phase, o: offset, s: signature }), 'utf8').toString('base64url');
}

function sourceError(error, sourceTable) {
  const status = error?.status;
  if (status === 403 || status === 401) {
    return { code: 'permission_denied', message: `Read access denied while reading ${sourceTable}; results are not evidence of absence.`, source_table: sourceTable };
  }
  if (status === 404) {
    return { code: 'not_found', message: `${sourceTable} is not installed or not visible to this account.`, source_table: sourceTable };
  }
  if (error?.code === 'malformed_response') {
    return { code: 'malformed_response', message: `Malformed response while reading ${sourceTable}.`, source_table: sourceTable };
  }
  return { code: 'request_failed', message: `Read failed for ${sourceTable}. Check connection and metadata access.`, source_table: sourceTable };
}

async function dictionaryFields(sdk, table) {
  const params = new URLSearchParams({
    sysparm_query: `nameIN${table}^elementISNOTEMPTY`,
    sysparm_limit: '2001',
    sysparm_fields: 'element',
  });
  const rows = await sdk.listStrict('sys_dictionary', params);
  if (rows.length > 2000) throw errUsage(`Field inventory for ${table} exceeds the supported bound.`);
  const fields = new Set(rows.map(row => text(row, 'element')).filter(Boolean));
  fields.add('sys_id');
  return fields;
}

function quoteList(values) {
  return values.join(',');
}

function associationFor(source, rowTable, requested, ancestors) {
  if (rowTable === requested) return { association: 'direct', detail: 'exact_table', inherited: false };
  if (source.includeGlobal && rowTable === 'global') {
    return { association: 'inherited', detail: 'global_actions', inherited: true };
  }
  if (ancestors.includes(rowTable)) {
    if (source.inherit === 'applies_extended') return { association: 'inherited', detail: 'ancestor_applies_extended', inherited: true };
    if (source.inherit === 'inherit') return { association: 'inherited', detail: 'ancestor_inherit_flag', inherited: true };
    return { association: 'inherited', detail: 'ancestor_table', inherited: true };
  }
  return { association: 'inherited', detail: 'unrecognized_association', inherited: true };
}

/**
 * ACL clauses are names such as `incident`, `incident.*`, `incident.field`,
 * `*.field` or `*`. Keep the global/table/field distinction explicit instead
 * of reducing every row to a generic inherited association.
 */
function aclAssociation(name, requested, ancestors) {
  if (!name) return { association: 'inherited', detail: 'unrecognized_association', inherited: true };
  if (name === '*') return { association: 'global', detail: 'global_all', inherited: true };
  if (name.startsWith('*.')) return { association: 'global', detail: 'global_field', inherited: true };
  for (const [index, table] of [requested, ...ancestors].entries()) {
    const prefix = index === 0 ? 'direct' : 'ancestor';
    const association = index === 0 ? 'direct' : 'inherited';
    if (name === table) return { association, detail: `${prefix}_table`, inherited: index !== 0 };
    if (name === `${table}.*`) return { association, detail: `${prefix}_table_wildcard`, inherited: index !== 0 };
    if (name.startsWith(`${table}.`)) return { association, detail: `${prefix}_field`, inherited: index !== 0 };
  }
  return { association: 'inherited', detail: 'unrecognized_association', inherited: true };
}

function overrideEvidence(row, fields) {
  if (!fields.has('sys_overrides')) return undefined;
  const override = text(row, 'sys_overrides');
  if (!override) return undefined;
  return {
    sys_overrides: rawValue(row, 'sys_overrides') || override,
    note: 'Override link preserved as evidence; effective resolution is not simulated.',
  };
}

/**
 * Ordering is expressed in the instance query, not applied to a returned page.
 * ServiceNow sorts empty values first for ORDERBY, so a primary sort key gets
 * an ISEMPTY phase after its ISNOTEMPTY phase to keep missing keys last.
 */
function sortPhases(source) {
  if (source.sortPhases?.length) return source.sortPhases;
  const sort = source.sort || [];
  if (!sort.length) return [{ query: '', order: [] }];
  const [primary, ...rest] = sort;
  return [
    { query: `${primary}ISNOTEMPTY`, order: sort },
    { query: `${primary}ISEMPTY`, order: rest },
  ];
}

function associationParts(source, requested, ancestors, directOnly) {
  if (source.associationQuery) {
    return [source.associationQuery({ table: requested, ancestors, directOnly })];
  }
  if (directOnly) return [`${source.target}=${requested}`];
  if (source.inherit) {
    const parts = [`${source.target}=${requested}`];
    if (ancestors.length) parts.push(`${source.target}IN${quoteList(ancestors)}^${source.inherit}=true`);
    if (source.includeGlobal) parts.push(`${source.target}=global`);
    return parts;
  }
  const associated = source.includeGlobal ? [...ancestors, 'global'] : ancestors;
  return [`${source.target}IN${quoteList([requested, ...associated])}`];
}

function phaseQuery(parts, filters, phase) {
  const order = [...new Set([...(phase.order || []), 'sys_id'])].map(field => `ORDERBY${field}`);
  return parts
    .map(part => [part, ...filters, phase.query, ...order].filter(Boolean).join('^'))
    .join('^NQ');
}

function requiredField(source, fields, field) {
  return fields.has(field) || field === source.target || field === source.activeField
    || (source.sort || []).includes(field)
    || (source.sortPhases || []).some(phase => (phase.order || []).includes(field))
    || field === 'sys_id';
}

async function readOrderedRows(sdk, source, context) {
  const { requested, ancestors, directOnly, includeInactive, name, fields, limit, cursor } = context;
  const phases = sortPhases(source);
  const parts = associationParts(source, requested, ancestors, directOnly);
  const filters = [];
  const activeField = source.activeField || (fields.has('active') ? 'active' : null);
  if (!includeInactive) {
    if (activeField) filters.push(`${activeField}=true`);
  }
  if (name) {
    const nameField = source.filterField
      || (fields.has('name') ? 'name' : fields.has('short_description') ? 'short_description' : null);
    if (nameField) filters.push(`${nameField}LIKE${name}`);
  }

  const collected = [];
  // A row can satisfy more than one ordering phase on a live instance (an empty
  // value still matches ISNOTEMPTY for some field types), so keep the first
  // occurrence and drop repeats. Ordering is preserved.
  const seenIds = new Set();
  for (let phaseIndex = cursor.phase; phaseIndex < phases.length && collected.length <= limit; phaseIndex++) {
    const phase = phases[phaseIndex];
    const offset = phaseIndex === cursor.phase ? cursor.offset : 0;
    const remaining = limit + 1 - collected.length;
    if (remaining <= 0) break;
    const query = phaseQuery(parts, filters, phase);
    const rows = await sdk.listStrict(source.table, new URLSearchParams({
      sysparm_query: query,
      sysparm_fields: context.wanted.join(','),
      sysparm_limit: String(remaining),
      sysparm_offset: String(offset),
      sysparm_display_value: 'all',
      sysparm_exclude_reference_link: 'true',
      sysparm_no_count: 'true',
    }));
    for (let index = 0; index < rows.length; index++) {
      const rowId = text(rows[index], 'sys_id');
      if (rowId) {
        if (seenIds.has(rowId)) continue;
        seenIds.add(rowId);
      }
      collected.push({ row: rows[index], phase: phaseIndex, index: offset + index });
    }
    if (rows.length < remaining) continue;
    break;
  }

  const hasMore = collected.length > limit;
  const extra = hasMore ? collected[limit] : null;
  return {
    page: collected.slice(0, limit),
    hasMore,
    next: extra ? { phase: extra.phase, offset: extra.index } : null,
  };
}

function scriptSummary(row, source, fields) {
  const available = (source.scripts || []).filter(field => fields.has(field));
  let present = false;
  let bytesTotal = 0;
  for (const field of available) {
    const value = text(row, field);
    if (value) present = true;
    bytesTotal += Buffer.byteLength(value || '', 'utf8');
  }
  return { has_script: present, script_bytes: bytesTotal, script_fields: available };
}

function summarize(category, source, row, fields, context) {
  const { requested, ancestors } = context;
  const rowTable = source.target ? text(row, source.target) : '';
  const sysId = text(row, 'sys_id');
  if (!SAFE_SYS_ID.test(sysId)) throw new Error(`Metadata record in ${source.table} lacks a valid sys_id.`);
  const rowName = text(row, 'name');
  const association = category === 'access_controls'
    ? aclAssociation(rowName, requested, ancestors)
    : associationFor(source, rowTable, requested, ancestors);
  const item = {
    reference: { kind: category, source_table: source.table, sys_id: sysId },
    source_table: source.table,
    name: rowName || text(row, 'short_description') || sysId,
    table: rowTable || undefined,
    association: association.association,
    association_detail: association.detail,
    inherited: association.inherited,
    active: bool(row, 'active'),
    scope: text(row, 'sys_scope') || undefined,
    order: integer(row, 'order'),
    updated_on: text(row, 'sys_updated_on') || undefined,
    override_evidence: overrideEvidence(row, fields),
  };
  const has = field => fields.has(field);

  if (category === 'business_rules') {
    item.when = text(row, 'when') || undefined;
    item.operations = ['action_insert', 'action_update', 'action_delete', 'action_query']
      .filter(field => has(field) && bool(row, field) === true)
      .map(field => field.replace('action_', ''));
    item.condition = text(row, 'filter_condition') || text(row, 'condition') || undefined;
    item.advanced = bool(row, 'advanced');
    item.abort_action = bool(row, 'abort_action');
    item.message = has('add_message') && bool(row, 'add_message') === true ? (text(row, 'message') || undefined) : undefined;
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'client_scripts') {
    item.type = text(row, 'type') || undefined;
    item.field = text(row, 'field') || undefined;
    item.ui_type = text(row, 'ui_type') || undefined;
    item.view = text(row, 'view') || undefined;
    item.applies_extended = bool(row, 'applies_extended');
    item.isolate_script = bool(row, 'isolate_script');
    item.condition = text(row, 'condition') || undefined;
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'ui_actions') {
    item.action_name = text(row, 'action_name') || undefined;
    item.client = bool(row, 'client');
    item.ui_type = text(row, 'ui_type') || undefined;
    item.condition = text(row, 'condition') || undefined;
    item.roles = text(row, 'roles') || undefined;
    item.show_insert = bool(row, 'show_insert');
    item.show_update = bool(row, 'show_update');
    item.placements = ['form_button', 'form_link', 'form_context_menu', 'list_button', 'list_link', 'list_context_menu', 'list_banner_button', 'list_choice']
      .filter(field => has(field) && bool(row, field) === true);
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'ui_policies') {
    item.conditions = text(row, 'conditions') || undefined;
    item.on_load = bool(row, 'on_load');
    item.reverse_if_false = bool(row, 'reverse_if_false');
    item.inherit = bool(row, 'inherit');
    item.global = bool(row, 'global');
    item.view = text(row, 'view') || undefined;
    item.run_scripts = bool(row, 'run_scripts');
    item.ui_type = text(row, 'ui_type') || undefined;
    item.field_actions = (context.related.get(sysId) || []).map(action => ({
      field: text(action, 'field') || undefined,
      mandatory: text(action, 'mandatory') || undefined,
      disabled: text(action, 'disabled') || undefined,
      visible: text(action, 'visible') || undefined,
      cleared: text(action, 'cleared') || undefined,
      value_action: text(action, 'value_action') || undefined,
      value: text(action, 'value') || undefined,
      field_message_type: text(action, 'field_message_type') || undefined,
      field_message: text(action, 'field_message') || undefined,
      reference: SAFE_SYS_ID.test(text(action, 'sys_id')) ? { kind: category, source_table: 'sys_ui_policy_action', sys_id: text(action, 'sys_id') } : undefined,
    }));
  } else if (category === 'data_policies') {
    item.conditions = text(row, 'conditions') || undefined;
    item.reverse_if_false = bool(row, 'reverse_if_false');
    item.inherit = bool(row, 'inherit');
    item.apply_import_set = bool(row, 'apply_import_set');
    item.apply_soap = bool(row, 'apply_soap');
    item.enforce_ui = bool(row, 'enforce_ui');
    item.field_actions = (context.related.get(sysId) || []).map(action => ({
      field: text(action, 'field') || undefined,
      mandatory: text(action, 'mandatory') || undefined,
      disabled: text(action, 'disabled') || undefined,
      reference: SAFE_SYS_ID.test(text(action, 'sys_id')) ? { kind: category, source_table: 'sys_data_policy_rule', sys_id: text(action, 'sys_id') } : undefined,
    }));
  } else if (category === 'dictionary_entries') {
    const element = text(row, 'element');
    item.level = element ? 'column' : 'table';
    item.element = element || undefined;
    item.column_label = text(row, 'column_label') || undefined;
    item.internal_type = text(row, 'internal_type') || undefined;
    item.max_length = integer(row, 'max_length');
    item.mandatory = bool(row, 'mandatory');
    item.reference_table = text(row, 'reference') || undefined;
    item.default_value = text(row, 'default_value') || undefined;
    item.active = bool(row, 'active');
    item.scope = text(row, 'sys_scope') || undefined;
    item.sys_overrides = text(row, 'sys_overrides') || undefined;
    if (!element) {
      item.name = `${rowTable || 'unknown'} (table-level)`;
      item.table_level = true;
    } else {
      item.name = text(row, 'column_label') ? `${element} (${text(row, 'column_label')})` : element;
    }
  } else if (category === 'dictionary_overrides') {
    const element = text(row, 'element');
    item.level = element ? 'column' : 'table';
    for (const field of source.fields) item[field] = rawValue(row, field);
    item.table_level = !element;
    item.name = element || `${rowTable || 'unknown'} (table-level override)`;
    item.interpretation = 'Raw override values; no effective dictionary resolution is computed.';
  } else if (category === 'notifications') {
    item.event_name = text(row, 'event_name') || undefined;
    item.type = text(row, 'type') || undefined;
    item.condition = text(row, 'condition') || undefined;
    item.advanced_condition = text(row, 'advanced_condition') || undefined;
    item.subject = text(row, 'subject') || undefined;
    item.weight = integer(row, 'weight');
    item.recipient_fields = text(row, 'recipient_fields') || undefined;
    item.event_parm_1 = text(row, 'event_parm_1') || undefined;
    item.event_parm_2 = text(row, 'event_parm_2') || undefined;
    item.template = text(row, 'template') || undefined;
    item.item = text(row, 'item') || undefined;
    item.item_table = text(row, 'item_table') || undefined;
    item.category = text(row, 'category') || undefined;
    item.importance = text(row, 'importance') || undefined;
    item.digestable = bool(row, 'digestable');
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'access_controls') {
    item.name = rowName || sysId;
    item.operation = text(row, 'operation') || undefined;
    item.type = text(row, 'type') || undefined;
    item.active = bool(row, 'active');
    item.admin_overrides = bool(row, 'admin_overrides');
    item.decision_type = text(row, 'decision_type') || undefined;
    item.condition = text(row, 'condition') || undefined;
    item.applies_to = text(row, 'applies_to') || undefined;
    item.description = text(row, 'description') || undefined;
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'styles') {
    item.element = text(row, 'element') || undefined;
    item.value = text(row, 'value') || undefined;
    item.style = text(row, 'style') || undefined;
    item.alt = text(row, 'alt') || undefined;
    item.themed_style = text(row, 'themed_style') || undefined;
  } else if (category === 'view_rules') {
    const view = text(row, 'view');
    item.view = view || undefined;
    item.view_empty = has('view') && 'view' in row && !view;
    item.advanced = bool(row, 'advanced');
    item.condition = text(row, 'condition') || undefined;
    item.match_conditions = text(row, 'match_conditions') || undefined;
    item.device_type = text(row, 'device_type') || undefined;
    item.overrides_user_preference = bool(row, 'overrides_user_preference');
    item.name = view ? `view: ${view}` : `${rowTable || 'unknown'} (view rule ${sysId})`;
    Object.assign(item, scriptSummary(row, source, fields));
  } else if (category === 'flows') {
    item.trigger_type = 'record';
    item.on_insert = bool(row, 'on_insert');
    item.on_update = bool(row, 'on_update');
    item.on_delete = bool(row, 'on_delete');
    item.condition = text(row, 'condition') || undefined;
    item.run_flow_in = text(row, 'run_flow_in') || undefined;
    item.run_on_extended = bool(row, 'run_on_extended');
    item.run_when_user_list = text(row, 'run_when_user_list') || undefined;
    item.run_when_setting = text(row, 'run_when_setting') || undefined;
    item.name = rowName || `record trigger ${sysId}`;
  }

  const critical = ['sys_id', 'name', source.target, 'active'].filter(field => field && fields.has(field));
  const missing = critical.filter(field => !(field in row));
  const missingScripts = (source.scripts || []).filter(field => fields.has(field) && !(field in row));
  if (missing.length || missingScripts.length) {
    const names = [...missing, ...missingScripts];
    item.warnings = [{ code: 'missing_fields', message: `Fields not returned (may be ACL-restricted): ${names.join(', ')}.`, source_table: source.table }];
  }
  return item;
}

async function readRelated(sdk, source, items, warnings) {
  const related = new Map();
  if (!source.related || !items.length) return related;
  const { table, foreignKey, fields } = source.related;
  const ids = items.map(item => item.reference.sys_id).filter(id => SAFE_SYS_ID.test(id));
  if (!ids.length) return related;
  try {
    const available = await dictionaryFields(sdk, table);
    if (!available.has(foreignKey)) {
      warnings.push({ code: 'unsupported_layout', message: `${table} lacks the ${foreignKey} field; field actions were not read.`, source_table: table });
      return related;
    }
    const wanted = [...new Set([...COMMON_FIELDS, foreignKey, ...fields])].filter(field => available.has(field));
    const rows = await sdk.listStrict(table, new URLSearchParams({
      sysparm_query: `${foreignKey}IN${quoteList(ids)}`,
      sysparm_limit: '1000',
      sysparm_fields: wanted.join(','),
      sysparm_display_value: 'all',
    }));
    if (rows.length >= 1000) {
      warnings.push({ code: 'truncated', message: `${table} child read reached the 1000-row bound; some field actions are omitted.`, source_table: table });
    }
    for (const row of rows) {
      const key = rawValue(row, foreignKey);
      if (!key) continue;
      const list = related.get(String(key)) || [];
      list.push(row);
      related.set(String(key), list);
    }
  } catch (error) {
    warnings.push({ code: 'related_read_failed', message: `Child field actions in ${table} could not be read; policy rows alone are incomplete.`, source_table: table, detail: sourceError(error, table).code });
  }
  return related;
}

/**
 * Discover behavior configuration for a table.
 *
 * @param {object} sdk — authenticated reader (listStrict)
 * @param {string} requestedTable
 * @param {object} [options]
 * @returns {Promise<object>} bounded inventory envelope data
 */
export async function discoverTableBehavior(sdk, requestedTable, options = {}) {
  const table = tableName(requestedTable);
  const categories = normalizeCategories(options.categories);
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw errUsage(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_MAX_BYTES || maxBytes > MAX_MAX_BYTES) {
    throw errUsage(`--max-bytes must be an integer from ${MIN_MAX_BYTES} to ${MAX_MAX_BYTES}.`);
  }
  const name = options.name ? String(options.name) : '';
  if (name && (name.length > 128 || /[\^\r\n]/.test(name))) {
    throw errUsage('--name must be at most 128 characters and cannot contain encoded-query characters.');
  }
  const includeInactive = options.includeInactive === true;
  const directOnly = options.directOnly === true;
  const cursors = options.cursors || {};

  const hierarchy = await loadHierarchy(sdk, table);
  const ancestors = hierarchy.slice(1).map(node => node.name);
  const result = {
    table,
    label: hierarchy[0].label,
    table_sys_id: hierarchy[0].sys_id,
    ancestors,
    filters: {
      categories,
      include_inactive: includeInactive,
      direct_only: directOnly,
      name: name || undefined,
      limit,
      max_bytes: maxBytes,
    },
    visibility: 'accessible_configuration',
    interpretation: 'Configuration inventory only. Conditions are not evaluated, scripts and flows are not executed, and absence is not proof that no other behavior exists.',
    categories: [],
    warnings: [],
    next_cursors: {},
  };

  const fieldsCache = new Map();
  const fieldsFor = async sourceTable => {
    if (!fieldsCache.has(sourceTable)) fieldsCache.set(sourceTable, dictionaryFields(sdk, sourceTable));
    return fieldsCache.get(sourceTable);
  };

  const itemPositions = new WeakMap();
  for (const category of categories) {
    const definition = SOURCES[category];
    const section = {
      category,
      label: definition.label,
      layer: definition.layer,
      enforcement: definition.enforcement,
      source_tables: definition.sources.map(source => source.table),
      interpretation: definition.summary,
      status: 'complete',
      supplied_sources: definition.sources.map(source => source.table),
      supported_trigger_types: definition.triggerSupport?.supported,
      unsupported_trigger_types: definition.triggerSupport?.unsupported,
      direct_count: 0,
      inherited_count: 0,
      returned: 0,
      omitted: 0,
      truncated: false,
      has_more: false,
      next_cursor: undefined,
      warnings: [],
      items: [],
    };
    if (definition.triggerSupport) {
      section.trigger_support = {
        supported: definition.triggerSupport.supported,
        unsupported: definition.triggerSupport.unsupported,
        note: 'Only record triggers are inventoried; other trigger families are unsupported and are not guessed by text joins.',
      };
    }
    result.categories.push(section);

    for (const source of definition.sources) {
      const signature = categorySignature(table, category, { limit, directOnly, includeInactive, name }, ancestors);
      let cursor;
      try {
        cursor = decodeCursor(cursors[category], category, signature);
      } catch (error) {
        if (error.code === 'usage_error') throw error;
        section.status = 'unavailable';
        section.warnings.push({ code: 'invalid_cursor', message: error.message, source_table: source.table });
        continue;
      }

      let fields;
      try {
        fields = await fieldsFor(source.table);
      } catch (error) {
        section.status = 'unavailable';
        section.warnings.push(sourceError(error, source.table));
        continue;
      }

      const missing = [source.target, ...(source.inherit ? [source.inherit] : [])].filter(field => !fields.has(field));
      if (missing.length) {
        section.status = 'unsupported';
        section.warnings.push({
          code: 'unsupported_layout',
          message: `${source.table} is missing required field(s) ${missing.join(', ')}; no unfiltered query was issued.`,
          source_table: source.table,
        });
        continue;
      }

      const activeField = source.activeField || (fields.has('active') ? 'active' : null);
      if (!includeInactive && !activeField) {
        section.warnings.push({ code: 'missing_fields', message: `Active status is unavailable on ${source.table}; candidates may be inactive.`, source_table: source.table });
      }
      const filterField = source.filterField
        || (fields.has('name') ? 'name' : fields.has('short_description') ? 'short_description' : null);
      if (name && !filterField) {
        section.status = 'unsupported';
        section.warnings.push({ code: 'unsupported_layout', message: `Name filtering is unavailable for ${source.table}.`, source_table: source.table });
        continue;
      }

      const wanted = [...new Set([
        ...COMMON_FIELDS,
        source.target,
        ...(source.fields || []),
        ...(source.scripts || []),
        ...(source.sort || []),
        ...(source.sortPhases || []).flatMap(phase => phase.order || []),
        ...(activeField ? [activeField] : []),
      ])].filter(field => requiredField(source, fields, field));

      let read;
      try {
        read = await readOrderedRows(sdk, source, {
          requested: table, ancestors, directOnly, includeInactive, name,
          fields, wanted, limit, cursor,
        });
      } catch (error) {
        section.status = 'unavailable';
        section.warnings.push(sourceError(error, source.table));
        continue;
      }

      section.has_more = read.hasMore;
      const page = read.page;
      const related = await readRelated(sdk, source, page.map(entry => ({ reference: { sys_id: text(entry.row, 'sys_id') } })), section.warnings);
      let truncatedAt = null;
      for (let index = 0; index < page.length; index++) {
        const entry = page[index];
        let item;
        try {
          item = summarize(category, source, entry.row, fields, { requested: table, ancestors, related });
        } catch (error) {
          section.warnings.push({ code: 'malformed_response', message: `Record ${text(entry.row, 'sys_id') || '?'} in ${source.table} was skipped: ${error.message}`, source_table: source.table });
          continue;
        }
        section.items.push(item);
        itemPositions.set(item, { phase: entry.phase, index: entry.index, signature, sourceTable: source.table });
        section.returned += 1;
        if (byteLength(result) > maxBytes - 1024) {
          section.items.pop();
          section.returned -= 1;
          truncatedAt = { phase: entry.phase, index: entry.index };
          section.truncated = true;
          break;
        }
      }
      if (truncatedAt !== null) {
        section.has_more = true;
        section.omitted = page.length - section.items.length;
        section.next_cursor = encodeCursor(category, truncatedAt.phase, truncatedAt.index, signature);
        section.warnings.push({
          code: 'truncated',
          message: `Response budget reached at ${section.items.length} item(s) in ${category}. Items are omitted whole; no script or message body is returned. Continue with its cursor, raise --max-bytes, or lower --limit.`,
          source_table: source.table,
        });
        section.status = 'partial';
        continue;
      }
      if (read.hasMore) {
        section.next_cursor = encodeCursor(category, read.next.phase, read.next.offset, signature);
        section.status = 'partial';
      }
      if (section.warnings.length || section.items.some(item => item.warnings?.length)) section.status = 'partial';
      continue;
    }
    section.direct_count = section.items.filter(item => item.association === 'direct').length;
    section.inherited_count = section.items.filter(item => item.inherited).length;
    if (section.next_cursor) result.next_cursors[category] = section.next_cursor;
  }

  // Last-resort budget pass: remove items from the last categories first and
  // record the exact continuation point for each. Categories are never dropped
  // silently, and a tight budget never turns into a usage error.
  if (byteLength(result) > maxBytes) {
    for (let index = result.categories.length - 1; index >= 0 && byteLength(result) > maxBytes; index--) {
      const section = result.categories[index];
      while (section.items.length && byteLength(result) > maxBytes) {
        const item = section.items.pop();
        const position = itemPositions.get(item);
        section.returned -= 1;
        section.omitted += 1;
        section.truncated = true;
        section.has_more = true;
        section.status = 'partial';
        if (position) {
          section.next_cursor = encodeCursor(section.category, position.phase, position.index, position.signature);
        }
        if (!section.warnings.some(warning => warning.code === 'truncated')) {
          section.warnings.push({
            code: 'truncated',
            message: 'Response budget reached before this category could be returned in full. Items are omitted whole; continue with its cursor or raise --max-bytes.',
            source_table: position?.sourceTable || section.source_tables[0],
          });
        }
      }
    }
  }
  for (const section of result.categories) {
    section.direct_count = section.items.filter(item => item.association === 'direct').length;
    section.inherited_count = section.items.filter(item => item.inherited).length;
    if (section.next_cursor) result.next_cursors[section.category] = section.next_cursor;
    else delete result.next_cursors[section.category];
  }

  result.totals = {
    returned: result.categories.reduce((sum, section) => sum + section.returned, 0),
    direct: result.categories.reduce((sum, section) => sum + section.direct_count, 0),
    inherited: result.categories.reduce((sum, section) => sum + section.inherited_count, 0),
    unavailable_categories: result.categories.filter(section => section.status === 'unavailable').length,
    unsupported_categories: result.categories.filter(section => section.status === 'unsupported').length,
    partial_categories: result.categories.filter(section => section.status === 'partial').length,
  };
  if (byteLength(result) > maxBytes) {
    result.budget_exceeded = true;
    result.warnings.push({
      code: 'budget_exceeded',
      message: `Category metadata alone exceeds --max-bytes (${maxBytes}); no items remain to omit. Raise --max-bytes or select fewer categories.`,
    });
  }
  return result;
}

export function formatTableBehavior(data) {
  const lines = [];
  lines.push('');
  lines.push(`\u{1F4CB} Table behavior: ${data.table}${data.label ? ` (${data.label})` : ''}`);
  if (data.ancestors.length) lines.push(`   Inherited from: ${data.ancestors.join(' \u2192 ')}`);
  lines.push(`   Filters: ${data.filters.categories.join(', ')}${data.filters.direct_only ? ' | direct only' : ''}${data.filters.include_inactive ? ' | including inactive' : ' | active only'}${data.filters.name ? ` | name LIKE ${data.filters.name}` : ''}`);
  lines.push('   Accessible configuration only; conditions are not evaluated and scripts are not executed.');
  lines.push('');
  for (const section of data.categories) {
    const breakdown = section.items.reduce((acc, item) => {
      const key = item.association_detail === 'global_actions' ? 'global'
        : item.association === 'direct' ? 'direct' : 'inherited';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const parts = [];
    if (breakdown.direct) parts.push(`${breakdown.direct} direct`);
    if (breakdown.inherited) parts.push(`${breakdown.inherited} inherited`);
    if (breakdown.global) parts.push(`${breakdown.global} global`);
    const counts = parts.length ? ` | ${parts.join(', ')}` : '';
    lines.push(`\u25B6 ${section.label.toUpperCase()} [${section.enforcement}] \u2014 ${section.status}${counts}`);
    lines.push('\u2500'.repeat(58));
    if (section.warnings.length) {
      for (const warning of section.warnings) lines.push(`  ! ${warning.code}: ${warning.message}`);
    }
    if (section.trigger_support?.unsupported?.length) {
      lines.push(`  unsupported trigger types: ${section.trigger_support.unsupported.map(trigger => `${trigger.type} (${trigger.table})`).join(', ')}. Only record triggers are inventoried.`);
    }
    if (!section.items.length) {
      lines.push(section.status === 'complete' ? '  (none in accessible configuration)' : '  (no results from available sources)');
    }
    for (const item of section.items) {
      const flags = [item.association, item.table ? `on ${item.table}` : '', item.active === false ? 'inactive' : '', item.scope && item.scope !== 'global' ? item.scope : ''].filter(Boolean);
      lines.push(`  ${item.name}${flags.length ? ` \u2014 ${flags.join(', ')}` : ''}`);
      const meta = [];
      if (item.level) meta.push(item.level === 'table' ? 'table-level' : 'column');
      if (item.element) meta.push(`element ${item.element}`);
      if (item.internal_type) meta.push(item.internal_type);
      if (item.max_length !== undefined) meta.push(`max ${item.max_length}`);
      if (item.base_table) meta.push(`base ${item.base_table}`);
      if (item.operation) meta.push(item.operation);
      if (item.event_name) meta.push(item.event_name);
      if (item.view) meta.push(`view ${item.view}`);
      if (item.view_empty) meta.push('view empty');
      if (item.trigger_type) meta.push(`${item.trigger_type} trigger`);
      if (item.on_insert || item.on_update || item.on_delete) {
        meta.push(['insert', 'update', 'delete'].filter(operation => item[`on_${operation}`]).join('/'));
      }
      if (item.when) meta.push(item.when);
      if (item.operations?.length) meta.push(item.operations.join('/'));
      if (item.order !== undefined) meta.push(`order ${item.order}`);
      if (item.type) meta.push(item.type);
      if (item.condition) meta.push(`condition: ${item.condition.length > 100 ? item.condition.slice(0, 97) + '...' : item.condition}`);
      if (meta.length) lines.push(`      ${meta.join(' | ')}`);
      if (item.field_actions?.length) {
        const actions = item.field_actions.map(action => `${action.field || '?'}${action.mandatory && action.mandatory !== 'ignore' ? ` mandatory=${action.mandatory}` : ''}${action.disabled && action.disabled !== 'ignore' ? ` disabled=${action.disabled}` : ''}${action.visible && action.visible !== 'ignore' ? ` visible=${action.visible}` : ''}`);
        lines.push(`      field actions: ${actions.join('; ')}`);
      }
      if (item.has_script) lines.push(`      content present (${item.script_bytes} bytes; not retrieved)`);
    }
    if (section.next_cursor) lines.push(`  ... more available; continue with --cursor ${section.next_cursor}`);
    if (section.omitted) lines.push(`  ${section.omitted} item(s) omitted by the response budget.`);
    lines.push('');
  }
  lines.push(`Returned ${data.totals.returned} item(s): ${data.totals.direct} direct, ${data.totals.inherited} inherited.`);
  if (data.totals.unavailable_categories || data.totals.unsupported_categories) {
    lines.push(`Unavailable categories: ${data.totals.unavailable_categories}; unsupported: ${data.totals.unsupported_categories}. These are not empty results.`);
  }
  if (data.budget_exceeded) lines.push('Response budget exceeded by category metadata alone; reduce categories or raise --max-bytes.');
  return lines.join('\n');
}
