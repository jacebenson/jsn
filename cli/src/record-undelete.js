// Restore a deleted record through the Deleted Records audit (sys_audit_delete).
// The Undelete Record UI action is one server call, GlideAuditDelete().undelete(id),
// with no REST API or processor in front of it, so the call runs in a guarded
// background script, as skipped-update-provider.js does for its revert.
import { errUsage } from './errors.js';
import { assertMutationScope } from './intended-context.js';

const SYS_ID = /^[0-9a-f]{32}$/;

// Every value that goes into the script is checked here, by each exported function.
function checkIds(table, id) {
  if (!/^[a-z0-9_]+$/.test(table || '')) throw errUsage('--table must be a table name (lower-case letters, digits and underscores).');
  if (!SYS_ID.test(id || '')) throw errUsage('--sys-id must be the deleted record\'s 32-character sys_id.');
}

async function readRecord(sdk, table, id) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: 'sys_id', sysparm_limit: '1' }));
  return rows.find(row => row?.sys_id === id);
}

export async function findDeletedRecord(app, table, id) {
  checkIds(table, id);
  const [entry] = await app.sdk.listStrict('sys_audit_delete', new URLSearchParams({
    sysparm_query: `tablename=${table}^documentkey=${id}^ORDERBYDESCsys_created_on`,
    sysparm_fields: 'sys_id,tablename,documentkey,display_value,sys_created_on,sys_created_by,payload',
    sysparm_display_value: 'false', sysparm_limit: '1' }));
  if (!entry) throw errUsage(`No deleted record ${table} ${id} in sys_audit_delete. Use the record's own table (incident, not task); otherwise it was never deleted or is already restored, its table does not audit deletes, or you lack admin.`);
  if (entry.tablename !== table || entry.documentkey !== id || !SYS_ID.test(entry.sys_id || '')) throw errUsage('The sys_audit_delete entry returned does not match the table and sys_id asked for. Nothing was restored.');
  if (await readRecord(app.sdk, table, id)) throw errUsage(`${table} ${id} already exists. Nothing was restored.`);
  // Undelete inserts the payload as it was, so a verified capture context must match its scope.
  if (app.mutationContext?.verified) assertMutationScope(app.mutationContext, entry.payload?.match(/<sys_scope(?:\s[^>]*)?>([^<]*)<\/sys_scope>/)?.[1], 'Deleted record');
  return entry;
}

export async function restoreDeletedRecord(sdk, entry) {
  const { sys_id: auditId, tablename: table, documentkey: id } = entry;
  checkIds(table, id);
  if (!SYS_ID.test(auditId || '')) throw errUsage('The sys_audit_delete entry has no valid sys_id. Nothing was restored.');
  const output = await sdk.executeScript(`(function() {
  if (!gs.hasRole('admin')) throw new Error('Admin role required');
  var entry = new GlideRecord('sys_audit_delete');
  if (!entry.get('${auditId}') || entry.getValue('tablename') !== '${table}' || entry.getValue('documentkey') !== '${id}') throw new Error('Deleted record entry changed or unavailable');
  var record = new GlideRecord('${table}');
  if (record.get('${id}')) throw new Error('Record already exists');
  new GlideAuditDelete().undelete('${auditId}');
  gs.print('JSN_UNDELETE:dispatched');
})();`, 'global');
  if (!String(output).includes('JSN_UNDELETE:dispatched')) throw new Error(`Undelete outcome is unknown; inspect ${table} ${id} before retrying. Script output: ${output || '(none)'}`);
  if (!await readRecord(sdk, table, id)) throw new Error(`${table} ${id} is not readable after the undelete; inspect it and sys_audit_delete ${auditId} before retrying.`);
}
