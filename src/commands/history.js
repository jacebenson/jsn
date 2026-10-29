import { declareCapabilities } from '../capabilities.js';
import { listHistory, pruneHistory } from '../mutation-history.js';

export function historyCmd(wrap) {
  declareCapabilities('history', { noInstance: true, skipDailyChecks: true });
  const list = wrap(async (argv, app) => {
    const entries = listHistory({ ...argv, instance: argv['instance-url'], profile: argv['profile-name'] });
    app.ok({ entries, retentionDays: 7, _formatted: entries.length
      ? entries.map(e => `${e.timestamp} ${e.operation} ${e.table}/${e.sys_id || '(unknown ID)'} ${e.outcome} ${e.instance}${e.reason ? ` — ${e.reason}` : ''}`).join('\n')
      : 'No local mutations in the last seven days.' });
  });
  const filters = b => b
    .option('since', { type: 'string', describe: 'Earliest ISO timestamp' })
    .option('until', { type: 'string', describe: 'Latest ISO timestamp' })
    .option('instance-url', { type: 'string', describe: 'Filter by instance origin' })
    .option('profile-name', { type: 'string', describe: 'Filter by recorded profile name (including removed profiles)' })
    .option('table', { type: 'string', describe: 'Filter by table' })
    .option('operation', { choices: ['create', 'update', 'delete'], type: 'string' })
    .option('record', { type: 'string', describe: 'Filter by full resolved sys_id' })
    .option('limit', { type: 'number', default: 50, describe: 'Maximum entries (1–10000)' });
  return { command: 'history [subcommand]', describe: 'Local seven-day mutation history (not a durable ServiceNow audit)',
    builder: y => filters(y).command({ command: 'list', describe: 'List local mutations', builder: filters, handler: list })
      .command({ command: 'prune', describe: 'Remove expired entries only', handler: wrap(async (_argv, app) => {
        app.ok({ ...pruneHistory(), _formatted: 'Expired local history removed; seven days retained.' });
      }) }), handler: list };
}
