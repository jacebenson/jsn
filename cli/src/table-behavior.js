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
];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
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
      fields: ['when', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'condition', 'advanced', 'abort_action', 'add_message', 'message', 'change_fields', 'role_conditions'],
      scripts: ['script'],
    }],
  },
  client_scripts: {
    label: 'Client scripts', layer: 'client', enforcement: 'client',
    summary: 'Browser-side scripts. They shape the form but do not enforce server data.',
    sources: [{
      table: 'sys_script_client', target: 'table', inherit: 'applies_extended',
      fields: ['type', 'field', 'ui_type', 'view', 'global', 'applies_extended', 'isolate_script', 'condition'],
      scripts: ['script'],
    }],
  },
  ui_actions: {
    label: 'UI actions', layer: 'client', enforcement: 'client',
    summary: 'Form/list actions. Button visibility and conditions are client-side configuration.',
    sources: [{
      table: 'sys_ui_action', target: 'table', inherit: null, includeGlobal: true,
      fields: ['action_name', 'condition', 'client', 'roles', 'form_button', 'form_link', 'form_context_menu', 'list_button', 'list_link', 'list_context_menu', 'list_banner_button', 'list_choice', 'show_insert', 'show_update', 'sys_overrides', 'ui_type', 'form_button_v2', 'form_menu_button_v2', 'format_for_configurable_workspace'],
      scripts: ['script', 'onclick', 'client_script_v2'],
    }],
  },
  ui_policies: {
    label: 'UI policies', layer: 'client', enforcement: 'client',
    summary: 'Client-side field behavior. Mandatory/read-only actions here are not server enforcement.',
    sources: [{
      table: 'sys_ui_policy', target: 'table', inherit: 'inherit',
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
      table: 'sys_data_policy2', target: 'model_table', inherit: 'inherit',
      fields: ['conditions', 'reverse_if_false', 'inherit', 'apply_import_set', 'apply_soap', 'enforce_ui'],
      related: {
        table: 'sys_data_policy_rule', foreignKey: 'sys_data_policy',
        fields: ['field', 'mandatory', 'disabled'],
      },
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
  if (!token) return 0;
  if (typeof token !== 'string' || token.length > 512) throw errUsage('Invalid cursor token.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw errUsage('Invalid cursor token.');
  }
  if (!parsed || parsed.v !== 1 || parsed.c !== category || parsed.s !== signature
    || !Number.isInteger(parsed.o) || parsed.o < 0 || parsed.o > 1000000) {
    throw errUsage('Cursor does not match this table, category, or filter set.',
      'Restart discovery without a cursor or keep the original filters.');
  }
  return parsed.o;
}

function encodeCursor(category, offset, signature) {
  return Buffer.from(JSON.stringify({ v: 1, c: category, o: offset, s: signature }), 'utf8').toString('base64url');
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

function overrideEvidence(row, fields) {
  if (!fields.has('sys_overrides')) return undefined;
  const override = text(row, 'sys_overrides');
  if (!override) return undefined;
  return {
    sys_overrides: rawValue(row, 'sys_overrides') || override,
    note: 'Override link preserved as evidence; effective resolution is not simulated.',
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
  const association = associationFor(source, rowTable, requested, ancestors);
  const item = {
    reference: { kind: category, source_table: source.table, sys_id: sysId },
    source_table: source.table,
    name: text(row, 'name') || text(row, 'short_description') || sysId,
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
    result.categories.push(section);

    for (const source of definition.sources) {
      const signature = categorySignature(table, category, { limit, directOnly, includeInactive, name }, ancestors);
      let offset;
      try {
        offset = decodeCursor(cursors[category], category, signature);
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

      const parts = [];
      if (directOnly) {
        parts.push(`${source.target}=${table}`);
      } else if (source.inherit) {
        parts.push(`${source.target}=${table}`);
        if (ancestors.length) parts.push(`${source.target}IN${quoteList(ancestors)}^${source.inherit}=true`);
        if (source.includeGlobal) parts.push(`${source.target}=global`);
      } else {
        const associated = source.includeGlobal ? [...ancestors, 'global'] : ancestors;
        parts.push(`${source.target}IN${quoteList([table, ...associated])}`);
      }
      const filters = [];
      if (!includeInactive) {
        if (fields.has('active')) filters.push('active=true');
        else section.warnings.push({ code: 'missing_fields', message: `Active status is unavailable on ${source.table}; candidates may be inactive.`, source_table: source.table });
      }
      if (name) {
        const nameField = fields.has('name') ? 'name' : fields.has('short_description') ? 'short_description' : null;
        if (!nameField) {
          section.status = 'unsupported';
          section.warnings.push({ code: 'unsupported_layout', message: `Name filtering is unavailable for ${source.table}.`, source_table: source.table });
          continue;
        }
        filters.push(`${nameField}LIKE${name}`);
      }
      const query = parts.map(part => [part, ...filters].join('^')).join('^NQ') + '^ORDERBYsys_id';
      const wanted = [...new Set([...COMMON_FIELDS, source.target, ...source.fields, ...(source.scripts || [])])]
        .filter(field => fields.has(field));

      let rows;
      try {
        rows = await sdk.listStrict(source.table, new URLSearchParams({
          sysparm_query: query,
          sysparm_fields: wanted.join(','),
          sysparm_limit: String(limit + 1),
          sysparm_offset: String(offset),
          sysparm_display_value: 'all',
          sysparm_exclude_reference_link: 'true',
          sysparm_no_count: 'true',
        }));
      } catch (error) {
        section.status = 'unavailable';
        section.warnings.push(sourceError(error, source.table));
        continue;
      }

      const page = rows.slice(0, limit);
      section.has_more = rows.length > limit;
      const related = await readRelated(sdk, source, page.map(row => ({ reference: { sys_id: text(row, 'sys_id') } })), section.warnings);
      let truncatedAt = null;
      for (let index = 0; index < page.length; index++) {
        let item;
        try {
          item = summarize(category, source, page[index], fields, { requested: table, ancestors, related });
        } catch (error) {
          section.warnings.push({ code: 'malformed_response', message: `Record ${text(page[index], 'sys_id') || '?'} in ${source.table} was skipped: ${error.message}`, source_table: source.table });
          continue;
        }
        section.items.push(item);
        section.returned += 1;
        if (byteLength(result) > maxBytes - 1024) {
          section.items.pop();
          section.returned -= 1;
          truncatedAt = offset + index;
          section.truncated = true;
          break;
        }
      }
      if (truncatedAt !== null) {
        section.omitted = page.length - section.items.length;
        section.next_cursor = encodeCursor(category, truncatedAt, signature);
        section.warnings.push({
          code: 'truncated',
          message: `Response budget reached at ${section.items.length} item(s) in ${category}. Script bodies are never cut. Continue with its cursor, raise --max-bytes, or lower --limit.`,
          source_table: source.table,
        });
        section.status = 'partial';
        continue;
      }
      if (section.has_more) {
        section.next_cursor = encodeCursor(category, offset + page.length, signature);
        section.status = 'partial';
      }
      if (section.warnings.length || section.items.some(item => item.warnings?.length)) section.status = 'partial';
      continue;
    }
    section.direct_count = section.items.filter(item => item.association === 'direct').length;
    section.inherited_count = section.items.filter(item => item.inherited).length;
    if (section.next_cursor) result.next_cursors[category] = section.next_cursor;
    if (byteLength(result) > maxBytes) {
      throw errUsage(`Behavior output metadata exceeds --max-bytes (${maxBytes}). Increase --max-bytes or select fewer categories.`);
    }
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
    throw errUsage(`Behavior output metadata exceeds --max-bytes (${maxBytes}). Increase --max-bytes or select fewer categories.`);
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
    lines.push(`\u25B6 ${section.label.toUpperCase()} [${section.enforcement}] \u2014 ${section.status}${section.direct_count || section.inherited_count ? ` | ${section.direct_count} direct, ${section.inherited_count} inherited` : ''}`);
    lines.push('\u2500'.repeat(58));
    if (section.warnings.length) {
      for (const warning of section.warnings) lines.push(`  ! ${warning.code}: ${warning.message}`);
    }
    if (!section.items.length) {
      lines.push(section.status === 'complete' ? '  (none in accessible configuration)' : '  (no results from available sources)');
    }
    for (const item of section.items) {
      const flags = [item.association, item.table ? `on ${item.table}` : '', item.active === false ? 'inactive' : '', item.scope && item.scope !== 'global' ? item.scope : ''].filter(Boolean);
      lines.push(`  ${item.name}${flags.length ? ` \u2014 ${flags.join(', ')}` : ''}`);
      const meta = [];
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
      if (item.has_script) lines.push(`      script present (${item.script_bytes} bytes; not retrieved)`);
    }
    if (section.next_cursor) lines.push(`  ... more available; continue with --cursor ${section.next_cursor}`);
    if (section.omitted) lines.push(`  ${section.omitted} item(s) omitted by the response budget.`);
    lines.push('');
  }
  lines.push(`Returned ${data.totals.returned} item(s): ${data.totals.direct} direct, ${data.totals.inherited} inherited.`);
  if (data.totals.unavailable_categories || data.totals.unsupported_categories) {
    lines.push(`Unavailable categories: ${data.totals.unavailable_categories}; unsupported: ${data.totals.unsupported_categories}. These are not empty results.`);
  }
  return lines.join('\n');
}
