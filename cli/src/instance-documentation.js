import fs from 'node:fs';
import path from 'node:path';
import { errUsage } from './errors.js';

const identity = /^[0-9a-f]{32}$/i;
const tableName = /^[a-z][a-z0-9_]*$/;
const common = ['sys_id', 'sys_scope', 'sys_package', 'sys_updated_on'];
const fields = {
  sys_scope: ['sys_id', 'name', 'scope', 'sys_class_name', 'sys_updated_on'],
  sys_db_object: [...common, 'name', 'label', 'super_class'],
  sys_dictionary: [...common, 'name', 'element', 'column_label', 'internal_type', 'reference', 'mandatory', 'read_only'],
  sys_script: [...common, 'name', 'collection', 'active', 'when', 'order', 'action_insert', 'action_update', 'action_delete', 'action_query'],
  sys_script_client: [...common, 'name', 'table', 'active', 'type', 'field', 'applies_extended'],
  sys_ui_policy: [...common, 'short_description', 'table', 'active', 'on_load', 'reverse_if_false'],
  sys_ui_action: [...common, 'name', 'table', 'active', 'action_name', 'client', 'form_button', 'list_button'],
  sys_script_include: [...common, 'name', 'api_name', 'access', 'active', 'client_callable'],
  sys_hub_flow: [...common, 'name', 'active'],
  sp_page: [...common, 'id', 'title'],
  sp_widget: [...common, 'id', 'name'],
  sp_container: [...common, 'name', 'sp_page', 'order'],
  sp_row: [...common, 'sp_container', 'order'],
  sp_column: [...common, 'sp_row', 'order'],
  sp_instance: [...common, 'title', 'sp_column', 'sp_widget', 'order'],
  sys_rest_message: [...common, 'name', 'active'],
  sys_soap_message: [...common, 'name', 'active'],
  sysauto_script: [...common, 'name', 'active', 'run_type'],
};
const labels = { sys_db_object: 'Tables', sys_dictionary: 'Fields', sys_script: 'Business rules', sys_script_client: 'Client scripts', sys_ui_policy: 'UI policies', sys_ui_action: 'UI actions', sys_script_include: 'Script Includes', sys_hub_flow: 'Flows', sp_page: 'Portal pages', sp_widget: 'Portal widgets', sp_container: 'Portal containers', sp_row: 'Portal rows', sp_column: 'Portal columns', sp_instance: 'Widget instances', sys_rest_message: 'REST integrations', sys_soap_message: 'SOAP integrations', sysauto_script: 'Scheduled automation' };
export const DOCUMENT_BUDGETS = {
  pageSize: [25, 1, 100], discoveryPages: [2, 1, 5], applications: [3, 1, 6], detailPages: [1, 1, 3], maxRequests: [96, 1, 200],
};
const raw = input => {
  const value = input && typeof input === 'object' ? input.value : input;
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value).slice(0, 512) : null;
};
const sort = rows => rows.sort((a, b) => String(a.sys_id).localeCompare(String(b.sys_id), 'en'));
const safeIds = rows => [...new Set(rows.map(row => row.sys_id).filter(value => identity.test(value || '')))];

export function validateDocument(argv) {
  if (typeof argv.profile !== 'string' || !argv.profile.trim()) throw errUsage('Instance documentation requires explicit --profile.');
  if (argv.instance) throw errUsage('Use --profile without --instance for instance documentation.');
  const budgets = {};
  for (const [name, [fallback, min, max]] of Object.entries(DOCUMENT_BUDGETS)) {
    const n = argv[name] ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw errUsage(`Invalid ${name}: use an integer from ${min} to ${max}.`);
    budgets[name] = n;
  }
  if (argv.output !== undefined) {
    if (typeof argv.output !== 'string' || !argv.output.trim()) throw errUsage('--output must name a new file.');
    try { fs.lstatSync(argv.output); throw errUsage('--output already exists; refusing to overwrite.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!fs.statSync(path.dirname(path.resolve(argv.output))).isDirectory()) throw errUsage('--output parent must be a directory.');
  }
  return budgets;
}

/** A namespace string never establishes ownership. Missing/unknown references stay unresolved. */
export function documentOwner(row, candidates) {
  if (!Object.hasOwn(row, 'sys_scope') || !Object.hasOwn(row, 'sys_package') || row.sys_scope === null || row.sys_package === null) return { kind: 'unresolved', reason: 'missing_ownership_fields' };
  const refs = [row.sys_scope, row.sys_package].filter(ref => ref && ref !== 'global');
  if (refs.some(ref => !candidates.some(c => c.identity === ref))) return { kind: 'unresolved', reason: 'unknown_ownership_reference' };
  if (new Set(refs).size > 1) return { kind: 'unresolved', reason: 'conflicting_ownership_references' };
  return refs.length ? { kind: 'application', identity: refs[0] } : { kind: 'unassigned-global' };
}

export async function collectInstanceDocumentation(argv, app) {
  const budgets = validateDocument(argv);
  app.requireInstance();
  const evidence = { schema_version: 1, profile: argv.profile, observed_at: new Date().toISOString(), status: 'incomplete',
    release_identity: 'unknown', customization_evidence: 'not_collected', budgets, requests_used: 0,
    candidates: [], applications: [], global_candidates: [], global_details: [], unresolved: [], sources: [], portal_relations: [],
    limitations: ['Bounded configuration metadata, not execution, customer authorship, baseline differences or effective access.',
      'Completeness is unknown. No provider count was collected; short or empty pages do not prove absence.',
      'Scripts, conditions, defaults, URLs, credentials, bodies, business records and execution telemetry are not collected.',
      'Instance release/build identity and existing customization evidence were not collected.',
      'Inherited behavior, flow internals, nested portal rows, catalog configuration and standalone/OOTB changes remain gaps.'] };
  // Every Table API call, including schema discovery, passes this budget and strict reader.
  async function read(table, query, pages = budgets.detailPages, requestedFields = fields[table]) {
    const rows = [], seen = new Set();
    for (let page = 0; page < pages; page++) {
      const source = { id: `source-${evidence.sources.length + 1}`, resource: `/api/now/table/${table}`, table, method: 'GET',
        fields: [...requestedFields], query, observed_at: new Date().toISOString(),
        bounds: { limit: budgets.pageSize, offset: page * budgets.pageSize, page: page + 1, max_pages: pages },
        count: null, continuation: 'unknown', completeness: 'unknown', status: 'not_collected', reasons: [], records: [] };
      evidence.sources.push(source);
      if (evidence.requests_used >= budgets.maxRequests) { source.status = 'truncated'; source.reasons.push('request_budget'); break; }
      evidence.requests_used++;
      try {
        const result = await app.sdk.listStrict(table, new URLSearchParams({ sysparm_fields: requestedFields.join(','), sysparm_query: query,
          sysparm_limit: String(budgets.pageSize), sysparm_offset: String(source.bounds.offset), sysparm_display_value: 'false' }));
        source.count = result.length;
        source.continuation = result.length >= budgets.pageSize ? 'possible' : 'unknown';
        source.status = 'observed';
        if (result.length >= budgets.pageSize && page + 1 === pages) { source.status = 'truncated'; source.reasons.push('page_budget'); }
        if (result.length > budgets.pageSize) source.reasons.push('provider_over_return');
        const missing = new Set();
        for (const input of result.slice(0, budgets.pageSize)) {
          const row = Object.fromEntries(requestedFields.filter(field => {
            if (!Object.hasOwn(input || {}, field)) { missing.add(field); return false; } return true;
          }).map(field => [field, raw(input[field])]));
          source.records.push(row);
          if (!row.sys_id || seen.has(row.sys_id)) { source.reasons.push(row.sys_id ? 'duplicate_record' : 'missing_record_identity'); continue; }
          seen.add(row.sys_id); rows.push({ ...row, source: source.id });
        }
        source.missing_fields = [...missing].sort();
        if (missing.size) { source.reasons.push('missing_fields'); if (source.status === 'observed') source.status = 'missing-fields'; }
        if (!result.length) source.reasons.push('empty_page_not_completeness_proof');
      } catch (error) {
        if (error.status === 403) { source.status = 'denied'; source.reasons.push('http_403'); }
        else if (error.status === 404 || error.code === 'malformed_response') { source.status = 'unavailable'; source.reasons.push(error.status === 404 ? 'http_404' : 'malformed_response'); }
        else throw error;
        break;
      }
    }
    return sort(rows);
  }
  const hierarchy = await read('sys_db_object', 'nameINsys_app,sys_scope,sys_package^ORDERBYsys_id');
  const ownership = await read('sys_dictionary', 'name=sys_metadata^elementINsys_scope,sys_package^ORDERBYsys_id', 1, ['sys_id', 'name', 'element', 'reference']);
  const scopeClass = hierarchy.find(r => r.name === 'sys_scope'), packageClass = hierarchy.find(r => r.name === 'sys_package');
  const validIdentitySchema = scopeClass && packageClass && hierarchy.some(r => r.name === 'sys_app' && r.super_class === scopeClass.sys_id)
    && scopeClass.super_class === packageClass.sys_id && [['sys_scope', 'sys_scope'], ['sys_package', 'sys_package']].every(([element, reference]) => ownership.some(r => r.element === element && r.reference === reference));
  if (!validIdentitySchema) { evidence.limitations.push('Identity schema not established; dependent application and Global discovery refused.'); return evidence; }
  const discovered = await read('sys_scope', 'ORDERBYsys_id', budgets.discoveryPages);
  evidence.candidates = discovered.filter(row => identity.test(row.sys_id || '')).map(row => ({ identity: row.sys_id, name: row.name || 'Unnamed application', namespace: row.scope ?? 'unknown', class: row.sys_class_name ?? 'unknown', source: row.source, selected: false,
    provenance: 'Observed application record; class and Store status do not prove customer authorship.' }));
  const globalApps = evidence.candidates.filter(c => c.namespace === 'global'), scopedApps = evidence.candidates.filter(c => c.namespace !== 'global');
  const selected = [...globalApps.slice(0, 1), ...scopedApps.slice(0, 1), ...evidence.candidates].filter((c, index, list) => list.findIndex(x => x.identity === c.identity) === index).slice(0, budgets.applications);
  for (const candidate of selected) candidate.selected = true;
  const classify = (records, expected, allowDirect = false) => records.filter(record => {
    const owner = documentOwner(record, evidence.candidates);
    if (owner.kind === 'unresolved') { evidence.unresolved.push({ record, ...owner }); return false; }
    return expected ? owner.identity === expected || allowDirect && owner.kind === 'unassigned-global' : owner.kind === 'unassigned-global';
  });
  const portalSchema = await read('sys_dictionary', 'nameINsp_container,sp_row,sp_column,sp_instance^ORDERBYsys_id', 1, ['sys_id', 'name', 'element', 'reference']);
  const portalContracts = [['sp_container', 'sp_page', 'sp_page'], ['sp_row', 'sp_container', 'sp_container'], ['sp_column', 'sp_row', 'sp_row'], ['sp_instance', 'sp_column', 'sp_column'], ['sp_instance', 'sp_widget', 'sp_widget']];
  const portalVerified = portalContracts.every(([name, element, reference]) => portalSchema.some(r => r.name === name && r.element === element && r.reference === reference));
  if (!portalVerified) evidence.limitations.push('Portal reference schema not established; composition collection refused.');
  for (const candidate of selected) {
    const application = { ...candidate, sections: {}, portal_relations: [] };
    evidence.applications.push(application);
    const query = `sys_scope=${candidate.identity}^ORsys_package=${candidate.identity}`;
    const tables = classify(await read('sys_db_object', `${query}^ORDERBYsys_id`), candidate.identity);
    application.sections.sys_db_object = tables;
    const names = [...new Set(tables.map(t => t.name).filter(n => tableName.test(n || '')))];
    for (const table of ['sys_script', 'sys_script_client', 'sys_ui_policy', 'sys_ui_action', 'sys_script_include', 'sys_hub_flow', 'sp_page', 'sp_widget', 'sys_rest_message', 'sys_soap_message', 'sysauto_script']) {
      const target = table === 'sys_script' ? 'collection' : ['sys_script_client', 'sys_ui_policy', 'sys_ui_action'].includes(table) ? 'table' : null;
      const selector = target && names.length ? `${query}^OR${target}IN${names.join(',')}` : query;
      const records = classify(await read(table, `${selector}^ORDERBYsys_id`), candidate.identity, Boolean(target));
      application.sections[table] = records.filter(row => !target || documentOwner(row, evidence.candidates).identity === candidate.identity || names.includes(row[target]));
    }
    application.sections.sys_dictionary = names.length ? classify(await read('sys_dictionary', `nameIN${names.join(',')}^ORDERBYsys_id`), candidate.identity, true) : [];
    if (portalVerified && application.sections.sp_page.length) {
      let parents = application.sections.sp_page;
      for (const [table, field] of portalContracts.slice(0, 4)) {
        const ids = safeIds(parents);
        const records = ids.length ? classify(await read(table, `${field}IN${ids.join(',')}^ORDERBYsys_id`), candidate.identity, true).filter(r => ids.includes(r[field])) : [];
        application.sections[table] = records; parents = records;
      }
      const widgetIds = [...new Set((application.sections.sp_instance || []).map(r => r.sp_widget).filter(v => identity.test(v || '')))];
      if (widgetIds.length) application.sections.sp_widget = classify(await read('sp_widget', `sys_idIN${widgetIds.join(',')}^ORDERBYsys_id`), candidate.identity, true).filter(r => widgetIds.includes(r.sys_id));
      for (const instance of application.sections.sp_instance || []) {
        const column = application.sections.sp_column.find(r => r.sys_id === instance.sp_column);
        const row = application.sections.sp_row.find(r => r.sys_id === column?.sp_row);
        const container = application.sections.sp_container.find(r => r.sys_id === row?.sp_container);
        const page = application.sections.sp_page.find(r => r.sys_id === container?.sp_page);
        const widget = application.sections.sp_widget.find(r => r.sys_id === instance.sp_widget);
        if (page && widget) {
          const relation = { application: candidate.identity, page: page.sys_id, widget: widget.sys_id,
            page_title: page.title || page.id, widget_name: widget.name || widget.id,
            path: [page, container, row, column, instance, widget].map(r => ({ sys_id: r.sys_id, source: r.source })), schema_sources: [...new Set(portalSchema.map(r => r.source))] };
          evidence.portal_relations.push(relation); application.portal_relations.push(relation);
        }
      }
    }
  }
  const leads = await read('sys_db_object', 'sys_scope=global^nameSTARTSWITHu_^ORDERBYsys_id');
  evidence.global_candidates = classify(leads).filter(r => r.name?.startsWith('u_'));
  for (const lead of evidence.global_candidates.slice(0, 2)) {
    if (!tableName.test(lead.name)) continue;
    const detail = { table: lead, sections: {} };
    evidence.global_details.push(detail);
    for (const [table, field] of [['sys_dictionary', 'name'], ['sys_script', 'collection'], ['sys_script_client', 'table'], ['sys_ui_policy', 'table'], ['sys_ui_action', 'table']]) detail.sections[table] = classify(await read(table, `${field}=${lead.name}^ORDERBYsys_id`)).filter(r => r[field] === lead.name);
  }
  return evidence;
}

// Numeric entities prevent Markdown/HTML/autolink syntax from metadata labels.
const md = value => String(value ?? 'unknown').replace(/[^\p{L}\p{N} \n]/gu, char => `&#${char.codePointAt(0)};`).replace(/[\r\n]/g, ' ');
// Mermaid uses only generated identifiers and an inert, bounded label alphabet.
const mermaid = value => String(value ?? 'unknown').replace(/[^\p{L}\p{N} ]/gu, ' ').slice(0, 100);
export function renderInstanceDocumentation(evidence) {
  const lines = ['# Instance configuration documentation', '', `Profile: ${md(evidence.profile)}. Observed: ${md(evidence.observed_at)}.`, '',
    'Release/build identity: unknown. Coverage: incomplete.', '', ...evidence.limitations.map(text => `- ${md(text)}`), '', '## Application discovery', '',
    '| Application | Namespace | Exact identity | Detail |', '| --- | --- | --- | --- |'];
  for (const c of evidence.candidates) lines.push(`| ${md(c.name)} | ${md(c.namespace)} | ${md(c.identity)} | ${c.selected ? 'selected' : 'deferred by budget'} |`);
  const section = (table, rows) => {
    lines.push(`### ${labels[table] || table}`, '');
    if (!rows.length) { lines.push('No rows established in this bounded collection. See source receipts.', ''); return; }
    const columns = fields[table].filter(f => !['sys_scope', 'sys_package'].includes(f));
    lines.push(`| ${columns.join(' | ')} | Source |`, `| ${columns.map(() => '---').join(' | ')} | --- |`);
    for (const row of rows) lines.push(`| ${columns.map(c => md(row[c])).join(' | ')} | ${md(row.source)} |`);
    lines.push('');
  };
  for (const app of evidence.applications) {
    lines.push(`## ${md(app.name)} ${app.namespace === 'global' ? 'Global application' : 'application'}`, '',
      'Exact ownership and configured target metadata only. No execution or customer-authorship claim.', '');
    for (const [table, rows] of Object.entries(app.sections)) section(table, rows);
    if (app.portal_relations.length) {
      lines.push('### Verified portal page to widget references', '', '```mermaid', 'flowchart LR');
      app.portal_relations.slice(0, 20).forEach((r, i) => lines.push(`  p${i}["${mermaid(r.page_title)}"] -->|configured composition| w${i}["${mermaid(r.widget_name)}"]`));
      lines.push('```', '', 'Collapsed exact-reference paths only. Layout children remain in supporting tables. At most 20 relations drawn.', '');
    }
  }
  lines.push('## Unassigned Global development candidates', '', 'Custom-named table leads only, not proof of customer authorship or baseline changes. Named Global applications are separate.', '');
  section('sys_db_object', evidence.global_candidates);
  for (const detail of evidence.global_details) { lines.push(`### ${md(detail.table.label || detail.table.name)}`, ''); for (const [table, rows] of Object.entries(detail.sections)) section(table, rows); }
  lines.push('## Unresolved ownership', '', `${evidence.unresolved.length} returned records have unresolved ownership. Full projected references and reasons remain in JSON.`, '', '## Source receipts', '',
    `Table requests used: ${evidence.requests_used}/${evidence.budgets.maxRequests}. Provider counts not collected. Completeness unknown.`, '');
  for (const source of evidence.sources) lines.push(`### ${source.id}`, '',
    `Resource: ${md(source.resource)}. Method: GET. Status: ${source.status}. Reasons: ${md(source.reasons.join(', ') || 'none')}.`,
    `Fields: ${md(source.fields.join(', '))}. Query: ${md(source.query)}.`,
    `Observed: ${md(source.observed_at)}. Limit: ${source.bounds.limit}, offset: ${source.bounds.offset}, count: ${source.count ?? 'unknown'}, continuation: ${source.continuation}. Completeness unknown.`, '');
  return lines.join('\n') + '\n';
}

export function writeDocumentFile(destination, markdown) {
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, markdown, 'utf8'); } finally { fs.closeSync(fd); }
}
