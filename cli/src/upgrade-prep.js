import { errUsage } from './errors.js';
import { App } from './app.js';
import { applySession } from './session.js';
import { quoteShellArg } from './helpers.js';
import { discoverSkippedUpdates, raw } from './skipped-updates.js';
import { fetchTableResult } from './commands/atf.js';
import { scanResults } from './scan.js';
import { getReport } from './customizations.js';
import { tableReadParams } from './table-read-params.js';

const fieldName = /^[a-z][a-z0-9_]*$/;
const idPattern = /^[0-9a-f]{32}$/i;
const value = (row, field) => raw(row?.[field]);
const timestamp = row => value(row, 'sys_updated_on') || value(row, 'sys_created_on') || null;
const fieldsMissing = (fields, rows) => fields.filter(field => rows.some(row => !Object.hasOwn(row, field)));
const safeFields = new Set(['sys_id', 'sys_updated_on', 'sys_created_on', 'name', 'number', 'state', 'status',
  'severity', 'priority', 'disposition', 'resolution_status', 'short_description', 'description',
  'upgrade_preview', 'preview', 'version', 'target_version', 'source', 'target', 'source_instance',
  'target_instance', 'requested', 'scheduled', 'started', 'completed', 'start_time', 'end_time',
  'table', 'condition', 'active', 'preserve', 'exclude', 'upgrade_history', 'test', 'test_suite',
  'type', 'result', 'percent_complete', 'message']);

export function validatePrep(argv) {
  if (!argv.profile && !argv.instance) throw errUsage('Upgrade preparation requires explicit --profile or --instance.');
  if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (argv.target !== undefined && (typeof argv.target !== 'string' || !argv.target.trim())) throw errUsage('--target must be nonempty.');
  for (const name of argv.relatedProfile || []) if (typeof name !== 'string' || !name) throw errUsage('Supply explicit related profile names.');
}

/** Only Table API GETs are exposed to collectors, including reused readers. */
export async function collectUpgradePrep(argv, app) {
  validatePrep(argv);
  app.requireInstance();
  const related = (argv.relatedProfile || []).map(name => {
    const profile = app.config.profiles[name];
    if (!profile?.instance_url) throw errUsage(`Unknown related profile: ${name}`);
    const relatedApp = new App(app.config);
    applySession(relatedApp, { profile: name });
    return { profile: name, instance: relatedApp.getEffectiveInstance(), sdk: relatedApp.sdk };
  });
  const report = { generated_at: new Date().toISOString(), status: 'incomplete', target: argv.target || null,
    target_basis: argv.target ? 'operator_selection_not_eligibility_guarantee' : 'not_selected',
    sources: [], findings: [], activities: [], limitations: [
      'Read-only preparation evidence, not a readiness certification or upgrade executor.',
      'Offered targets are local metadata, not a fresh eligibility guarantee. No future target is selected automatically.',
      'Last completed platform history is not the live node build. Historical skips are not predicted skips.',
      'Version suffixes are not security advisories. Store metadata is not target compatibility or purchase authorization.',
      'Missing retrieval evidence does not establish absence of backups. ATF/scan success does not establish UAT or coverage.',
      'All reads are bounded; timestamps and inaccessible fields require human review. No topology is inferred from profile names.',
    ] };
  const addFinding = (kind, status, source, detail, metadata = {}) => {
    const finding = { id: `finding-${report.findings.length + 1}`, kind, status,
      source_refs: source ? [source.id] : [], record_ids: metadata.record_ids || [], detail, ...metadata };
    report.findings.push(finding);
    return finding;
  };
  const activity = (kind, action, refs = [], dependencies = [], completion = '') => report.activities.push({
    id: `activity-${report.activities.length + 1}`, kind, status: 'pending', action,
    source_refs: refs, depends_on: dependencies, completion_check: completion,
  });
  async function collectContext(context, lower = false) {
    const { profile, instance } = context;
    function reference(table, params, id) {
      const fields = (params.get('sysparm_fields') || '').split(',').filter(Boolean);
      const query = params.get('sysparm_query') || '';
      const path = `/api/now/table/${table}${id ? `/${id}` : ''}`;
      const source = { id: `source-${report.sources.length + 1}`, profile: profile || null, instance, table,
        fields, encoded_query: query, requested_record_ids: id ? [id] : [], record_ids: [], observed_at: new Date().toISOString(), source_timestamps: [],
        bounds: { limit: Number(params.get('sysparm_limit')) || 1, offset: Number(params.get('sysparm_offset')) || 0,
          truncation: 'unknown' }, status: 'not_checked', method: 'GET', path, params: Object.fromEntries(params),
        read_command: `jsn records ${id ? `get --table ${table} --sys-id ${quoteShellArg(id)}` : `list --table ${table}`} --instance ${quoteShellArg(instance)}${profile ? ` --profile ${quoteShellArg(profile)}` : ''}${!id ? ` --query ${quoteShellArg(query)} --limit ${params.get('sysparm_limit') || 1} --offset ${params.get('sysparm_offset') || 0} --display-values ${params.get('sysparm_display_value') === 'all' ? 'both' : params.get('sysparm_display_value') === 'true' ? 'display' : 'raw'} --no-count` : ''}${fields.length ? ` --fields ${quoteShellArg(fields.join(','))}` : ''} --json` };
      report.sources.push(source);
      return source;
    }
    const sdk = Object.fromEntries(['list', 'listStrict', 'get'].map(method => [method, async (table, argument) => {
      if (!fieldName.test(table)) throw errUsage('Unsafe evidence table.');
      const params = method === 'get' ? new URLSearchParams() : tableReadParams(argument, context.sdk);
      const source = reference(table, params, method === 'get' ? argument : null);
      try {
        const result = await context.sdk[method === 'list' ? 'listStrict' : method](table, argument);
        const rows = Array.isArray(result) ? result : result ? [result] : [];
        source.records = rows;
        source.record_ids = rows.map(row => value(row, 'sys_id')).filter(Boolean);
        source.missing_fields = fieldsMissing(source.fields, rows);
        source.source_timestamps = rows.map(row => ({ sys_id: value(row, 'sys_id'), timestamp: timestamp(row) }));
        source.bounds.truncation = method === 'get' ? 'no' : rows.length >= source.bounds.limit ? 'possible' : 'no';
        source.status = rows.length ? 'observed' : 'missing';
        source.stale_record_ids = rows.filter(row => timestamp(row) && Date.parse(timestamp(row)) < Date.now() - 30 * 86400000).map(row => value(row, 'sys_id'));
        return result;
      } catch (error) {
        source.status = [401, 403].includes(error.status) ? 'inaccessible' : error.status === 404 ? 'missing' : 'error';
        source.http_status = error.status || null;
        // Do not expose transport messages, which can include credentials/URLs.
        throw error;
      }
    }]));
    async function read(table, fields, query = 'ORDERBYsys_id', limit = argv.limit) {
      try { return await sdk.listStrict(table, new URLSearchParams({ sysparm_fields: fields,
        sysparm_query: query, sysparm_limit: String(limit), sysparm_display_value: 'false' })); }
      catch { return []; }
    }
    const last = () => report.sources.at(-1);
    async function schema(table) {
      const rows = await read('sys_dictionary', 'sys_id,name,element,reference,sys_updated_on',
        `name=${table}^elementISNOTEMPTY^ORDERBYelement`, 200);
      return rows.map(row => value(row, 'element')).filter(field => fieldName.test(field));
    }
    async function dynamic(table, query) {
      const known = await schema(table);
      if (!known.length) {
        addFinding('schema_gap', last().status === 'observed' ? 'missing' : last().status, last(), `Readable dictionary fields for ${table} are incomplete; no data query attempted.`);
        return [];
      }
      const fields = [...new Set(['sys_id', ...known.filter(field => safeFields.has(field))])];
      const rows = await read(table, fields.join(','), query || 'ORDERBYsys_id');
      return rows;
    }
    if (lower) {
      for (const table of ['sys_update_set', 'sys_remote_update_set']) {
        const rows = await dynamic(table);
        addFinding('lower_environment_preservation', rows.length ? 'observed' : last().status, last(),
          `${table} evidence for explicitly related profile; retrieval is not a backup or proof of recoverability.`, { records: rows });
      }
      return;
    }
    await read('upgrade_center_metadata', 'sys_id,scheduled_version,upgrade_scheduled_on,end_of_life,near_end_of_life,sys_updated_on');
    const schedules = last();
    addFinding('scheduling', schedules.status, schedules, 'Recorded scheduling and lifecycle metadata only; blank schedules do not select an upgrade.');
    const targets = await read('upgrade_preview_version', 'sys_id,label,value,upgrade_center_metadata,sys_updated_on');
    const targetSource = last();
    addFinding('offered_targets', targetSource.status, targetSource, 'Locally offered platform targets; eligibility must be confirmed separately.', { records: targets });
    if (argv.target) {
      const matches = targets.filter(row => [value(row, 'sys_id'), value(row, 'value'), value(row, 'label')].includes(argv.target));
      addFinding('target_selection', matches.length === 1 ? 'observed' : 'missing', targetSource,
        matches.length === 1 ? 'Exact local target metadata match, not eligibility certification.' : 'Target was not uniquely observed in this bounded catalog.', { records: matches });
    }
    const history = await read('sys_upgrade_history', 'sys_id,from_version,to_version,upgrade_started,upgrade_finished,sys_updated_on',
      'to_versionSTARTSWITHglide^upgrade_finishedISNOTEMPTY^ORDERBYDESCupgrade_finished');
    addFinding('last_completed_platform_history', last().status, last(), 'Historical completed platform upgrade, not live node build.', { records: history.slice(0, 1) });
    const apps = await read('sys_store_app', 'sys_id,name,scope,version,latest_version,update_available,sys_updated_on',
      'update_available=true^NQlatest_versionISNOTEMPTY^ORDERBYsys_id');
    const storeSource = last();
    for (const row of apps) {
      // raw() stringifies scalar and reference values, including booleans.
      const flagValue = value(row, 'update_available');
      const flag = ['true', '1'].includes(flagValue) ? true : ['false', '0'].includes(flagValue) ? false : null;
      const readableVersion = field => {
        const fieldValue = row[field]?.value ?? row[field];
        return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue : '';
      };
      const installed = readableVersion('version'), latest = readableVersion('latest_version');
      if (flag === false && (!latest || latest === installed)) continue;
      const contradictory = Boolean(flag !== null && installed && latest && flag === (installed === latest));
      addFinding(contradictory ? 'store_metadata_conflict' : 'store_update_candidate', contradictory ? 'verified_problem' : flag === null ? 'missing' : 'observed', storeSource,
        contradictory ? 'Update flag contradicts recorded versions; verify catalog metadata before deciding.'
          : flag === null ? 'Update availability flag is missing or unrecognized; recorded versions are candidate evidence only, not a verified contradiction.'
            : 'Store update candidate; target compatibility remains unverified.',
        { record_ids: [value(row, 'sys_id')], record: row });
    }
    for (const table of ['upgrade_preview', 'upgrade_preview_log']) {
      const rows = await dynamic(table);
      const source = last();
      addFinding('existing_preview', source.status, source, 'Existing preview only; scope/target/time must be checked. Severity and priority are retained exactly, never inferred.', { records: rows });
      for (const row of rows.filter(row => ['severity', 'priority', 'disposition'].some(field => value(row, field)))) {
        addFinding('preview_finding', 'observed', source, 'Provider preview metadata requires operator triage; numeric priority is not interpreted as severity.',
          { record_ids: [value(row, 'sys_id')], metadata: Object.fromEntries(['severity', 'priority', 'disposition', 'resolution_status'].filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])) });
      }
    }
    try {
      const skipped = await discoverSkippedUpdates(sdk, { limit: argv.limit });
      addFinding('historical_skips', last().status, last(), 'Unresolved historical skipped updates whose base changed (Changed true), not predicted future skips.', { evidence: skipped });
    } catch { addFinding('historical_skips', last()?.status || 'error', last(), 'Historical skip reader could not establish valid unresolved evidence.'); }
    const cloneTables = await read('sys_db_object', 'sys_id,name,label,sys_updated_on', 'nameLIKEclone^ORDERBYname', 5);
    for (const row of cloneTables.slice(0, 4)) {
      const table = value(row, 'name');
      if (!fieldName.test(table)) continue;
      const rows = await dynamic(table);
      addFinding('clone_evidence', last().status, last(), `Dictionary-established ${table}; role and relation to this upgrade need operator confirmation.`, { records: rows });
    }
    if (!cloneTables.length) addFinding('clone_gap', last().status, last(), 'Clone requests/history/preservers/exclusions were not established. Ask an administrator for readable schema and recovery evidence.');
    for (const table of ['sys_atf_test_result', 'sys_atf_test_suite_result']) {
      const rows = await read(table, 'sys_id,sys_created_on,sys_updated_on', 'ORDERBYDESCsys_created_on', Math.min(argv.limit, 3));
      for (const row of rows) if (idPattern.test(value(row, 'sys_id'))) {
        try {
          const firstSource = report.sources.length;
          const evidence = await fetchTableResult({ sdk }, value(row, 'sys_id'));
          addFinding('existing_atf', evidence?.status === 'failed' ? 'verified_problem' : evidence ? 'observed' : 'missing', last(), 'Existing ATF result; reader may infer status. Verify scope, timestamp, target relevance and business coverage.',
            { evidence, source_refs: report.sources.slice(firstSource).map(source => source.id) });
        } catch { /* Exact failed read is retained in sources. */ }
      }
    }
    const scans = await read('sys_execution_tracker', 'sys_id,type,sys_created_on,sys_updated_on', 'type=instance_scan^ORDERBYDESCsys_created_on', Math.min(argv.limit, 3));
    for (const row of scans) if (idPattern.test(value(row, 'sys_id'))) {
      try {
        const firstSource = report.sources.length;
        const evidence = await scanResults(sdk, value(row, 'sys_id'), argv.limit);
        addFinding('existing_scan', evidence.findings.length ? 'verified_problem' : evidence.incomplete ? 'missing' : 'observed', last(), 'Existing scan result only; inspect target scope/time and incomplete evidence.',
          { evidence, source_refs: report.sources.slice(firstSource).map(source => source.id) });
      } catch { /* Exact failed read is retained in sources. */ }
    }
  }
  await collectContext({ profile: argv.profile || null, instance: app.getEffectiveInstance(), sdk: app.sdk });
  for (const context of related) await collectContext(context, true);
  if (!related.length) addFinding('lower_environment_preservation', 'not_checked', null,
    'No related profiles supplied. Provide --related-profile explicitly to inspect lower-environment update-set preservation/retrieval; topology is not inferred.');
  if (argv.customizations) {
    const capture = getReport(argv.customizations);
    if (!capture || capture.instance !== app.getEffectiveInstance()) throw errUsage('Customization capture must exist and match the selected instance exactly.');
    addFinding('customization_capture', 'observed', null, 'Existing local customization capture; assess age and bounds before reuse.', { evidence: capture });
  } else addFinding('customization_capture', 'not_checked', null, 'Supply --customizations with an existing local capture; no capture is persisted by this briefing.');
  for (const source of report.sources) {
    if (source.missing_fields?.length) addFinding('unreadable_fields', 'missing', source,
      'Requested fields were absent in returned records; absent fields are not blank values.', { fields: source.missing_fields });
    if (source.stale_record_ids?.length) addFinding('stale_evidence', 'stale', source, 'Records older than 30 days; revalidate relevance, not necessarily invalid.', { record_ids: source.stale_record_ids });
    if (source.bounds.truncation !== 'no') addFinding('bounded_evidence', 'missing', source, 'Evidence may be truncated; paginate this exact read before drawing absence conclusions.');
    if (['missing', 'inaccessible', 'error'].includes(source.status) || source.missing_fields?.length
      || source.stale_record_ids?.length || source.bounds.truncation !== 'no') {
      activity('evidence_gap', 'Obtain readable, current, completely paginated evidence or document why unavailable.',
        [source.id], [], 'Rerun exact GET; resolve absent fields, revalidate old records and record complete bounds.');
    }
  }
  activity('preserve_workflows', 'Inventory customizations, lower-environment update sets, clone preservation/exclusions and recovery ownership before a technical upgrade.',
    report.sources.filter(s => /update_set|clone|upgrade_history/.test(s.table)).map(s => s.id), [], 'Owners verify preservation and retrieval evidence; absence of retrieval is not absence of backups.');
  activity('technical_upgrade_review', 'Review exact platform/Store targets and preview dispositions with owners; preserve existing workflows where supported.',
    report.sources.filter(s => /upgrade|store/.test(s.table)).map(s => s.id), ['activity-' + report.activities.length], 'Document chosen targets, compatibility, unavoidable behavior changes and resolved preview decisions.');
  const technicalReviewId = report.activities.at(-1).id;
  for (const [kind, action, completion] of [
    ['release_changes', 'Obtain official target-specific deprecations, migrations, security advisories and default changes; never infer them from a version suffix.', 'Owners cite authoritative release documentation and validate affected workflows.'],
    ['recovery', 'Validate backups, restore rehearsal, downtime, rollback decision points and accountable owners.', 'Recovery owner records tested procedure and acceptable recovery point/time.'],
    ['uat', 'Define integration regression scope and business-owner UAT; map existing ATF/scan evidence to that scope.', 'Owners sign off representative workflows and document uncovered scope.'],
    ['optional_activation', 'Plan controlled later optional feature activation separately from technical upgrade; identify unavoidable changes first.', 'Feature owners approve opt-in rollout, testing and rollback separately.'],
  ]) activity(kind, action, [], kind === 'optional_activation' ? [technicalReviewId] : [], completion);
  return report;
}

function findingSummary(finding) {
  const parts = [`${finding.id} [${finding.status}] ${finding.kind}: ${finding.detail}`,
    `(${finding.source_refs.join(', ') || 'human/local evidence'})`];
  if (finding.record) {
    const row = finding.record;
    parts.push(`${value(row, 'name')}: installed=${value(row, 'version')} catalog=${value(row, 'latest_version')} update_available=${value(row, 'update_available')}`);
  }
  if (finding.metadata) parts.push(JSON.stringify(finding.metadata));
  if (finding.records?.length) {
    const row = finding.records[0];
    parts.push(`Observed records: ${finding.records.length}; first=${value(row, 'label') || value(row, 'name') || value(row, 'to_version') || value(row, 'sys_id')}`);
  }
  return parts.join(' ');
}

export function prepSummary(report) {
  return ['Upgrade preparation — incomplete evidence, not readiness certification',
    `Target: ${report.target || 'not selected (discovery only)'}`,
    `Sources: ${report.sources.length}; findings: ${report.findings.length}; activities: ${report.activities.length}`,
    ...report.findings.map(findingSummary),
    ...report.activities.map(a => `${a.id}: ${a.action} Completion: ${a.completion_check}`),
    'Use --json or --get data.sources for exact GET provenance and bounds.'].join('\n');
}
