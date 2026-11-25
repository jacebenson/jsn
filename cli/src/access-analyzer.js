import { errNotFound, errUsage } from './errors.js';

const REQUEST = 'sn_access_analyzer_request';
const RESULT = 'sn_access_analyzer_access_result';
const LOG = 'sn_access_analyzer_debug_log';
const fields = {
  [REQUEST]: 'sys_id,analyze_by,analyzed_by,user,group,role,resource_type,target_table,target_record,target_field,target_ui_page,target_rest_endpoint,target_rest_endpoint_method,target_client_callable_script_include,operations,short_description,last_run,evaluated_using',
  [RESULT]: 'sys_id,access_analyzer_request,analyzed_by,operation,overall_access,security_data_filter_result,acl_result,accesshandler_result,datafiltration_result,execution_time,execution_id,insights,read_only_field,script_execution,current_resource,current_resource_type,record_available',
  [LOG]: 'sys_id,access_analyzer_request,access_result,type,path,status,roles,roles_result,condition_result,script_result,security_attribute,decision_type,record_ref,log_table_name,log_sequence,log_time,app,applies_to,is_acl_customized,script_execution,applies_to_condition_result,controlled_by_references_result,empty',
};

// Display labels are presentation only. Never use them as reference join keys.
export const rawAccessValue = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
function validateId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) throw errUsage('Provide a 32-character hexadecimal sys_id.');
}
function bounds(limit, offset) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 201) throw errUsage('--offset must be a nonnegative safe integer.');
}
async function read(sdk, table, query, limit, offset = 0) {
  const params = new URLSearchParams({ sysparm_query: query, sysparm_fields: fields[table], sysparm_limit: String(limit), sysparm_offset: String(offset), sysparm_display_value: 'all' });
  const rows = await sdk.listStrict(table, params);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  }
  return rows;
}
async function one(sdk, table, id) {
  const rows = await read(sdk, table, `sys_id=${id}`, 1);
  if (!rows.length) throw errNotFound(`Saved Access Analyzer record ${id} was not found or is not readable.`);
  if (rawAccessValue(rows[0].sys_id) !== id) throw new Error('Access Analyzer returned a different record identity.');
  return rows[0];
}
async function page(sdk, table, query, limit, offset) {
  const rows = await read(sdk, table, query, limit + 1, offset);
  const hasMore = rows.length > limit;
  return { records: rows.slice(0, limit), count: Math.min(rows.length, limit), pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null } };
}

export async function listAccessAnalyses(sdk, { limit = 20, offset = 0 } = {}) {
  bounds(limit, offset);
  return page(sdk, REQUEST, 'ORDERBYDESClast_run^ORDERBYsys_id', limit, offset);
}
export async function showAccessAnalysis(sdk, id, { limit = 50, offset = 0 } = {}) {
  validateId(id);
  bounds(limit, offset);
  const request = await one(sdk, REQUEST, id);
  const results = await page(sdk, RESULT, `access_analyzer_request=${rawAccessValue(request.sys_id)}^ORDERBYexecution_id^ORDERBYoperation^ORDERBYsys_id`, limit, offset);
  assertAssociation(results.records, 'access_analyzer_request', rawAccessValue(request.sys_id));
  // execution_id identifies an operation result, not a shared analysis run.
  return { request, ...results };
}
export async function explainAccessResult(sdk, id, { limit = 50, offset = 0 } = {}) {
  validateId(id);
  bounds(limit, offset);
  const result = await one(sdk, RESULT, id);
  const checks = await page(sdk, LOG, `access_result=${rawAccessValue(result.sys_id)}^ORDERBYlog_sequence^ORDERBYsys_id`, limit, offset);
  assertAssociation(checks.records, 'access_result', rawAccessValue(result.sys_id));
  const notes = ['Saved evidence only; this command does not run an access evaluation.'];
  if (['false', 'no'].includes(rawAccessValue(result.record_available).toLowerCase())) notes.push('The target record was unavailable. Business Rule/query filtering evidence is not itself an ACL failure.');
  return { result, ...checks, notes };
}

function assertAssociation(rows, field, id) {
  if (rows.some(row => rawAccessValue(row[field]) !== id)) throw new Error(`Access Analyzer returned a mismatched ${field} association.`);
}
function requestLine(row) {
  const identity = ['analyze_by', 'analyzed_by', 'user', 'group', 'role'].map(key => text(row[key])).filter(Boolean).join(' / ') || '(identity unavailable)';
  const target = ['resource_type', 'target_table', 'target_record', 'target_field', 'target_ui_page', 'target_rest_endpoint', 'target_rest_endpoint_method', 'target_client_callable_script_include'].map(key => text(row[key])).filter(value => value && value !== 'undefined').join(' / ') || '(target unavailable)';
  return `${rawAccessValue(row.sys_id)} | ${identity}\n  Target: ${target}\n  Last run: ${text(row.last_run) || '(unavailable)'}`;
}
function outcome(row) {
  return `${rawAccessValue(row.sys_id)} | ${text(row.operation) || '(operation unavailable)'}: ${text(row.overall_access) || '(undefined)'} | execution ${text(row.execution_id) || '(unavailable)'}\n  ACL: ${text(row.acl_result) || '(undefined)'}; security data filter: ${text(row.security_data_filter_result) || '(undefined)'}; access handler: ${text(row.accesshandler_result) || '(undefined)'}; data filtration: ${text(row.datafiltration_result) || '(undefined)'}`;
}
export function formatAccessAnalysis(data, mode) {
  const lines = ['Saved Access Analyzer evidence (read-only)'];
  if (mode === 'list') lines.push(...data.records.map(requestLine));
  if (mode === 'show') lines.push(requestLine(data.request), ...data.records.map(outcome));
  if (mode === 'explain') {
    lines.push(outcome(data.result), ...data.notes);
    for (const row of data.records) {
      lines.push(`${text(row.log_sequence)}. ${text(row.type)} ${text(row.path)}: ${text(row.status) || '(undefined)'} [${rawAccessValue(row.sys_id)}]`);
      lines.push(`  Referenced rule: ${text(row.record_ref) || '(unavailable)'}; table: ${text(row.log_table_name) || '(unavailable)'}; sys_id: ${rawAccessValue(row.record_ref) || '(unavailable)'}`);
      lines.push(`  Roles: ${text(row.roles)} (${text(row.roles_result) || '(undefined)'}); condition: ${text(row.condition_result) || '(undefined)'}; script: ${text(row.script_result) || '(undefined)'}; security attribute: ${text(row.security_attribute) || '(undefined)'}; decision: ${text(row.decision_type) || '(undefined)'}`);
    }
  }
  if (!data.count) lines.push('No readable saved rows on this page. Empty results do not prove access or absence of ACL-filtered records.');
  lines.push(`Page: ${data.count} rows, offset ${data.pagination.offset}${data.pagination.has_more ? `; more available, next offset ${data.pagination.next_offset}` : '; no further readable rows'}.`);
  return lines.join('\n');
}
