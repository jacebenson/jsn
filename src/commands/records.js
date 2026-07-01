import { formatRecordForDisplay, buildQuerySuffix, parseDataArg, getStringField, interactiveList, resolveFieldsParam, checkDerivedFields } from '../helpers.js';

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
    command: 'records <subcommand>',
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
            .option('offset', { type: 'number', default: 0, describe: 'Offset' }),
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
            const breadcrumbs = [
              { action: 'create', cmd: `jsn records create --table ${table} --data '{...}'`, description: 'Create a new record' },
              { action: 'filter', cmd: `jsn records list --table ${table} --query "priority=1"`, description: 'Filter: priority 1 only' },
              { action: 'columns', cmd: `jsn dev columns --table ${table}`, description: 'View available columns' },
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
              pagination: { limit: argv.limit, offset: argv.offset },
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} record(s) from ${table}`, breadcrumbs });
          }),
        })
        .command({
          command: 'get',
          describe: 'Get a single record by sys_id',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' }),
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `sys_id=${argv['sys-id']}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'true');
            if (argv.columns && argv.columns !== '*') params.set('sysparm_fields', argv.columns);
            const records = await app.sdk.list(argv.table, params);
            if (records.length === 0) {
              throw new Error(`Record not found: ${argv['sys-id']}`);
            }
            app.ok(records[0], { summary: `Record from ${argv.table}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('data', { type: 'string', describe: 'JSON fields (e.g. \'{"state":"2"}\')' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' }),
          handler: wrap(async (argv, app) => {
            const recordData = parseDataArg(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await app.sdk.create(argv.table, recordData);
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
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' }),
          handler: wrap(async (argv, app) => {
            const recordData = parseDataArg(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await app.sdk.update(argv.table, argv['sys-id'], recordData);
            app.ok(record, { summary: `Updated record in ${argv.table}` });
          }),
        })
        .command({
          command: 'delete',
          describe: 'Delete a record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id' }),
          handler: wrap(async (argv, app) => {
            await app.sdk.delete(argv.table, argv['sys-id']);
            app.ok({ message: 'Record deleted', table: argv.table, sys_id: argv['sys-id'] }, { summary: `Deleted record from ${argv.table}` });
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
                cmd: `jsn dev flows show "${f.flow}"`,
                description: `View flow details for ${f.flow}`,
              })),
              ...result.businessRules.slice(0, 5).map(br => ({
                action: 'show',
                cmd: `jsn dev rules show "${br.name}"`,
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
    handler: () => {},
  };
}
