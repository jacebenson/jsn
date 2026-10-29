import { formatCommandList, formatRecordForDisplay, buildQuerySuffix, buildRecordPayload, getStringField, interactiveList, resolveFieldsParam, checkDerivedFields, confirmDelete, verifyWriteBack } from '../helpers.js';
import { listRecords, recordListParams, getRecord, createRecord, updateRecord, deleteRecord } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { errUsage } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

declareCapabilities('records', {
  mutationSubcommands: ['create', 'update', 'delete', 'bulk'],
});

const tableDefaultColumns = {
  incident: ['number', 'short_description', 'priority', 'state', 'assigned_to'],
  change_request: ['number', 'short_description', 'risk', 'state', 'assigned_to'],
  change_task: ['number', 'short_description', 'state', 'assigned_to'],
  problem: ['number', 'short_description', 'priority', 'state', 'assigned_to'],
  sc_request: ['number', 'short_description', 'request_state', 'requested_for'],
  sc_req_item: ['number', 'short_description', 'stage', 'assigned_to'],
  sc_task: ['number', 'short_description', 'state', 'assigned_to'],
  sys_user: ['user_name', 'name', 'email', 'active'],
  sys_user_group: ['name', 'manager', 'email'],
  cmdb_ci: ['name', 'operational_status', 'ip_address'],
  cmdb_ci_server: ['name', 'operational_status', 'ip_address'],
  cmdb_rel_ci: ['parent', 'type', 'child'],
  kb_knowledge: ['number', 'short_description', 'workflow_state', 'author'],
};

/**
 * Raw sys_id from a reference field (string or {display_value, link, value}).
 */
function refSysId(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (field.value && typeof field.value === 'string') return field.value;
    if (field.link && typeof field.link === 'string') {
      const parts = field.link.split('/');
      return parts[parts.length - 1];
    }
  }
  return '';
}

/**
 * Breadcrumbs from a cmdb_rel_ci record into the cmdb relationships walk.
 */
export function relationshipBreadcrumbs(record) {
  const parentId = refSysId(record.parent);
  const childId = refSysId(record.child);
  const crumbs = [];
  if (childId) {
    crumbs.push({
      action: 'relationships',
      cmd: `jsn cmdb relationships --ci ${childId}`,
      description: "Traverse from this relationship's child CI",
    });
  }
  if (parentId) {
    crumbs.push({
      action: 'impact',
      cmd: `jsn cmdb relationships --ci ${parentId} --impact`,
      description: 'Impact analysis upstream from the parent CI',
    });
  }
  return crumbs;
}

function getDefaultColumns(table) {
  return tableDefaultColumns[table] || ['sys_id'];
}

function recordLookup(argv) {
  const sysId = argv['sys-id'];
  if ((sysId === undefined) === (argv.identifier === undefined)) throw errUsage('Supply exactly one of --sys-id or --identifier.');
  if (sysId !== undefined && argv.identifierField && argv.identifierField !== 'sys_id') throw errUsage('--sys-id cannot be combined with a different --identifier-field.');
  return { table: argv.table, identifier: sysId ?? argv.identifier,
    identifierField: sysId !== undefined ? 'sys_id' : (argv.identifierField || 'sys_id'),
    displayValues: argv.displayValues, resource: 'Record' };
}

export function recordsCmd(wrap) {
  return {
    command: 'records [subcommand]',
    describe: 'Query and manage records in any table (e.g. "records list --table incident --query priority=1")',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          describe: 'List records from a table',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Record sys_id (filters to a single record)' })
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { type: 'number', default: 20, describe: 'Max records' })
            .option('offset', { type: 'number', default: 0, describe: 'Offset' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('count', { type: 'boolean', default: true, describe: 'Include the total-matching count (use --no-count to opt out)' })
            .epilogue([
              'In an interactive terminal with automatic output, browse a picker (10 visible items).',
              'Use arrow keys to browse, type to search sys_id on the server, scroll to load more,',
              'and press Enter to select or Esc to cancel. --sys-id skips the picker.',
              'Use --json for noninteractive structured output; pipes and explicit formats also skip the picker.',
              'Example: jsn records list --table incident --query "active=true" --limit 5 --json',
              'Discover fields with: jsn columns --table incident',
            ].join('\n')),
          handler: wrap(async (argv, app) => {
            const table = argv.table;
            const columns = argv.columns ? argv.columns.split(',') : getDefaultColumns(table);
            let query = argv.query || '';

            // If --sys-id is provided, append it to the query
            if (argv['sys-id']) {
              if (query) query += '^';
              query += `sys_id=${argv['sys-id']}`;
            }

            // Interactive picker (only when no --sys-id filter, otherwise go straight to results)
            if (!argv['sys-id']) {
              const picked = await interactiveList({
                app, table, singular: 'record', columns, limit: argv.limit, query, labelField: 'sys_id',
                formatLabel: r => {
                  // Relationship rows read best as "parent <type> child [sys_id]"
                  if (table === 'cmdb_rel_ci') {
                    const parent = getStringField(r, 'parent');
                    const type = getStringField(r, 'type') || 'Related to';
                    const child = getStringField(r, 'child');
                    return `${parent || '?'} ${type} ${child || '?'} [${getStringField(r, 'sys_id')}]`;
                  }
                  const cols = getDefaultColumns(table);
                  return cols.map(c => `${c}: ${getStringField(r, c) || '-'}`).join(' | ');
                },
              });
              if (picked) {
                picked._context = { instance_url: app.getEffectiveInstance(), table };
                const crumbs = table === 'cmdb_rel_ci' ? relationshipBreadcrumbs(picked) : [];
                return app.ok(picked, {
                  summary: `Record from ${table}`,
                  ...(crumbs.length ? { breadcrumbs: crumbs } : {}),
                });
              }
            }

            // Text/table fallback (or sys-id direct lookup)
            const fields = resolveFieldsParam(columns);
            const params = recordListParams({ limit: argv['sys-id'] ? 1 : argv.limit, offset: argv.offset, fields, query });
            const records = await listRecords(app.sdk, { table, params, displayValues: argv.displayValues });
            const displayRecords = fields && !argv.displayValues ? records.map(r => formatRecordForDisplay(r, columns)) : records;

            // include_counts: default opt-in on every list. Opt out per-profile
            // (config include_counts:false) or per-invocation (--no-count).
            const profile = (app.config.profiles || {})[app.config.activeProfile || app.config.defaultProfile] || {};
            const countsOn = argv.count !== false && profile.include_counts !== false;
            let total;
            if (countsOn && !argv['sys-id']) {
              try { total = await app.sdk.aggregateCount(table, query); } catch { total = undefined; }
            }

            const breadcrumbs = [
              { action: 'create', cmd: `jsn records create --table ${table} -f name=value`, description: 'Create a new record' },
              { action: 'filter', cmd: `jsn records list --table ${table} --query "priority=1"`, description: 'Filter: priority 1 only' },
              { action: 'columns', cmd: `jsn columns --table ${table}`, description: 'View available columns' },
            ];
            if (argv['sys-id']) {
              breadcrumbs.unshift({
                action: 'get',
                cmd: `jsn records get --table ${table} --sys-id ${argv['sys-id']}`,
                description: 'Get full record details',
              });
            }
            if (records.length === argv.limit) {
              breadcrumbs.push({
                action: 'next',
                cmd: `jsn records list --table ${table} --limit ${argv.limit} --offset ${argv.offset + argv.limit}${buildQuerySuffix(argv.query)}`,
                description: `Next page`,
              });
            }
            if (argv.offset > 0) {
              breadcrumbs.push({
                action: 'prev',
                cmd: `jsn records list --table ${table} --limit ${argv.limit} --offset ${Math.max(0, argv.offset - argv.limit)}${buildQuerySuffix(argv.query)}`,
                description: 'Previous page',
              });
            }
            app.ok({
              table,
              count: records.length,
              columns,
              records: displayRecords,
              pagination: { limit: argv.limit, offset: argv.offset, ...(total != null ? { total } : {}) },
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} record(s) from ${table}${total != null ? ` of ${total}` : ''}`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'get',
          describe: 'Get one record by sys_id or an explicit identifier field',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('attachments', { type: 'boolean', default: false, describe: 'Also list the record\'s attachments' })
            .epilogue('Exact lookup precedes sys_id prefix, then suffix. Ambiguous matches fail.\nExample: jsn records get --table incident --sys-id <sys_id> --json\nExample: jsn records get --table incident --identifier INC0010001 --identifier-field number --json'),
          handler: wrap(async (argv, app) => {
            const lookup = recordLookup(argv);
            const fields = argv.columns && argv.columns !== '*' ? argv.columns.split(',') : undefined;
            const record = await getRecord(app.sdk, { ...lookup, fields, displayValue: 'true' });
            if (argv.attachments) {
              try {
                const atts = await app.sdk.listAttachments(unwrapSysId(record));
                record._attachments = atts;
              } catch {
                record._attachments = [];
              }
            }
            record._context = { instance_url: app.getEffectiveInstance(), table: argv.table };
            const crumbs = argv.table === 'cmdb_rel_ci' ? relationshipBreadcrumbs(record) : [];
            app.ok(record, {
              summary: `Record from ${argv.table}${argv.attachments ? ` (${(record._attachments || []).length} attachment(s))` : ''}`,
              ...(crumbs.length ? { breadcrumbs: crumbs } : {}),
            });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await createRecord(app.sdk, { table: argv.table, data: recordData });
            const sysID = getStringField(record, 'sys_id');
            const mismatches = await verifyWriteBack(app, argv.table, sysID, recordData);
            for (const m of mismatches) {
              process.stderr.write(`⚠ field "${m.field}" was not persisted (sent: "${m.sent}", got: "${m.got}")\n`);
            }
            if (mismatches.length > 0 && argv.strict) {
              throw new Error(`Strict mode: ${mismatches.length} field(s) not persisted after create`);
            }
            app.ok(record, { summary: `Created record in ${argv.table}` });
          }),
        })
        .command({
          command: 'update',
          describe: 'Update an existing record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const lookup = recordLookup(argv);
            const resolved = await getRecord(app.sdk, lookup);
            const record = await updateRecord(app.sdk, { table: argv.table, record: resolved, data: recordData });
            const mismatches = await verifyWriteBack(app, argv.table, unwrapSysId(resolved), recordData);
            for (const m of mismatches) {
              process.stderr.write(`⚠ field "${m.field}" was not persisted (sent: "${m.sent}", got: "${m.got}")\n`);
            }
            if (mismatches.length > 0 && argv.strict) {
              throw new Error(`Strict mode: ${mismatches.length} field(s) not persisted after update`);
            }
            app.ok(record, { summary: `Updated record in ${argv.table}` });
          }),
        })
        .command({
          command: 'delete',
          describe: 'Delete a record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const lookup = recordLookup(argv);
            await confirmDelete(app, argv, `Delete record from ${argv.table} (${lookup.identifier})`);
            const sysID = await deleteRecord(app.sdk, lookup);
            app.ok({ message: 'Record deleted', table: argv.table, sys_id: sysID }, { summary: `Deleted record from ${argv.table}` });
          }),
        })
        .command({
          command: 'aggregate',
          describe: 'Run ServiceNow Stats API aggregation with optional grouping',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', describe: 'Encoded query to constrain the aggregation' })
            .option('group-by', { type: 'string', describe: 'Comma-separated fields to group by' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('count', { type: 'boolean', default: true, describe: 'Include record counts' })
            .option('avg-fields', { type: 'string', describe: 'Comma-separated fields to average' })
            .option('sum-fields', { type: 'string', describe: 'Comma-separated fields to sum' })
            .option('min-fields', { type: 'string', describe: 'Comma-separated fields for minimum values' })
            .option('max-fields', { type: 'string', describe: 'Comma-separated fields for maximum values' })
            .option('order-by', { type: 'string', describe: 'Comma-separated fields to order by' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const split = (value) => value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
            const options = {
              query: argv.query || '',
              groupBy: split(argv['group-by']),
              count: argv.count !== false,
              averageFields: split(argv['avg-fields']),
              sumFields: split(argv['sum-fields']),
              minimumFields: split(argv['min-fields']),
              maximumFields: split(argv['max-fields']),
              orderBy: split(argv['order-by']),
            };
            const result = await app.sdk.aggregate(argv.table, options);
            app.ok({
              table: argv.table,
              query: options.query,
              group_by: options.groupBy,
              aggregate: {
                count: options.count,
                average_fields: options.averageFields,
                sum_fields: options.sumFields,
                minimum_fields: options.minimumFields,
                maximum_fields: options.maximumFields,
                order_by: options.orderBy,
              },
              ...result,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `Aggregated ${argv.table}${options.groupBy.length ? ` by ${options.groupBy.join(', ')}` : ''}` });
          }),
        })
        .command({
          command: 'bulk',
          describe: 'Bulk-update records matching a query. Dry-run by default — pass --execute to commit',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', demandOption: true, describe: 'Encoded query selecting the records to update (e.g. "priority=1^state=1")' })
            .option('set', { type: 'string', describe: 'JSON object of fields to set' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('dry-run', { type: 'boolean', default: true, describe: 'Preview the count + a sample without mutating (default)' })
            .option('execute', { type: 'boolean', default: false, describe: 'Perform the update after confirmation' })
            .option('limit', { type: 'number', default: 200, describe: 'Max records to update when executing' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation (with --execute)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const set = buildRecordPayload({ ...argv, data: argv.set }, { required: true });
            if (!argv['dry-run'] && !argv.execute) {
              argv.execute = true; // explicit --no-dry-run implies execute intent
            }
            const dryRun = argv['dry-run'] && !argv.execute;
            const count = await app.sdk.aggregateCount(argv.table, argv.query);

            if (dryRun) {
              const params = new URLSearchParams();
              params.set('sysparm_query', argv.query);
              params.set('sysparm_limit', '5');
              params.set('sysparm_fields', 'sys_id,number,name');
              let sample = [];
              try { sample = await app.sdk.list(argv.table, params); } catch { /* non-fatal */ }
              app.ok({
                table: argv.table,
                query: argv.query,
                set,
                count,
                dry_run: true,
                sample,
                context: { instance_url: app.getEffectiveInstance() },
              }, { summary: `Dry run: ${count} record(s) in ${argv.table} would be updated` });
              return;
            }

            await confirmDelete(app, argv, `Bulk update ${count} record(s) in ${argv.table}?`);
            const sysIDs = [];
            const pageSize = Math.min(argv.limit, 1000);
            const params = new URLSearchParams();
            params.set('sysparm_query', argv.query);
            params.set('sysparm_limit', String(pageSize));
            params.set('sysparm_fields', 'sys_id');
            let offset = 0;
            while (sysIDs.length < argv.limit) {
              params.set('sysparm_offset', String(offset));
              let recs;
              try { recs = await app.sdk.list(argv.table, params); } catch { break; }
              if (!recs || recs.length === 0) break;
              for (const r of recs) {
                const id = getStringField(r, 'sys_id');
                if (id) sysIDs.push(id);
              }
              if (recs.length < pageSize) break;
              offset += recs.length;
            }
            const targets = sysIDs.slice(0, argv.limit);
            let updated = 0;
            const failures = [];
            for (const id of targets) {
              try {
                await app.sdk.update(argv.table, id, set);
                updated += 1;
              } catch (e) {
                failures.push({ sys_id: id, error: e.message || String(e) });
              }
            }
            app.ok({
              table: argv.table,
              query: argv.query,
              set,
              matched: count,
              updated,
              failed: failures,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `Updated ${updated} of ${count} matching record(s) in ${argv.table}` });
          }),
        })
        .command({
          command: 'inspect <table> <identifier>',
          aliases: ['debug', 'diag'],
          describe: 'Inspect a record: show audit history, business rules, and running flows',
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident)', type: 'string' })
            .positional('identifier', { describe: 'Record sys_id or number', type: 'string' }),
          handler: wrap(async (argv, app) => {
            const { inspectRecord, formatInspectOutput } = await import('../records/inspect.js');
            const result = await inspectRecord(app, argv.table, argv.identifier);
            const breadcrumbs = [
              ...result.flows.map(f => ({
                action: 'show',
                cmd: `jsn flows show "${f.flow}"`,
                description: `View flow details for ${f.flow}`,
              })),
              ...result.businessRules.slice(0, 5).map(br => ({
                action: 'show',
                cmd: `jsn rules show "${br.name}"`,
                description: `View business rule: ${br.name}`,
              })),
            ];
            app.ok({ ...result, _formatted: formatInspectOutput(result) }, {
              summary: `Inspected ${argv.table} ${argv.identifier}`,
              breadcrumbs,
            });
          }),
        })

    },
    // Parent discovery through the output controller: the subcommand list is
    // registry-derived (argv.subcommands), so `jsn records --json` returns a
    // structured envelope instead of prose, and the descriptions can no longer
    // describe a different surface than the registrations (the previous
    // hand-written list advertised `inspect` as table schema/statistics).
    handler: wrap(async (argv, app) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      const subcommands = argv.subcommands || [];
      const summary = 'Query and manage records in any ServiceNow table.';
      app.ok({
        command: 'records',
        subcommands,
        _formatted: formatCommandList({
          title: summary,
          commands: subcommands,
          footer: 'Run "jsn records <command> --help" for details.',
        }),
      }, { summary });
    }),
  };
}
