// Read-only metadata inventory. Upgrade skips are historical evidence, not a
// current baseline diff. Scope ownership must be declared, never inferred.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getVersion } from './commands/version.js';

// Raw provider choices: 4 = Skipped, 104 = Skipped (second pass). Other skip
// dispositions do not establish a preserved customization, so the upgrade
// history read is filtered server-side and a bounded budget spends its pages
// on preserved-customization evidence instead of arbitrary history rows.
export const SKIP_DISPOSITIONS = ['4', '104'];
const SKIP_QUERY = `dispositionIN${SKIP_DISPOSITIONS.join(',')}`;
const SOURCES = {
  sys_scope: { fields: 'sys_id,name,scope,sys_class_name', query: 'ORDERBYsys_id', countQuery: '', kind: 'inventory read' },
  sys_metadata: { fields: 'sys_id,sys_name,sys_class_name,sys_scope,sys_update_name,sys_updated_on', query: 'ORDERBYsys_id', countQuery: '', kind: 'bounded sample' },
  sys_upgrade_history_log: { fields: 'sys_id,file_name,disposition,resolution_status,sys_updated_on', query: `${SKIP_QUERY}^ORDERBYsys_id`, countQuery: SKIP_QUERY, kind: 'inventory read' },
};
// The broad sys_metadata read is an arbitrary sys_id-ordered slice of a table
// that can hold hundreds of thousands of rows, so it can only ever be a bounded
// sample of the instance. Skipped-upgrade artifacts are therefore resolved
// directly by the update names the filtered history read observed, so every
// skipped artifact visible on the instance reaches the inventory.
export const RESOLUTION_SOURCE = 'sys_metadata_name_resolution';
export const RESOLUTION_CHUNK_SIZE = 25;
const RESOLUTION_MAX_PAGES = 3;
const value = v => v && typeof v === 'object' ? v.value ?? '' : v ?? '';
const text = v => String(value(v));

// How many rows are available for the same query? The Stats API count is the
// only evidence that lets a capture claim completeness; without it coverage
// must stay unknown rather than implied by a page that happened to end.
async function availableCount(sdk, table, countQuery, fetched) {
  if (typeof sdk.aggregateCount !== 'function') return null;
  let count;
  try {
    count = await sdk.aggregateCount(table, countQuery);
  } catch {
    return null;
  }
  if (!Number.isFinite(count) || count < 0) return null;
  // A zero count with rows in hand means the count is unusable, not that the
  // table is empty.
  if (count === 0 && fetched > 0) return null;
  return Math.floor(count);
}

// A per-query count with no zero/short-page guessing: a count of 0 for a name
// chunk means no visible row matched that chunk, which is real evidence.
async function statsCount(sdk, table, query) {
  if (typeof sdk.aggregateCount !== 'function') return null;
  try {
    const count = await sdk.aggregateCount(table, query);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
  } catch {
    return null;
  }
}

async function readSource(sdk, table, { fields, query, countQuery, kind }, pageSize, maxPages) {
  const rows = [];
  const seen = new Set();
  const coverage = {
    status: 'limited', fetched: 0, available: null, pages: 0, duplicate_rows: 0, missing_identity: 0,
    query, ...(kind ? { kind } : {}), reason: 'Page limit reached; remaining records unknown.',
  };
  // The strict seam rejects a 2xx body without a result array, so a malformed
  // envelope becomes an unavailable source instead of an empty inventory.
  const listFn = typeof sdk.listStrict === 'function' ? sdk.listStrict.bind(sdk) : sdk.list.bind(sdk);
  let failure = '';
  try {
    for (let page = 0; page < maxPages; page++) {
      const batch = await listFn(table, {
        sysparm_fields: fields, sysparm_query: query,
        sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true',
        sysparm_limit: String(pageSize), sysparm_offset: String(page * pageSize),
      }, { readOnly: true });
      coverage.pages++;
      if (!Array.isArray(batch)) throw new Error('Invalid table response');
      for (const row of batch) {
        const id = text(row.sys_id);
        if (!id) { coverage.missing_identity++; continue; }
        if (seen.has(id)) { coverage.duplicate_rows++; continue; }
        seen.add(id);
        rows.push(row);
        const required = table === 'sys_metadata' ? ['sys_class_name', 'sys_scope', 'sys_update_name'] : table === 'sys_scope' ? ['scope'] : ['file_name', 'disposition', 'resolution_status'];
        if (required.some(field => !Object.hasOwn(row, field))) coverage.missing_identity++;
      }
      coverage.fetched = rows.length;
      // A short page is not exhaustion: ServiceNow returns short offset pages
      // on large tables. Keep reading within the page budget.
      if (batch.length === 0) break;
    }
  } catch (error) {
    failure = String(error?.message || error);
  }
  if (failure) {
    coverage.status = /401|403|permission|forbidden|access denied/i.test(failure) ? 'permission_denied' : 'unavailable';
    coverage.reason = 'Table read failed; partial results retained. Authentication, ACLs, table availability or network access may limit coverage.';
    return { rows, coverage };
  }
  coverage.available = await availableCount(sdk, table, countQuery, rows.length);
  const duplicateNote = coverage.duplicate_rows
    ? ` Pagination returned ${coverage.duplicate_rows} repeated identit${coverage.duplicate_rows === 1 ? 'y' : 'ies'}; offset paging on large tables can overlap or skip.`
    : '';
  if (coverage.missing_identity) {
    coverage.status = 'missing_fields';
    coverage.reason = 'Some records omitted identity or classification fields; field ACLs or malformed responses may hide evidence.';
  } else if (coverage.available !== null && coverage.fetched >= coverage.available) {
    coverage.status = 'exhausted';
    coverage.reason = `Read all ${coverage.available} rows the Stats API reports for this query. Both the count and the rows reflect visible ACL-filtered records.`;
  } else if (coverage.available !== null) {
    coverage.status = 'limited';
    coverage.reason = `Read ${coverage.fetched} of ${coverage.available} rows the Stats API reports for this query; ${coverage.available - coverage.fetched} row(s) were not read within the page budget.`;
  } else if (coverage.duplicate_rows) {
    coverage.status = 'unstable';
    coverage.reason = 'Repeated identities across pages; pagination may be ignored or records changed during capture. The Stats API count for this query was unavailable, so completeness is unknown.';
  } else {
    coverage.status = 'limited';
    coverage.reason = 'The Stats API count for this query was unavailable, so visible-result completeness cannot be claimed.';
  }
  coverage.reason += duplicateNote;
  return { rows, coverage };
}

// Resolve observed skipped-upgrade update names against visible sys_metadata
// with chunked GET-only `sys_update_nameIN<chunk>` queries. The broad sample
// cannot be relied on for this: it is an arbitrary sys_id-ordered slice, so an
// inventory claim needs the artifacts the history read actually named.
// Read failures are reported per chunk instead of being hidden behind the
// sample, and completeness stays anchored to the Stats API count for the exact
// name queries used, never to a page that happened to end.
async function resolveUpdateNames(sdk, names) {
  const requested = [...new Set(names)].sort();
  const rows = [];
  const seen = new Set();
  const resolved = new Set();
  const coverage = {
    kind: 'targeted name resolution', status: 'limited', fetched: 0, available: null, pages: 0, chunks: 0,
    query: 'sys_update_nameIN<observed skipped update names>', requested_names: requested.length,
    resolved_names: 0, unresolved_names: 0, failed_chunks: 0, reason: '',
  };
  if (!requested.length) {
    coverage.query = '';
    coverage.reason = 'No skipped upgrade rows were observed, so no update names required resolution.';
    return { rows, resolved, coverage };
  }
  const listFn = typeof sdk.listStrict === 'function' ? sdk.listStrict.bind(sdk) : sdk.list.bind(sdk);
  const failures = [];
  let countSum = 0;
  let countKnown = true;
  for (let start = 0; start < requested.length; start += RESOLUTION_CHUNK_SIZE) {
    const chunk = requested.slice(start, start + RESOLUTION_CHUNK_SIZE);
    const limit = Math.max(chunk.length, 1);
    const query = `sys_update_nameIN${chunk.join(',')}`;
    coverage.chunks++;
    try {
      for (let page = 0; page < RESOLUTION_MAX_PAGES; page++) {
        const batch = await listFn('sys_metadata', {
          sysparm_fields: SOURCES.sys_metadata.fields, sysparm_query: `${query}^ORDERBYsys_id`,
          sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true',
          sysparm_limit: String(limit), sysparm_offset: String(page * limit),
        }, { readOnly: true });
        coverage.pages++;
        if (!Array.isArray(batch)) throw new Error('Invalid table response');
        for (const row of batch) {
          const updateName = text(row.sys_update_name);
          if (updateName && chunk.includes(updateName)) resolved.add(updateName);
          const id = text(row.sys_id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          rows.push(row);
        }
        coverage.fetched = rows.length;
        if (batch.length === 0) break;
      }
    } catch (error) {
      failures.push(String(error?.message || error));
    }
    const counted = await statsCount(sdk, 'sys_metadata', query);
    if (counted === null) countKnown = false;
    else countSum += counted;
  }
  coverage.available = countKnown ? countSum : null;
  coverage.resolved_names = resolved.size;
  coverage.unresolved_names = requested.length - resolved.size;
  if (failures.length) {
    coverage.status = failures.some(message => /401|403|permission|forbidden|access denied/i.test(message)) ? 'permission_denied' : 'unavailable';
    coverage.failed_chunks = failures.length;
    coverage.reason = `${failures.length} of ${coverage.chunks} update-name lookup chunk(s) failed; rows resolved by the remaining chunks were retained, but some observed skipped artifacts may be missing from this inventory. ACL visibility or a read error may limit this source.`;
  } else if (coverage.available !== null && coverage.fetched >= coverage.available) {
    coverage.status = 'exhausted';
    coverage.reason = `Resolved ${coverage.resolved_names} of ${requested.length} observed skipped update names in ${coverage.chunks} chunk(s) and read all ${coverage.available} row(s) the Stats API reports for those name queries.`;
  } else if (coverage.available !== null) {
    coverage.status = 'limited';
    coverage.reason = `Resolved ${coverage.resolved_names} of ${requested.length} observed skipped update names and read ${coverage.fetched} of ${coverage.available} row(s) the Stats API reports for those name queries; the per-chunk page budget was reached.`;
  } else {
    coverage.status = 'limited';
    coverage.reason = `Resolved ${coverage.resolved_names} of ${requested.length} observed skipped update names; the Stats API count for those name queries was unavailable, so lookup completeness cannot be claimed.`;
  }
  return { rows, resolved, coverage };
}

export const CUSTOMIZATION_SCHEMA_VERSION = 1;
export function getCustomizationsDir() {
  return path.join(process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn'), 'customizations');
}

function reportFile(id, dir) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error('Invalid customization report ID');
  return path.join(dir, `${id}.json`);
}
function validateReport(report) {
  if (report?.capture_schema_version !== CUSTOMIZATION_SCHEMA_VERSION || !report.instance || !report.categories || !report.coverage) throw new Error('Unsupported or invalid customization report schema');
  for (const category of ['ootb_modifications', 'customer_app_artifacts', 'unclassified']) {
    if (!Array.isArray(report.categories[category])) throw new Error('Invalid customization report categories');
  }
  return report;
}

export async function captureReport({ sdk, instance, profile = '', label = '', customerScopes = [], pageSize = 100, maxPages = 10, dir = getCustomizationsDir() }) {
  if (!instance) throw new Error('An authenticated instance is required for customization capture');
  const start_time = new Date().toISOString();
  const capture = await captureCustomizations({ sdk, customerScopes, pageSize, maxPages });
  const report = { run_id: crypto.randomUUID(), instance, profile, label, start_time, finish_time: new Date().toISOString(), jsn_version: getVersion(), capture_schema_version: CUSTOMIZATION_SCHEMA_VERSION, command_options: { customerScopes, pageSize, maxPages }, ...capture };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportFile(report.run_id, dir), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  return report;
}

export function getReport(id, { dir = getCustomizationsDir() } = {}) {
  try { return validateReport(JSON.parse(fs.readFileSync(reportFile(id, dir), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function listReports({ limit = 50, dir = getCustomizationsDir() } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const report = getReport(name.slice(0, -5), { dir });
    return { run_id: report.run_id, instance: report.instance, profile: report.profile, label: report.label, start_time: report.start_time, status: report.status };
  }).sort((a, b) => b.start_time.localeCompare(a.start_time) || a.run_id.localeCompare(b.run_id)).slice(0, Math.max(1, Math.min(1000, Number(limit) || 50)));
}

// Object key order and evidence enumeration order are not artifact changes.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function inventory(report) {
  return new Map(Object.entries(report.categories).flatMap(([category, items]) => items.map(item => [`${item.identity.table}:${item.identity.sys_id}`, { category, ...item }])));
}

// Sources that cannot be read are not empty sources. A comparison built on top
// of one must say so instead of presenting missing coverage as real removals.
function impairedSources(coverage) {
  const sources = coverage?.sources || {};
  return Object.entries(sources).filter(([, source]) => {
    if (source.status === 'unavailable' || source.status === 'permission_denied') return true;
    return source.fetched === 0 && source.available === null;
  }).map(([table, source]) => `${table} (${source.status})`);
}

export function compareReports(baseline, newer) {
  validateReport(baseline); validateReport(newer);
  if (baseline.instance !== newer.instance) throw new Error('Customization reports must describe the same instance');
  const a = inventory(baseline), b = inventory(newer);
  const additions = [], removals = [], changes = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(id)) additions.push({ id, availability: 'not_observed_in_baseline', item: b.get(id) });
    else if (!b.has(id)) removals.push({ id, availability: 'not_observed_in_new', item: a.get(id) });
    else if (JSON.stringify(canonical(a.get(id))) !== JSON.stringify(canonical(b.get(id)))) changes.push({ id, baseline: a.get(id), new: b.get(id) });
  }
  const impaired = { baseline: impairedSources(baseline.coverage), new: impairedSources(newer.coverage) };
  const unreliable = impaired.baseline.length > 0 || impaired.new.length > 0;
  const unknowns = ['Additions/removals mean newly observed/no longer observed, not proven creation/deletion. ACLs, limits and concurrent changes can affect visibility.', 'Only captured metadata and evidence are compared, not full artifact content or OOTB baselines.', 'Ownership declarations, scope visibility and evidence coverage can cause category changes without an artifact change.'];
  if (unreliable) unknowns.push(`Unavailable or empty sources make observed additions/removals unreliable: baseline [${impaired.baseline.join(', ') || 'none'}], new [${impaired.new.join(', ') || 'none'}]. They may reflect missing coverage rather than a real change and must not be read as mass creation or deletion.`);
  return { baseline_run_id: baseline.run_id, new_run_id: newer.run_id, instance: baseline.instance, status: unreliable ? 'unreliable' : 'incomplete', additions, removals, changes,
    impaired_sources: impaired,
    coverage: { baseline: baseline.coverage, new: newer.coverage },
    unknowns };
}

export function formatReport(report) {
  const lines = [`Customization capture ${report.run_id}${report.label ? ` (${report.label})` : ''}`, `Instance: ${report.instance}`, `Status: ${report.status}`, '', 'COVERAGE'];
  for (const [source, coverage] of Object.entries(report.coverage.sources)) lines.push(`${source}${coverage.kind ? ` [${coverage.kind}]` : ''}: ${coverage.status}, ${coverage.fetched} fetched of ${coverage.available === null || coverage.available === undefined ? 'unknown' : coverage.available} available. ${coverage.reason}`);
  for (const limitation of report.coverage.limitations) lines.push(`Unknown: ${limitation}`);
  if (report.coverage.unmatched_customer_scopes.length) lines.push(`Unmatched customer declarations: ${report.coverage.unmatched_customer_scopes.join(', ')}`);
  const upgrade = report.coverage.upgrade_evidence;
  if (upgrade) {
    lines.push(`Observed skipped upgrade rows: ${upgrade.skipped_rows_observed}; distinct update names: ${upgrade.update_names_observed}; resolved by direct name lookup: ${upgrade.resolved_by_lookup}; unresolved: ${upgrade.unresolved_update_names.length}${upgrade.lookup_failures ? `; failed lookup chunks: ${upgrade.lookup_failures}` : ''}`);
    if (upgrade.unresolved_update_names.length) lines.push(`Unresolved skipped update names (not visible in sys_metadata): ${upgrade.unresolved_update_names.slice(0, 20).join(', ')}${upgrade.unresolved_update_names.length > 20 ? `, ... and ${upgrade.unresolved_update_names.length - 20} more` : ''}`);
  }
  lines.push(`Unmatched upgrade history records: ${report.coverage.unmatched_upgrade_records}`);
  for (const [category, items] of Object.entries(report.categories)) {
    lines.push('', `${category.toUpperCase()} (${items.length})`);
    for (const item of items) {
      lines.push(`${item.identity.table}:${item.identity.sys_id} ${item.identity.name}`, `  Scope: ${item.scope.scope || item.scope.sys_id || 'unknown'}`, `  Risk: ${item.risk.rating}. ${item.risk.rationale}`);
      for (const evidence of item.evidence) lines.push(`  Evidence: ${evidence.source}:${evidence.sys_id}. ${evidence.basis}`);
      if (item.reversion) {
        for (const impact of item.reversion.known_impact) lines.push(`  Known impact: ${impact}`);
        lines.push(`  Known dependencies: ${item.reversion.known_dependencies.join(', ') || 'not established'}`);
        for (const unknown of item.reversion.unknowns) lines.push(`  Reversion unknown: ${unknown}`);
      }
      for (const unknown of item.unknowns) lines.push(`  Unknown: ${unknown}`);
      lines.push(`  Recommendation: ${item.recommendation}`);
    }
  }
  return lines.join('\n') + '\n';
}
export function formatReportList(runs) {
  return ['RUN ID  STATUS  LABEL  INSTANCE', ...runs.map(run => `${run.run_id}  ${run.status}  ${run.label || '(unlabeled)'}  ${run.instance}`), ...(runs.length ? [] : ['(no customization captures)'])].join('\n') + '\n';
}

// Flatten a captured item into comparable leaf fields so a comparison can show
// what actually changed instead of only asserting that something did.
function flattenFields(source, prefix = '', out = {}) {
  const current = prefix || 'value';
  if (source === null || source === undefined) { out[current] = ''; return out; }
  if (Array.isArray(source)) {
    if (!source.length) { out[current] = '(none)'; return out; }
    source.forEach((entry, index) => flattenFields(entry, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof source === 'object') {
    const keys = Object.keys(source).sort();
    if (!keys.length) { out[current] = '(none)'; return out; }
    for (const key of keys) flattenFields(source[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  out[current] = String(source);
  return out;
}
function fieldChanges(before, after) {
  const a = flattenFields(canonical(before));
  const b = flattenFields(canonical(after));
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(field => a[field] !== b[field])
    .map(field => ({ field, before: Object.hasOwn(a, field) ? a[field] : '(absent)', after: Object.hasOwn(b, field) ? b[field] : '(absent)' }));
}
function describeComparedItem(item) {
  const identity = item?.identity || {};
  const scope = item?.scope || {};
  return [
    `Artifact: ${identity.table || 'unknown'}:${identity.sys_id || 'unknown'} "${identity.name || identity.update_name || 'unnamed'}"`,
    `Category: ${item?.category || 'unknown'}`,
    `Scope: ${scope.scope || scope.sys_id || 'unknown'}${scope.name ? ` (${scope.name})` : ''}`,
    `Evidence: ${(item?.evidence || []).map(evidence => `${evidence.source}:${evidence.sys_id}`).join(', ') || 'none captured'}`,
    `Risk: ${item?.risk?.rating || 'unknown'}`,
    `Recommendation: ${item?.recommendation || 'not recorded'}`,
  ];
}

export function formatReportComparison(result) {
  const lines = [`Customization comparison: ${result.status}`, `Baseline: ${result.baseline_run_id}`, `New: ${result.new_run_id}`, ...result.unknowns];
  const impaired = result.impaired_sources || { baseline: [], new: [] };
  if (impaired.baseline.length) lines.push(`Unreliable baseline sources: ${impaired.baseline.join(', ')}`);
  if (impaired.new.length) lines.push(`Unreliable new sources: ${impaired.new.join(', ')}`);
  for (const kind of ['additions', 'removals', 'changes']) {
    lines.push('', `${kind.toUpperCase()} (${result[kind].length})`);
    for (const entry of result[kind]) {
      if (kind === 'changes') {
        lines.push(`${entry.id}: ${entry.availability || 'captured metadata/evidence changed'}`);
        const fields = fieldChanges(entry.baseline, entry.new);
        for (const field of fields) lines.push(`  ${field.field}: "${field.before}" -> "${field.after}"`);
        if (!fields.length) lines.push('  No compared field differs; evidence ordering or another unrendered value changed.');
      } else {
        lines.push(`${entry.id}: ${entry.availability}`);
        for (const detail of describeComparedItem(entry.item)) lines.push(`  ${detail}`);
      }
    }
  }
  for (const side of ['baseline', 'new']) for (const [table, source] of Object.entries(result.coverage[side].sources)) lines.push(`${side} ${table}${source.kind ? ` [${source.kind}]` : ''}: ${source.status}, ${source.fetched} fetched of ${source.available === null || source.available === undefined ? 'unknown' : source.available} available. ${source.reason}`);
  return lines.join('\n') + '\n';
}

export async function captureCustomizations({ sdk, customerScopes = [], pageSize = 100, maxPages = 10 }) {
  if (!sdk) throw new Error('An authenticated SDK is required');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('pageSize must be 1..1000 and maxPages 1..100');
  const sources = {};
  const data = {};
  for (const [table, source] of Object.entries(SOURCES)) {
    const result = await readSource(sdk, table, source, pageSize, maxPages);
    sources[table] = result.coverage;
    data[table] = result.rows;
  }
  // The broad sys_metadata read is a bounded sample, so the artifacts the
  // filtered history read actually named are looked up directly. The source is
  // only registered when there is something to resolve, so a report with no
  // skipped rows has no phantom empty source.
  const observedNames = data.sys_upgrade_history_log.map(row => text(row.file_name)).filter(Boolean);
  const resolution = await resolveUpdateNames(sdk, observedNames);
  if (observedNames.length) {
    sources[RESOLUTION_SOURCE] = resolution.coverage;
    const sampled = new Set(data.sys_metadata.map(row => text(row.sys_id)));
    data.sys_metadata = [...data.sys_metadata, ...resolution.rows.filter(row => !sampled.has(text(row.sys_id)))];
  }
  const scopes = new Map(data.sys_scope.map(row => [text(row.sys_id), row]));
  const declared = new Set(customerScopes);
  const logs = new Map();
  for (const row of data.sys_upgrade_history_log) {
    const name = text(row.file_name);
    if (!logs.has(name)) logs.set(name, []);
    logs.get(name).push(row);
  }
  const categories = { ootb_modifications: [], customer_app_artifacts: [], unclassified: [] };
  for (const row of data.sys_metadata) {
    const scopeId = text(row.sys_scope);
    const scope = scopes.get(scopeId);
    const scopeName = text(scope?.scope);
    const identity = { sys_id: text(row.sys_id), table: text(row.sys_class_name) || 'unknown', name: text(row.sys_name) || text(row.sys_update_name) || text(row.sys_id), update_name: text(row.sys_update_name) };
    const evidence = [{ source: 'sys_metadata', sys_id: identity.sys_id, basis: 'Visible application metadata record', updated_on: text(row.sys_updated_on) }];
    const item = {
      identity, scope: { sys_id: scopeId || null, name: text(scope?.name) || null, scope: scopeName || null }, evidence,
      risk: { rating: 'unknown', rationale: 'No trusted current OOTB baseline, runtime usage or dependency analysis was captured.' },
      recommendation: 'Review ownership, current configuration and tests before changing this artifact.',
      unknowns: ['Current content and behavioral differences were not captured.', 'Metadata timestamps can change without a behavioral change.'],
    };
    const history = (logs.get(identity.update_name) || []).sort((a, b) => text(b.sys_updated_on).localeCompare(text(a.sys_updated_on)) || text(a.sys_id).localeCompare(text(b.sys_id)));
    // Raw provider choices: 4 = Skipped, 104 = Skipped (second pass).
    // The read is already filtered server-side; this check stays because a
    // server filter is never trusted to be a classification.
    const skipped = history.filter(log => Object.hasOwn(log, 'resolution_status') && SKIP_DISPOSITIONS.includes(text(log.disposition)) && text(log.resolution_status) !== 'reviewed_reverted');
    // A declaration is caller evidence, not platform/vendor provenance. Keep it
    // separate from OOTB findings and record the uncertainty explicitly.
    if (scope && scopeId !== 'global' && scopeName !== 'global' && (declared.has(scopeName) || declared.has(scopeId))) {
      evidence.push({ source: 'capture_options', sys_id: scopeId, basis: 'Customer ownership declared by caller; scope identity verified in sys_scope.' });
      item.unknowns.push('Publisher/customer ownership is not independently verified.');
      item.recommendation = 'Maintain as a declared customer application artifact; review with its owner, not as an OOTB deviation.';
      categories.customer_app_artifacts.push(item);
    } else if (identity.update_name && skipped.length) {
      for (const log of skipped) evidence.push({ source: 'sys_upgrade_history_log', sys_id: text(log.sys_id), basis: 'Upgrade disposition skipped preserves a customization of a vendor-delivered artifact.', disposition: text(log.disposition), resolution_status: text(log.resolution_status) || null });
      item.unknowns.push('Historical upgrade skips do not prove the customization still differs from OOTB. Later reversion or merge may have occurred.');
      item.reversion = {
        known_impact: ['The recorded upgrade did not overwrite the customization.'],
        known_dependencies: [],
        unknowns: ['Current OOTB baseline and exact changes are unavailable.', 'Runtime impact and dependencies of reverting have not been established. An empty dependency list does not mean none exist.'],
      };
      item.recommendation = 'Retain pending review. Compare the current artifact with a trusted baseline, inspect callers and regression-test in non-production before any reversion.';
      categories.ootb_modifications.push(item);
    } else {
      item.unknowns.push('Origin is unclassified. A non-global scope or an update timestamp is not proof of customer ownership or an OOTB modification.');
      categories.unclassified.push(item);
    }
  }
  const visibleNames = new Set(data.sys_metadata.map(row => text(row.sys_update_name)).filter(Boolean));
  const unresolvedNames = [...new Set(observedNames)].filter(name => !visibleNames.has(name)).sort();
  return {
    status: 'incomplete', categories,
    coverage: { complete: false, sources,
      upgrade_evidence: {
        skipped_rows_observed: data.sys_upgrade_history_log.length,
        update_names_observed: new Set(observedNames).size,
        resolved_by_lookup: observedNames.length ? resolution.coverage.resolved_names : 0,
        unresolved_update_names: unresolvedNames,
        lookup_failures: observedNames.length ? resolution.coverage.failed_chunks : 0,
      },
      unmatched_upgrade_records: data.sys_upgrade_history_log.filter(row => !visibleNames.has(text(row.file_name))).length,
      unmatched_customer_scopes: customerScopes.filter(id => !data.sys_scope.some(row => text(row.sys_id) === id || text(row.scope) === id)),
      limitations: ['Inventory covers visible sys_metadata and upgrade history only, not every customization mechanism.', `Upgrade history is read server-side for raw dispositions ${SKIP_DISPOSITIONS.join(' and ')} only; unmatched upgrade counts describe that filtered population, not all upgrade history.`, 'Coverage compares rows fetched with the Stats API count for the same query; a short page never implies exhaustion and an unavailable count leaves completeness unknown.', `The broad sys_metadata source is a bounded sample of an arbitrary sys_id-ordered slice, not an inventory, so unclassified and declared-customer categories only describe sampled artifacts. Skipped-upgrade artifacts are separate: they are resolved by the update names the filtered history read observed (${RESOLUTION_SOURCE}).`, 'Name resolution only looks up artifacts with skipped-upgrade evidence, so customizations with no upgrade-skip history are not discovered by it.', 'A resolved artifact can show a scope sys_id without a scope name when that scope record was outside the bounded sys_scope read.', 'Row/field ACL filtering and concurrent changes cannot be ruled out.', 'No current baseline, source payloads or dependency graph captured. Comparisons detect captured metadata/evidence changes only.', 'OOTB category means historical skipped-upgrade evidence, not a verified current deviation. Customer scopes are caller declarations.'],
    },
  };
}
