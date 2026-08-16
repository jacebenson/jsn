import fs from 'node:fs';
import path from 'node:path';
import { formatRecordForDisplay, buildQuerySuffix, parseDataArg, getStringField, interactiveList, resolveFieldsParam, checkDerivedFields, confirmDelete, assertSafeExactMatch, verifyWriteBack } from '../helpers.js';

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
  kb_knowledge: ['number', 'short_description', 'workflow_state', 'author'],
};

function getDefaultColumns(table) {
  return tableDefaultColumns[table] || ['sys_id'];
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
            .option('count', { type: 'boolean', default: true, describe: 'Include the total-matching count (use --no-count to opt out)' }),
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
                  const cols = getDefaultColumns(table);
                  return cols.map(c => `${c}: ${getStringField(r, c) || '-'}`).join(' | ');
                },
              });
              if (picked) {
                picked._context = { instance_url: app.getEffectiveInstance(), table };
                return app.ok(picked, { summary: `Record from ${table}` });
              }
            }

            // Text/table fallback (or sys-id direct lookup)
            const params = new URLSearchParams();
            params.set('sysparm_limit', argv['sys-id'] ? '1' : String(argv.limit));
            params.set('sysparm_offset', String(argv.offset));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (query) params.set('sysparm_query', query);
            const records = await app.sdk.list(table, params);
            const displayRecords = fields ? records.map(r => formatRecordForDisplay(r, columns)) : records;

            // include_counts: default opt-in on every list. Opt out per-profile
            // (config include_counts:false) or per-invocation (--no-count).
            const profile = (app.config.profiles || {})[app.config.activeProfile || app.config.defaultProfile] || {};
            const countsOn = argv.count !== false && profile.include_counts !== false;
            let total;
            if (countsOn && !argv['sys-id']) {
              try { total = await app.sdk.aggregateCount(table, query); } catch { total = undefined; }
            }

            const breadcrumbs = [
              { action: 'create', cmd: `jsn records create --table ${table} --data '{...}'`, description: 'Create a new record' },
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
          describe: 'Get a single record by sys_id',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('attachments', { type: 'boolean', default: false, describe: 'Also list the record\'s attachments' }),
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv['sys-id']);
            const params = new URLSearchParams();
            params.set('sysparm_query', `sys_id=${argv['sys-id']}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'true');
            if (argv.columns && argv.columns !== '*') params.set('sysparm_fields', argv.columns);
            const records = await app.sdk.list(argv.table, params);
            if (records.length === 0) {
              throw new Error(`Record not found: ${argv['sys-id']}`);
            }
            const record = records[0];
            if (argv.attachments) {
              try {
                const atts = await app.sdk.listAttachments(argv['sys-id']);
                record._attachments = atts;
              } catch {
                record._attachments = [];
              }
            }
            record._context = { instance_url: app.getEffectiveInstance(), table: argv.table };
            app.ok(record, { summary: `Record from ${argv.table}${argv.attachments ? ` (${(record._attachments || []).length} attachment(s))` : ''}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('data', { type: 'string', describe: 'JSON fields (e.g. \'{"state":"2"}\')' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = parseDataArg(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await app.sdk.create(argv.table, recordData);
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
            .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id' })
            .option('data', { type: 'string', describe: 'JSON fields (e.g. \'{"state":"2"}\')' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = parseDataArg(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await app.sdk.update(argv.table, argv['sys-id'], recordData);
            const mismatches = await verifyWriteBack(app, argv.table, argv['sys-id'], recordData);
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
            .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            await confirmDelete(app, argv, `Delete record from ${argv.table} (${argv['sys-id']})`);
            await app.sdk.delete(argv.table, argv['sys-id']);
            app.ok({ message: 'Record deleted', table: argv.table, sys_id: argv['sys-id'] }, { summary: `Deleted record from ${argv.table}` });
          }),
        })
        .command({
          command: 'attachments',
          describe: 'Work with attachments on a record',
          builder: (y) => y
            .command({
              command: 'list',
              describe: 'List attachments on a record',
              builder: (yy) => yy
                .option('sys-id', { alias: 's', type: 'string', demandOption: true, describe: 'Parent record sys_id' })
                .option('table', { type: 'string', describe: 'Parent table name (context only)' }),
              handler: wrap(async (argv, app) => {
                app.requireInstance();
                const attachments = await app.sdk.listAttachments(argv['sys-id']);
                app.ok({
                  sys_id: argv['sys-id'],
                  table: argv.table || '',
                  count: attachments.length,
                  attachments,
                  context: { instance_url: app.getEffectiveInstance() },
                }, { summary: `${attachments.length} attachment(s) on record ${argv['sys-id']}` });
              }),
            })
            .command({
              command: 'get <attachment-id>',
              describe: 'Download an attachment to a local file',
              builder: (yy) => yy
                .positional('attachment-id', { describe: 'Attachment sys_id', type: 'string' })
                .option('sys-id', { alias: 's', type: 'string', demandOption: true, describe: 'Parent record sys_id (used to resolve the file name)' })
                .option('out', { alias: 'o', type: 'string', describe: 'Output file path (default: attachment file name in cwd)' }),
              handler: wrap(async (argv, app) => {
                app.requireInstance();
                const buf = await app.sdk.getAttachment(argv['attachment-id']);
                let name = argv.out;
                if (!name) {
                  // Best-effort: derive the file name from the attachment row.
                  let fileName = `${argv['attachment-id']}.bin`;
                  try {
                    const rows = await app.sdk.listAttachments(argv['sys-id']);
                    const hit = (rows || []).find((a) => getStringField(a, 'sys_id') === argv['attachment-id']);
                    const fn = getStringField(hit, 'file_name');
                    if (fn) fileName = fn;
                  } catch { /* keep default */ }
                  name = fileName;
                }
                await fs.promises.writeFile(name, buf);
                app.ok({ sys_id: argv['attachment-id'], out: name, bytes: buf.length }, { summary: `Wrote ${buf.length} bytes to ${name}` });
              }),
            })
            .command({
              command: 'add <file>',
              describe: 'Upload a file as a new attachment on a record (mutation)',
              builder: (yy) => yy
                .positional('file', { describe: 'Local file path to upload', type: 'string' })
                .option('sys-id', { alias: 's', type: 'string', demandOption: true, describe: 'Parent record sys_id' })
                .option('table', { type: 'string', demandOption: true, describe: 'Parent table for the record (e.g. incident)' })
                .option('name', { type: 'string', describe: 'Display file name (default: basename of --file)' })
                .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
              handler: wrap(async (argv, app) => {
                app.requireInstance();
                await confirmDelete(app, argv, `Upload "${argv.file}" as an attachment on ${argv.table} ${argv['sys-id']}?`);
                const content = await fs.promises.readFile(argv.file);
                const fileName = argv.name || path.basename(argv.file);
                const created = await app.sdk.addAttachment(argv.table, argv['sys-id'], content, fileName);
                app.ok({ sys_id: created?.sys_id, file_name: fileName, table: argv.table, recordsys_id: argv['sys-id'] }, { summary: `Attached ${fileName}` });
              }),
            })
            .demandCommand(1, 'Specify an attachment action: list, get, or add'),
        })
        .command({
          command: 'bulk',
          describe: 'Bulk-update records matching a query. Dry-run by default — pass --execute to commit',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', demandOption: true, describe: 'Encoded query selecting the records to update (e.g. "priority=1^state=1")' })
            .option('set', { type: 'string', demandOption: true, describe: 'JSON object of fields to set (e.g. \'{"state":"3"}\')' })
            .option('dry-run', { type: 'boolean', default: true, describe: 'Preview the count + a sample without mutating (default)' })
            .option('execute', { type: 'boolean', default: false, describe: 'Perform the update after confirmation' })
            .option('limit', { type: 'number', default: 200, describe: 'Max records to update when executing' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation (with --execute)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            let set;
            try {
              set = JSON.parse(argv.set);
            } catch (e) {
              throw new Error(`Invalid --set JSON: ${e.message}`, { cause: e });
            }
            if (!set || typeof set !== 'object' || Array.isArray(set)) {
              throw new Error('--set must be a JSON object of field=value pairs');
            }
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
    handler: (argv) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      console.log('Query and manage records in any ServiceNow table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List records from a table (includes total by default)');
      console.log('  get                   Get a single record by sys_id (--attachments to include files)');
      console.log('  create                Create a record');
      console.log('  update                Update a record');
      console.log('  delete                Delete a record');
      console.log('  inspect               Inspect table schema and statistics');
      console.log('');
      console.log('Run "jsn records <command> --help" for details.');
    },
  };
}
