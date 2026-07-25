import { formatRecordForDisplay, interactiveList, getStringField } from '../../helpers.js';

function logIcon(level) {
  level = (level || '').toLowerCase();
  if (level === 'error') return '❌';
  if (level === 'warning') return '⚠️';
  if (level === 'information' || level === 'info') return 'ℹ️';
  return '📝';
}

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
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "level=error" or "sourceLIKEscript")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const columns = argv.columns ? argv.columns.split(',') : ['level', 'message', 'source', 'sys_created_on'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'syslog', singular: 'log entry', columns, limit: argv.limit, query, labelField: 'message',
              formatLabel: r => {
                const level = getStringField(r, 'level') || '';
                const msg = (getStringField(r, 'message') || '').substring(0, 80);
                const src = getStringField(r, 'source') || '';
                return `${logIcon(level)} ${msg}${src ? `  [${src}]` : ''}`;
              },
            });
            if (picked === undefined) return;
            if (picked) {
              picked._context = { instance_url: app.getEffectiveInstance(), table: 'syslog' };
              const level = getStringField(picked, 'level') || '?';
              return app.ok(picked, {
                summary: `${logIcon(level)} ${level}: ${(getStringField(picked, 'message') || '').substring(0, 80)}`,
              });
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
            const level = getStringField(record, 'level') || '?';
            app.ok(record, { summary: `${logIcon(level)} ${level}: ${(getStringField(record, 'message') || '').substring(0, 80)}` });
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
