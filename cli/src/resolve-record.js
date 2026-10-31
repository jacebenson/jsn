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
import { errNotFound } from './errors.js';

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
 * Resolve a single record by human identifier.
 *
 * @param {object} sdk — SDK handle (uses sdk.list)
 * @param {object} opts
 * @param {string} opts.table — ServiceNow table
 * @param {string} opts.identifier — sys_id (32 hex) or value of matchField
 * @param {string} opts.matchField — field to match non-sys_id identifiers on
 *   (e.g. 'number', 'name', 'user_name')
 * @param {string} [opts.resource] — label for the not-found error
 *   (e.g. 'User' → "User not found: <id>"); defaults to matchField
 * @param {string[]} [opts.fields] — restrict sysparm_fields when set
 * @returns {Promise<object>} the record (display values requested)
 * @throws {AppError} code not_found when no record matches
 */
export async function resolveRecord(sdk, { table, identifier, matchField, resource, fields }) {
  assertSafeExactMatch(identifier);
  const queryField = isSysId(identifier) ? 'sys_id' : matchField;
  const params = new URLSearchParams();
  params.set('sysparm_query', `${queryField}=${identifier}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_display_value', 'all');
  if (fields && fields.length > 0) {
    params.set('sysparm_fields', fields.join(','));
  }
  const records = await sdk.list(table, params);
  if (records.length === 0) {
    throw errNotFound(resource || matchField, identifier);
  }
  return records[0];
}

/**
 * Resolve a record and return just its raw sys_id.
 * Same options as resolveRecord; defaults to fetching only sys_id.
 */
export async function resolveSysId(sdk, opts) {
  const record = await resolveRecord(sdk, { fields: ['sys_id'], ...opts });
  return unwrapSysId(record);
}
