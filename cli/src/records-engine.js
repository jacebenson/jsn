// In-process CRUD transport shared by generic and specialized commands.
// Policy (confirmation, scope, payload and output shape) stays with callers.
import { resolveRecord, unwrapSysId } from './resolve-record.js';
import { errUsage } from './errors.js';

export function displayValue(mode, fallback = 'all') {
  if (mode === undefined) return fallback;
  const values = { raw: 'false', display: 'true', both: 'all' };
  if (!Object.hasOwn(values, mode)) throw errUsage('display-values must be raw, display or both');
  return values[mode];
}

export function recordListParams({ limit, offset, query, fields, displayValue: representation = 'all' } = {}) {
  const params = new URLSearchParams({ sysparm_display_value: representation });
  if (limit !== undefined) params.set('sysparm_limit', String(limit));
  if (offset !== undefined) params.set('sysparm_offset', String(offset));
  if (query) params.set('sysparm_query', query);
  if (fields) params.set('sysparm_fields', Array.isArray(fields) ? fields.join(',') : fields);
  return params;
}

export function listRecords(sdk, { table, params, displayValues, ...options }) {
  const query = params ? new URLSearchParams(params) : recordListParams(options);
  if (displayValues !== undefined) query.set('sysparm_display_value', displayValue(displayValues));
  return sdk.list(table, query);
}

export function getRecord(sdk, options) {
  return resolveRecord(sdk, { ...options, displayValue: displayValue(options.displayValues, options.displayValue || 'all') });
}

export function createRecord(sdk, { table, data }) {
  return sdk.create(table, data);
}

function mutationId(record) {
  const id = unwrapSysId(record);
  if (!id) throw errUsage('The matched record has no readable sys_id; check field ACLs before retrying.');
  return id;
}

export async function updateRecord(sdk, { table, data, record, ...lookup }) {
  const resolved = record || await getRecord(sdk, { table, ...lookup });
  return sdk.update(table, mutationId(resolved), data);
}

export async function deleteRecord(sdk, { table, record, ...lookup }) {
  const resolved = record || await getRecord(sdk, { table, ...lookup });
  const id = mutationId(resolved);
  await sdk.delete(table, id);
  return id;
}

export function recordOptions(y, display = true) {
  const command = y.option('identifier-field', { type: 'string', describe: 'Exact field for disambiguation (sys_id, number, name, etc); no human-field partial matches' });
  return display ? command.option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both; omitted preserves existing output' }) : command;
}
