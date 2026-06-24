import { formatRecordForDisplay, getStringField, buildQuerySuffix, resolveFieldsParam } from '../helpers.js';

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
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "active=true^priority=1")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description,priority")' })
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' })
            .option('offset', { alias: 'o', type: 'number', default: 0, describe: 'Offset' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['number', 'short_description', 'state', 'assigned_to'];
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_offset', String(argv.offset));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('ticket', params);
            const displayRecords = fields ? records.map(r => formatRecordForDisplay(r, columns)) : records;
            const breadcrumbs = [
              { action: 'create', cmd: 'jsn tickets create --data \'{...}\'', description: 'Create a new ticket' },
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
              table: 'ticket',
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
          handler: wrap(async (argv, app) => {
            const params = new URLSearchParams();
            params.set('sysparm_query', `number=${argv.number}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('ticket', params);
            if (records.length === 0) {
              throw new Error(`Ticket not found: ${argv.number}`);
            }
            app.ok(records[0], { summary: `Ticket ${argv.number}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new ticket',
          builder: (y) => y.option('data', { type: 'string', demandOption: true, describe: 'JSON fields (e.g. \'{"state":"2","priority":"1"}\')' }),
          handler: wrap(async (argv, app) => {
            const recordData = JSON.parse(argv.data);
            const record = await app.sdk.create('ticket', recordData);
            app.ok(record, { summary: `Created ticket ${getStringField(record, 'number')}` });
          }),
        })
        .command({
          command: 'update <number>',
          describe: 'Update a ticket',
          builder: (y) => y.option('data', { type: 'string', demandOption: true, describe: 'JSON fields (e.g. \'{"state":"2","priority":"1"}\')' }),
          handler: wrap(async (argv, app) => {
            const recordData = JSON.parse(argv.data);
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `number=${argv.number}`);
            findParams.set('sysparm_limit', '1');
            const records = await app.sdk.list('ticket', findParams);
            if (records.length === 0) {
              throw new Error(`Ticket not found: ${argv.number}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const updated = await app.sdk.update('ticket', sysID, recordData);
            app.ok(updated, { summary: `Updated ticket ${argv.number}` });
          }),
        })
        .command({
          command: 'delete <number>',
          describe: 'Delete a ticket',
          handler: wrap(async (argv, app) => {
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `number=${argv.number}`);
            findParams.set('sysparm_limit', '1');
            const records = await app.sdk.list('ticket', findParams);
            if (records.length === 0) {
              throw new Error(`Ticket not found: ${argv.number}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await app.sdk.delete('ticket', sysID);
            app.ok({ number: argv.number, message: 'Ticket deleted' }, { summary: `Deleted ticket ${argv.number}` });
          }),
        })

    },
    handler: () => {},
  };
}
