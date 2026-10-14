// Read-only metadata inventory. Upgrade skips are historical evidence, not a
// current baseline diff. Scope ownership must be declared, never inferred.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getVersion } from './commands/version.js';

const SOURCES = {
  sys_scope: 'sys_id,name,scope,sys_class_name',
  sys_metadata: 'sys_id,sys_name,sys_class_name,sys_scope,sys_update_name,sys_updated_on',
  sys_upgrade_history_log: 'sys_id,name,disposition,resolution_status,sys_updated_on',
};
const value = v => v && typeof v === 'object' ? v.value ?? '' : v ?? '';
const text = v => String(value(v));

async function readSource(sdk, table, fields, pageSize, maxPages) {
  const rows = [];
  const seen = new Set();
  const coverage = { status: 'limited', fetched: 0, pages: 0, missing_identity: 0, reason: 'Page limit reached; remaining records unknown.' };
  try {
    for (let page = 0; page < maxPages; page++) {
      const batch = await sdk.list(table, {
        sysparm_fields: fields, sysparm_query: 'ORDERBYsys_id',
        sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true',
        sysparm_limit: String(pageSize), sysparm_offset: String(page * pageSize),
      }, { readOnly: true });
      coverage.pages++;
      if (!Array.isArray(batch)) throw new Error('Invalid table response');
      let duplicate = false;
      for (const row of batch) {
        const id = text(row.sys_id);
        if (!id) { coverage.missing_identity++; continue; }
        if (seen.has(id)) { duplicate = true; continue; }
        seen.add(id);
        rows.push(row);
        const required = table === 'sys_metadata' ? ['sys_class_name', 'sys_scope', 'sys_update_name'] : table === 'sys_scope' ? ['scope'] : ['name', 'disposition', 'resolution_status'];
        if (required.some(field => !Object.hasOwn(row, field))) coverage.missing_identity++;
      }
      coverage.fetched = rows.length;
      if (duplicate) { coverage.status = 'unstable'; coverage.reason = 'Repeated identities across pages; pagination may be ignored or records changed during capture.'; break; }
      if (batch.length < pageSize) {
        coverage.status = coverage.missing_identity ? 'missing_fields' : 'exhausted';
        coverage.reason = coverage.missing_identity ? 'Some records omitted identity or classification fields; field ACLs or malformed responses may hide evidence.' : 'Visible result exhausted. Row and field ACL filtering cannot be ruled out.';
        break;
      }
    }
  } catch (error) {
    coverage.status = /401|403|permission|forbidden|access denied/i.test(String(error?.message)) ? 'permission_denied' : 'unavailable';
    coverage.reason = 'Table read failed; partial results retained. Authentication, ACLs, table availability or network access may limit coverage.';
  }
  return { rows, coverage };
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
  return { baseline_run_id: baseline.run_id, new_run_id: newer.run_id, instance: baseline.instance, status: 'incomplete', additions, removals, changes,
    coverage: { baseline: baseline.coverage, new: newer.coverage },
    unknowns: ['Additions/removals mean newly observed/no longer observed, not proven creation/deletion. ACLs, limits and concurrent changes can affect visibility.', 'Only captured metadata and evidence are compared, not full artifact content or OOTB baselines.', 'Ownership declarations, scope visibility and evidence coverage can cause category changes without an artifact change.'] };
}

export function formatReport(report) {
  const lines = [`Customization capture ${report.run_id}${report.label ? ` (${report.label})` : ''}`, `Instance: ${report.instance}`, `Status: ${report.status}`, '', 'COVERAGE'];
  for (const [source, coverage] of Object.entries(report.coverage.sources)) lines.push(`${source}: ${coverage.status}, ${coverage.fetched} fetched. ${coverage.reason}`);
  for (const limitation of report.coverage.limitations) lines.push(`Unknown: ${limitation}`);
  if (report.coverage.unmatched_customer_scopes.length) lines.push(`Unmatched customer declarations: ${report.coverage.unmatched_customer_scopes.join(', ')}`);
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
export function formatReportComparison(result) {
  const lines = [`Customization comparison: ${result.status}`, `Baseline: ${result.baseline_run_id}`, `New: ${result.new_run_id}`, ...result.unknowns];
  for (const kind of ['additions', 'removals', 'changes']) {
    lines.push('', `${kind.toUpperCase()} (${result[kind].length})`);
    for (const change of result[kind]) lines.push(`${change.id}: ${change.availability || 'captured metadata/evidence changed'}`);
  }
  for (const side of ['baseline', 'new']) for (const [table, source] of Object.entries(result.coverage[side].sources)) lines.push(`${side} ${table}: ${source.status}, ${source.fetched} fetched. ${source.reason}`);
  return lines.join('\n') + '\n';
}

export async function captureCustomizations({ sdk, customerScopes = [], pageSize = 100, maxPages = 10 }) {
  if (!sdk) throw new Error('An authenticated SDK is required');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('pageSize must be 1..1000 and maxPages 1..100');
  const sources = {};
  const data = {};
  for (const [table, fields] of Object.entries(SOURCES)) {
    const result = await readSource(sdk, table, fields, pageSize, maxPages);
    sources[table] = result.coverage;
    data[table] = result.rows;
  }
  const scopes = new Map(data.sys_scope.map(row => [text(row.sys_id), row]));
  const declared = new Set(customerScopes);
  const logs = new Map();
  for (const row of data.sys_upgrade_history_log) {
    const name = text(row.name);
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
    const skipped = history.filter(log => Object.hasOwn(log, 'resolution_status') && text(log.disposition).toLowerCase() === 'skipped' && text(log.resolution_status).toLowerCase() !== 'reverted');
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
  const matchedLogs = new Set(data.sys_metadata.map(row => text(row.sys_update_name)).filter(Boolean));
  return {
    status: 'incomplete', categories,
    coverage: { complete: false, sources,
      unmatched_upgrade_records: data.sys_upgrade_history_log.filter(row => !matchedLogs.has(text(row.name))).length,
      unmatched_customer_scopes: customerScopes.filter(id => !data.sys_scope.some(row => text(row.sys_id) === id || text(row.scope) === id)),
      limitations: ['Inventory covers visible sys_metadata and upgrade history only, not every customization mechanism.', 'Row/field ACL filtering and concurrent changes cannot be ruled out.', 'No current baseline, source payloads or dependency graph captured. Comparisons detect captured metadata/evidence changes only.', 'OOTB category means historical skipped-upgrade evidence, not a verified current deviation. Customer scopes are caller declarations.'],
    },
  };
}
