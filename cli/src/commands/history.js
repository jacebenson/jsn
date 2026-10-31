import { declareCapabilities } from '../capabilities.js';
import { listHistory, pruneHistory } from '../mutation-history.js';

export function historyCmd(wrap) {
  declareCapabilities('history', { noInstance: true, skipDailyChecks: true });
  const list = wrap(async (argv, app) => {
    const entries = listHistory({ ...argv, instance: argv['instance-url'], profile: argv['profile-name'] });
    app.ok({ entries, retentionDays: 7, _formatted: renderHistory(entries, { details: argv.details }) });
  });
  const filters = b => b
    .option('details', { type: 'boolean', default: false, describe: 'Show full record IDs, instance URLs and reasons' })
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

export function renderHistory(entries, { details = false, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (!entries.length) return 'No local mutations in the last seven days.';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // Strip terminal control characters from stored identifiers and labels.
  // eslint-disable-next-line no-control-regex
  const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
  const clip = (value, length) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
  const rows = entries.map(entry => {
    let connection = entry.profile;
    if (!connection) {
      try { connection = new URL(entry.instance).host; } catch { connection = entry.instance; }
    }
    return [date.format(new Date(entry.timestamp)), entry.operation, clip(clean(entry.table), 22),
      clip(clean(entry.sys_id || '(unknown)'), 12), entry.outcome, clip(clean(connection), 22)];
  });
  const headers = ['WHEN', 'ACTION', 'TABLE', 'RECORD', 'RESULT', 'CONNECTION'];
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));
  const format = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const lines = [`Recent mutations · ${timeZone}`, '', format(headers)];
  rows.forEach((row, i) => {
    lines.push(format(row));
    if (details) {
      const entry = entries[i];
      lines.push(`  ${clean(entry.timestamp)} · ${clean(entry.table)}/${clean(entry.sys_id || '(unknown)')}`,
        `  ${clean(entry.instance)}${entry.reason ? ` · ${clean(entry.reason)}` : ''}`);
    }
  });
  if (!details) lines.push('', 'Use --details for full IDs, URLs and reasons; --json for structured history.');
  return lines.join('\n');
}
