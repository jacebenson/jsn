// Explain Plan and Suggest Index for slow query patterns.
//
// Both follow the platform's own UI actions on sys_query_pattern: run the
// engine's Java API through a background script, then read the records the
// call wrote back through the Table API. They are writes: an explain creates
// plan_execution subclass rows and a suggestion creates a sys_index_suggestion
// row. Neither changes the slow query record itself.
//
// This module never decides whether a write is allowed; the perf command
// confirms with the caller first and the read-only profile guard refuses the
// subcommand. It does refuse to report success without evidence: an explain
// that produced no readable plan rows, or a suggestion call that returned no
// readable suggestion record, is an error carrying the provider's answer.

import { errUsage, errUsageHint } from './errors.js';
import { showSlowPattern } from './slow-patterns.js';

// plan_execution is the base; each engine's explain writes its own subclass.
// MySQL's EXPLAIN table is the only one with step columns.
const PLAN_TABLES = [
  ['plan_mysql', 'id,select_type,table,type,possible_keys,key,key_len,ref,rows,extra'],
  ['plan_postgres', 'plan'],
  ['plan_oracle', 'operation,name,cost,time,rows,bytes'],
  ['plan_trino', 'plan'],
];
const PLAN_ROW_FIELDS = 'sys_id,sys_class_name,order';
const PLAN_ROW_LIMIT = 500;
const SUGGESTION_FIELDS = 'sys_id,table_name,column_names,state,index_name,slow_query,example,sys_created_on';
const MARKERS = { explain: 'JSN_EXPLAIN', suggest: 'JSN_SUGGEST' };
const HEX_ID = /^[0-9a-f]{32}$/i;

const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function read(sdk, table, query, fields, limit = 200) {
  const params = new URLSearchParams({
    sysparm_query: query,
    sysparm_fields: fields,
    sysparm_limit: String(limit),
    sysparm_display_value: 'all',
  });
  return sdk.listStrict(table, params);
}

/**
 * Read a slow pattern and require it to be a slow query. Explain plans and
 * index suggestions exist only for sys_query_pattern; a script or transaction
 * pattern has no SQL to explain and no index to suggest.
 */
export async function loadQueryPattern(sdk, id) {
  const data = await showSlowPattern(sdk, id);
  if (data.type !== 'queries') {
    throw errUsageHint(
      `Slow pattern ${id} is ${data.table}; only Slow Queries (sys_query_pattern) have an explain plan or index suggestion.`,
      'List them with `jsn perf slow --type queries`, then pass one of those sys_ids.',
    );
  }
  return { id, table: data.table, label: text(data.record.label), record: data.record };
}

/**
 * Pick the SQL and engine exactly as the platform's Explain Plan UI action
 * does: executable SQL when present, otherwise the example; MongoTable queries
 * go to the collection named after fDefinition with the header stripped; a
 * trino pool uses getForTrino(); anything else uses the default engine.
 */
export function explainTarget(record) {
  const executable = raw(record?.executable_sql);
  const example = raw(record?.example);
  const sql = executable || example;
  if (!sql) throw errUsage('This slow query has no executable_sql or example SQL to explain.');
  const pool = raw(record?.pool_name);

  if (sql.includes('MongoTable')) {
    const at = sql.indexOf('fDefinition');
    const close = sql.indexOf('}');
    if (at === -1 || close === -1) {
      throw new Error('MongoTable SQL is missing fDefinition or its closing brace; refusing to explain an unparseable query.');
    }
    const collection = sql.slice(at + 12, close).trim();
    if (!collection) throw new Error('MongoTable SQL names no collection in fDefinition.');
    // The UI action slices off "MongoTable{...}" plus its blank line.
    const body = sql.slice(close + 2);
    if (!body.trim()) throw new Error('MongoTable SQL has no query after its collection header.');
    return { engine: 'mongo', collection, sql: body };
  }
  if (pool.toLowerCase().includes('trino')) return { engine: 'trino', collection: null, sql };
  return { engine: 'default', collection: null, sql };
}

/** The background script that mirrors the Explain Plan UI action, minus current.update(). */
export function buildExplainScript({ id, target }) {
  if (!HEX_ID.test(String(id))) throw errUsage('Provide a 32-character hexadecimal sys_id.');
  if (!target?.sql) throw errUsage('Explain needs the slow query SQL.');
  const explainer = target.engine === 'mongo'
    ? `GlideAQueryExplanation.get(${JSON.stringify(target.collection)})`
    : target.engine === 'trino' ? 'GlideAQueryExplanation.getForTrino()' : 'GlideAQueryExplanation.get()';
  return `(function() {
  var patternId = ${JSON.stringify(id)};
  var sql = ${JSON.stringify(target.sql)};
  var engine = ${JSON.stringify(target.engine)};
  var record = new GlideRecord('sys_query_pattern');
  if (!record.get(patternId)) {
    gs.print('${MARKERS.explain}:' + JSON.stringify({ ok: false, engine: engine, error: 'Slow query ' + patternId + ' was not found' }));
    return;
  }
  try {
    var explainer = ${explainer};
    if (!explainer) {
      gs.print('${MARKERS.explain}:' + JSON.stringify({ ok: false, engine: engine, error: 'The platform returned no explain engine for engine ' + engine }));
      return;
    }
    var status = explainer.explainPlan(sql, patternId, null);
    gs.print('${MARKERS.explain}:' + JSON.stringify({ ok: true, engine: engine, status: status == null ? '' : String(status) }));
  } catch (e) {
    gs.print('${MARKERS.explain}:' + JSON.stringify({ ok: false, engine: engine, error: String((e && e.message) || e) }));
  }
})();`;
}

/** The background script that mirrors the Suggest Index UI action. */
export function buildSuggestScript(id) {
  if (!HEX_ID.test(String(id))) throw errUsage('Provide a 32-character hexadecimal sys_id.');
  return `(function() {
  var patternId = ${JSON.stringify(id)};
  var record = new GlideRecord('sys_query_pattern');
  if (!record.get(patternId)) {
    gs.print('${MARKERS.suggest}:' + JSON.stringify({ ok: false, error: 'Slow query ' + patternId + ' was not found' }));
    return;
  }
  try {
    var api = new SNC.IndexSuggestionAPI();
    var value = api.suggestIndex(record);
    gs.print('${MARKERS.suggest}:' + JSON.stringify({ ok: true, value: value == null ? '' : String(value) }));
  } catch (e) {
    gs.print('${MARKERS.suggest}:' + JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
})();`;
}

/**
 * Parse one marker line from background-script output. The last marker wins:
 * a script that retried prints more than one, and only the final answer counts.
 */
export function parseMarker(output, kind) {
  const marker = MARKERS[kind];
  const matches = [...String(output ?? '').matchAll(new RegExp(`${marker}:(\\{[^\\n]*\\})`, 'g'))];
  if (!matches.length) {
    throw new Error(`The background script ran but printed no ${marker} result, so its answer cannot be trusted.`);
  }
  let parsed;
  try { parsed = JSON.parse(matches.at(-1)[1]); } catch {
    throw new Error(`The background script printed a ${marker} result that is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error(`The background script printed a malformed ${marker} result.`);
  }
  return parsed;
}

// A status that says the engine could not explain anything. Never turn these
// into a success just because the call returned: the answer is the failure.
const FAILED_STATUS = /(needs?\b[^.]*\bstatistics?|\bstats?\b[^.]*\b(needed|required|missing)|statistics?[^.]*\b(needed|required|stale|out[- ]of[- ]date)|ANALYZE\s+TABLE|not\s+(enabled|available|supported)|disabled|unsupported|explain\s+is\s+not|no\s+plan\b)/i;

export function assertExplainAnswer(parsed) {
  if (parsed.ok !== true) throw new Error(`Explain plan failed: ${parsed.error || 'the platform reported no reason'}`);
  const status = String(parsed.status ?? '');
  if (FAILED_STATUS.test(status)) throw new Error(`Explain plan failed: ${status}`);
  return status;
}

/**
 * Read the plan rows explain wrote. plan_execution is the base table, but its
 * subclass columns are not addressable through the base dictionary, so each
 * engine table is read on its own. A table this account cannot read is
 * reported, not silently treated as empty.
 */
export async function readPlanRows(sdk, patternId) {
  const rows = [];
  const tables = [];
  const unavailable = [];
  for (const [table, fields] of PLAN_TABLES) {
    try {
      const found = await read(sdk, table, `sys_query_pattern=${patternId}`, `${PLAN_ROW_FIELDS},${fields}`, PLAN_ROW_LIMIT);
      if (!Array.isArray(found)) throw new Error(`Malformed table response for ${table}`);
      tables.push(table);
      for (const row of found) rows.push({ plan_table: table, ...row });
    } catch (error) {
      const status = Number(error?.status) || 0;
      // A missing table or an ACL refusal is about this engine, not the run.
      if ([400, 403, 404].includes(status) || /Invalid table|not found|Access forbidden/i.test(String(error?.message || ''))) {
        unavailable.push({ table, status: status || null, reason: error.message });
        continue;
      }
      throw error;
    }
  }
  // The platform's step order is the only meaningful sequence; ties fall back
  // to sys_id so two identical runs render the same way.
  rows.sort((a, b) => {
    const left = Number(raw(a.order));
    const right = Number(raw(b.order));
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return raw(a.sys_id).localeCompare(raw(b.sys_id));
  });
  return { rows, tables, unavailable };
}

/**
 * Wait briefly for plan rows. explainPlan writes in the script's transaction,
 * so rows normally exist as soon as the script returns; a short bounded re-read
 * covers a lagging read replica without turning an empty answer into success.
 */
export async function readPlanRowsSettled(sdk, patternId, { attempts = 3, delayMs = 250, delay = sleep } = {}) {
  let result = await readPlanRows(sdk, patternId);
  for (let attempt = 1; result.rows.length === 0 && result.tables.length > 0 && attempt < attempts; attempt++) {
    await delay(delayMs);
    result = await readPlanRows(sdk, patternId);
  }
  return result;
}

export async function explainLoadedQuery(sdk, query, target, options = {}) {
  const parsed = parseMarker(await sdk.executeScript(buildExplainScript({ id: query.id, target }), 'global'), 'explain');
  const status = assertExplainAnswer(parsed);
  const plan = await readPlanRowsSettled(sdk, query.id, options);
  if (plan.tables.length === 0) {
    const reasons = plan.unavailable.map(entry => `${entry.table}${entry.status ? ` (HTTP ${entry.status})` : ''}: ${entry.reason}`).join('; ');
    throw new Error(`Explain plan ran for ${query.id}${status ? ` (status: ${status})` : ''}, but no plan table is readable, so the plan cannot be verified. ${reasons}`);
  }
  if (plan.rows.length === 0) {
    throw new Error(`Explain plan ran for ${query.id}${status ? ` (status: ${status})` : ''}, but wrote no readable plan rows. That is a failure, not an empty plan.`);
  }
  return {
    pattern: { sys_id: query.id, table: query.table, label: query.label },
    engine: parsed.engine || target.engine,
    sql: target.sql,
    status,
    plan_rows: plan.rows,
    plan_tables: plan.tables,
    unreadable_tables: plan.unavailable,
    count: plan.rows.length,
  };
}

/** Explain one slow query end to end (read the pattern, run the action, read the plan). */
export async function explainSlowQuery(sdk, id, options = {}) {
  const query = await loadQueryPattern(sdk, id);
  const target = explainTarget(query.record);
  return explainLoadedQuery(sdk, query, target, options);
}

/** Read back the suggestion record the API created. */
export async function readIndexSuggestion(sdk, suggestionId) {
  const rows = await read(sdk, 'sys_index_suggestion', `sys_id=${suggestionId}`, SUGGESTION_FIELDS, 1);
  if (!Array.isArray(rows)) throw new Error('Malformed table response for sys_index_suggestion');
  return rows[0] ?? null;
}

/**
 * Ask IndexSuggestionAPI for a suggestion and verify the record it claims to
 * have created. MySQL-only on the platform: the API is absent or refuses on
 * other engines, and its message is the failure.
 */
export async function suggestIndexForLoadedQuery(sdk, query) {
  const parsed = parseMarker(await sdk.executeScript(buildSuggestScript(query.id), 'global'), 'suggest');
  if (parsed.ok !== true) throw new Error(`Index suggestion failed: ${parsed.error || 'the platform reported no reason'}`);
  const value = String(parsed.value ?? '').trim();
  if (!HEX_ID.test(value)) {
    throw new Error(`Index suggestion failed: the platform answered "${value || '(empty answer)'}" instead of a sys_index_suggestion sys_id.`);
  }
  const record = await readIndexSuggestion(sdk, value);
  if (!record) {
    throw new Error(`Index suggestion ${value} was reported but no sys_index_suggestion record is readable.`);
  }
  const owner = raw(record.slow_query);
  if (owner && owner !== query.id) {
    throw new Error(`Index suggestion ${value} belongs to slow query ${owner}, not ${query.id}; refusing to report it as this query's suggestion.`);
  }
  if (!text(record.table_name) || !text(record.column_names)) {
    throw new Error(`Index suggestion ${value} has no table or columns; that is not a usable suggestion.`);
  }
  return {
    pattern: { sys_id: query.id, table: query.table, label: query.label },
    suggestion: record,
    note: 'A suggestion record, not an index. Creating, scheduling or dropping the index is the platform\'s job.',
  };
}

export async function suggestIndexForSlowQuery(sdk, id) {
  const query = await loadQueryPattern(sdk, id);
  return suggestIndexForLoadedQuery(sdk, query);
}

function planRowLine(row) {
  const table = raw(row.plan_table);
  if (table === 'plan_mysql') {
    const parts = [
      `id ${text(row.id) || '-'}`,
      `select_type ${text(row.select_type) || '-'}`,
      `table ${text(row.table) || '-'}`,
      `type ${text(row.type) || '-'}`,
      `key ${text(row.key) || '(none)'}`,
      `possible_keys ${text(row.possible_keys) || '(none)'}`,
      `rows ${text(row.rows) || '-'}`,
    ];
    const extra = text(row.extra);
    if (extra) parts.push(`Extra ${extra}`);
    return parts.join(' | ');
  }
  if (table === 'plan_postgres' || table === 'plan_trino') return text(row.plan) || '(empty plan step)';
  if (table === 'plan_oracle') {
    return [`operation ${text(row.operation) || '-'}`, `name ${text(row.name) || '-'}`, `cost ${text(row.cost) || '-'}`, `time ${text(row.time) || '-'}`, `rows ${text(row.rows) || '-'}`].join(' | ');
  }
  return JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, text(value)])));
}

export function formatExplainPlan(data) {
  const lines = [
    `Explain plan for slow query ${data.pattern.sys_id} (${data.engine}, ${data.plan_tables.join(', ')})`,
    `Label: ${data.pattern.label || '-'}`,
    `Status: ${data.status || '-'}`,
    `SQL: ${data.sql}`,
    `Plan rows: ${data.count}`,
  ];
  let order = 0;
  for (const row of data.plan_rows) lines.push(`  ${++order}. [${row.plan_table}] ${planRowLine(row)}`);
  if (data.unreadable_tables.length) {
    lines.push('Unreadable plan tables:');
    for (const entry of data.unreadable_tables) lines.push(`  ${entry.table}${entry.status ? ` (HTTP ${entry.status})` : ''}: ${entry.reason}`);
  }
  lines.push('This wrote plan rows on the instance; it did not change the slow query record.');
  return lines.join('\n');
}

export function formatIndexSuggestion(data) {
  const s = data.suggestion;
  return [
    `Index suggestion for slow query ${data.pattern.sys_id}`,
    `Suggestion: ${text(s.sys_id)}`,
    `Table: ${text(s.table_name) || '-'}`,
    `Columns: ${text(s.column_names) || '-'}`,
    `State: ${text(s.state) || '-'}`,
    `Index name: ${text(s.index_name) || '(none yet)'}`,
    `Created: ${text(s.sys_created_on) || '-'}`,
    data.note,
  ].join('\n');
}
