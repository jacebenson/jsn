import { CodeAuth, CodeNetwork, errUsage } from '../errors.js';
import { quoteShellArg } from '../helpers.js';
import { parseCount } from '../related-lists.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';

const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const malformed = message => Object.assign(new Error(message), { code: 'malformed_response' });
const isName = value => /^[A-Za-z0-9_]+$/.test(value);
const LABELS = ['number', 'name', 'sys_name', 'user_name', 'short_description'];
const ROW_FIELDS = ['sys_id', 'sys_class_name', ...LABELS].join(',');
export const LARGE_TABLE = 100000;
export const COUNT_TIMEOUT = 20000;
export const MAX_SLOW = 3;
const DICTIONARY_PAGE = 1000;
const DICTIONARY_MAX = 20000;

// [group, table, columns]. Columns of one table join with ^OR into one LIKE query.
// system: small configuration tables, never size-checked. data scans are size-checked. scripts: system mode with --scripts.
export const CATALOG = [
  ['system', 'sys_script', 'filter_condition,template'],
  ['system', 'sys_ui_policy', 'conditions,set_values'],
  ['system', 'catalog_ui_policy', 'catalog_conditions'],
  ['system', 'sys_data_policy2', 'conditions'],
  ['system', 'sys_security_acl', 'condition'],
  ['system', 'sysevent_email_action', 'condition'],
  ['system', 'sysevent_in_email_action', 'filter_condition,template'],
  ['system', 'sysrule_assignment', 'condition'],
  ['system', 'sysrule_approvals', 'condition'],
  ['system', 'contract_sla', 'start_condition,stop_condition,pause_condition,reset_condition,resume_condition,cancel_condition'],
  ['system', 'sys_report', 'filter'],
  ['system', 'sys_filter', 'filter'],
  ['system', 'sys_decision_question', 'condition'],
  ['system', 'sys_template', 'template,template_condition'],
  ['system', 'sys_properties', 'value'],
  ['system', 'sys_dictionary', 'default_value,reference_qual,reference_qual_condition'],
  ['system', 'sys_dictionary_override', 'default_value,reference_qual'],
  ['system', 'question', 'default_value,reference_qual,reference_qual_condition'],
  ['system', 'sp_instance', 'widget_parameters'],
  ['system', 'sys_cb_topic', 'graph'],
  ['data', 'sc_item_option', 'value'],
  ['data', 'question_answer', 'value'],
  ['data', 'sc_multi_row_question_answer', 'value'],
  ['data', 'sys_variable_value', 'value'],
  ['data', 'sys_user_preference', 'value'],
  ['scripts', 'sys_script', 'script,condition'],
  ['scripts', 'sys_script_include', 'script'],
  ['scripts', 'sys_script_client', 'script'],
  ['scripts', 'sys_ui_action', 'script,client_script_v2,condition'],
  ['scripts', 'sys_script_fix', 'script'],
  ['scripts', 'sysauto_script', 'script'],
  ['scripts', 'sys_ui_script', 'script'],
  ['scripts', 'catalog_script_client', 'script'],
  ['scripts', 'sys_script_email', 'script'],
  ['scripts', 'sysevent_in_email_action', 'script'],
  ['scripts', 'sys_security_acl', 'script'],
  ['scripts', 'user_criteria', 'script'],
  ['scripts', 'sysrule_assignment', 'script'],
  ['scripts', 'sysrule_approvals', 'script'],
  ['scripts', 'sys_ui_policy', 'script_true,script_false'],
  ['scripts', 'sysevent_email_action', 'advanced_condition,message_html,message_text'],
  ['scripts', 'sys_ws_operation', 'operation_script'],
  ['scripts', 'sys_relationship', 'query_with,query_from'],
  ['scripts', 'sys_dictionary', 'calculation'],
];
// Dictionary fields on these tables are never counted, with the reason the not-searched list gives.
const UNSEARCHABLE = [
  [/^var__m_/, 'Variable model tables (var__m_*): values are searched through sys_variable_value.value'],
  [/^(v_|ts_|text_search|sys_history_)/, 'Views, text index and history-set tables: no column search'],
  [/\d{4}$/, 'Rotation shards: the base table count reads every shard'],
  [/^(sys_audit|sys_journal_field|sys_email|syslog|sys_update_xml|sys_update_version|sys_flow_context)$|(^|_)(log|logs|history|stats|diagnostic_info)(_|$)|^syslog/, 'Log and history tables: records of past events, not references'],
];
// Reference fields that tie a child item to its record; group approvals inherit task.parent, which stays counted.
const CHILD_FIELDS = new Set(['sysapproval_approver.sysapproval']);
const ALWAYS_SKIPPED = [
  { source: 'Child items: journal entries, attachments, audit, update records, approvals, translations, emails and other document ID fields on data tables', reason: 'They belong to the record rather than refer to it' },
  { source: 'sys_created_by and sys_updated_by', reason: 'They hold user names, not sys_ids' },
  { source: 'Values stored as display values or names', reason: 'A sys_id search cannot match them' },
];
const MODE_SKIPPED = {
  data: [{ source: 'Configuration such as scheduled jobs and assignment rules: reference, list and document ID fields on sys_metadata tables, conditions, properties, templates, defaults and policies', reason: 'Run with --mode system' }],
  system: [
    { source: 'Records on data tables (incidents, group members, catalog answers)', reason: 'Run with --mode data, the default' },
    { source: 'Flow Designer (sys_hub_*)', reason: 'Flow values are compressed (gzip and base64); try jsn flows search <sys_id>, which decodes every visible flow and can be slow on first use' },
  ],
};

function validate({ mode, scripts, limit, maxRequests }) {
  if (!['data', 'system'].includes(mode)) throw errUsage('--mode must be data or system.');
  if (scripts && mode !== 'system') throw errUsage('--scripts scans script fields, which only --mode system searches.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw errUsage('--limit must be an integer from 1 to 100.');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 20000) throw errUsage('--max-requests must be an integer from 1 to 20000.');
}

function rowsOf(rows, table) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(`Malformed table response for ${table}`);
  return rows;
}

// Table parents from sys_db_object, chasing ancestors not yet seen. A table without a row maps to null.
async function readParents(sdk, names, parents, used) {
  let todo = [...new Set(names)].filter(name => !parents.has(name));
  while (todo.length) {
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      used.metadata++;
      const rows = rowsOf(await sdk.listStrict('sys_db_object', new URLSearchParams({ sysparm_query: `nameIN${chunk.join(',')}`, sysparm_fields: 'name,super_class.name', sysparm_limit: String(chunk.length), sysparm_display_value: 'false' })), 'sys_db_object');
      for (const row of rows) if (chunk.includes(raw(row.name))) parents.set(raw(row.name), raw(row['super_class.name']));
      for (const name of chunk) if (!parents.has(name)) parents.set(name, null);
    }
    todo = [...new Set(parents.values())].filter(name => name && isName(name) && !parents.has(name));
  }
}
function ancestors(table, parents) {
  const chain = [];
  for (let next = parents.get(table); next && !chain.includes(next) && chain.length < 30; next = parents.get(next)) chain.push(next);
  return chain;
}

async function readDictionary(sdk, query, used, gaps) {
  const rows = [];
  for (let offset = 0; offset < DICTIONARY_MAX; offset += DICTIONARY_PAGE) {
    used.metadata++;
    const page = rowsOf(await sdk.listStrict('sys_dictionary', new URLSearchParams({ sysparm_query: `${query}^ORDERBYsys_id`, sysparm_fields: 'name,element,internal_type,reference', sysparm_limit: String(DICTIONARY_PAGE), sysparm_offset: String(offset), sysparm_display_value: 'false' })), 'sys_dictionary');
    rows.push(...page);
    if (page.length < DICTIONARY_PAGE) return rows;
  }
  gaps.push({ source: `sys_dictionary ${query}`, reason: `More than ${DICTIONARY_MAX} dictionary rows; fields after the first ${DICTIONARY_MAX} were not searched` });
  return rows;
}

/** Build every count query for the mode: dictionary fields deduped by ancestry and split by sys_metadata, then the catalogue. */
async function plan(sdk, { sysId, cls, mode, scripts }, used) {
  const parents = new Map();
  const gaps = [];
  await readParents(sdk, [cls], parents, used);
  if (parents.get(cls) === null) throw malformed(`There is no sys_db_object row for ${cls}, so its parent classes are unknown; check that this user can read sys_db_object.`);
  const hierarchy = [cls, ...ancestors(cls, parents)];
  // Read in both modes: every instance has document ID fields (sysapproval_approver.document_id), so none means the read was filtered.
  const documentFields = await readDictionary(sdk, 'active=true^internal_type=document_id', used, gaps);
  if (!documentFields.length) throw malformed('sys_dictionary returned no document ID fields; check that this user can read sys_dictionary.');
  const fields = [
    ...await readDictionary(sdk, `active=true^internal_typeINreference,glide_list^referenceIN${hierarchy.join(',')}`, used, gaps),
    // Document ID fields on data tables tie child items (approvals, translations, emails) to a record; only configuration ones are references.
    ...(mode === 'system' ? documentFields : []),
  ].map(row => ({ table: raw(row.name), field: raw(row.element), kind: raw(row.internal_type) })).filter(row => isName(row.table) && isName(row.field));
  await readParents(sdk, fields.map(row => row.table), parents, used);
  const isConfig = table => table === 'sys_metadata' || ancestors(table, parents).includes('sys_metadata');
  const defined = new Set(fields.map(row => `${row.table}.${row.field}`));
  const skipped = new Map();
  const skip = (reason, table) => { const entry = skipped.get(reason) || skipped.set(reason, []).get(reason); entry.push(table); };
  const sources = [];
  for (const row of fields) {
    if (isConfig(row.table) !== (mode === 'system')) continue;
    // Children repeat an inherited field's dictionary row; the parent's count covers them.
    if (ancestors(row.table, parents).some(parent => defined.has(`${parent}.${row.field}`))) continue;
    if (CHILD_FIELDS.has(`${row.table}.${row.field}`)) { skip('Approvals of the record itself: they belong to it rather than refer to it', `${row.table}.${row.field}`); continue; }
    const unsearchable = UNSEARCHABLE.find(([pattern]) => pattern.test(row.table));
    if (unsearchable) { skip(unsearchable[1], `${row.table}.${row.field}`); continue; }
    const like = row.kind === 'glide_list';
    sources.push({ group: 'fields', kind: row.kind, table: row.table, fields: [row.field], match: like ? 'like' : 'eq', sized: like });
  }
  for (const [group, table, columns] of CATALOG) {
    if (group === 'data' ? mode !== 'data' : mode !== 'system' || (group === 'scripts' && !scripts)) continue;
    sources.push({ group, kind: 'text', table, fields: columns.split(','), match: 'like', sized: group === 'data' });
  }
  for (const source of sources) source.query = source.fields.map(field => `${field}${source.match === 'like' ? 'LIKE' : '='}${sysId}`).join('^OR');
  for (const [reason, tables] of skipped) gaps.push({ source: `${tables.length} field(s), e.g. ${[...new Set(tables)].slice(0, 5).join(', ')}`, reason });
  if (mode === 'system' && !scripts) gaps.push({ source: 'Script fields (business rules, script includes, client scripts, UI actions, fix scripts, scheduled jobs and more)', reason: 'Add --scripts' });
  // The other mode's gap first: it is the one a reader most needs and the one a truncated read would lose.
  return { hierarchy, sources, gaps: [...MODE_SKIPPED[mode], ...gaps] };
}

function countError(error) {
  return { count: null, status: error?.status || null, reason: error?.message || 'Aggregate request failed.' };
}
function checked(count, status = null) {
  return count === null ? { count, status, reason: 'Aggregate response did not contain a valid count.' } : { count };
}
const statsUrl = (table, query) => `/api/now/stats/${table}?${new URLSearchParams({ sysparm_count: 'true', ...(query ? { sysparm_query: query } : {}) })}`;

/**
 * Find records that hold a record's sys_id. mode data: reference and glide_list fields on
 * data tables, then catalog answers, variable values and preferences. mode system: reference,
 * glide_list and document_id fields on sys_metadata tables, then configuration text columns.
 * Counts come before rows, one per request in the session, so a slow one is cancelled alone.
 */
export async function findReferences(sdk, { table, identifier, identifierField, mode = 'data', planOnly = false, scripts = false, includeLarge = false, limit = 20, maxRequests = 2000, signal, profile, instance } = {}) {
  validate({ mode, scripts, limit, maxRequests });
  const record = await resolveRecord(sdk, { table, identifier, identifierField, fields: ['sys_class_name', ...LABELS], resource: 'Record' });
  const sysId = unwrapSysId(record);
  if (!/^[0-9a-f]{32}$/i.test(sysId)) throw malformed('The matched record has no readable sys_id; check field ACLs before retrying.');
  const cls = isName(raw(record.sys_class_name)) ? raw(record.sys_class_name) : table;
  const used = { metadata: 0, counts: 0, rows: 0 };
  const { hierarchy, sources, gaps } = await plan(sdk, { sysId, cls, mode, scripts }, used);
  const sizeTables = [...new Set(sources.filter(source => source.sized).map(source => source.table))];
  const planned = sources.length + sizeTables.length;
  const data = {
    table, mode, record: { table: cls, sys_id: sysId, label: LABELS.map(name => raw(record[name])).find(Boolean) || '' }, hierarchy,
    plan_only: planOnly, requests: { planned, max: maxRequests, used }, sources, records: [], not_searched: [...gaps, ...ALWAYS_SKIPPED], partial: false,
  };
  if (planOnly) {
    for (const source of sources) source.status = 'planned';
    data.size_checks = sizeTables;
    return data;
  }
  if (planned > maxRequests) throw errUsage(`This search needs ${planned} count queries, more than --max-requests ${maxRequests}. Run with --plan to see them, then raise --max-requests or narrow the search.`);

  let counting = false;
  let session = true;
  let slow = 0;
  let cancelling;
  // The platform's own cancel, in the session the count runs in, as jsn eval cancels a script.
  const cancel = () => sdk.fetchResponse(`${sdk.baseURL}/cancel_my_transaction.do?sysparm_output=xml`, { method: 'GET', stateful: true, timeout: 10000 })
    .then(async response => (response.ok ? { status: 'sent', message: /<message text="([^"]*)"/.exec(await response.text())?.[1]?.trim() || '' } : { status: 'failed', message: `HTTP ${response.status}` }),
      error => ({ status: 'failed', message: error.message }));
  const onAbort = () => { if (counting && session) cancelling = cancel().then(result => { data.cancel = result; }); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const interrupted = () => signal?.aborted;
  const stopped = () => interrupted() || slow >= MAX_SLOW;
  // Every count and row read is one request in the session: the Batch API runs a batch as one transaction, so one slow count would cancel the rest.
  const timed = async call => {
    counting = true;
    const run = () => call({ method: 'GET', readOnly: true, stateful: session, timeout: COUNT_TIMEOUT });
    try {
      // A refused UI login (flapping instance, web-service-only user) fails every session read, not just this one.
      try { return await run(); } catch (error) { if (!session || error.code !== CodeAuth) throw error; session = false; data.scan_session = 'refused'; return await run(); }
    } catch (error) {
      if (interrupted()) throw error;
      const timedOut = error.code === CodeNetwork && /timed out/i.test(error.message);
      // A rate-limit refusal (429) means the instance wants fewer requests, so it counts as slow.
      if (timedOut || error.status === 429 || /maximum execution time|transaction cancel/i.test(error.message || '')) slow++;
      // The instance keeps running a query jsn stops waiting for, so cancel it there.
      if (timedOut) error.slow = `No answer in ${COUNT_TIMEOUT / 1000}s; ${session ? `cancel sent to the instance: ${(await cancel()).status}` : 'without a UI session it runs on until the instance\'s own quota'}`;
      throw error;
    } finally { counting = false; }
  };
  const count = async (name, query) => {
    used.counts++;
    try { return checked(parseCount(await timed(opts => sdk.request(`${sdk.baseURL}${statsUrl(name, query)}`, opts)))); } catch (error) { return { ...countError(error), ...(error.slow ? { reason: error.slow } : {}) }; }
  };
  const settle = (source, result) => {
    Object.assign(source, result.count === null ? { status: 'failed', count: null, reason: result.reason, ...(result.status ? { http_status: result.status } : {}) } : { status: 'counted', count: result.count });
  };
  try {
    // Equality counts first; LIKE scans after a row count of their table.
    const sizes = new Map();
    for (const source of [...sources.filter(item => item.match !== 'like'), ...sources.filter(item => item.match === 'like')]) {
      if (stopped()) break;
      if (source.sized) {
        if (!sizes.has(source.table)) sizes.set(source.table, await count(source.table));
        const size = sizes.get(source.table);
        if (size.count === null) { Object.assign(source, { status: 'failed', count: null, reason: `Row count for ${source.table} failed, so the scan was not run: ${size.reason}` }); continue; }
        if (size.count > LARGE_TABLE && !includeLarge) { Object.assign(source, { status: 'skipped', count: null, rows: size.count, reason: `${source.table} has ${size.count} rows, over ${LARGE_TABLE}; add --include-large to scan it` }); continue; }
        if (stopped()) break;
      }
      settle(source, await count(source.table, source.query));
    }
    if (slow >= MAX_SLOW) data.stopped = 'slow';
    // Rows only for nonzero counts, within what is left of the budget.
    const byId = new Map();
    for (const source of sources.filter(item => item.count > 0)) {
      const hint = ['jsn', 'records', 'list', '--table', source.table, '--query', source.query, ...(profile ? ['--profile', profile] : []), ...(instance ? ['--instance', instance] : [])].map(quoteShellArg).join(' ');
      if (interrupted()) { Object.assign(source, { listed: 0, command: hint, reason: 'Interrupted before its rows were read' }); continue; }
      if (used.counts + used.rows >= maxRequests) { Object.assign(source, { listed: 0, command: hint, reason: 'Budget reached before its rows were read' }); continue; }
      used.rows++;
      let rows;
      try {
        // sysparm_no_count: the Table API otherwise repeats the whole count for X-Total-Count.
        rows = rowsOf(await timed(opts => sdk.listStrict(source.table, new URLSearchParams({ sysparm_query: source.query, sysparm_fields: ROW_FIELDS, sysparm_limit: String(limit), sysparm_display_value: 'false', sysparm_no_count: 'true' }), opts)), source.table);
        if (rows.some(row => !/^[0-9a-f]{32}$/i.test(raw(row.sys_id)))) throw malformed(`${source.table} returned a row without a readable sys_id`);
      } catch (error) { Object.assign(source, { listed: 0, command: hint, reason: `Rows could not be read: ${error.slow || error.message}` }); continue; }
      source.listed = rows.length;
      if (source.count > rows.length) source.command = hint;
      if (!rows.length) source.reason = `Counted ${source.count}, but no row could be read`;
      for (const row of rows) {
        const id = raw(row.sys_id);
        const entry = byId.get(id) || byId.set(id, { table: isName(raw(row.sys_class_name)) ? raw(row.sys_class_name) : source.table, sys_id: id, label: LABELS.map(name => raw(row[name])).find(Boolean) || '', via: [] }).get(id);
        entry.via.push(`${source.table}.${source.fields.join('|')}`);
      }
    }
    data.records = [...byId.values()].sort((a, b) => a.table.localeCompare(b.table) || a.sys_id.localeCompare(b.sys_id));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancelling;
  }
  for (const source of sources) {
    if (!source.status) Object.assign(source, { status: 'not_run', reason: data.stopped ? `Not run: ${MAX_SLOW} counts took over ${COUNT_TIMEOUT / 1000}s or hit the instance's rate limit, so the run stopped to spare the instance` : 'Interrupted before this count' });
    if (['failed', 'skipped', 'not_run'].includes(source.status) || source.reason) data.not_searched.push({ source: `${source.table}.${source.fields.join('|')}`, reason: source.reason });
  }
  data.interrupted = !!interrupted();
  data.partial = data.interrupted || sources.some(source => ['failed', 'skipped', 'not_run'].includes(source.status) || (source.count > 0 && !source.listed));
  // Sources last: a few hundred of them would push the records out of a truncated read.
  delete data.sources;
  data.sources = sources;
  return data;
}

export function formatReferences(data) {
  const lines = [`${data.record.table} ${data.record.sys_id}${data.record.label ? ` (${data.record.label})` : ''}; class hierarchy: ${data.hierarchy.join(' > ')}; mode: ${data.mode}`];
  if (data.plan_only) {
    const groups = new Map();
    for (const source of data.sources) groups.set(`${source.group}/${source.kind}`, (groups.get(`${source.group}/${source.kind}`) || 0) + 1);
    lines.push(`Plan: ${data.requests.planned} count queries (${data.size_checks.length} table size checks), budget ${data.requests.max}. Nothing was counted.`);
    for (const [group, count] of groups) lines.push(`  ${group}: ${count}`);
  } else {
    lines.push(`${data.records.length} referring record(s)${data.partial ? '; PARTIAL: see not searched' : ''}`);
    for (const ref of data.records) lines.push(`${ref.table} ${ref.sys_id}${ref.label ? ` ${ref.label}` : ''}  via ${ref.via.join(', ')}`);
    const more = data.sources.filter(source => source.count > (source.listed || 0));
    if (more.length) lines.push('', 'More rows than listed:', ...more.map(source => `  ${source.table}.${source.fields.join('|')}: ${source.count} (listed ${source.listed || 0}) ${source.command || ''}`.trimEnd()));
    if (data.stopped === 'slow') lines.push('', `Stopped after ${MAX_SLOW} counts took over ${COUNT_TIMEOUT / 1000}s or hit the instance's rate limit, to spare the instance; the counts not run are listed under not searched.`);
    if (data.cancel) lines.push('', `Cancel sent to the instance: ${data.cancel.status}${data.cancel.message ? ` (${data.cancel.message})` : ''}`);
    if (data.scan_session === 'refused') lines.push('', 'The instance refused jsn\'s UI session, so the counts ran without it and neither Ctrl-C nor a slow count can be cancelled on the instance.');
  }
  lines.push('', 'Not searched:', ...data.not_searched.map(item => `  ${item.source}: ${item.reason}`));
  return lines.join('\n');
}
