import fs from 'node:fs';
import { errNotFoundHint, errUsage } from './errors.js';
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

// Transform history (sys_import_set_run) for `import runs`; every join below is on a raw sys_id.
const RUN_FIELDS = 'sys_id,number,set,sys_transform_map,state,total,processed,inserts,updates,ignored,skipped,errors,completed,run_time,sys_created_on';
const SET_FIELDS = 'sys_id,number,table_name,state,mode,data_source,sys_created_on';
// sys_data_source also holds passwords, keys and connection strings; they are never read.
const SOURCE_FIELDS = 'sys_id,name,type,format,import_set_table_name,file_retrieval_method,last_run_datetime,last_success_import_time';
const ROW_FIELDS = 'sys_id,sys_import_set,import_set_run,sys_import_row,sys_import_state,sys_import_state_comment,sys_row_error,sys_target_table,sys_transform_map';
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const count = value => { const n = Number(raw(value)); return raw(value) !== '' && Number.isSafeInteger(n) ? n : null; };

async function readRows(sdk, table, query, fields, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: 'all' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  }
  return rows;
}
async function readMatching(sdk, table, field, value, fields, limit = 1, order = '') {
  const rows = await readRows(sdk, table, `${field}=${value}${order}`, fields, limit);
  if (rows.some(row => raw(row[field]).toLowerCase() !== value.toLowerCase())) throw new Error(`${table} ${value} read back as a different record.`);
  return rows;
}

/** Runs of one import set, or of every set from one data source, newest first, with the error rows of the newest run's set. */
export async function readImportRuns(sdk, target, { limit = 10, errors = 20 } = {}) {
  if (typeof target !== 'string' || !target.trim()) throw errUsage('Name an import set number or sys_id, or a data source name or sys_id.');
  if (target.includes('^')) throw errUsage('The import set or data source cannot contain ^, which would change the query.');
  if (/\p{Cc}/u.test(target)) throw errUsage('The import set or data source cannot contain control characters.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw errUsage('--limit must be an integer from 1 to 100.');
  if (!Number.isSafeInteger(errors) || errors < 1 || errors > 200) throw errUsage('--errors must be an integer from 1 to 200.');
  const id = target.trim();
  const byId = /^[0-9a-f]{32}$/i.test(id);
  const notes = [];
  let unprovenRuns = [];
  const [set] = await readMatching(sdk, 'sys_import_set', byId ? 'sys_id' : 'number', id, SET_FIELDS);
  let source = null;
  if (set && raw(set.data_source)) {
    [source] = await readMatching(sdk, 'sys_data_source', 'sys_id', raw(set.data_source), SOURCE_FIELDS);
    if (!source) notes.push(`Data source ${raw(set.data_source)} is not visible to this identity.`);
  } else if (!set) {
    const sources = await readMatching(sdk, 'sys_data_source', byId ? 'sys_id' : 'name', id, SOURCE_FIELDS, 2);
    if (sources.length > 1) throw errUsage(`${sources.length} data sources are named ${id} (${sources.map(s => raw(s.sys_id)).join(', ')}); pass one sys_id.`);
    [source] = sources;
    if (!source) throw errNotFoundHint('Import set or data source', id, 'Pass an import set number (ISET0010001) or sys_id, or a data source name or sys_id (jsn import list; jsn records list --table sys_data_source).');
  }
  const runQuery = set ? `set=${raw(set.sys_id)}` : `set.data_source=${raw(source.sys_id)}`;
  const runRows = await readRows(sdk, 'sys_import_set_run', `${runQuery}^ORDERBYDESCsys_created_on^ORDERBYDESCnumber`, RUN_FIELDS, limit + 1);
  const runs = runRows.slice(0, limit).map(r => ({ sys_id: raw(r.sys_id), number: raw(r.number), import_set: { sys_id: raw(r.set), number: shown(r.set) },
    transform_map: { sys_id: raw(r.sys_transform_map), name: shown(r.sys_transform_map) }, state: raw(r.state),
    ...Object.fromEntries(['total', 'processed', 'inserts', 'updates', 'ignored', 'skipped', 'errors'].map(key => [key, count(r[key])])),
    completed: raw(r.completed), run_time: shown(r.run_time), created: raw(r.sys_created_on) }));
  if (set) {
    if (runs.some(r => r.import_set.sys_id !== raw(set.sys_id))) throw new Error('sys_import_set_run returned a run with a mismatched set.');
  } else {
    // The query walks set.data_source; read the sets back so every run is proven to come from this data source.
    const ids = [...new Set(runs.map(r => r.import_set.sys_id).filter(Boolean))];
    const owners = new Map((ids.length ? await readRows(sdk, 'sys_import_set', `sys_idIN${ids.join(',')}`, SET_FIELDS, ids.length) : [])
      .map(s => [raw(s.sys_id), raw(s.data_source)]));
    // An unreadable set (ACL) is not a foreign one: owners.get() is undefined for
    // both, and failing the whole read would hide the runs the caller can see.
    const unreadable = runs.filter(r => r.import_set.sys_id && !owners.has(r.import_set.sys_id));
    const stray = runs.find(r => owners.has(r.import_set.sys_id) && owners.get(r.import_set.sys_id) !== raw(source.sys_id));
    if (stray) throw new Error(`Run ${stray.number} does not belong to data source ${raw(source.name)}.`);
    if (unreadable.length) {
      unprovenRuns = unreadable.map(r => r.number);
      notes.push(`${unreadable.length} run(s) belong to an import set this identity cannot read, so their data source is unproven: ${unprovenRuns.slice(0, 5).join(', ')}.`);
    }
  }
  let errorRows = null;
  const newest = runs[0];
  if (newest) {
    // Rows keep the state of their set's latest transform, which is the newest run's.
    const setId = newest.import_set.sys_id;
    const rows = await readRows(sdk, 'sys_import_set_row', `sys_import_set=${setId}^sys_import_state=error^ORDERBYsys_import_row`, ROW_FIELDS, errors + 1);
    if (rows.some(r => raw(r.sys_import_set) !== setId)) throw new Error('sys_import_set_row returned a row with a mismatched sys_import_set.');
    const kept = rows.slice(0, errors);
    const errorIds = [...new Set(kept.map(r => raw(r.sys_row_error)).filter(Boolean))];
    const details = new Map((errorIds.length ? await readRows(sdk, 'sys_import_set_row_error', `sys_idIN${errorIds.join(',')}`, 'sys_id,row,error_code,error_message', errorIds.length) : [])
      .map(e => [raw(e.sys_id), e]));
    errorRows = { import_set: newest.import_set, run: newest.number, has_more: rows.length > errors, rows: kept.map(r => {
      const detail = details.get(raw(r.sys_row_error));
      // shortcut: an empty row is trusted, since no instance seen yet has filled one; it is checked whenever it is set.
      if (detail && raw(detail.row) && raw(detail.row) !== raw(r.sys_id)) throw new Error(`Row error ${raw(detail.sys_id)} names another row than ${raw(r.sys_id)}.`);
      return { sys_id: raw(r.sys_id), row: count(r.sys_import_row), state: raw(r.sys_import_state),
        message: [...new Set([raw(r.sys_import_state_comment), detail ? raw(detail.error_message) : ''].filter(Boolean))].join('; '),
        error_code: detail ? raw(detail.error_code) : '', target_table: raw(r.sys_target_table), transform_map: shown(r.sys_transform_map), run: shown(r.import_set_run) };
    }) };
    if (!kept.length && newest.errors > 0) notes.push(`${newest.number} counted ${newest.errors} error(s), but no error row of ${newest.import_set.number} is visible to this identity.`);
  } else notes.push(set ? `No transform run of ${raw(set.number)} is visible to this identity: none has run, or sys_import_set_run is ACL-hidden.`
    : `No transform run of ${raw(source.name)} is visible to this identity: none has run, its import sets were cleaned up, or sys_import_set_run is ACL-hidden.`);
  return {
    target: set ? { type: 'import_set', sys_id: raw(set.sys_id), name: raw(set.number) } : { type: 'data_source', sys_id: raw(source.sys_id), name: raw(source.name) },
    data_source: source && { sys_id: raw(source.sys_id), name: raw(source.name), type: raw(source.type), format: raw(source.format),
      import_set_table: raw(source.import_set_table_name), file_retrieval_method: raw(source.file_retrieval_method),
      last_run: raw(source.last_run_datetime), last_success: raw(source.last_success_import_time) },
    runs, runs_has_more: runRows.length > limit, error_rows: errorRows, notes,
    ...(unprovenRuns.length ? { unproven_runs: unprovenRuns } : {}),
  };
}

export function formatImportRuns(data) {
  const lines = [`${data.target.type === 'import_set' ? 'Import set' : 'Data source'} ${data.target.name}`];
  const ds = data.data_source;
  if (ds) lines.push(`Data source: ${ds.name} (${[ds.type, ds.format].filter(Boolean).join(', ') || 'type not set'}), staging table ${ds.import_set_table || '(not set)'}, last success ${ds.last_success || '(none)'}`);
  lines.push('', 'RUN          SET           STATE                 TOTAL   INS   UPD   IGN  SKIP   ERR  COMPLETED            MAP');
  const n = value => String(value ?? '?').padStart(5);
  for (const r of data.runs) {
    lines.push(`${r.number.padEnd(12)} ${r.import_set.number.padEnd(13)} ${r.state.padEnd(21)} ${n(r.total)} ${n(r.inserts)} ${n(r.updates)} ${n(r.ignored)} ${n(r.skipped)} ${n(r.errors)}  ${r.completed.padEnd(19)}  ${r.transform_map.name}`.trimEnd());
  }
  if (!data.runs.length) lines.push('(no runs)');
  if (data.runs_has_more) lines.push('More runs exist; raise --limit to see them.');
  if (data.error_rows) {
    lines.push('', `Error rows of ${data.error_rows.import_set.number} as its latest transform (${data.error_rows.run}) left them:`);
    for (const r of data.error_rows.rows) lines.push(`  row ${r.row ?? '?'}: ${r.message || '(no message)'}`);
    if (!data.error_rows.rows.length) lines.push(data.runs[0].errors ? '  none visible to this identity (see the note below)' : '  none');
    if (data.error_rows.has_more) lines.push('  More error rows exist; raise --errors to see them.');
  }
  for (const note of data.notes) lines.push('', note);
  return `${lines.join('\n')}\n`;
}

// Transform maps for `import maps`: maps by staging table, name or sys_id, then their field maps and scripts by raw map sys_id.
const MAP_FIELDS = 'sys_id,name,source_table,target_table,active,order,run_business_rules,enforce_mandatory_fields,copy_empty_fields,create_new_record_on_empty_coalesce_fields,run_script';
const ENTRY_FIELDS = 'sys_id,map,source_field,target_field,coalesce,coalesce_empty_fields,use_source_script,choice_action,date_format';
const SCRIPT_FIELDS = 'sys_id,map,when,order,active';
const MAX_MAPS = 50, MAX_ENTRIES = 1000, MAX_SCRIPTS = 200;
// The order transform events fire: once at the start, per row around the field maps, once at the end.
const WHEN = ['onStart', 'onBefore', 'onForeignInsert', 'onChoiceCreate', 'onReject', 'onAfter', 'onComplete'];
const flag = value => raw(value) === 'true';

/** Transform maps that read a staging table (or one map by name or sys_id), each with its field maps and transform scripts. */
export async function readImportMaps(sdk, target, { scripts = false } = {}) {
  if (typeof target !== 'string' || !target.trim()) throw errUsage('Name a staging table, a transform map name, or a transform map sys_id.');
  if (target.includes('^')) throw errUsage('The staging table or map name cannot contain ^, which would change the query.');
  if (/\p{Cc}/u.test(target)) throw errUsage('The staging table or map name cannot contain control characters.');
  const id = target.trim();
  const fields = scripts ? `${MAP_FIELDS},script` : MAP_FIELDS;
  const order = '^ORDERBYorder^ORDERBYname';
  let matchedBy = /^[0-9a-f]{32}$/i.test(id) ? 'sys_id' : 'source_table';
  let rows = await readMatching(sdk, 'sys_transform_map', matchedBy, id, fields, MAX_MAPS + 1, order);
  if (!rows.length && matchedBy === 'source_table') {
    matchedBy = 'name';
    rows = await readMatching(sdk, 'sys_transform_map', 'name', id, fields, MAX_MAPS + 1, order);
  }
  if (!rows.length) throw errNotFoundHint('Transform map', id, 'Pass a staging table, a transform map name or a sys_id (jsn records list --table sys_transform_map). Maps hidden by ACLs are not visible.');
  const maps = rows.slice(0, MAX_MAPS).map(m => ({ sys_id: raw(m.sys_id), name: raw(m.name), source_table: raw(m.source_table), target_table: raw(m.target_table),
    active: flag(m.active), order: count(m.order), run_business_rules: flag(m.run_business_rules), enforce_mandatory_fields: raw(m.enforce_mandatory_fields),
    copy_empty_fields: flag(m.copy_empty_fields), create_new_record_on_empty_coalesce_fields: flag(m.create_new_record_on_empty_coalesce_fields),
    run_script: flag(m.run_script), ...(scripts ? { script: raw(m.script) } : {}), coalesce: [], field_maps: [], transform_scripts: [] }));
  // The ids go into an IN query, so a malformed one could widen it.
  if (maps.some(m => !/^[0-9a-f]{32}$/.test(m.sys_id))) throw new Error('sys_transform_map returned an unexpected sys_id.');
  const byId = new Map(maps.map(m => [m.sys_id, m]));
  const children = async (table, childFields, sort, limit, what) => {
    const found = await readRows(sdk, table, `mapIN${[...byId.keys()].join(',')}^ORDERBY${sort}`, childFields, limit + 1);
    if (found.some(row => !byId.has(raw(row.map)))) throw new Error(`${table} returned a ${what} of another transform map.`);
    return found;
  };
  // Coalesce rows sort first, so a cut list still holds every coalesce field.
  const entries = await children('sys_transform_entry', scripts ? `${ENTRY_FIELDS},source_script` : ENTRY_FIELDS, 'DESCcoalesce^ORDERBYtarget_field', MAX_ENTRIES, 'field map');
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    byId.get(raw(e.map)).field_maps.push({ sys_id: raw(e.sys_id), source_field: raw(e.source_field), target_field: raw(e.target_field), coalesce: flag(e.coalesce),
      coalesce_empty_fields: flag(e.coalesce_empty_fields), use_source_script: flag(e.use_source_script), choice_action: raw(e.choice_action), date_format: raw(e.date_format), ...(scripts ? { source_script: raw(e.source_script) } : {}) });
  }
  const events = await children('sys_transform_script', scripts ? `${SCRIPT_FIELDS},script` : SCRIPT_FIELDS, 'order', MAX_SCRIPTS, 'script');
  for (const s of events.slice(0, MAX_SCRIPTS)) {
    byId.get(raw(s.map)).transform_scripts.push({ sys_id: raw(s.sys_id), when: raw(s.when), order: count(s.order), active: flag(s.active), ...(scripts ? { script: raw(s.script) } : {}) });
  }
  const rank = when => WHEN.includes(when) ? WHEN.indexOf(when) : WHEN.length;
  for (const m of maps) {
    m.coalesce = m.field_maps.filter(f => f.coalesce).map(f => f.target_field);
    m.transform_scripts.sort((a, b) => rank(a.when) - rank(b.when) || (a.order ?? 0) - (b.order ?? 0));
  }
  const notes = [rows.length > MAX_MAPS && `More than ${MAX_MAPS} transform maps match; pass one map's sys_id to read the others.`,
    entries.length > MAX_ENTRIES && `More than ${MAX_ENTRIES} field maps; the list is cut. Pass one map's sys_id to read fewer at a time.`,
    events.length > MAX_SCRIPTS && `More than ${MAX_SCRIPTS} transform scripts; the list is cut. Pass one map's sys_id to read fewer at a time.`].filter(Boolean);
  return { target: id, matched_by: matchedBy, maps, has_more: rows.length > MAX_MAPS, field_maps_has_more: entries.length > MAX_ENTRIES,
    scripts_has_more: events.length > MAX_SCRIPTS, notes };
}

export function formatImportMaps(data) {
  const heading = { source_table: 'Transform maps reading', name: 'Transform maps named', sys_id: 'Transform map' }[data.matched_by];
  const lines = [`${heading} ${data.target} (${data.maps.length})`];
  const yes = value => value ? 'yes' : 'no';
  const body = text => String(text).split(/\r?\n/).map(line => `      ${line}`.trimEnd());
  for (const m of data.maps) {
    lines.push('', `${m.name} [${m.sys_id}] ${m.source_table} -> ${m.target_table}, order ${m.order ?? '?'}${m.active ? '' : ' (inactive)'}`);
    lines.push(`  Run business rules: ${yes(m.run_business_rules)}. Enforce mandatory fields: ${m.enforce_mandatory_fields || '(not set)'}. Copy empty fields: ${yes(m.copy_empty_fields)}.`,
      `  Create new record on empty coalesce fields: ${yes(m.create_new_record_on_empty_coalesce_fields)}.`);
    lines.push(`  Map script: ${m.run_script ? 'runs' : 'off (Run script is not set)'}`);
    if (m.script) lines.push(...body(m.script));
    const empty = m.field_maps.filter(f => f.coalesce && f.coalesce_empty_fields).map(f => f.target_field);
    const keys = m.coalesce.length > 1 ? `${m.coalesce.slice(0, -1).join(', ')} and ${m.coalesce.at(-1)} match` : `${m.coalesce[0]} matches`;
    lines.push(!m.field_maps.length ? '  No field map is visible to this identity, so its coalesce fields are unknown.'
      : m.coalesce.length ? `  Coalesce on ${m.coalesce.join(', ')}: a row whose ${keys} an existing ${m.target_table} record updates it; a row with no match inserts a new one${m.create_new_record_on_empty_coalesce_fields || empty.length ? '' : ', unless its coalesce fields are all empty'}.`
      : '  No coalesce field: every row inserts a new record.');
    if (empty.length) lines.push(`  Coalesce empty fields on ${empty.join(', ')}: an empty value matches an existing record where that field is empty.`);
    lines.push(`  Field maps (${m.field_maps.length}):`);
    if (m.field_maps.length) {
      const width = Math.max(20, ...m.field_maps.map(f => f.source_field.length + 1));
      lines.push(`    ${'SOURCE'.padEnd(width)} ${'TARGET'.padEnd(width)} COALESCE  SCRIPTED  CHOICE  DATE FORMAT`);
      for (const f of m.field_maps) lines.push(`    ${f.source_field.padEnd(width)} ${f.target_field.padEnd(width)} ${yes(f.coalesce).padEnd(9)} ${yes(f.use_source_script).padEnd(9)} ${f.choice_action.padEnd(7)} ${f.date_format}`.trimEnd());
      for (const f of m.field_maps.filter(f => f.source_script)) lines.push(`    ${f.target_field} source script:`, ...body(f.source_script));
    }
    lines.push(`  Transform scripts (${m.transform_scripts.length}):`);
    for (const s of m.transform_scripts) {
      lines.push(`    ${s.when.padEnd(16)} ${String(s.order ?? '?').padEnd(6)} ${s.active ? '' : 'inactive'}`.trimEnd());
      if (s.script) lines.push(...body(s.script));
    }
  }
  for (const note of data.notes) lines.push('', note);
  return `${lines.join('\n')}\n`;
}
