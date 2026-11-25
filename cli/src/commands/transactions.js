export function normalizeTransactionQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return 'sys_created_on>=javascript:gs.daysAgoStart(1)';
  return raw.replace(/(^|\^)sys_created_on=(\d{4}-\d{2}-\d{2})(?=\^|$)/g, (_, prefix, date) => {
    const nextDay = new Date(`${date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const next = nextDay.toISOString().slice(0, 10);
    return `${prefix}sys_created_on>=${date}^sys_created_on<${next}`;
  });
}

function displayMetric(value) {
  if (value == null) return '-';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ms`;
}

function formatTransactionTable(types) {
  const lines = [
    'CLASS       TYPE           COUNT  AVG       MIN       MAX',
    '----------  -------------  -----  --------  --------  --------',
  ];
  for (const row of types) {
    const value = (metric) => displayMetric(row[metric]);
    lines.push(`${row.class.padEnd(10)}  ${row.type.padEnd(13)}  ${String(row.count).padStart(5)}  ${value('avg_response_time_ms').padEnd(8)}  ${value('min_response_time_ms').padEnd(8)}  ${value('max_response_time_ms')}`);
  }
  if (types.length === 0) lines.push('(no transactions)');
  return `${lines.join('\n')}\n`;
}

export function classifyTransactionType(type, url = '') {
  const normalized = String(type || '').toLowerCase();
  const path = String(url || '').toLowerCase();
  if (normalized === 'scheduler' || path.startsWith('job:')) return 'job';
  if (['rest', 'batch_rest'].includes(normalized)) return 'api';
  if (['form', 'list'].includes(normalized)) return 'ui';
  if (['export', 'instance_scan'].includes(normalized)) return 'background';
  return 'unknown';
}

function numericValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

function groupValue(group, field) {
  return group?.groupby_fields?.find(item => item?.field === field)?.value || '';
}

function metricValue(stats, metric, field) {
  const value = stats?.[metric];
  return typeof value === 'object' ? numericValue(value[field]) : numericValue(value);
}

function summarizeGroup(group) {
  const type = groupValue(group, 'type') || 'unknown';
  const stats = group?.stats || {};
  return {
    type,
    class: classifyTransactionType(type),
    count: numericValue(stats.count) ?? 0,
    avg_response_time_ms: metricValue(stats, 'avg', 'response_time'),
    min_response_time_ms: metricValue(stats, 'min', 'response_time'),
    max_response_time_ms: metricValue(stats, 'max', 'response_time'),
  };
}

function topQuery(argv = {}) {
  const parts = [];
  if (argv.query) parts.push(String(argv.query));
  for (const field of ['type', 'table', 'view']) if (argv[field]) parts.push(`${field}=${argv[field]}`);
  if (argv.window != null && String(argv.window) !== '') {
    const days = Math.max(1, Math.min(30, Number(argv.window) || 1));
    parts.push(`sys_created_on>=javascript:gs.daysAgoStart(${days})`);
  }
  if (argv.since) parts.push(`sys_created_on>=${argv.since}`);
  if (argv.until) parts.push(`sys_created_on<=${argv.until}`);
  return normalizeTransactionQuery(parts.join('^'));
}

function topGroup(group) {
  const stats = group?.stats || {};
  return {
    type: groupValue(group, 'type') || 'unavailable',
    table: groupValue(group, 'table') || 'unavailable',
    view: groupValue(group, 'view') || 'unavailable',
    count: numericValue(stats.count) ?? 0,
    avg_response_time_ms: metricValue(stats, 'avg', 'response_time'),
    min_response_time_ms: metricValue(stats, 'min', 'response_time'),
    max_response_time_ms: metricValue(stats, 'max', 'response_time'),
  };
}

function formatTopTransactions(groups) {
  const value = metric => metric == null ? 'unavailable' : `${Math.round(metric * 100) / 100} ms`;
  const lines = [
    'TYPE         TABLE              VIEW             COUNT  AVG          MIN          MAX',
    '-----------  -----------------  ---------------  -----  -----------  -----------  -----------',
  ];
  for (const row of groups) lines.push(`${String(row.type).slice(0, 11).padEnd(11)}  ${String(row.table).slice(0, 17).padEnd(17)}  ${String(row.view).slice(0, 15).padEnd(15)}  ${String(row.count).padStart(5)}  ${value(row.avg_response_time_ms).padEnd(11)}  ${value(row.min_response_time_ms).padEnd(11)}  ${value(row.max_response_time_ms)}`);
  if (groups.length === 0) lines.push('(no transaction groups)');
  return `${lines.join('\\n')}\\n`;
}

import { declareCapabilities } from '../capabilities.js';
import { listActiveTransactions, formatActiveTransactions, killTransaction, formatKillTransaction } from '../active-transactions.js';
declareCapabilities('transactions', { queryTable: 'syslog_transaction', mutationContext: 'operational', mutationSubcommands: ['kill'] });

export function activeTransactionsCmd(wrap) {
  return {
    command: 'active',
    describe: 'List transactions running now on every node, oldest first',
    builder: (y) => y
      .strict()
      .option('older-than', { type: 'string', describe: 'Only transactions running at least this long: seconds, or 90s, 5m, 2h' })
      .option('user', { type: 'string', describe: 'Only this user name' })
      .option('type', { type: 'string', describe: 'Only this transaction type value, such as rest, form or scheduler' })
      .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Maximum transactions to return (1-100)' })
      .epilogue([
        'Refreshes Active Transactions (All Nodes) the way its module does (loading_transactions.do), then reads v_cluster_transaction in the same session.',
        "Needs the admin role. jsn's own listing request is left out.",
        'Examples:',
        '  jsn transactions active',
        '  jsn transactions active --older-than 5m --type scheduler --json',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = { ...await listActiveTransactions(app.sdk, argv), context: { instance_url: app.getEffectiveInstance() } };
      Object.defineProperty(data, '_formatted', { value: formatActiveTransactions(data), enumerable: false });
      app.ok(data, { summary: `Active transactions: ${data.count}${data.pagination.has_more ? ' (more exist)' : ''}${data.refresh.complete ? '' : '; refresh incomplete'}` });
    }),
  };
}

export function killTransactionCmd(wrap) {
  return {
    command: 'kill <session>',
    describe: "Kill a running transaction by session with the platform's own Kill; previews without --yes",
    builder: (y) => y
      .strict()
      .positional('session', { type: 'string', describe: 'session_id from jsn transactions active' })
      .option('yes', { type: 'boolean', default: false, describe: 'Send the kill (requires --expect-transaction); without it, show what would be killed' })
      .option('expect-transaction', { type: 'string', describe: 'Required with --yes: the transaction_id the preview showed' })
      .epilogue([
        'Kill is meant for background processes such as scheduled jobs, not for users\' requests.',
        'It needs the admin role, and security_admin elevation when High Security Settings are on.',
        'An uncancelable system transaction is refused unless --force, which sends Force Kill instead.',
        'Worker sessions are reused and repeat on every node, so --yes needs the transaction_id from the preview; the preview prints the command.',
        "jsn will not kill its own listing session. After sending, it re-reads the transactions up to 5 times, 2 seconds apart, and the cancellation log, and exits 1 unless the transaction has ended.",
        'Examples:',
        '  jsn transactions kill glide.scheduler.worker.3',
        '  jsn transactions kill glide.scheduler.worker.3 --yes --expect-transaction 4ba972c9c3f0d71068353eec05013113',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = { ...await killTransaction(app.sdk, argv), context: { instance_url: app.getEffectiveInstance() } };
      Object.defineProperty(data, '_formatted', { value: formatKillTransaction(data), enumerable: false });
      const verb = data.method === 'forceKill' ? 'Force Kill' : 'Kill';
      app.ok(data, { summary: data.dry_run ? `Dry run: ${verb} would go to session ${data.session}` : data.ended ? `${verb} sent; session ${data.session}'s transaction ended` : `${verb} sent; transaction not confirmed ended` });
      if (!data.dry_run && !data.ended) process.exitCode = 1;
    }),
  };
}

export function topTransactionsCmd(wrap) {
  return {
    command: 'top',
    describe: 'Rank Client Transaction Timings by type, table, and view',
    builder: (y) => y
      .option('type', { type: 'string', describe: 'Filter transaction type' })
      .option('table', { type: 'string', describe: 'Filter transaction table' })
      .option('view', { type: 'string', describe: 'Filter transaction view' })
      .option('query', { type: 'string', describe: 'Additional encoded query' })
      .option('window', { type: 'number', default: 1, describe: 'Look back this many days (max 30)' })
      .option('since', { type: 'string', describe: 'Only records on or after this timestamp' })
      .option('until', { type: 'string', describe: 'Only records on or before this timestamp' })
      .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Maximum groups to return' }),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const query = topQuery(argv);
      const limit = Math.max(1, Math.min(100, Number(argv.limit) || 20));
      const result = await app.sdk.aggregate('syslog_transaction', {
        query,
        groupBy: ['type', 'table', 'view'],
        count: true,
        averageFields: ['response_time'],
        minimumFields: ['response_time'],
        maximumFields: ['response_time'],
        orderBy: 'countDESC',
      });
      const groups = (Array.isArray(result.groups) ? result.groups : []).map(topGroup).slice(0, limit);
      app.ok({
        table: 'syslog_transaction',
        query,
        group_by: ['type', 'table', 'view'],
        response_time_unit: 'ms',
        groups,
        _formatted: formatTopTransactions(groups),
        context: { instance_url: app.getEffectiveInstance() },
      }, { summary: `Top transaction groups: ${groups.length}` });
    }),
  };
}

export function transactionsCmd(wrap) {
  return {
    command: 'transactions',
    describe: 'Summarize syslog_transaction response times by transaction type',
    builder: (y) => y
      .command(activeTransactionsCmd(wrap))
      .command(killTransactionCmd(wrap))
      .option('query', { type: 'string', global: false, describe: 'Encoded query; date-only sys_created_on equality expands to the full day' })
      .option('order-by', { type: 'string', global: false, describe: 'Stats API order-by fields' }),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const query = normalizeTransactionQuery(argv.query);
      const result = await app.sdk.aggregate('syslog_transaction', {
        query,
        groupBy: ['type'],
        count: true,
        averageFields: ['response_time'],
        minimumFields: ['response_time'],
        maximumFields: ['response_time'],
        orderBy: argv['order-by'] || '',
      });
      const groups = Array.isArray(result.groups) ? result.groups : [];
      const types = groups.map(summarizeGroup);
      app.ok({
        table: 'syslog_transaction',
        query,
        group_by: ['type'],
        response_time_unit: 'ms',
        types,
        _formatted: formatTransactionTable(types),
        context: { instance_url: app.getEffectiveInstance() },
      }, { summary: `Transactions by type: ${types.length} type(s)` });
    }),
  };
}
