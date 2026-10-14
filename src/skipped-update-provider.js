import { errUsage } from './errors.js';

function validateId(id) {
  if (!/^[0-9a-fA-F]{32}$/.test(id || '')) throw errUsage('A literal 32-hex skipped finding sys_id is required.');
}

// Contract observed in RevertUpdateVersionAjax.revertToBaseSystem, PDI Australia.
// Keep read and write separate. No Table API state update can implement revert.
export async function readSkippedBaseline(sdk, id) {
  validateId(id);
  const output = await sdk.executeScript(`(function() {
    var record = new GlideRecordSecure('sys_upgrade_history_log');
    if (!record.get('${id}') || !record.canRead()) throw new Error('Finding unavailable');
    var name = record.getValue('file_name');
    var storeAppID = GlideappUpdateVersion.getStoreAppID(record);
    var baseline = storeAppID != null
      ? GlideappUpdateVersion.getVersion(name, storeAppID, 'sys_store_app', null)
      : GlideappUpdateVersion.getVersion(name, record.upgrade_history, 'sys_upgrade_history', null);
    if (!baseline || !baseline.isValidRecord()) throw new Error('No base system version found');
    gs.print('JSN_SKIPPED_BASE:' + JSON.stringify({sys_id: baseline.getUniqueValue(),
      payload: baseline.getValue('payload'), source: baseline.getValue('source'),
      source_table: baseline.getValue('source_table')}));
  })();`, 'global');
  const match = output.match(/JSN_SKIPPED_BASE:(\{[^\r\n]*\})/);
  if (!match) throw errUsage('Base version inspection returned no verifiable result.');
  try { return JSON.parse(match[1]); } catch { throw errUsage('Base version inspection returned invalid JSON.'); }
}

export async function revertSkippedUpdate(sdk, id, modCount) {
  validateId(id);
  if (!/^\d+$/.test(modCount || '')) throw errUsage('Finding update count is required for safe revert.');
  const output = await sdk.executeScript(`(function() {
    if (!gs.hasRole('admin')) throw new Error('Admin role required');
    var record = new GlideRecordSecure('sys_upgrade_history_log');
    if (!record.get('${id}') || !record.canWrite()) throw new Error('Finding unavailable or not writable');
    if (record.getValue('disposition') !== '4' ||
        ['', 'not_reviewed'].indexOf(record.getValue('resolution_status') || '') < 0 ||
        record.getValue('sys_mod_count') !== '${modCount}') throw new Error('Finding changed or is not eligible');
    new RevertUpdateVersionAjax().revertToBaseSystem('${id}');
    gs.print('JSN_SKIPPED_REVERT:dispatched');
  })();`, 'global');
  if (!output.includes('JSN_SKIPPED_REVERT:dispatched')) throw errUsage('Revert dispatch outcome is unknown; inspect the finding before retrying.');
  // The processor returns no success boolean. Caller must verify disposition and
  // resolution by GET; dispatch alone must never be reported as success.
}
