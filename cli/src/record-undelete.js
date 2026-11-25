// Restore a deleted record through the Deleted Records audit (sys_audit_delete).
// The Undelete Record UI action is one server call, GlideAuditDelete().undelete(id),
// with no REST API or processor in front of it, so the call runs in a guarded
// background script, as skipped-update-provider.js does for its revert.
import { errUsage } from './errors.js';
import { assertMutationScope } from './intended-context.js';
import { recordedOperations, requireAdmin, startRollbackWorker, unsure } from './eval-rollback.js';

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
    sysparm_fields: 'sys_id,tablename,documentkey,display_value,sys_created_on,sys_created_by,delete_recovery,payload',
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

const value = field => field && typeof field === 'object' ? String(field.value ?? '') : String(field ?? '');
const label = field => field && typeof field === 'object' ? String(field.display_value ?? field.value ?? '') : String(field ?? '');

async function readRow(sdk, table, id, fields, missing) {
  const [row] = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: fields, sysparm_display_value: 'all', sysparm_limit: '1' }));
  if (!row || value(row.sys_id) !== id) throw errUsage(missing);
  return row;
}

// Undelete With Related reverts what a script delete recorded in its delete recovery: the record, what its
// delete cascaded to, and the references it cleared. Its UI action shows when the entry has a delete recovery.
// This delete's sequences and those of everything it cascaded to, not yet recovered. Their ids are not sys_ids, so they are counted, not listed.
const pending = (contextId, auditId) => `context=${contextId}^audit_delete=${auditId}^ORaudit_delete_pathLIKE${auditId}^recovered!=true^ORrecoveredISEMPTY`;
export async function previewRelatedUndelete(sdk, entry) {
  // entry comes from findDeletedRecord, which has checked its table, sys_id and audit id.
  const { sys_id: auditId, tablename: table, documentkey: id, delete_recovery: recoveryId } = entry;
  if (!recoveryId) throw errUsage(`${table} ${id} has no delete recovery, so there is nothing related to restore. One is recorded only when server-side script deletes the record, as a background script or business rule does; Table API deletes, as records delete makes, record none. Run without --with-related to restore the record alone.`);
  if (!SYS_ID.test(recoveryId)) throw errUsage('The sys_audit_delete entry has a malformed delete recovery. Nothing was restored.');
  const recovery = await readRow(sdk, 'sys_delete_recovery', recoveryId, 'sys_id,state,rollback_context', `Delete recovery ${recoveryId} for ${table} ${id} cannot be read; the docs give seven days to use one. Run without --with-related to restore the record alone.`);
  const contextId = value(recovery.rollback_context);
  if (!SYS_ID.test(contextId)) throw errUsage(`Delete recovery ${recoveryId} has no rollback context. Nothing was restored.`);
  const context = await readRow(sdk, 'sys_rollback_context', contextId, 'sys_id,number,state', `The rollback context of delete recovery ${recoveryId} cannot be read; the docs say rollback contexts are deleted after ten days. Run without --with-related to restore the record alone.`);
  const number = label(context.number);
  const operations = await recordedOperations(sdk, pending(contextId, auditId), number, 'Nothing was restored.');
  if (!operations.length) throw errUsage(`Delete recovery ${number} has nothing left to restore for ${table} ${id}. Nothing was restored.`);
  return { table, sys_id: id, display_value: entry.display_value, audit_delete: auditId, deleted_on: entry.sys_created_on, deleted_by: entry.sys_created_by,
    delete_recovery: { sys_id: recoveryId, state: value(recovery.state) }, rollback_context: { sys_id: contextId, number, state: value(context.state) },
    operations, total: operations.reduce((sum, op) => sum + op.count, 0) };
}

export async function runRelatedUndelete(sdk, plan, options = {}) {
  const { table, sys_id: id, audit_delete: auditId, delete_recovery: { sys_id: recoveryId }, rollback_context: { sys_id: contextId, number } } = plan;
  checkIds(table, id);
  if (![auditId, recoveryId, contextId].every(value => SYS_ID.test(value || ''))) throw errUsage('The plan has no valid sys_audit_delete, delete recovery or rollback context id. Nothing was restored.');
  await requireAdmin(sdk, 'Undelete With Related needs the admin role, as its action in Deleted Records does. Nothing was restored.');
  const check = `jsn records get --table ${table} --sys-id ${id} and jsn records get --table sys_delete_recovery --sys-id ${recoveryId}`;
  const { progressId, status, message, lost } = await startRollbackWorker(sdk, { sysparm_ajax_processor_audit_delete_id: auditId }, { noun: `undelete of ${table} ${id} with related records (${number})`, check, ...options });
  const back = await readRecord(sdk, table, id).catch(error => { throw lost(error); });
  if (status !== 'successful' || !back) throw unsure(`The undelete of ${table} ${id} with related records ended ${status}${message ? ` (${message})` : ''} and the record ${back ? 'is back' : 'is still missing'}. Check ${check}.`, check);
  // The worker marks each sequence it reverts recovered; the recovery and context then read partially recovered and rolled back.
  const left = await recordedOperations(sdk, pending(contextId, auditId), number, '').catch(error => { throw lost(error); });
  if (left.length) throw unsure(`The undelete of ${table} ${id} with related records brought the record back, but ${number} still has unrecovered operations: ${left.map(op => `${op.table} ${op.operation} ${op.count}`).join(', ')}. Check ${check}.`, check);
  return { ...plan, delete_recovery: { sys_id: recoveryId }, rollback_context: { sys_id: contextId, number }, progress_id: progressId, restored: true };
}
