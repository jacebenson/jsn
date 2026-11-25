// List what Deleted Records (sys_audit_delete) holds: what was deleted, by whom and when, whether the
// record is back in its table, and whether a delete recovery (sys_delete_recovery) recorded its cascade.
import { errUsage } from './errors.js';
import { quoteShellArg } from './helpers.js';

const SYS_ID = /^[0-9a-f]{32}$/;
const TABLE = /^[a-z0-9_]+$/;
const FIELDS = 'sys_id,tablename,documentkey,display_value,transaction,delete_recovery,sys_created_by,sys_created_on';
// Display labels are presentation only; every join below uses raw sys_ids.
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
// sys_audit_delete is admin-read by default and an ACL-filtered list answers 200 with no rows, so an empty page proves nothing.
const EMPTY = "No readable rows. Deleted Records keys each row by the record's own table (incident, not task) and only admins read it by default, so this does not prove nothing was deleted.";
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');

async function read(sdk, table, query, fields, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_display_value: 'all', sysparm_limit: String(limit) }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !SYS_ID.test(raw(row.sys_id)))) {
    throw Object.assign(new Error(`Malformed ${table} response: expected rows with sys_ids`), { code: 'malformed_response' });
  }
  return rows;
}

export function deletedQuery({ table, by, since, query, limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (table != null && !TABLE.test(table)) throw errUsage('--table must be a table name (lower-case letters, digits and underscores).');
  if (by != null && !/^[^\s^]+$/.test(by)) throw errUsage('--by must be a user name (sys_created_by), with no spaces or ^.');
  if (since != null && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(since)) throw errUsage('--since must be a date or date-time: YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS".');
  return [table && `tablename=${table}`, by && `sys_created_by=${by}`, since && `sys_created_on>=${since}`, query, 'ORDERBYDESCsys_created_on'].filter(Boolean).join('^');
}

export async function listDeleted(sdk, { table, by, since, query, limit = 20 } = {}) {
  const filter = deletedQuery({ table, by, since, query, limit });
  const rows = await read(sdk, 'sys_audit_delete', filter, FIELDS, limit + 1);
  const page = rows.slice(0, limit).map(row => ({ audit_delete: raw(row.sys_id), table: raw(row.tablename), sys_id: raw(row.documentkey),
    display_value: raw(row.display_value), deleted_by: raw(row.sys_created_by), deleted_on: raw(row.sys_created_on),
    transaction: shown(row.transaction), delete_recovery: raw(row.delete_recovery) }));

  // Is it back? One read per table, by the deleted sys_ids. A table that cannot be read leaves the answer unknown.
  const byTable = new Map();
  for (const row of page) if (TABLE.test(row.table) && SYS_ID.test(row.sys_id)) byTable.set(row.table, [...(byTable.get(row.table) || []), row.sys_id]);
  const back = new Map();
  for (const [name, ids] of byTable) {
    try {
      const found = new Set((await read(sdk, name, `sys_idIN${[...new Set(ids)].join(',')}`, 'sys_id', ids.length)).map(row => raw(row.sys_id)));
      for (const id of ids) back.set(`${name}:${id}`, { back: found.has(id) });
    } catch (error) {
      for (const id of ids) back.set(`${name}:${id}`, { back: null, back_error: error.message || String(error) });
    }
  }

  // Delete recoveries and their rollback contexts, joined by raw sys_id.
  const recoveryIds = [...new Set(page.map(row => row.delete_recovery).filter(id => SYS_ID.test(id)))];
  const recoveries = new Map(recoveryIds.length ? (await read(sdk, 'sys_delete_recovery', `sys_idIN${recoveryIds.join(',')}`, 'sys_id,state,rollback_context', recoveryIds.length)).map(row => [raw(row.sys_id), row]) : []);
  const contextIds = [...new Set([...recoveries.values()].map(row => raw(row.rollback_context)).filter(id => SYS_ID.test(id)))];
  const contexts = new Map(contextIds.length ? (await read(sdk, 'sys_rollback_context', `sys_idIN${contextIds.join(',')}`, 'sys_id,number,state,type', contextIds.length)).map(row => [raw(row.sys_id), row]) : []);

  const records = page.map(({ delete_recovery: recoveryId, ...row }) => {
    const found = back.get(`${row.table}:${row.sys_id}`) || { back: null, back_error: 'The deleted-record entry has no valid table or sys_id.' };
    if (!recoveryId) return { ...row, ...found, delete_recovery: null };
    const recovery = recoveries.get(recoveryId);
    const context = recovery && contexts.get(raw(recovery.rollback_context));
    return { ...row, ...found, delete_recovery: { sys_id: recoveryId, found: Boolean(recovery), state: recovery ? raw(recovery.state) : null, state_label: recovery ? shown(recovery.state) : null,
      rollback_context: context ? { sys_id: raw(context.sys_id), number: raw(context.number), state: raw(context.state), state_label: shown(context.state) } : null,
      // The same conditions the Rollback... action on a delete recovery shows under.
      recoverable: Boolean(context) && raw(recovery.state) !== 'recovered' && raw(context.state) === 'recorded' } };
  });
  return { query: filter, records, count: records.length, pagination: { limit, has_more: rows.length > limit }, ...(records.length ? {} : { visibility: EMPTY }) };
}

export function deletedBreadcrumb(records) {
  const row = records.find(record => record.back === false);
  return { action: 'undelete', description: 'Restore a record that is not back',
    cmd: row ? `jsn records undelete --table ${quoteShellArg(row.table)} --sys-id ${row.sys_id}` : 'jsn records undelete --table <table> --sys-id <deleted sys_id>' };
}

export function formatDeleted(data) {
  const lines = ['Deleted records (sys_audit_delete), newest first'];
  for (const row of data.records) {
    const back = row.back === true ? 'yes' : row.back === false ? 'no' : `unknown (${row.back_error})`;
    const recovery = !row.delete_recovery ? 'none'
      : !row.delete_recovery.found ? `${row.delete_recovery.sys_id}, no longer recorded`
      : `${row.delete_recovery.rollback_context?.number || row.delete_recovery.sys_id}, ${row.delete_recovery.state_label}${row.delete_recovery.rollback_context ? `, context ${row.delete_recovery.rollback_context.state_label}` : ''}${row.delete_recovery.recoverable ? '' : ', not recoverable'}`;
    const transaction = row.transaction.length > 80 ? `${row.transaction.slice(0, 77)}...` : row.transaction;
    lines.push(`${row.deleted_on}  ${row.table} ${row.display_value || '(no display value)'} (${row.sys_id})`,
      `  deleted by ${row.deleted_by || '(unknown)'}${transaction ? ` in ${transaction}` : ''}`,
      `  back: ${back}; cascade recovery: ${recovery}`);
  }
  if (!data.records.length) lines.push(data.visibility);
  if (data.pagination.has_more) lines.push(data.pagination.limit < 200 ? `More match; narrow with --table, --by or --since, or raise --limit (now ${data.pagination.limit}).` : 'More match; narrow with --table, --by, --since or --query (--limit is at its maximum, 200).');
  return `${lines.join('\n')}\n`;
}
