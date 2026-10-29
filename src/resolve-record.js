// Shared resolver for "find one record by a human identifier".
//
// Every command that accepts a number / name / user_name / sys_id used to
// hand-roll the same five steps (classify the identifier, guard the query,
// build params, fetch, unwrap sys_id) — and they drifted: hex detection
// differed per file and some lookups forgot sysparm_display_value=all, so a
// wrapped {value, display_value} sys_id leaked into update/delete calls.
// This module is the single deep seam; commands shrink to
// resolve → mutate → report.

import { assertSafeExactMatch, isHexString } from './helpers.js';
import { errNotFound, errUsage, AppError, CodeAmbiguous } from './errors.js';

/**
 * True when the identifier looks like a ServiceNow sys_id (32 hex chars).
 * Exported so call sites that only need classification share one definition.
 */
export function isSysId(identifier) {
  return typeof identifier === 'string' && identifier.length === 32 && isHexString(identifier);
}

/**
 * Unwrap a record's sys_id, which may be a plain string or a
 * {value, display_value} object when display values were requested.
 */
export function unwrapSysId(record) {
  const sysId = record?.sys_id;
  if (sysId && typeof sysId === 'object') return sysId.value || sysId.display_value || '';
  return sysId || '';
}

/**
 * Exact lookups precede partial sys_id lookup. Configured human identifiers keep
 * their legacy precedence; identifierField explicitly disambiguates collisions.
 * Each query requests at most two rows so no operation silently picks a match.
 */
export async function resolveRecord(sdk, { table, identifier, matchField = 'sys_id', identifierField,
  resource, fields, displayValue = 'all', partial = true }) {
  assertSafeExactMatch(identifier);
  if (typeof identifier !== 'string' || !identifier.trim()) throw errUsage('An identifier is required.');
  for (const value of [table, identifierField || matchField]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value || '')) throw errUsage('Invalid table or identifier field name.');
  }
  const explicit = identifierField !== undefined;
  const firstField = identifierField || (isSysId(identifier) ? 'sys_id' : matchField);
  const attempts = [];
  async function lookup(field, operator, mode) {
    const params = new URLSearchParams({
      sysparm_query: `${field}${operator}${identifier}`,
      sysparm_limit: '2', sysparm_display_value: displayValue,
    });
    if (fields?.length) params.set('sysparm_fields', [...new Set(['sys_id', ...fields])].join(','));
    const records = await sdk.list(table, params);
    const resolution = { table, field, mode, matches: Math.min(records.length, 2),
      ...(records.length >= 2 ? { at_least: true } : {}) };
    attempts.push(resolution);
    if (records.length > 1) {
      const error = new AppError(CodeAmbiguous, `Multiple ${resource || 'records'} found matching ${mode} ${field}: ${identifier}`,
        'Use a longer/full sys_id or select the exact human field with --identifier-field <field>.');
      error.resolution = { ...resolution, attempts };
      throw error;
    }
    return records[0];
  }
  let record = await lookup(firstField, '=', 'exact');
  if (record) return record;
  if (!explicit && firstField !== 'sys_id') {
    record = await lookup('sys_id', '=', 'exact');
    if (record) return record;
  }
  // An explicitly selected human field must never fall back to another field.
  if (partial && (!explicit || firstField === 'sys_id')) {
    record = await lookup('sys_id', 'STARTSWITH', 'prefix');
    if (record) return record;
    record = await lookup('sys_id', 'ENDSWITH', 'suffix');
    if (record) return record;
  }
  const error = errNotFound(resource || matchField, identifier);
  error.hint = 'No accessible record matched. Check the table/ACLs, supply a full or longer sys_id, or use --identifier-field <field> for an exact human identifier.';
  error.resolution = { ...attempts.at(-1), attempts };
  throw error;
}

/**
 * Resolve a record and return just its raw sys_id.
 * Same options as resolveRecord; defaults to fetching only sys_id.
 */
export async function resolveSysId(sdk, opts) {
  const record = await resolveRecord(sdk, { fields: ['sys_id'], ...opts });
  const id = unwrapSysId(record);
  if (!id) throw errUsage('The matched record has no readable sys_id; check field ACLs before retrying.');
  return id;
}
