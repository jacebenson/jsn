import { enrichRelatedLists, relatedListOptions } from '../related-lists.js';
import { formatRecordForDisplay, getStringField, buildQuerySuffix, resolveFieldsParam, buildRecordPayload, confirmDelete } from '../helpers.js';
import { getRecord, listRecords, recordListParams, createRecord, updateRecord, deleteRecord, recordOptions } from '../records-engine.js';
import { resolveSysId } from '../resolve-record.js';
import { declareCapabilities } from '../capabilities.js';

declareCapabilities('tickets', { mutationSubcommands: ['create', 'update', 'delete'] });

export function ticketsCmd(wrap) {
  return {
    command: 'tickets [subcommand]',
    aliases: ['ticket'],
    describe: 'Query generic tickets (e.g. "tickets list --query active=true")',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List tickets',
          builder: (y) => recordOptions(y)
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "active=true^priority=1")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description,priority")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' })
            .option('offset', { alias: 'o', type: 'number', default: 0, describe: 'Offset' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['number', 'short_description', 'state', 'assigned_to'];
            const fields = resolveFieldsParam(columns);
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            const params = recordListParams({ limit: argv.limit, offset: argv.offset, fields, query: q });
            const records = await listRecords(app.sdk, { table: 'task', params, displayValues: argv.displayValues });
            const displayRecords = fields && !argv.displayValues ? records.map(r => formatRecordForDisplay(r, columns)) : records;
            const breadcrumbs = [
              { action: 'create', cmd: 'jsn tickets create -f short_description=New ticket', description: 'Create a new ticket' },
            ];
            if (records.length === argv.limit) {
              breadcrumbs.push({
                action: 'next',
                cmd: `jsn tickets list --limit ${argv.limit} --offset ${argv.offset + argv.limit}${buildQuerySuffix(argv.query)}`,
                description: `Next page`,
              });
            }
            if (argv.offset > 0) {
              breadcrumbs.push({
                action: 'prev',
                cmd: `jsn tickets list --limit ${argv.limit} --offset ${Math.max(0, argv.offset - argv.limit)}${buildQuerySuffix(argv.query)}`,
                description: 'Previous page',
              });
            }
            app.ok({
              table: 'task',
              count: records.length,
              columns,
              records: displayRecords,
              pagination: { limit: argv.limit, offset: argv.offset },
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} ticket(s)`, breadcrumbs });
          }),
        })
        .command({
          command: 'show <number>',
          aliases: ['get'],
          describe: 'Show a ticket',
          builder: y => relatedListOptions(recordOptions(y)),
          handler: wrap(async (argv, app) => {
            const record = await getRecord(app.sdk, { table: 'task', identifier: argv.number, identifierField: argv.identifierField, displayValues: argv.displayValues, matchField: 'number', resource: 'Ticket' });
            await enrichRelatedLists(record, { table: 'task', argv, app });
            app.ok(record, { summary: `Ticket ${argv.number}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new ticket',
          builder: (y) => recordOptions(y, false)
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const record = await createRecord(app.sdk, { table: 'task', data: recordData });
            app.ok(record, { summary: `Created ticket ${getStringField(record, 'number')}` });
          }),
        })
        .command({
          command: 'update <number>',
          describe: 'Update a ticket',
          builder: (y) => recordOptions(y, false)
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const sysID = await resolveSysId(app.sdk, { table: 'task', identifier: argv.number, identifierField: argv.identifierField, displayValues: argv.displayValues, matchField: 'number', resource: 'Ticket' });
            const updated = await updateRecord(app.sdk, { table: 'task', record: { sys_id: sysID }, data: recordData });
            app.ok(updated, { summary: `Updated ticket ${argv.number}` });
          }),
        })
        .command({
          command: 'delete <number>',
          describe: 'Delete a ticket',
          builder: y => recordOptions(y, false).option('force', { type: 'boolean', default: false, describe: 'Skip confirmation after approval' }),
          handler: wrap(async (argv, app) => {
            await confirmDelete(app, argv, `Delete ticket ${argv.number}`);
            const sysID = await resolveSysId(app.sdk, { table: 'task', identifier: argv.number, identifierField: argv.identifierField, displayValues: argv.displayValues, matchField: 'number', resource: 'Ticket' });
            await deleteRecord(app.sdk, { table: 'task', record: { sys_id: sysID } });
            app.ok({ number: argv.number, message: 'Ticket deleted' }, { summary: `Deleted ticket ${argv.number}` });
          }),
        })

    },
    handler: () => {
      console.log('Query generic tickets from the ticket table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                  List tickets');
      console.log('  show <number or sys_id>  Show a ticket');
      console.log('  create                Create a new ticket');
      console.log('  update <identifier>   Update a ticket');
      console.log('  delete <identifier>   Delete a ticket');
      console.log('');
      console.log('Run "jsn tickets <command> --help" for details.');
    },
  };
}
