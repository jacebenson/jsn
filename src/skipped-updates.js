import { createHash } from 'node:crypto';
import { errUsage, errNotFound, AppError } from './errors.js';
import { analyzeImpact, baselineFields, isImpactField } from './impact-analysis.js';

export const SKIP_TABLE = 'sys_upgrade_history_log';
const SKIPPED = ['4', '104', '9', '10', '11'];
export const raw = value => String(value?.value ?? value ?? '');
export const unresolved = record => Boolean(record && Object.hasOwn(record, 'disposition')
  && Object.hasOwn(record, 'resolution_status') && SKIPPED.includes(raw(record.disposition))
  && ['', 'not_reviewed'].includes(raw(record.resolution_status)));
const FIELDS = 'sys_id,file_name,target_name,disposition,resolution_status,upgrade_history,reason,changed,sys_mod_count,sys_updated_on';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = id => /^[0-9a-fA-F]{32}$/.test(id || '');

function validateSelection(ids, action) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !validId(id))) {
    throw errUsage('Select between 1 and 100 literal finding sys_ids.');
  }
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw errUsage('Duplicate finding sys_ids are not allowed.');
  if (!['retain', 'revert'].includes(action)) throw errUsage('Select an explicit action: retain or revert. Recommendations are never actions.');
}

export async function reviewSkippedUpdate(sdk, id) {
  if (!validId(id)) throw errUsage('A literal 32-hex finding sys_id is required.');
  const finding = await sdk.get(SKIP_TABLE, id);
  if (!finding) throw errNotFound('Skipped finding', id);
  if (raw(finding.sys_id).toLowerCase() !== id.toLowerCase()) throw errUsage('Provider finding identity does not match selection.');
  const fileName = raw(finding.file_name);
  const match = fileName.match(/^([a-z][a-z0-9_]*)_([0-9a-fA-F]{32})$/);
  const artifact = { update_name: fileName, name: raw(finding.target_name),
    table: match?.[1] || null, sys_id: match?.[2] || null };
  let current = null;
  let baseline = null;
  const unknown = [];
  if (match) {
    try { current = await sdk.get(artifact.table, artifact.sys_id); }
    catch { unknown.push('Current artifact could not be read; access or availability is unknown.'); }
  } else unknown.push('Artifact identity cannot be decoded from the provider update name.');
  try { baseline = await sdk.getSkippedUpdateBaseline(id); }
  catch { unknown.push('Base inspection is unavailable. Background-script access and version API availability are required.'); }
  const dependencies = [];
  if (match) {
    try {
      const refs = await sdk.list('sys_dictionary', new URLSearchParams({
        sysparm_query: `reference=${artifact.table}^elementISNOTEMPTY^ORDERBYname^ORDERBYelement`,
        sysparm_fields: 'name,element', sysparm_limit: '21', sysparm_display_value: 'false',
      }));
      if (refs.length > 20) unknown.push('Incoming reference discovery is truncated to 20 dictionary fields.');
      for (const ref of refs.slice(0, 20)) {
        const table = raw(ref.name), field = raw(ref.element);
        if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(field)) continue;
        try {
          const rows = await sdk.list(table, new URLSearchParams({ sysparm_query: `${field}=${artifact.sys_id}^ORDERBYsys_id`,
            sysparm_fields: 'sys_id', sysparm_limit: '11', sysparm_display_value: 'false' }));
          for (const row of rows.slice(0, 10)) dependencies.push({ table, field, sys_id: raw(row.sys_id), relation: 'incoming_reference' });
          if (rows.length > 10) unknown.push(`Incoming references from ${table}.${field} are truncated to 10 records.`);
        } catch { unknown.push(`Incoming references from ${table}.${field} could not be read.`); }
      }
    } catch { unknown.push('Dictionary-backed incoming dependency discovery is unavailable.'); }
  }
  const impact = analyzeImpact({ artifact, current, baseline, dependencies, unknown });
  const fields = baselineFields(baseline?.payload, artifact);
  const fingerprint = digest({ finding, current, baseline });
  return { sys_id: raw(finding.sys_id), artifact, finding: Object.fromEntries(FIELDS.split(',').map(key => [key, raw(finding[key])])),
    impact, fingerprint, eligible: unresolved(finding),
    revert_supported: raw(finding.disposition) === '4' && validId(baseline?.sys_id)
      && Boolean(current && raw(current.sys_id) === artifact.sys_id && fields
        && Object.keys(fields).every(field => !isImpactField(field) || Object.hasOwn(current, field))) };
}

export async function prepareSkippedBatch(sdk, { ids, action, instance = '' }) {
  validateSelection(ids, action);
  const selected = [];
  for (const id of ids) {
    const review = await reviewSkippedUpdate(sdk, id);
    if (!review.eligible) throw errUsage(`Finding ${id} is no longer unresolved and skipped.`);
    if (action === 'revert' && !review.revert_supported) throw errUsage(`Revert is unsupported for ${id}: requires disposition 4, readable artifact and exact base version.`);
    selected.push({ ...review, action, operation: action === 'retain'
      ? 'Set resolution_status=reviewed_retained only; leave artifact unchanged.'
      : 'Call RevertUpdateVersionAjax.revertToBaseSystem; replace customization with provider-selected base version.' });
  }
  if (action === 'revert') {
    const includes = await sdk.list('sys_script_include', new URLSearchParams({
      sysparm_query: 'name=RevertUpdateVersionAjax', sysparm_fields: 'script', sysparm_limit: '2', sysparm_display_value: 'false' }));
    if (includes.length !== 1 || !/revertToBaseSystem\s*:\s*function\s*\(\s*sys_id\s*\)/.test(raw(includes[0].script))
        || !raw(includes[0].script).includes('GlideappUpdateVersion.getVersion')) {
      throw errUsage('Provider revert lifecycle contract is unavailable; no writes performed.');
    }
  }
  const preview = { instance, selected, count: selected.length };
  return { ...preview, confirmation_token: digest(preview), writes_performed: false };
}


export async function processSkippedBatch({ sdk, ids, action, instance = '', readOnly = false,
  confirmationToken, confirm, onPreview }) {
  if (readOnly) throw new AppError('read_only', 'Read-only profiles cannot process findings.');
  const preview = await prepareSkippedBatch(sdk, { ids, action, instance });
  // Preview precedes the sole confirmation. Never honor force or a profile's
  // skip_confirmations here; this batch always requires explicit consent.
  if (onPreview) await onPreview(preview);
  if (confirmationToken) {
    if (confirmationToken !== preview.confirmation_token) throw errUsage('Preview changed or confirmation token does not match. Review a new preview before confirming.');
  } else if (confirm) {
    if (!await confirm(preview)) return { preview, cancelled: true, results: [], success_count: 0, failure_count: 0, partial: false, writes_performed: false };
  } else {
    throw new AppError('confirmation_required', 'Review the exact batch preview before processing.',
      `Run jsn skipped-updates preview --ids ${ids.join(',')} --action ${action}; review its exact selection, then process that selection with --confirm <preview-token>.`);
  }
  const results = [];
  for (const selected of preview.selected) {
    let attempted = false;
    try {
      const latest = await reviewSkippedUpdate(sdk, selected.sys_id);
      if (!latest.eligible || latest.fingerprint !== selected.fingerprint) throw errUsage('Finding, artifact or base version changed after preview; no write attempted.');
      attempted = true;
      if (action === 'retain') await sdk.update(SKIP_TABLE, selected.sys_id, { resolution_status: 'reviewed_retained' });
      else await sdk.revertSkippedUpdate(selected.sys_id, selected.finding.sys_mod_count);
      const persisted = await sdk.get(SKIP_TABLE, selected.sys_id);
      const expected = action === 'retain' ? 'reviewed_retained' : 'reviewed_reverted';
      if (!persisted || raw(persisted.sys_id) !== selected.sys_id || raw(persisted.resolution_status) !== expected
          || raw(persisted.disposition) !== (action === 'revert' ? '5' : selected.finding.disposition)) {
        throw errUsage('Provider state readback did not verify the selected action.');
      }
      if (action === 'revert') {
        const artifact = await sdk.get(selected.artifact.table, selected.artifact.sys_id);
        const baseline = await sdk.getSkippedUpdateBaseline(selected.sys_id);
        const fields = baselineFields(baseline?.payload, selected.artifact);
        if (!artifact || raw(artifact.sys_id) !== selected.artifact.sys_id || !fields
            || baseline.sys_id !== selected.impact.evidence.baseline_version
            || Object.entries(fields).some(([field, value]) => isImpactField(field)
              && (!Object.hasOwn(artifact, field) || raw(artifact[field]) !== value))) {
          throw errUsage('Artifact readback did not verify all meaningful base fields against the previewed base version.');
        }
      }
      results.push({ sys_id: selected.sys_id, action, success: true, write_attempted: true,
        resolution_status: raw(persisted.resolution_status), disposition: raw(persisted.disposition), verified: true });
    } catch (err) {
      results.push({ sys_id: selected.sys_id, action, success: false, write_attempted: attempted,
        effect: attempted ? 'unknown' : 'unchanged', code: err.code || 'provider_error',
        message: attempted ? 'Selected action or its readback failed; inspect this finding before retrying.' : err.message });
    }
  }
  const successCount = results.filter(result => result.success).length;
  return { preview, results, cancelled: false, success_count: successCount,
    failure_count: results.length - successCount, partial: successCount > 0 && successCount < results.length,
    writes_performed: results.some(result => result.write_attempted) };
}

export async function discoverSkippedUpdates(sdk, { limit = 100, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
    throw errUsage('Use a limit between 1 and 500 and a nonnegative integer offset.');
  }
  const params = new URLSearchParams({
    sysparm_query: 'dispositionIN4,104,9,10,11^resolution_statusIN,not_reviewed^ORDERBYsys_id',
    sysparm_fields: FIELDS, sysparm_display_value: 'all',
    sysparm_limit: String(limit + 1), sysparm_offset: String(offset),
  });
  const rows = await sdk.list(SKIP_TABLE, params);
  // Recheck locally: an instance can ignore a query field the caller cannot read.
  if (rows.some(row => !unresolved(row))) throw errUsage('Provider returned a finding outside the unresolved skipped state.');
  return { findings: rows.slice(0, limit), count: Math.min(rows.length, limit),
    limit, offset, has_more: rows.length > limit, total: null };
}
