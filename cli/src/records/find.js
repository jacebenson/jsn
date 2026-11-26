import { AppError, CodeAPI, errUsage } from '../errors.js';

const MARKER = 'JSN_RECORDS_FIND:';
// Table API first: sys_metadata and task hold most sys_ids people paste, and need no script.
const FIRST = [{ table: 'sys_metadata', display: 'sys_name' }, { table: 'task', display: 'number' }];
const TABLE_NAME = /^[a-z0-9_$]{1,80}$/;

const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const text = value => (value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? ''));
const malformed = message => new AppError(CodeAPI, message);
const count = n => Number.isSafeInteger(n) && n >= 0;

function validate({ sysId, maxTables, timeLimit }) {
  if (typeof sysId !== 'string' || !/^[0-9a-f]{32}$/i.test(sysId)) throw errUsage('A sys_id is 32 hexadecimal characters; nothing was searched.');
  if (!Number.isSafeInteger(maxTables) || maxTables < 1 || maxTables > 20000) throw errUsage('--max-tables must be an integer from 1 to 20000.');
  if (!Number.isSafeInteger(timeLimit) || timeLimit < 1 || timeLimit > 600) throw errUsage('--time-limit must be a whole number of seconds from 1 to 600.');
}

// Base tables only: a GlideRecord on a parent returns its children's rows, and
// getRecordClassName names the child. Remote (scripted) tables run a script and
// virtual tables compute rows, so neither is queried. Only tables whose
// dictionary has a sys_id field are listed: a few key on another field, and on
// those get() ignores the unknown field, returns any row and prints a stack
// trace that, over hundreds of tables, made the response too large to arrive
// on a PDI. Only the exact sys_id counts. A whole scan in one script outlasts
// the transaction, so a slice runs for at most SLICE_MS and the next resumes
// after the last table it read. Each slice reads at least one table, so a short
// last slice still moves on.
const SLICE_MS = 20000;
function sliceScript(id, after, maxTables, ms) {
  return `(function() {
  var id = '${id}', maxTables = ${maxTables}, deadline = new Date().getTime() + ${ms};
  var out = { found: null, tried: 0, left: 0, skipped: 0, failed: 0, last: '${after}', more: false, errors: [] };
  var t = new GlideRecord('sys_db_object');
  t.addNullQuery('super_class');${after ? `\n  t.addQuery('name', '>', '${after}');` : ''}
  t.addJoinQuery('sys_dictionary', 'name', 'name').addCondition('element', 'sys_id');
  t.orderBy('name');
  t.query();
  out.left = t.getRowCount();
  var first = true;
  while (out.tried < maxTables && (first || new Date().getTime() < deadline) && t.next()) {
    first = false;
    var name = t.getValue('name'), scripted = String(t.getValue('scriptable_table'));
    out.last = name;
    if (scripted == '1' || scripted == 'true' || t.getValue('provider_class') || name.indexOf('v_') == 0) { out.skipped++; continue; }
    try {
      var gr = new GlideRecord(name);
      if (!gr.isValid()) { out.skipped++; continue; }
      out.tried++;
      if (gr.get('sys_id', id) && gr.getUniqueValue() == id) { out.found = { table: gr.getRecordClassName(), base: name, display: String(gr.getDisplayValue()) }; break; }
    } catch (e) {
      out.failed++;
      if (out.errors.length < 20) out.errors.push({ table: name, message: String(e && e.message || e) });
    }
  }
  out.more = !out.found && t.hasNext();
  // shortcut: the SDK fails any script output holding TypeError or "is not defined", so a display value or table error with those words fails the command instead of answering; encode those strings if it turns up.
  gs.print('${MARKER}' + JSON.stringify(out));
})();`;
}

function parse(output) {
  const line = String(output ?? '').match(new RegExp(`${MARKER}(\\{[^\\r\\n]*\\})`));
  if (!line) throw malformed('The background script printed no search result; the search did not run to an answer.');
  let out;
  try { out = JSON.parse(line[1]); } catch { throw malformed('The background script printed a search result that is not valid JSON.'); }
  const found = out?.found;
  if (!count(out?.tried) || !count(out.left) || !count(out.skipped) || !count(out.failed) || !Array.isArray(out.errors)
    || typeof out.more !== 'boolean' || (out.last !== '' && !TABLE_NAME.test(out.last ?? ''))
    || (found !== null && (typeof found !== 'object' || !TABLE_NAME.test(found.table ?? '') || !TABLE_NAME.test(found.base ?? '')))) {
    throw malformed('The background script printed a malformed search result.');
  }
  return out;
}

/**
 * Say which table holds a bare sys_id. Reads only: two Table API lookups, then
 * background scripts of up to 20 seconds each that query the base tables by
 * sys_id in name order, within a table count and a time limit. A limit reached
 * is "not found within the bound".
 */
export async function findRecord(sdk, { sysId, maxTables = 10000, timeLimit = 120 } = {}, { now = Date.now } = {}) {
  validate({ sysId, maxTables, timeLimit });
  const id = sysId.toLowerCase();
  for (const { table, display } of FIRST) {
    const rows = await sdk.listStrict(table, new URLSearchParams({
      sysparm_query: `sys_id=${id}`,
      sysparm_fields: `sys_id,sys_class_name,${display}`,
      sysparm_limit: '1',
      sysparm_display_value: 'all',
    }));
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(`Malformed table response for ${table}`);
    if (!rows.length) continue;
    if (raw(rows[0].sys_id) !== id) throw malformed(`${table} returned a row with another sys_id than ${id}.`);
    return { sys_id: id, found: true, table: raw(rows[0].sys_class_name) || table, display_value: text(rows[0][display]), found_in: table, method: 'table_api' };
  }

  const deadline = now() + timeLimit * 1000;
  const search = { complete: false, tables_tried: 0, base_tables: null, skipped_tables: 0, stopped_by: null, failed_tables: 0, background_scripts: 0, errors: [] };
  let after = '', found = null;
  for (;;) {
    const left = deadline - now();
    if (search.tables_tried >= maxTables) { search.stopped_by = 'tables'; break; }
    if (left <= 0) { search.stopped_by = 'time'; break; }
    const ms = Math.min(SLICE_MS, left);
    let output;
    try {
      output = await sdk.executeScript(sliceScript(id, after, maxTables - search.tables_tried, ms), 'global', { rollback: false, timeout: ms + 30000 });
    } catch (error) {
      // The Table API reads are ACL-filtered, so an empty one proves only what this user can see.
      error.message = `The Table API returned no sys_metadata or task row with sys_id ${id} that this user can read${search.tables_tried ? `, and the ${search.tables_tried} base tables searched so far hold none` : ''}; the background script searching the other tables failed: ${error.message}`;
      throw error;
    }
    const out = parse(output);
    search.background_scripts++;
    search.base_tables ??= out.left;
    search.tables_tried += out.tried;
    search.skipped_tables += out.skipped;
    search.failed_tables += out.failed;
    search.errors.push(...out.errors.slice(0, 20 - search.errors.length));
    if (out.found) { found = out.found; break; }
    if (!out.more) break;
    if (out.last === after) throw malformed(`The background script made no progress after table ${after || '(start)'}.`);
    after = out.last;
  }
  search.complete = Boolean(found) || (!search.stopped_by && !search.failed_tables);
  if (!found) return { sys_id: id, found: false, table: null, display_value: null, found_in: null, method: 'background_script', search };
  return { sys_id: id, found: true, table: found.table, display_value: String(found.display ?? ''), found_in: found.base, method: 'background_script', search };
}

export function formatFind(data) {
  const lines = [];
  if (data.found) {
    const how = data.method === 'table_api' ? `found in ${data.found_in} by the Table API` : `found in ${data.found_in} by a background script, after sys_metadata and task`;
    lines.push(`${data.sys_id} is a ${data.table} record: ${data.display_value || '(no display value)'} (${how})`);
    return lines.join('\n');
  }
  const s = data.search;
  if (s.complete) {
    lines.push(`No record with sys_id ${data.sys_id} in sys_metadata, task or the ${s.tables_tried} base tables searched (children included).`);
  } else if (s.stopped_by) {
    const cap = s.stopped_by === 'time' ? 'the time limit; raise --time-limit' : 'the table limit; raise --max-tables';
    lines.push(`Not found within the bound: ${s.tables_tried} of ${s.base_tables} base tables searched before ${cap} to search further.`);
  } else {
    lines.push(`Not found, but the search is incomplete: ${s.failed_tables} table(s) could not be queried, so the sys_id may be in one of them.`);
  }
  if (s.errors.length) lines.push(...s.errors.map(e => `  ${e.table}: ${e.message}`));
  if (s.skipped_tables) lines.push(`${s.skipped_tables} remote, virtual or missing table(s) were not searched.`);
  return lines.join('\n');
}
