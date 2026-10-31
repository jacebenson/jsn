import { SaxesParser } from 'saxes';
import { getRecord, recordListParams } from './records-engine.js';
import { isSysId, unwrapSysId } from './resolve-record.js';
import { errAPI, errNotFound, errUsage } from './errors.js';

export const CHECK_TABLES = {
  table: 'scan_table_check', column: 'scan_column_type_check',
  linter: 'scan_linter_check', script: 'scan_script_only_check',
};
export const raw = value => value && typeof value === 'object' ? (value.value ?? '') : value;
export const active = record => [true, 'true', '1', 1].includes(raw(record?.active));
export const referenceId = value => {
  const id = raw(value) || value?.link?.split('/').at(-1);
  return isSysId(id) ? id : '';
};

export function requireId(value, label = 'execution') {
  if (!isSysId(value)) throw errUsage(`Use a full 32-character sys_id for ${label}.`);
  return value;
}

export function boundedLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  return value;
}

export async function scanList(sdk, table, { limit = 50, offset = 0, fields, query } = {}) {
  boundedLimit(limit);
  if (!Number.isInteger(offset) || offset < 0) throw errUsage('--offset must be a nonnegative integer.');
  const params = recordListParams({ limit, offset, fields, query, displayValue: 'false' });
  return sdk.listStrict(table, params);
}

export async function resolveScanRecord(sdk, table, identifier, matchField = 'name') {
  const record = await getRecord(sdk, { table, identifier, matchField, displayValues: 'raw', resource: table });
  if (table !== 'scan_check') return record;
  const subtype = String(raw(record.sys_class_name) || '');
  if (!Object.values(CHECK_TABLES).includes(subtype)) return record;
  const concrete = await sdk.get(subtype, unwrapSysId(record));
  if (!concrete || unwrapSysId(concrete) !== unwrapSysId(record)) throw errUsage('The concrete check definition is unavailable; inspect its class and permissions before changing it.');
  return { ...record, ...concrete };
}

const COMMON_FIELDS = ['name', 'description', 'short_description', 'active', 'category', 'priority',
  'script', 'run_condition', 'finding_type', 'resolution_details', 'documentation_url', 'score_min', 'score_max', 'score_scale'];

export function validateScanPayload(kind, input, { create = false, suite = false, current = {} } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw errUsage('The payload must be a JSON object.');
  if (!suite && !CHECK_TABLES[kind]) throw errUsage('Choose --type table, column, linter, or script.');
  const fields = suite ? ['name', 'description', 'active', 'private'] : [...COMMON_FIELDS,
    ...(kind === 'table' ? ['table', 'conditions', 'advanced', 'use_manifest'] : []),
    ...(kind === 'column' ? ['column_type'] : [])];
  for (const field of Object.keys(input)) {
    if (!fields.includes(field)) throw errUsage(`Unsupported ${suite ? 'suite' : kind + ' check'} field: ${field}`);
  }
  const data = { ...input };
  for (const field of ['active', 'private', 'advanced', 'use_manifest']) {
    if (data[field] === undefined) continue;
    if (![true, false, 'true', 'false'].includes(data[field])) throw errUsage(`${field} must be true or false.`);
    data[field] = data[field] === true || data[field] === 'true';
  }
  if ((create || data.name !== undefined) && (typeof data.name !== 'string' || !data.name.trim())) throw errUsage('A nonempty name is required.');
  if (data.script !== undefined && typeof data.script !== 'string') throw errUsage('script must be a string.');
  if (create && data.active === undefined) data.active = false;
  if (data.table !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(data.table)) throw errUsage('Invalid target table name.');
  if (data.column_type !== undefined && !['script', 'xml', 'html'].includes(data.column_type)) throw errUsage('column_type must be script, xml, or html.');
  if (!suite) {
    const script = data.script ?? raw(current.script);
    const advanced = data.advanced ?? active({ active: current.advanced });
    if (create && kind === 'table' && !data.table) throw errUsage('Table checks require a table.');
    if (create && kind === 'column' && !data.column_type) throw errUsage('Column checks require column_type.');
    if ((create || Object.hasOwn(data, 'script') || Object.hasOwn(data, 'advanced'))
      && (kind !== 'table' || advanced) && (typeof script !== 'string' || !script.trim())) {
      throw errUsage('This check type requires a nonempty script.');
    }
  }
  return data;
}

export function checkKind(record) {
  const table = String(raw(record.sys_class_name) || '');
  const kind = Object.keys(CHECK_TABLES).find(key => CHECK_TABLES[key] === table);
  if (!kind) throw errUsage('Unknown or unreadable check class; inspect the check before changing it.');
  return kind;
}

function decodeAjax(xml) {
  let answer;
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw errAPI(200, 'Unexpected document type in scan response.'); });
  parser.on('opentag', node => { if (node.name === 'xml') answer = node.attributes.answer; });
  try { parser.write(xml).close(); } catch { throw errAPI(200, 'Malformed scan processor XML response.'); }
  if (typeof answer !== 'string') throw errAPI(200, 'Scan processor returned no answer; check endpoint access.');
  return answer;
}

export async function scanAjax(sdk, method, parameters) {
  const query = new URLSearchParams({ sysparm_processor: 'ScanAjaxProcessor', sysparm_name: method, ...parameters });
  return decodeAjax(await sdk.rawRequest(`${sdk.baseURL}/xmlhttp.do?${query}`, { method: 'POST' }));
}

const TERMINAL = new Set(['successful', 'failed', 'cancelled']);
const STATES = { '0': 'pending', '1': 'running', '2': 'successful', '3': 'failed', '4': 'cancelled',
  pending: 'pending', running: 'running', successful: 'successful', failed: 'failed',
  cancelled: 'cancelled', canceled: 'cancelled' };

export async function scanStatus(sdk, id, { allowInitializing = false } = {}) {
  requireId(id);
  const tracker = await sdk.get('sys_execution_tracker', id);
  if (!tracker) throw errNotFound('scan execution', id);
  if (!raw(tracker.type) && allowInitializing) return { execution_id: id, status: 'pending', terminal: false,
    percent_complete: null, message: 'Execution tracker is initializing', result_id: null };
  if (raw(tracker.type) === 'sys.instance_scan.queue') return { execution_id: id, status: 'pending', terminal: false,
    percent_complete: raw(tracker.percent_complete) ?? null, message: raw(tracker.message) || 'Scan is queued', result_id: null };
  if (raw(tracker.type) !== 'instance_scan') throw errUsage('This execution tracker is not an Instance Scan.');
  const state = STATES[String(raw(tracker.state)).toLowerCase()] || 'unknown';
  let resultId = '';
  if (raw(tracker.result)) {
    try { resultId = referenceId(JSON.parse(raw(tracker.result)).result_id); } catch { /* reported as unavailable below */ }
  }
  return { execution_id: id, status: state, terminal: TERMINAL.has(state),
    percent_complete: raw(tracker.percent_complete) ?? null,
    message: raw(tracker.message) || '', result_id: resultId || null };
}

async function resolveSuite(sdk, identifier) {
  const suite = await resolveScanRecord(sdk, 'scan_check_suite', identifier);
  if (!active(suite)) throw errUsage('The selected suite is inactive or its active state is unreadable. Activate it explicitly first.');
  return unwrapSysId(suite);
}

export async function prepareScan(sdk, argv) {
  const previous = argv.previous;
  const updateSet = argv.updateSet ?? argv['update-set'];
  for (const value of [previous, updateSet, argv.scope, argv.record, argv.suite]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw errUsage('Scan target and suite identifiers must be nonempty strings.');
  }
  const selectors = [updateSet, argv.scope, argv.record, previous].filter(value => value !== undefined).length;
  if (selectors + Number(Boolean(argv.full)) !== 1 && !(previous && argv.full && selectors === 1)) {
    throw errUsage('Choose exactly one target: --update-set, --scope, --record with --table, --full, or --previous.');
  }
  if (Boolean(argv.table) !== Boolean(argv.record)) throw errUsage('--record and --table must be supplied together.');
  if (previous && argv.suite) throw errUsage('--previous preserves its source suite; do not combine it with --suite.');
  let target;
  if (previous) {
    const status = await scanStatus(sdk, previous);
    if (!status.terminal || !status.result_id) throw errUsage('The previous scan must have finished and have a readable result.');
    const result = await sdk.get('scan_result', status.result_id);
    const comboId = referenceId(result?.combo);
    if (!comboId) throw errUsage('The previous scan has no reusable target combination. Choose an explicit target.');
    const combo = await sdk.get('scan_combo', comboId);
    if (!combo) throw errUsage('The previous scan combination is unavailable.');
    if (!raw(combo.targets) && !argv.full) throw errUsage('The previous scan was instance-wide. Repeat with --full to approve that breadth.');
    target = { kind: 'previous', execution_id: previous, combo_id: comboId, full: !raw(combo.targets) };
  } else if (updateSet !== undefined) {
    const record = await resolveScanRecord(sdk, 'sys_update_set', updateSet);
    target = { kind: 'update_set', sys_id: unwrapSysId(record), name: raw(record.name),
      note: 'Scans current instance records referenced by this update set, not historical XML versions. Script-only checks do not participate.' };
  } else if (argv.scope !== undefined) {
    const record = await resolveScanRecord(sdk, 'sys_scope', argv.scope, 'scope');
    target = { kind: 'scope', sys_id: unwrapSysId(record), name: raw(record.scope) };
  } else if (argv.record !== undefined) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(argv.table)) throw errUsage('Invalid target table.');
    const record = await resolveScanRecord(sdk, argv.table, argv.record, 'sys_id');
    target = { kind: 'record', table: argv.table, sys_id: unwrapSysId(record),
      inactive: raw(record.active) === false || raw(record.active) === 'false',
      note: 'Inactive target records may be skipped by the scan engine. Script-only checks do not participate.' };
  } else target = { kind: 'full', note: 'Instance-wide scans can traverse many tables and take substantially longer.' };
  if (!target.sys_id && !['full', 'previous'].includes(target.kind)) throw errUsage('The target has no readable sys_id.');
  const suiteId = argv.suite ? await resolveSuite(sdk, argv.suite) : null;
  return { target, suite_id: suiteId };
}

export async function startScan(sdk, plan) {
  const { target, suite_id: suite } = plan;
  let response;
  if (suite && ['update_set', 'scope'].includes(target.kind)) {
    const kind = target.kind === 'scope' ? 'scoped_apps' : 'update_sets';
    const field = target.kind === 'scope' ? 'app_scope_sys_ids' : 'update_set_sys_ids';
    const data = await sdk.request(`${sdk.baseURL}/api/sn_cicd/instance_scan/suite_scan/${requireId(suite, 'suite')}/${kind}`, {
      method: 'POST', body: JSON.stringify({ [field]: [target.sys_id] }),
    });
    response = data?.result;
    if (response?.error || !['0', '1', '2'].includes(String(response?.status))) throw errAPI(200, 'Scan dispatch was rejected by the provider.');
    const executionId = response?.links?.progress?.id;
    if (!isSysId(executionId)) throw errAPI(200, 'Scan dispatch returned no valid execution id. Inspect existing scans before retrying.');
    return { execution_id: executionId, via: 'sn_cicd', ...plan };
  }
  let method, parameters;
  if (target.kind === 'previous') { method = 'executeScanFromCombo'; parameters = { sysparm_combo_id: target.combo_id }; }
  else if (suite && target.kind === 'full') { method = 'executeSuiteScan'; parameters = { sysparm_sys_id: suite }; }
  else if (suite) {
    method = 'executeSuiteScanWithTargets'; parameters = { sysparm_suite_sys_id: suite,
      sysparm_target_table: target.table, sysparm_target_sys_ids: JSON.stringify([target.sys_id]) };
  } else if (target.kind === 'update_set') { method = 'executeUpdateSetScan'; parameters = { sysparm_sys_id: target.sys_id }; }
  else if (target.kind === 'scope') { method = 'executeAppScan'; parameters = { sysparm_scope_id: target.sys_id }; }
  else if (target.kind === 'record') { method = 'executePointScan'; parameters = { sysparm_sys_id: target.sys_id, sysparm_table_name: target.table }; }
  else { method = 'executeFullScan'; parameters = {}; }
  try { response = JSON.parse(await scanAjax(sdk, method, parameters)); }
  catch (error) { if (error.code) throw error; throw errAPI(200, 'Malformed scan dispatch answer. Inspect existing scans before retrying.'); }
  if (response.status !== 0 || !isSysId(response.progressId)) throw errAPI(200, 'Scan dispatch failed or returned no valid execution id. Inspect existing scans before retrying.');
  return { execution_id: response.progressId, via: 'ScanAjaxProcessor', ...plan };
}

export async function scanResults(sdk, id, limit = 50) {
  boundedLimit(limit);
  const status = await scanStatus(sdk, id);
  const data = { ...status, checks_executed: null, findings_count: null, checks: [], findings: [],
    incomplete: !status.terminal, unavailable: [], truncated: {}, rerun_full: false, reusable_target: false };
  if (!status.result_id) { data.unavailable.push('scan_result'); data.incomplete = true; return data; }
  let result;
  try {
    result = await sdk.get('scan_result', status.result_id);
    if (!result) throw new Error('Result unavailable');
    data.scan_number = raw(result.number);
    const value = raw(result.finding_count);
    const count = Number(value);
    if ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isInteger(count) && count >= 0) data.findings_count = count;
    else { data.unavailable.push('scan_result.finding_count'); data.incomplete = true; }
  } catch { data.unavailable.push('scan_result'); data.incomplete = true; }
  for (const [key, table, fields] of [
    ['checks', 'scan_check_execution', ['check', 'message', 'execution_time']],
    ['findings', 'scan_finding', ['check', 'source_table', 'source', 'finding_details', 'count']],
  ]) {
    try {
      const rows = await sdk.listStrict(table, recordListParams({ limit: limit + 1,
        query: `result=${status.result_id}^ORDERBYsys_id`, fields, displayValue: 'all' }));
      data[key] = rows.slice(0, limit);
      data.truncated[key] = rows.length > limit;
      if (key === 'checks' && !data.truncated[key] && status.terminal) data.checks_executed = rows.length;
    } catch { data.unavailable.push(table); data.incomplete = true; }
  }
  const comboId = referenceId(result?.combo);
  if (comboId) {
    try { const combo = await sdk.get('scan_combo', comboId); if (combo) { data.reusable_target = true; data.rerun_full = !raw(combo.targets); } }
    catch { /* Optional rerun hint is omitted when target metadata is inaccessible. */ }
  }
  data.coverage_note = 'Execution success does not prove functional correctness or complete coverage. Zero findings may mean records or checks were skipped.';
  return data;
}

export async function cancelScan(sdk, id) {
  const status = await scanStatus(sdk, id);
  if (status.terminal) return { ...status, cancellation_requested: false };
  const answer = await scanAjax(sdk, 'cancelScan', { sysparm_progress_id: id });
  const after = await scanStatus(sdk, id);
  if (after.status !== 'cancelled' && !/cancelled successfully/i.test(answer)) throw errAPI(200, 'Cancellation was not confirmed. Check the execution status before retrying.');
  return { ...after, cancellation_requested: true };
}
