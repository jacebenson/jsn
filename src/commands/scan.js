import { buildRecordPayload, confirmDelete, getStringField, quoteShellArg, verifyWriteBack } from '../helpers.js';
import { createRecord, updateRecord, deleteRecord } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { getCurrentApplication, getCurrentUser } from '../context.js';
import { declareCapabilities } from '../capabilities.js';
import { errAPI, errUsage } from '../errors.js';
import { CHECK_TABLES, active, raw, referenceId, boundedLimit, scanList, resolveScanRecord,
  validateScanPayload, checkKind, prepareScan, startScan, scanStatus, scanResults, cancelScan } from '../scan.js';

declareCapabilities('scan', { mutationSubcommands: [
  ...['checks', 'suites'].flatMap(group => ['create', 'update', 'delete', 'activate', 'deactivate'].map(verb => `${group} ${verb}`)),
  'suites add-check', 'suites remove-check', 'run', 'cancel',
] });

const hint = (action, cmd, description) => ({ action, cmd, description });
function report(app, argv, data, options) {
  const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}`
    : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
  app.ok(data, { ...options, breadcrumbs: options.breadcrumbs.map(item => ({ ...item, cmd: item.cmd + connection })) });
}
const rootHints = () => [hint('checks', 'jsn scan checks list', 'Browse available checks'),
  hint('suites', 'jsn scan suites list', 'Browse suites'), hint('run', 'jsn scan run --help', 'Choose an explicit scan target')];
const itemHints = (group, record) => {
  const id = unwrapSysId(record);
  return [hint('list', `jsn scan ${group} list`, `Browse ${group}`),
    hint('show', `jsn scan ${group} show ${id}`, 'Inspect this definition'),
    hint('update', `jsn scan ${group} update ${id} --data-file ${group === 'checks' ? 'check' : 'suite'}.json`, 'Update selected fields'),
    hint(active(record) ? 'deactivate' : 'activate', `jsn scan ${group} ${active(record) ? 'deactivate' : 'activate'} ${id}`, 'Change eligibility without starting a scan'),
    ...(group === 'suites' ? [hint('add-check', `jsn scan suites add-check ${id} --check '<check-id-or-name>'`, 'Add an existing check'),
      hint('run', `jsn scan run --suite ${id} --update-set '<update-set>'`, 'Run against an explicit update set')] :
      [hint('suites', 'jsn scan suites list', 'Choose a suite for this check')]),
    hint('delete', `jsn scan ${group} delete ${id}`, 'Delete this definition after confirmation')];
};

function executionHints(data) {
  const id = data.execution_id;
  return [hint('status', `jsn scan status ${id}`, 'Read execution progress'),
    hint('results', `jsn scan results ${id}`, 'Inspect findings and recorded check executions'),
    ...(!data.terminal ? [hint('cancel', `jsn scan cancel ${id}`, 'Request cancellation')] : []),
    ...(data.reusable_target ? [hint('rerun', `jsn scan run --previous ${id}${data.rerun_full ? ' --full' : ''}`, 'Rerun the previous target with current check definitions')] : []),
    hint('checks', 'jsn scan checks list', 'Review available checks')];
}

const payloadOptions = y => y.option('data', { type: 'string', describe: 'JSON fields' })
  .option('data-file', { type: 'string', describe: 'Read JSON fields from a file (recommended for scripts)' })
  .option('data-stdin', { type: 'boolean', describe: 'Read JSON fields from stdin' })
  .option('field', { alias: 'f', type: 'array', describe: 'Set field=value; repeatable' });
const lookupOptions = y => y.positional('identifier', { type: 'string', describe: 'Unique name or sys_id' });

async function guardScope(app, record) {
  const scopeId = referenceId(record.sys_scope) || raw(record.sys_scope);
  if (!scopeId) throw errUsage('The definition scope is unreadable; inspect permissions before changing it.');
  const user = await getCurrentUser(app.sdk);
  if (!user) throw errUsage('Could not verify the current scope.');
  const scope = await getCurrentApplication(app.sdk, user.sys_id, { unknownWhenMissing: true });
  if (scope.appSysId !== scopeId && scope.scope !== scopeId) {
    throw errUsage(`Select the definition scope before changing it: jsn scopes set ${quoteShellArg(scopeId)}`);
  }
}

async function verify(app, table, id, data) {
  if (!id) throw errAPI(200, 'The write returned no sys_id. Inspect the instance before retrying.');
  const mismatches = await verifyWriteBack(app, table, id, data);
  if (mismatches.length) throw errAPI(200, `Write-back verification failed for ${table}/${id}: ${mismatches.map(item => item.field).join(', ')}. The write may have succeeded partially; inspect before retrying.`);
}

function definitions(group, wrap) {
  const suite = group === 'suites';
  const baseTable = suite ? 'scan_check_suite' : 'scan_check';
  const emit = (app, argv, record, summary) => report(app, argv, record, { summary, breadcrumbs: itemHints(group, record) });
  return {
    command: `${group} [subcommand]`,
    describe: suite ? 'Manage scan suites and their check memberships' : 'Manage typed Instance Scan check definitions',
    builder: y => {
      y.command({ command: 'list', describe: `List ${group}`,
        builder: p => {
          p.option('query', { type: 'string', describe: 'Encoded query' })
            .option('limit', { type: 'number', default: 50, describe: 'Maximum records (1–200)' })
            .option('offset', { type: 'number', default: 0, describe: 'Pagination offset' });
          return suite ? p : p.option('type', { choices: Object.keys(CHECK_TABLES), type: 'string', describe: 'Filter by check type' });
        }, handler: wrap(async (argv, app) => {
          const table = suite ? baseTable : (argv.type ? CHECK_TABLES[argv.type] : baseTable);
          const records = await scanList(app.sdk, table, { limit: argv.limit, offset: argv.offset, query: argv.query,
            fields: ['sys_id', 'name', 'active', ...(suite ? ['description'] : ['sys_class_name', 'short_description'])] });
          report(app, argv, { table, records, count: records.length, limit: argv.limit, offset: argv.offset,
            more_available: records.length === argv.limit ? null : false }, {
            summary: `${records.length} scan ${group}`, breadcrumbs: [
              ...records.slice(0, 5).map(record => hint('show', `jsn scan ${group} show ${unwrapSysId(record)}`, `Inspect ${getStringField(record, 'name')}`)),
              hint('create', `jsn scan ${group} create${suite ? '' : ' --type table'} --data-file ${suite ? 'suite' : 'check'}.json`, 'Create an inactive definition'),
              ...(records.length === argv.limit ? [hint('next', `jsn scan ${group} list --offset ${argv.offset + argv.limit} --limit ${argv.limit}${argv.type ? ` --type ${argv.type}` : ''}${argv.query ? ` --query ${quoteShellArg(argv.query)}` : ''}`, 'Next page')] : []),
            ],
          });
        }) });
      y.command({ command: 'show <identifier>', describe: `Inspect a ${suite ? 'suite and its members' : 'check'}`, builder: lookupOptions,
        handler: wrap(async (argv, app) => {
          const record = await resolveScanRecord(app.sdk, baseTable, argv.identifier);
          if (suite) {
            const members = await scanList(app.sdk, 'scan_check_suite_check', { limit: 200, query: `suite=${unwrapSysId(record)}^ORDERBYsys_id`, fields: ['sys_id', 'check'] });
            record.members = members;
            record.members_may_be_truncated = members.length === 200;
          }
          emit(app, argv, record, `Scan ${suite ? 'suite' : 'check'}: ${getStringField(record, 'name')}`);
        }) });
      y.command({ command: 'create', describe: `Create an inactive ${suite ? 'suite' : 'typed check'} unless active is explicitly supplied`,
        builder: p => suite ? payloadOptions(p) : payloadOptions(p).option('type', { choices: Object.keys(CHECK_TABLES), type: 'string', demandOption: true, describe: 'Check type' }),
        handler: wrap(async (argv, app) => {
          const data = validateScanPayload(argv.type, buildRecordPayload(argv), { create: true, suite });
          const table = suite ? baseTable : CHECK_TABLES[argv.type];
          const record = await createRecord(app.sdk, { table, data });
          await verify(app, table, unwrapSysId(record), data);
          emit(app, argv, record, `Created scan ${suite ? 'suite' : 'check'}`);
        }) });
      for (const operation of ['update', 'activate', 'deactivate']) y.command({
        command: `${operation} <identifier>`, describe: `${operation} a scan ${suite ? 'suite' : 'check'} without running it`,
        builder: p => operation === 'update' ? payloadOptions(lookupOptions(p)) : lookupOptions(p),
        handler: wrap(async (argv, app) => {
          const record = await resolveScanRecord(app.sdk, baseTable, argv.identifier);
          const kind = suite ? null : checkKind(record);
          const patch = operation === 'update' ? validateScanPayload(kind, buildRecordPayload(argv), { suite, current: record }) : { active: operation === 'activate' };
          if (!suite && operation === 'activate') validateScanPayload(kind, {
            name: raw(record.name), script: raw(record.script), ...(kind === 'table' ? { table: raw(record.table), advanced: raw(record.advanced) } : {}),
            ...(kind === 'column' ? { column_type: raw(record.column_type) } : {}),
          }, { create: true });
          await guardScope(app, record);
          const table = suite ? baseTable : CHECK_TABLES[kind];
          const updated = await updateRecord(app.sdk, { table, record, data: patch });
          await verify(app, table, unwrapSysId(record), patch);
          emit(app, argv, updated, `Updated scan ${suite ? 'suite' : 'check'}`);
        }),
      });
      y.command({ command: 'delete <identifier>', describe: `Delete a ${suite ? 'suite' : 'check'} definition after confirmation`, builder: lookupOptions,
        handler: wrap(async (argv, app) => {
          const record = await resolveScanRecord(app.sdk, baseTable, argv.identifier);
          await guardScope(app, record);
          await confirmDelete(app, argv, `Delete scan ${suite ? 'suite' : 'check'} "${getStringField(record, 'name')}"?`);
          const id = await deleteRecord(app.sdk, { table: suite ? baseTable : CHECK_TABLES[checkKind(record)], record });
          report(app, argv, { sys_id: id, deleted: true }, { summary: 'Deleted scan definition', breadcrumbs: [hint('list', `jsn scan ${group} list`, 'Browse remaining definitions')] });
        }) });
      if (suite) for (const operation of ['add-check', 'remove-check']) y.command({
        command: `${operation} <identifier>`, describe: `${operation === 'add-check' ? 'Add a check to' : 'Remove a check from'} a suite`,
        builder: p => lookupOptions(p).option('check', { type: 'string', demandOption: true, describe: 'Check name or sys_id' }),
        handler: wrap(async (argv, app) => {
          const suiteRecord = await resolveScanRecord(app.sdk, baseTable, argv.identifier);
          const check = await resolveScanRecord(app.sdk, 'scan_check', argv.check);
          await guardScope(app, suiteRecord);
          const data = { suite: unwrapSysId(suiteRecord), check: unwrapSysId(check) };
          const table = 'scan_check_suite_check';
          const members = await scanList(app.sdk, table, { query: `suite=${data.suite}^check=${data.check}`, limit: 2 });
          if (members.length > 1) throw errUsage('Duplicate suite memberships exist; inspect and reconcile them before changing membership.');
          let changed = false;
          if (operation === 'add-check' && !members.length) {
            const member = await createRecord(app.sdk, { table, data });
            await verify(app, table, unwrapSysId(member), data);
            changed = true;
          } else if (operation === 'remove-check' && members.length) {
            await confirmDelete(app, argv, 'Remove this check from the suite? The check definition will be retained.');
            await deleteRecord(app.sdk, { table, record: members[0] });
            changed = true;
          }
          report(app, argv, { ...data, changed, member: operation === 'add-check' }, { summary: 'Suite membership reconciled', breadcrumbs: itemHints(group, suiteRecord) });
        }),
      });
      return y;
    },
    handler: wrap(async (argv, app) => report(app, argv, { commands: ['list', 'show', 'create', 'update', 'delete', 'activate', 'deactivate', ...(suite ? ['add-check', 'remove-check'] : [])] }, {
      summary: `Scan ${group}`, breadcrumbs: [hint('list', `jsn scan ${group} list`, `Browse ${group}`)],
    })),
  };
}

export function scanCmd(wrap) {
  return {
    command: 'scan [subcommand]', describe: 'Instance Scan checks, suites, explicit targets, progress and findings',
    builder: y => y.command(definitions('checks', wrap)).command(definitions('suites', wrap))
      .command({ command: 'run', describe: 'Start an explicit target scan (confirmation required; no implicit full scan)',
        builder: p => p.option('update-set', { type: 'string', describe: 'Update set name or sys_id; scans current records' })
          .option('scope', { type: 'string', describe: 'Application scope value or sys_id' })
          .option('record', { type: 'string', describe: 'Record sys_id; requires --table' })
          .option('table', { type: 'string', describe: 'Table for --record' })
          .option('full', { type: 'boolean', describe: 'Explicitly allow an instance-wide scan' })
          .option('previous', { type: 'string', describe: 'Rerun a previous execution target; full scans also require --full' })
          .option('suite', { type: 'string', describe: 'Optional active suite name or sys_id' })
          .option('wait', { type: 'boolean', default: false, describe: 'Wait for completion; timeout does not cancel the scan' })
          .option('timeout', { type: 'number', default: 120, describe: 'Maximum wait in seconds (1–3600)' }),
        handler: wrap(async (argv, app) => {
          if (!Number.isFinite(argv.timeout) || argv.timeout < 1 || argv.timeout > 3600) throw errUsage('--timeout must be from 1 to 3600 seconds.');
          const plan = await prepareScan(app.sdk, argv);
          await confirmDelete(app, argv, `Start scan of ${plan.target.kind} ${plan.target.name || plan.target.sys_id || plan.target.execution_id || 'the full instance'}${plan.suite_id ? ` using suite ${plan.suite_id}` : ''}?`);
          const scheduled = await startScan(app.sdk, plan);
          let data = { ...scheduled, status: 'scheduled', terminal: false };
          if (argv.wait) {
            try {
              const deadline = Date.now() + argv.timeout * 1000;
              while (Date.now() < deadline) {
                try {
                  data = { ...scheduled, ...await scanStatus(app.sdk, scheduled.execution_id, { allowInitializing: true }) };
                } catch (error) {
                  if (error.code !== 'not_found' && error.status !== 404) throw error;
                  // The processor can return before its execution tracker is visible.
                  data = { ...scheduled, status: 'scheduled', terminal: false };
                }
                if (data.terminal) { data = { ...scheduled, ...await scanResults(app.sdk, scheduled.execution_id) }; break; }
                await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))));
              }
              if (!data.terminal) data.wait_timed_out = true;
            } catch (error) {
              throw errAPI(error.status || 0, `Scan ${scheduled.execution_id} was scheduled, but progress could not be read: ${error.message}. Use jsn scan status ${scheduled.execution_id}; do not resubmit automatically.`);
            }
          }
          const breadcrumbs = executionHints(data);
          if (data.terminal && !data.reusable_target) breadcrumbs.push(hint('rerun', 'jsn scan run --help', 'Choose a target for another scan'));
          report(app, argv, data, { summary: `Scan ${data.execution_id}: ${data.status}${data.wait_timed_out ? ' (still running; wait timed out)' : ''}`, breadcrumbs });
        }) })
      .command({ command: 'status <id>', describe: 'Read scan execution progress',
        handler: wrap(async (argv, app) => {
          const data = await scanStatus(app.sdk, argv.id);
          report(app, argv, data, { summary: `Scan ${data.status}: ${data.message}`, breadcrumbs: executionHints(data) });
        }) })
      .command({ command: 'results <id>', describe: 'Read findings and check execution coverage; unreadable data is not zero',
        builder: p => p.option('limit', { type: 'number', default: 50, describe: 'Maximum findings/check rows (1–200); truncation is reported' }),
        handler: wrap(async (argv, app) => {
          const data = await scanResults(app.sdk, argv.id, boundedLimit(argv.limit));
          report(app, argv, data, { summary: `Scan ${data.status}; ${data.findings_count ?? 'unknown'} findings; ${data.checks_executed ?? 'unknown'} recorded check executions${data.incomplete ? '; incomplete data' : ''}`, breadcrumbs: executionHints(data) });
        }) })
      .command({ command: 'cancel <id>', describe: 'Request cancellation of this scan after confirmation',
        handler: wrap(async (argv, app) => {
          const status = await scanStatus(app.sdk, argv.id);
          if (!status.terminal) await confirmDelete(app, argv, `Cancel scan ${argv.id}?`);
          const data = status.terminal ? { ...status, cancellation_requested: false } : await cancelScan(app.sdk, argv.id);
          report(app, argv, data, { summary: data.cancellation_requested ? `Cancellation requested: ${argv.id}` : 'Scan already finished; no cancellation sent', breadcrumbs: executionHints(data) });
        }) }),
    handler: wrap(async (argv, app) => report(app, argv, { commands: ['checks', 'suites', 'run', 'status', 'results', 'cancel'] }, { summary: 'Instance Scan', breadcrumbs: rootHints() })),
  };
}
