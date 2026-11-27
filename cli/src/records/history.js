import { errUsage } from '../errors.js';
import { resolveRecord, unwrapSysId, isSysId } from '../resolve-record.js';
import { readTableAudit } from '../table-audit.js';

const AUDIT = 'sys_audit';
const FIELDS = 'sys_id,tablename,documentkey,fieldname,oldvalue,newvalue,user,reason,sys_created_on';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SINCE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
const MAX_SHOWN = 100;
const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const malformed = message => Object.assign(new Error(message), { code: 'malformed_response' });
// sys_audit is admin-read by default and an ACL-filtered list answers 200 with no rows.
const UNPROVEN = `${AUDIT} is admin-read by default, and a list the ACLs filter answers with no rows, so an empty history alone does not prove nothing changed.`;

function validate({ limit, field, since }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (field != null && !NAME.test(field)) throw errUsage('--field must be a column name (letters, digits and underscores).');
  if (since != null && !SINCE.test(since)) throw errUsage('--since must be a date or date-time: YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS".');
}

// Reuses `jsn tables audit`, so an empty history names the setting that kept changes out of sys_audit.
async function whyEmpty(sdk, table, field, since) {
  const window = since ? ` on or after ${since}` : '';
  let audit;
  try { audit = await readTableAudit(sdk, table, field ? { field } : {}); } catch (error) { return `No changes found${window}; audit status for ${table} was not read: ${error.message}`; }
  if (audit.field && !audit.field.audited) return `No changes found: ${audit.field.reason}`;
  if (!audit.audited) return `No changes found: table auditing is off for ${audit.table}${audit.parents_audited.length ? `; ${audit.parents_audited.join(', ')} audits, but auditing does not inherit` : ''}.`;
  return `No changes found${window}, though ${audit.table}${field ? ` and ${field} are` : ' is'} audited. ${audit.inserts.audited ? '' : `Inserts are not audited (${audit.inserts.reason.replace(/; inserts.*$/, '')}), so a record nobody changed after creating it has none. `}Changes made by import sets, update set applies, Import XML and upgrades are never audited.`;
}

/**
 * Read one record's field changes from sys_audit, newest first.
 *
 * Every read is keyed on tablename and documentkey (the record's raw sys_id) and bounded: sys_audit
 * is among an instance's largest tables. History sets (sys_history_set/line) are not read; the
 * platform builds them from sys_audit only when someone opens History.
 */
export async function recordHistory(sdk, { table, identifier, identifierField, field, since, limit = 20 } = {}) {
  validate({ limit, field, since });
  // A deleted record keeps its sys_audit rows, so a full sys_id that no longer resolves is still read.
  const bySysId = isSysId(identifier) && (identifierField ?? 'sys_id') === 'sys_id';
  let record = null;
  let missing = null;
  try {
    record = await resolveRecord(sdk, { table, identifier, identifierField, fields: ['sys_class_name'], resource: 'Record', partial: !bySysId });
  } catch (error) {
    if (!bySysId || error.code !== 'not_found') throw error;
    missing = error;
  }
  const sysId = record ? unwrapSysId(record) : identifier;
  if (!isSysId(sysId)) throw malformed('The matched record has no readable sys_id; check field ACLs before retrying.');
  // sys_audit keeps rows under the record's own class (incident, not task).
  const tablename = (record && raw(record.sys_class_name)) || table;
  if (!NAME.test(tablename)) throw malformed(`The matched record has an unreadable class: ${tablename}`);

  const query = [`tablename=${tablename}`, `documentkey=${sysId}`, field && `fieldname=${field}`, since && `sys_created_on>=${since}`, 'ORDERBYDESCsys_created_on', 'ORDERBYDESCsys_id'].filter(Boolean).join('^');
  const rows = await sdk.listStrict(AUDIT, new URLSearchParams({ sysparm_query: query, sysparm_fields: FIELDS, sysparm_limit: String(limit + 1), sysparm_display_value: 'false', sysparm_no_count: 'true' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(`Malformed table response for ${AUDIT}`);
  if (rows.some(row => raw(row.documentkey) !== sysId || raw(row.tablename) !== tablename || (field && raw(row.fieldname) !== field))) throw malformed(`${AUDIT} returned a row for another record or field than ${tablename} ${sysId}.`);
  if (missing && !rows.length) {
    // An ACL-hidden record also lists as empty, and a filter can hide the rows a deleted record does have.
    missing.hint = `No ${table} record with sys_id ${sysId} is readable (it may not exist, or ACLs hide it), and ${AUDIT} holds no rows for it${field || since ? ' matching --field or --since; run without them to see all its rows' : ''}. Audit rows are kept under the record's own table (incident, not task).`;
    throw missing;
  }

  const changes = rows.slice(0, limit).map(row => ({
    sys_id: raw(row.sys_id),
    // Raw values are UTC; the display value is in the caller's time zone and cannot be compared.
    changed_on: raw(row.sys_created_on),
    user: raw(row.user),
    field: raw(row.fieldname),
    old_value: raw(row.oldvalue),
    new_value: raw(row.newvalue),
    reason: raw(row.reason),
  }));
  const notes = [];
  if (missing) notes.push(rows.some(row => raw(row.fieldname) === 'DELETED') ? `No ${table} record has sys_id ${sysId} now; these rows are its history before it was deleted.` : `No ${table} record with sys_id ${sysId} is readable now (deleted, or hidden by ACLs); these are its ${AUDIT} rows.`);
  if (!changes.length) notes.push(await whyEmpty(sdk, tablename, field, since), UNPROVEN);
  if (rows.length > limit) notes.push(limit < 200 ? 'More changes exist; raise --limit (up to 200), or narrow with --field or --since.' : 'More changes exist; narrow with --field or --since (--limit is at its maximum, 200).');
  return {
    table,
    record: { sys_id: sysId, table: tablename, found: Boolean(record) },
    field: field ?? null,
    since: since ?? null,
    count: changes.length,
    changes,
    pagination: { limit, has_more: rows.length > limit },
    notes,
  };
}

const shown = value => JSON.stringify(value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN - 3)}...` : value);

export function formatHistory(data) {
  const scope = [data.field && `field ${data.field}`, data.since && `since ${data.since}`].filter(Boolean).join(', ');
  const lines = [`History of ${data.record.table} ${data.record.sys_id} from sys_audit${scope ? ` (${scope})` : ''}, newest first, times UTC (read-only)`];
  for (const change of data.changes) {
    const what = change.field === 'DELETED' ? 'record deleted' : `${change.field}: ${shown(change.old_value)} -> ${shown(change.new_value)}`;
    lines.push(`${change.changed_on}  ${change.user || '(user hidden)'}  ${what}${change.reason ? `  (reason: ${change.reason})` : ''}`);
  }
  if (data.changes.some(change => change.old_value.length > MAX_SHOWN || change.new_value.length > MAX_SHOWN)) lines.push(`Values over ${MAX_SHOWN} characters are cut here; --json returns them whole.`);
  lines.push(...data.notes);
  return lines.join('\n');
}
