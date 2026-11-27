// Shared, read-only condition evidence for the "why didn't it run" commands.
//
// The platform's query engine is the authority on whether an encoded query
// matches a record. These helpers never evaluate scripts and never run the
// condition in memory: they re-read the record with `sys_id=<id>^<condition>`
// through the Table API, one `^NQ` group at a time. Operators that describe a
// change after the event (`CHANGESTO`, `CHANGESFROM`, `VALCHANGES`) and script
// conditions are reported as untested instead of being guessed at.

import { getStringField } from './helpers.js';
import { errUsage } from './errors.js';
import { isSysId, resolveRecord, unwrapSysId } from './resolve-record.js';
import { loadHierarchy } from './table-behavior.js';

export { loadHierarchy };

const TABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONDITION_TOKEN = /^(OR)?([A-Za-z_][A-Za-z0-9_.]*?)(CHANGESFROM|CHANGESTO|VALCHANGES|NOT IN|ISNOTEMPTY|ISEMPTY|STARTSWITH|ENDSWITH|NOTLIKE|LIKE|IN|>=|<=|!=|=|>|<)(.*)$/;
const CHANGE_OPERATORS = new Set(['CHANGESTO', 'CHANGESFROM', 'VALCHANGES']);
const SCRIPT_PREFIX = /^\s*javascript:/i;
const SAFE_VALUE = /^[^\r\n]*$/;

export function assertTableName(table) {
  const name = String(table || '');
  if (!TABLE_NAME.test(name) || name.length > 160) {
    throw errUsage(`Invalid table name: ${name || '(empty)'}`, 'Use a table name such as incident or x_custom_table.');
  }
  return name;
}

export function assertFieldName(field) {
  const name = String(field || '');
  if (!FIELD_NAME.test(name) || name.length > 80) {
    throw errUsage(`Invalid field name: ${name || '(empty)'}`, 'Use a column element such as caller_id or short_description.');
  }
  return name;
}

function parseInteger(value) {
  const parsed = parseInt(String(value ?? '').replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

/**
 * Split an encoded query into `^NQ` groups and parse the tokens this command
 * can reason about. Unknown tokens are preserved in the query sent to the
 * platform; only script conditions and change operators are withheld.
 */
export function analyzeCondition(condition) {
  const value = String(condition ?? '').trim();
  if (!value || value === 'EQ' || /^\^?EQ\^?$/.test(value)) {
    return { value, empty: true, testable: true, matched: true, groups: [], untested: [] };
  }
  const groups = [];
  const untested = [];
  for (const raw of value.split('^NQ')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split('^').map(token => token.trim())
      .filter(token => token && token !== 'EQ' && !token.startsWith('ORDERBY'));
    if (!tokens.length) continue;
    if (SCRIPT_PREFIX.test(trimmed)) {
      untested.push({ query: trimmed, reason: 'script condition — not executed' });
      continue;
    }
    const parsed = [];
    let change;
    let scripted;
    for (const token of tokens) {
      const match = CONDITION_TOKEN.exec(token.startsWith('OR') ? token.slice(2) : token);
      if (!match) continue;
      const operation = match[3];
      const entry = { field: match[2], operation, value: match[4] };
      parsed.push(entry);
      if (CHANGE_OPERATORS.has(operation)) change = { token, operation };
      if (/javascript:/i.test(token)) scripted = token;
    }
    if (scripted) {
      untested.push({ query: trimmed, reason: 'script condition — not executed' });
      continue;
    }
    if (change) {
      untested.push({ query: trimmed, reason: `${change.operation} describes a change after the event — not testable against current state` });
      continue;
    }
    groups.push({ query: tokens.join('^'), tokens: parsed });
  }
  return {
    value,
    empty: false,
    testable: groups.length > 0,
    groups,
    untested,
  };
}

function probeError(error, table) {
  const status = error?.status;
  if (status === 403 || status === 401) {
    return { code: 'permission_denied', message: `Read access denied while testing the condition on ${table}; the result is unknown.` };
  }
  if (status === 400) {
    return { code: 'invalid_condition', message: `The platform rejected the condition as an encoded query: ${error.message || 'HTTP 400'}.` };
  }
  if (error?.code === 'malformed_response') {
    return { code: 'malformed_response', message: `Malformed response while testing the condition on ${table}.` };
  }
  return { code: 'request_failed', message: `Condition test failed for ${table}: ${error.message || String(error)}` };
}

/**
 * Ask the Table API whether `sys_id=<id>^<condition>` returns the record.
 * Result is tri-state: matched true, false, or null when some group is
 * untested (script/change operator) or a request failed.
 */
export async function probeCondition(sdk, { table, sysId, condition }) {
  const safeTable = assertTableName(table);
  if (!isSysId(sysId)) throw errUsage(`Invalid record sys_id for condition testing: ${sysId || '(empty)'}.`);
  const analysis = analyzeCondition(condition);
  if (analysis.empty) {
    return { value: String(condition ?? ''), tested: false, matched: true, reason: 'no condition', groups: [], warnings: [] };
  }
  const groups = [];
  const warnings = [];
  let matched = false;
  let sawError = false;
  for (const group of analysis.groups) {
    if (!SAFE_VALUE.test(group.query)) {
      groups.push({ query: group.query, matched: null, error: 'unsafe_condition' });
      warnings.push({ code: 'invalid_condition', message: 'Condition contains characters the CLI will not send.' });
      sawError = true;
      continue;
    }
    const query = `sys_id=${sysId}^${group.query}`;
    try {
      const rows = await sdk.listStrict(safeTable, new URLSearchParams({
        sysparm_query: query,
        sysparm_fields: 'sys_id',
        sysparm_limit: '1',
      }));
      const hit = Array.isArray(rows) && rows.length > 0;
      if (hit) matched = true;
      groups.push({ query: group.query, matched: hit });
    } catch (error) {
      const detail = probeError(error, safeTable);
      sawError = true;
      groups.push({ query: group.query, matched: null, error: detail.code });
      warnings.push(detail);
    }
  }
  for (const entry of analysis.untested) {
    groups.push({ query: entry.query, matched: null, untested: entry.reason });
    warnings.push({ code: 'untested_condition', message: entry.reason, query: entry.query });
  }
  const untested = analysis.untested.length > 0;
  return {
    value: analysis.value,
    tested: !sawError && !untested,
    matched: matched ? true : (sawError || untested ? null : false),
    groups,
    warnings,
    reason: matched ? undefined : (sawError ? 'condition test failed' : untested ? 'condition not fully testable' : 'condition did not match'),
  };
}

/**
 * Load the dictionary rows for a table and its ancestors once. The direct
 * table's row wins over an inherited row for the same element.
 */
export async function loadFieldCatalog(sdk, table) {
  const safeTable = assertTableName(table);
  const hierarchy = await loadHierarchy(sdk, safeTable);
  const names = hierarchy.map(node => node.name);
  const rows = await sdk.listStrict('sys_dictionary', new URLSearchParams({
    sysparm_query: `nameIN${names.join(',')}^elementISNOTEMPTY`,
    sysparm_fields: 'sys_id,name,element,internal_type,reference,mandatory,read_only,active,sys_overrides',
    sysparm_limit: '2001',
    sysparm_display_value: 'all',
  }));
  if (rows.length > 2000) throw errUsage(`Field inventory for ${safeTable} exceeds the supported bound.`);
  const fields = new Map();
  for (const row of rows) {
    const element = getStringField(row, 'element');
    if (!element) continue;
    const entry = {
      sys_id: getStringField(row, 'sys_id'),
      table: getStringField(row, 'name'),
      element,
      internal_type: getStringField(row, 'internal_type') || undefined,
      reference: getStringField(row, 'reference') || undefined,
      mandatory: parseBoolean(getStringField(row, 'mandatory')),
      read_only: parseBoolean(getStringField(row, 'read_only')),
      active: parseBoolean(getStringField(row, 'active')),
      sys_overrides: getStringField(row, 'sys_overrides') || undefined,
    };
    const existing = fields.get(element);
    if (!existing || (entry.table === safeTable && existing.table !== safeTable)) fields.set(element, entry);
  }
  return { table: safeTable, ancestors: names.slice(1), names, fields };
}

export function recordLabel(record, sysId) {
  return getStringField(record, 'number')
    || getStringField(record, 'name')
    || getStringField(record, 'short_description')
    || sysId;
}

/** Resolve `number|sys_id` (and a name when the table has one) to a record. */
export async function resolveTargetRecord(sdk, table, identifier, { catalog, resource = 'Record' } = {}) {
  const safeTable = assertTableName(table);
  const value = String(identifier ?? '').trim();
  if (!value || /[\^\r\n]/.test(value)) {
    throw errUsage(`Invalid record identifier: ${value || '(empty)'}.`, 'Pass a number or sys_id without encoded-query characters.');
  }
  const fields = catalog || await loadFieldCatalog(sdk, safeTable);
  let matchField = 'sys_id';
  if (!isSysId(value)) matchField = fields.fields.has('number') ? 'number' : fields.fields.has('name') ? 'name' : 'sys_id';
  const wanted = ['sys_id', 'number', 'name', 'short_description', 'sys_class_name'].filter(field => field === 'sys_id' || fields.fields.has(field));
  const record = await resolveRecord(sdk, {
    table: safeTable, identifier: value, matchField, resource, fields: wanted, displayValue: 'all',
  });
  const sysId = unwrapSysId(record);
  if (!sysId) throw errUsage('The matched record has no readable sys_id; check field ACLs before retrying.');
  return { record, sys_id: sysId, identifier: value, match_field: matchField, label: recordLabel(record, sysId) };
}

/**
 * Flag a reference field compared with something that is not a sys_id. A
 * display label ("Beth Anglin") can look like a value but never matches a
 * reference column; the platform compares the raw sys_id.
 */
export function referenceComparisonFlags(catalog, condition) {
  const analysis = analyzeCondition(condition);
  const flags = [];
  const seen = new Set();
  for (const group of analysis.groups) {
    for (const token of group.tokens) {
      if (!['=', 'IN'].includes(token.operation)) continue;
      const field = catalog.fields.get(token.field);
      if (!field?.reference) continue;
      for (const raw of String(token.value || '').split(',')) {
        const value = raw.trim();
        if (!value || value === 'NULL' || value === 'EMPTY') continue;
        if (isSysId(value)) continue;
        const key = `${token.field}\u0000${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flags.push({
          field: token.field,
          reference_table: field.reference,
          compared_value: value,
          message: `${token.field} is a reference to ${field.reference} but the condition compares ${JSON.stringify(value)}, which is not a sys_id; display values do not match reference columns.`,
        });
      }
    }
  }
  return flags;
}

/** Parse `--record <table> <number|sys_id>` (or `table:identifier`). */
export function parseRecordArgument(values) {
  const list = (Array.isArray(values) ? values : [values]).flatMap(value => String(value ?? '').split(/\s+/)).filter(Boolean);
  if (list.length === 0) throw errUsage('--record is required: pass "<table> <number|sys_id>".');
  if (list.length === 1 && list[0].includes(':')) {
    const index = list[0].indexOf(':');
    const table = list[0].slice(0, index);
    const identifier = list[0].slice(index + 1);
    if (table && identifier) return { table: assertTableName(table), identifier };
  }
  if (list.length === 2) return { table: assertTableName(list[0]), identifier: list[1] };
  throw errUsage('--record expects a table and one identifier, e.g. --record incident INC0010001.');
}

export { parseInteger, parseBoolean };
