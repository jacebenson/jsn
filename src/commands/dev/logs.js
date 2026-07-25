import { formatRecordForDisplay, interactiveList, getStringField } from '../../helpers.js';

export function logsCmd(wrap) {
  return {
    command: 'logs [subcommand]',
    aliases: ['log'],
    describe: 'Query system logs',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List system logs',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['level', 'message', 'source', 'created'];
            const query = argv.query || '';

            // Try interactive picker first
            const picked = await interactiveList({
              app, table: 'syslog', singular: 'log entry', columns, limit: argv.limit, query, labelField: 'message',
              formatLabel: r => `[${getStringField(r, 'level') || '?'}] ${(getStringField(r, 'message') || '').substring(0, 80)}`,
            });
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'syslog' };
              return app.ok(picked, { summary: `Log entry` });
            }

            // Fall back to text/table
            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = query ? query + '^ORDERBYDESCsys_created_on' : 'ORDERBYDESCsys_created_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('syslog', params);
            app.ok({
              table: 'syslog',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} log entry(s)` });
          }),
        })
        .command({
          command: 'show <sys_id>',
          aliases: ['get'],
          describe: 'Show a log entry by sys_id',
          handler: wrap(async (argv, app) => {
            const record = await app.sdk.get('syslog', argv.sys_id);
            if (!record) {
              throw new Error(`Log entry not found: ${argv.sys_id}`);
            }
            app.ok(record, { summary: `Log entry ${argv.sys_id}` });
          }),
        });
    },
    handler: () => {
      console.log('View system logs from the syslog table.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list                List log entries');
      console.log('  show <sys_id>       Show a log entry by sys_id');
      console.log('');
      console.log('Run "jsn logs <command> --help" for details.');
    },
  };
}
