import fs from 'node:fs';
import { errUsage } from './errors.js';
import { readTableMetadata } from './query-metadata.js';
import { quoteShellArg } from './helpers.js';

// Import Set API row outcomes (sys_import_set_row.sys_import_state); anything else is an error.
export const OUTCOMES = new Set(['inserted', 'updated', 'ignored', 'skipped']);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw errUsage('The CSV file has an unterminated quote.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...data] = rows.filter(r => r.some(value => value !== ''));
  if (!header.length || header.some(name => !name) || new Set(header).size !== header.length) {
    throw errUsage('The CSV header must name each column once.');
  }
  return data.map((values, i) => {
    if (values.length !== header.length) throw errUsage(`Row ${i + 1} has ${values.length} field(s); the header has ${header.length}.`);
    return Object.fromEntries(header.map((name, j) => [name, values[j]]));
  });
}

/** Parse a .json (array, or { records: [...] }) or .csv file into rows of string values. */
export function parseImportRows(name, text) {
  text = text.replace(/^\uFEFF/, '');
  let rows;
  if (/\.csv$/i.test(name)) rows = parseCsv(text);
  else if (/\.json$/i.test(name)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw errUsage('The --file is not valid JSON.'); }
    rows = Array.isArray(parsed) ? parsed : parsed?.records;
    if (!Array.isArray(rows)) throw errUsage('The JSON file must be an array of row objects, or { "records": [...] }.');
  } else throw errUsage('The --file must end in .json or .csv.');
  if (!rows.length) throw errUsage('The file has no rows.');
  return rows.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw errUsage(`Row ${i + 1} is not an object.`);
    const entries = Object.entries(row);
    if (!entries.length) throw errUsage(`Row ${i + 1} has no columns.`);
    return Object.fromEntries(entries.map(([column, value]) => {
      // The Import Set API stores only strings; nested values would be mangled.
      if (value !== null && typeof value === 'object') throw errUsage(`Row ${i + 1} column ${column} holds an object or array; only text, numbers and booleans load.`);
      return [column, value == null ? '' : String(value)];
    }));
  });
}

export function readImportFile(file, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw errUsage('--limit must be a positive safe integer.');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { throw errUsage(`Cannot read --file: ${error.message}`); }
  const rows = parseImportRows(file, text);
  if (rows.length > limit) throw errUsage(`The file's ${rows.length} rows exceed --limit ${limit}. Raise --limit explicitly to load them. No rows sent.`);
  return rows;
}

/** Prove the table is a staging table, every column exists on it, and a transform map reads it. */
export async function checkStagingTable(sdk, table, columns) {
  const metadata = await readTableMetadata(sdk, table);
  if (metadata.state !== 'observed') {
    const hint = metadata.suggestions?.length ? ` Did you mean: ${metadata.suggestions.join(', ')}?` : '';
    throw errUsage(`${metadata.reason || `Cannot read the metadata for ${table}`}.${hint} No rows sent.`);
  }
  if (!metadata.hierarchy.includes('sys_import_set_row')) throw errUsage(`${table} is not an import set staging table (it does not extend sys_import_set_row). No rows sent.`);
  const unknown = columns.filter(column => !Object.hasOwn(metadata.fields[table] || {}, column));
  if (unknown.length) throw errUsage(`Unknown column(s) on ${table}: ${unknown.join(', ')}. Use the staging table's column names (jsn columns list --table ${table}). No rows sent.`);
  const maps = await activeTransformMaps(sdk, table);
  if (!maps.length) throw errUsage(`No active transform map for ${table} is visible to this identity (none exists, or sys_transform_map is ACL-hidden), so a load would only stage rows. No rows sent.`);
  return maps;
}

// shortcut: Robust Transform Engine (sys_robust_import_set_transformer) tables are not read; add them when someone needs them.
export async function activeTransformMaps(sdk, table) {
  const maps = await sdk.listStrict('sys_transform_map', new URLSearchParams({
    sysparm_query: `source_table=${table}^active=true^ORDERBYorder`, sysparm_fields: 'sys_id,name,target_table',
    sysparm_limit: '50', sysparm_display_value: 'false' }));
  return maps.map(map => ({ sys_id: String(map?.sys_id ?? ''), name: String(map?.name ?? ''), target_table: String(map?.target_table ?? '') }));
}

/** POST each row to the synchronous Import Set API; stop at the first failed request. */
export async function loadImportRows(sdk, table, rows) {
  const results = [];
  const importSets = new Set();
  let sent = 0;
  for (const [index, row] of rows.entries()) {
    const n = index + 1;
    let body;
    sent++;
    try {
      body = await sdk.request(`${sdk.baseURL}/api/now/import/${table}`, { method: 'POST', body: JSON.stringify(row) });
    } catch (error) {
      results.push({ row: n, status: 'error', error_message: error.message || String(error) });
      break;
    }
    if (body?.import_set) importSets.add(String(body.import_set));
    const entries = Array.isArray(body?.result) ? body.result : [];
    if (!entries.length) results.push({ row: n, status: 'error', error_message: 'The Import Set API returned no transform result for this row.' });
    for (const entry of entries) {
      const status = String(entry?.status ?? '');
      const target = /^[0-9a-f]{32}$/.test(String(entry?.sys_id ?? '')) && /^[a-zA-Z0-9_]+$/.test(String(entry?.table ?? ''));
      const problem = !OUTCOMES.has(status) && status !== 'error' ? `Unknown import status '${status}'.`
        : (status === 'inserted' || status === 'updated') && !target ? 'The Import Set API named no target record for this row.' : undefined;
      results.push({ row: n, status, transform_map: entry?.transform_map, table: entry?.table, sys_id: entry?.sys_id,
        display_value: entry?.display_value, status_message: entry?.status_message, error_message: entry?.error_message || problem });
    }
  }
  // The API's answer is not proof: read each written target back, one bounded read per table.
  const written = results.filter(r => (r.status === 'inserted' || r.status === 'updated') && !r.error_message);
  for (const table of new Set(written.map(r => r.table))) {
    const mine = written.filter(r => r.table === table);
    let found;
    try {
      found = new Set((await sdk.listStrict(table, new URLSearchParams({ sysparm_query: `sys_idIN${mine.map(r => r.sys_id).join(',')}`,
        sysparm_fields: 'sys_id', sysparm_limit: String(mine.length), sysparm_display_value: 'false' }))).map(r => String(r?.sys_id ?? '')));
    } catch (error) {
      for (const r of mine) r.error_message = `Could not read ${table} back after the load: ${error.message}`;
      continue;
    }
    for (const r of mine) if (!found.has(r.sys_id)) r.error_message = `${table} ${r.sys_id} was not found when read back after the load.`;
  }
  const failedRows = new Set(results.filter(r => !OUTCOMES.has(r.status) || r.error_message).map(r => r.row));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { staging_table: table, import_sets: [...importSets], total: rows.length, sent, not_sent: rows.length - sent,
    failed: failedRows.size, counts, results };
}

/** Read one import set, by number or sys_id, and up to limit + 1 of its rows. */
export async function readImportSet(sdk, id, limit) {
  const field = /^[0-9a-fA-F]{32}$/.test(id) ? 'sys_id' : 'number';
  const [found] = await sdk.listStrict('sys_import_set', new URLSearchParams({ sysparm_query: `${field}=${id}`,
    sysparm_fields: 'sys_id,number,table_name,state,mode', sysparm_limit: '1', sysparm_display_value: 'false' }));
  if (!found) throw errUsage(`No import set ${id} is visible. Nothing transformed.`);
  if (String(found[field] ?? '').toLowerCase() !== id.toLowerCase()) throw errUsage(`Import set ${id} read back as a different record.`);
  const set = Object.fromEntries(['sys_id', 'number', 'table_name', 'state', 'mode'].map(key => [key, String(found[key] ?? '')]));
  const rows = await sdk.listStrict('sys_import_set_row', new URLSearchParams({ sysparm_query: `sys_import_set=${set.sys_id}^ORDERBYsys_import_row`,
    sysparm_fields: 'sys_id,sys_import_row,sys_import_state,sys_import_state_comment,sys_target_table,sys_target_sys_id,sys_transform_map',
    sysparm_limit: String(limit + 1), sysparm_display_value: 'false' }));
  return { set, rows };
}

/** The states the platform's Transform (loaded) and Reprocess (processed) UI actions start from. */
export function checkTransformable({ set, rows }, limit) {
  if (set.state !== 'loaded' && set.state !== 'processed') throw errUsage(`Import set ${set.number} is ${set.state || 'in no state'}; only a loaded or processed set can be transformed (a web service set stays loading until the platform closes it). Nothing transformed.`);
  if (!/^[0-9a-f]{32}$/.test(set.sys_id) || !/^[a-zA-Z0-9_]+$/.test(set.table_name)) throw errUsage(`Import set ${set.number} returned an unexpected sys_id or staging table. Nothing transformed.`);
  if (!rows.length) throw errUsage(`No rows of ${set.number} are visible to this identity. Nothing transformed.`);
  if (rows.length > limit) throw errUsage(`Import set ${set.number} has more than --limit ${limit} rows. Raise --limit explicitly to transform it. Nothing transformed.`);
  // The transformer only picks up pending rows; Reprocess sets them all back to pending first.
  if (set.state === 'loaded' && !rows.some(r => r?.sys_import_state === 'pending')) throw errUsage(`Import set ${set.number} is loaded but has no pending rows, so a transform would change nothing. Nothing transformed.`);
}

// Platform contract (PDI Australia): the Reprocess UI action sets a processed set back to loaded, which fires the
// Reload import sets rule that sets every row back to pending; Transform then runs the maps over the pending rows.
export async function transformImportSet(sdk, set) {
  const unknown = detail => errUsage(`Transform outcome is unknown${detail}; inspect the rows (jsn records list --table sys_import_set_row --query "sys_import_set=${set.sys_id}") before retrying.`);
  let output;
  try {
    output = await sdk.executeScript(`(function() {
    // GlideRecord as the Reprocess action uses: state is read-only in the dictionary, so GlideRecordSecure drops the write.
    var set = new GlideRecord('sys_import_set');
    if (!set.get('${set.sys_id}') || !set.canWrite()) throw new Error('Import set unavailable or not writable');
    if (set.getValue('state') != '${set.state}') throw new Error('Import set changed to ' + set.getValue('state'));
    if (set.getValue('state') == 'processed') {
      set.setValue('state', 'loaded');
      if (!set.update()) throw new Error('Could not set the import set back to loaded');
    }
    // An update the platform drops would leave the rows as they were and the transform a silent no-op.
    var pending = new GlideAggregate('sys_import_set_row');
    pending.addQuery('sys_import_set', set.getUniqueValue());
    pending.addQuery('sys_import_state', 'pending');
    pending.addAggregate('COUNT');
    pending.query();
    if (!pending.next() || pending.getAggregate('COUNT') == 0) throw new Error('No rows are pending, so the transform would change nothing');
    var transformer = new GlideImportSetTransformer();
    transformer.setSyncImport(true);
    transformer.transformAllMaps(set);
    gs.print('JSN_IMPORT_TRANSFORM:' + JSON.stringify({error: transformer.isError()}));
  })();`, 'global');
  } catch (error) {
    // The script's own guards stop before anything changes; any other failure (a timeout, a map error) may come mid-transform.
    if (/Import set unavailable or not writable|Import set changed to|Could not set the import set back|No rows are pending/.test(error.message)) throw error;
    throw unknown(` (${error.message})`);
  }
  const match = output.match(/JSN_IMPORT_TRANSFORM:(\{[^\r\n]*\})/);
  if (!match) throw unknown('');
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { parsed = null; }
  if (typeof parsed?.error !== 'boolean') throw unknown('');
  return parsed.error;
}

/** Describe the set and rows as read back after the transform; any row outside OUTCOMES is a failure. */
export function transformResult(set, rows, transformError) {
  const results = rows.map(r => ({ row: Number(r.sys_import_row) || 0, status: String(r.sys_import_state ?? ''), table: r.sys_target_table,
    sys_id: r.sys_target_sys_id, transform_map: r.sys_transform_map, status_message: r.sys_import_state_comment }));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { import_set: set.number, sys_id: set.sys_id, staging_table: set.table_name, state: set.state, transform_error: transformError,
    total: results.length, failed: results.filter(r => !OUTCOMES.has(r.status) || ((r.status === 'inserted' || r.status === 'updated') && !/^[0-9a-f]{32}$/.test(String(r.sys_id ?? '')))).length, counts, results };
}

export function loadRerun(table, file, limit) {
  return ['jsn', 'import', 'load', table, '--file', file, '--limit', String(limit), '--yes'].map(quoteShellArg).join(' ');
}

export function formatLoad(data) {
  const lines = [`Staging table ${data.staging_table}${data.import_sets.length ? `, import set ${data.import_sets.join(', ')}` : ''}`, ''];
  lines.push('ROW   STATUS    TABLE                 SYS_ID                            MESSAGE');
  for (const r of data.results) {
    lines.push(`${String(r.row).padEnd(5)} ${r.status.padEnd(9)} ${String(r.table ?? '').padEnd(21)} ${String(r.sys_id ?? '').padEnd(33)} ${r.error_message || r.status_message || ''}`.trimEnd());
  }
  if (data.not_sent) lines.push('', `${data.not_sent} row(s) not sent after the failed request.`);
  return `${lines.join('\n')}\n`;
}
