import { declareCapabilities } from '../capabilities.js';

// The report separates activity in the selected window from current totals.
// Missing or protected tables stay visible as unavailable instead of aborting
// the whole report.
const DATA_VOLUME = [
  ['Task records', 'task'],
  ['Incidents', 'incident'],
  ['Catalog tasks', 'sc_task'],
  ['Requested items', 'sc_req_item'],
  ['Requests', 'sc_request'],
  ['Problems', 'problem'],
  ['Change requests', 'change_request'],
  ['CMDB CI records', 'cmdb_ci'],
];
const DATA_VOLUME_CONCURRENCY = 2;
const DATA_VOLUME_TIMEOUT = 120000;

const CONFIGURED_AUTOMATION = [
  ['Scripted REST APIs', 'sys_ws_definition'],
  ['Scripted REST operations', 'sys_ws_operation'],
  ['Inbound email actions', 'sysevent_in_email_action'],
  ['SOAP messages', 'sys_soap_message'],
  ['Scheduled scripts', 'sysauto_script'],
  ['Async business rules', 'sys_script', 'when=async'],
];

declareCapabilities('instance', {});

function nextDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return '';
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function buildActivityQuery({ query, since, until } = {}) {
  if (query) return String(query);
  const clauses = [];
  if (since) clauses.push(`sys_created_on>=${since}`);
  if (until) clauses.push(`sys_created_on<${nextDate(until) || until}`);
  if (clauses.length) return clauses.join('^');
  return 'sys_created_on>=javascript:gs.daysAgoStart(1)';
}

function addQuery(base, extra) {
  return [base, extra].filter(Boolean).join('^');
}

function numeric(value) {
  const number = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function groupField(group, field) {
  return group?.groupby_fields?.find(item => item?.field === field)?.value || 'unknown';
}

function groupCount(group) {
  return numeric(group?.stats?.count ?? group?.count) ?? 0;
}

function metricValue(stats, metric, field) {
  const value = stats?.[metric];
  return numeric(typeof value === 'object' ? value?.[field] : value);
}

async function safeCount(sdk, label, table, query = '', options = {}) {
  try {
    return { label, table, query, count: await sdk.aggregateCount(table, query, options) };
  } catch (err) {
    const message = err.message || 'request failed';
    const deadline = options.timeout && message === 'Request timed out'
      ? ` after ${Math.round(options.timeout / 1000)} seconds`
      : '';
    return { label, table, query, count: null, unavailable: `${message}${deadline}` };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function safeAggregate(sdk, label, table, options) {
  try {
    const result = await sdk.aggregate(table, options);
    return {
      label,
      table,
      groups: Array.isArray(result?.groups) ? result.groups : (Array.isArray(result?.stats) ? result.stats : []),
      stats: result?.stats && !Array.isArray(result.stats) ? result.stats : null,
    };
  } catch (err) {
    return { label, table, groups: [], stats: null, unavailable: err.message || 'request failed' };
  }
}

function safeStatsResult(result) {
  const stats = result.stats || result.groups[0]?.stats || {};
  return {
    avg_ms: metricValue(stats, 'avg', 'response_time'),
    max_ms: metricValue(stats, 'max', 'response_time'),
    ...(result.unavailable ? { unavailable: result.unavailable } : {}),
  };
}

function buildDateList(since, until) {
  if (!since || !until || !nextDate(until)) return [];
  const dates = [];
  let current = since;
  for (let i = 0; i < 366 && current && current <= until; i += 1) {
    dates.push(current);
    current = nextDate(current);
  }
  return dates;
}

function formatCount(value) {
  if (value == null) return 'unavailable';
  return Number(value).toLocaleString('en-US');
}

export function formatDuration(ms) {
  if (ms == null) return 'unavailable';
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)} hours`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)} minutes`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} seconds`;
  return `${Math.round(ms * 100) / 100} ms`;
}

function formatMetricRows(rows) {
  return rows.map(row => `  ${row.label}: ${formatCount(row.count)}${row.unavailable ? ` (${row.unavailable})` : ''}`);
}

function formatFlowRows(flow) {
  const lines = [`  Flow executions: ${formatCount(flow.total_count)}`];
  for (const row of flow.states) lines.push(`  ${row.state}: ${formatCount(row.count)}`);
  if (flow.unavailable) lines.push(`  Unavailable: ${flow.unavailable}`);
  return lines;
}

function formatTransactions(transactions) {
  const lines = [`  Total transactions: ${formatCount(transactions.total_count)}`];
  if (transactions.types.length) {
    for (const row of transactions.types) {
      lines.push('');
      lines.push(`  ${row.type}`);
      lines.push(`    Count: ${formatCount(row.count)}`);
      lines.push(`    Average response: ${formatDuration(row.avg_response_time_ms)}`);
      lines.push(`    Maximum response: ${formatDuration(row.max_response_time_ms)}`);
    }
  } else {
    lines.push('  (no transaction types)');
  }
  if (transactions.unavailable) lines.push(`  Unavailable: ${transactions.unavailable}`);
  return lines;
}

function formatDailyFlows(rows) {
  if (!rows.length) return [];
  return [
    '',
    '  Daily flow executions',
    '  Date          Count',
    ...rows.map(row => `  ${row.date}  ${formatCount(row.count)}`),
  ];
}

function formatDailyImports(rows) {
  if (!rows.length) return [];
  return [
    '',
    '  Daily import activity',
    '  Date          Import sets  Import rows',
    ...rows.map(row => `  ${row.date}  ${formatCount(row.import_sets).padStart(11)}  ${formatCount(row.import_rows).padStart(12)}`),
  ];
}

export function formatInstanceGlance(data) {
  const lines = [
    'INSTANCE AT A GLANCE',
    `Instance: ${data.context.instance_url}`,
    `Activity window: ${data.window.since || 'last 24 hours'} through ${data.window.until || 'now'}`,
    'Configuration and data totals: current',
    '',
    '1. INBOUND AUTOMATION',
    ...formatMetricRows(data.inbound_automation.metrics),
    '  Scripted REST separation: not separated from other REST transactions',
    '',
    '2. ASYNCHRONOUS AUTOMATION',
    ...formatFlowRows(data.asynchronous_automation),
    `  Async business rules configured: ${formatCount(data.asynchronous_automation.async_business_rules_configured)}`,
    ...formatDailyFlows(data.asynchronous_automation.daily_flow_executions),
    '',
    '3. SCHEDULED WORK',
    `  Scheduled scripts configured: ${formatCount(data.scheduled_work.scheduled_scripts_configured)}`,
    `  Scheduler transactions: ${formatCount(data.scheduled_work.scheduler_transactions)}`,
    `  Average scheduler transaction time: ${formatDuration(data.scheduled_work.scheduler_transaction_time.avg_ms)}`,
    `  Maximum scheduler transaction time: ${formatDuration(data.scheduled_work.scheduler_transaction_time.max_ms)}`,
    `  Import sets: ${formatCount(data.scheduled_work.import_sets)}`,
    `  Import rows: ${formatCount(data.scheduled_work.import_rows)}`,
    ...formatDailyImports(data.scheduled_work.daily_import_activity),
    '',
    '4. QUERY AND SECURITY CONTROLS',
    ...formatMetricRows(data.query_and_security_controls),
    '',
    '5. DATA VOLUME',
    ...formatMetricRows(data.data_volume),
    '',
    '6. TRANSACTION DETAIL',
    ...formatTransactions(data.transactions),
  ];
  return `${lines.join('\n')}\n`;
}

function summarizeTransactions(groups) {
  return groups.map(group => {
    const stats = group?.stats || {};
    return {
      type: groupField(group, 'type'),
      count: groupCount(group),
      avg_response_time_ms: metricValue(stats, 'avg', 'response_time'),
      max_response_time_ms: metricValue(stats, 'max', 'response_time'),
    };
  });
}

function stateRows(groups) {
  return groups.map(group => ({ state: groupField(group, 'state'), count: groupCount(group) }));
}

function datesFor(argv) {
  return argv.daily === false ? [] : buildDateList(argv.since, argv.until);
}

export function instanceCmd(wrap) {
  return {
    command: 'instance [subcommand]',
    aliases: ['overview'],
    describe: 'Inspect the current ServiceNow instance',
    builder: y => y.command({
      command: 'glance',
      aliases: ['at-a-glance', 'summary'],
      describe: 'Show a readable instance health and activity report',
      builder: yargs => yargs
        .option('query', { type: 'string', describe: 'Encoded query for activity metrics' })
        .option('since', { type: 'string', describe: 'Activity start date (YYYY-MM-DD)' })
        .option('until', { type: 'string', describe: 'Activity end date (YYYY-MM-DD)' })
        .option('daily', { type: 'boolean', default: true, describe: 'Include daily flow and import rows when dates are supplied' }),
      handler: wrap(async (argv, app) => {
        app.requireInstance();
        const query = buildActivityQuery(argv);
        const dailyDates = datesFor(argv);
        const schedulerQuery = addQuery(query, 'urlLIKEscheduler');
        const [
          dataVolume,
          configured,
          flowTotal,
          flowStates,
          transactions,
          restTransactions,
          tableApi,
          graphql,
          inboundEmail,
          soap,
          schedulerTransactions,
          schedulerStats,
          asyncBusinessRules,
          beforeQueryRules,
          scriptedAcls,
          readAcls,
          writeAcls,
          deleteAcls,
          createAcls,
          executeAcls,
          importSets,
          importRows,
          dailyFlows,
          dailyImportSets,
          dailyImportRows,
        ] = await Promise.all([
          mapWithConcurrency(DATA_VOLUME, DATA_VOLUME_CONCURRENCY, ([label, table]) => safeCount(app.sdk, label, table, '', { timeout: DATA_VOLUME_TIMEOUT })),
          Promise.all(CONFIGURED_AUTOMATION.map(([label, table, tableQuery]) => safeCount(app.sdk, label, table, tableQuery))),
          safeCount(app.sdk, 'flow_executions', 'sys_flow_context', query),
          safeAggregate(app.sdk, 'flow_states', 'sys_flow_context', { query, groupBy: ['state'], count: true }),
          safeAggregate(app.sdk, 'transactions', 'syslog_transaction', { query, groupBy: ['type'], count: true, averageFields: ['response_time'], maximumFields: ['response_time'] }),
          safeCount(app.sdk, 'REST transactions', 'syslog_transaction', addQuery(query, 'type=rest')),
          safeCount(app.sdk, 'Table API URL matches', 'syslog_transaction', addQuery(query, 'urlLIKE/api/now/table/')),
          safeCount(app.sdk, 'GraphQL URL matches', 'syslog_transaction', addQuery(query, 'urlLIKEgraphql')),
          safeCount(app.sdk, 'Inbound email records', 'sys_email', addQuery(query, 'type=received')),
          safeCount(app.sdk, 'SOAP URL matches', 'syslog_transaction', addQuery(query, 'urlLIKEsoap')),
          safeCount(app.sdk, 'Scheduler transactions', 'syslog_transaction', schedulerQuery),
          safeAggregate(app.sdk, 'scheduler_transaction_time', 'syslog_transaction', { query: schedulerQuery, averageFields: ['response_time'], maximumFields: ['response_time'] }),
          safeCount(app.sdk, 'async_business_rules_configured', 'sys_script', 'when=async'),
          safeCount(app.sdk, 'Scripted before-query business rules', 'sys_script', 'when=before^action_query=true'),
          safeCount(app.sdk, 'Scripted access controls', 'sys_security_acl', 'scriptISNOTEMPTY'),
          safeCount(app.sdk, 'Scripted read ACLs', 'sys_security_acl', 'operation=read^scriptISNOTEMPTY'),
          safeCount(app.sdk, 'Scripted write ACLs', 'sys_security_acl', 'operation=write^scriptISNOTEMPTY'),
          safeCount(app.sdk, 'Scripted delete ACLs', 'sys_security_acl', 'operation=delete^scriptISNOTEMPTY'),
          safeCount(app.sdk, 'Scripted create ACLs', 'sys_security_acl', 'operation=create^scriptISNOTEMPTY'),
          safeCount(app.sdk, 'Scripted execute ACLs', 'sys_security_acl', 'operation=execute^scriptISNOTEMPTY'),
          safeCount(app.sdk, 'import_sets', 'sys_import_set', query),
          safeCount(app.sdk, 'import_rows', 'sys_import_set_row', query),
          Promise.all(dailyDates.map(date => safeCount(app.sdk, 'flow_executions', 'sys_flow_context', buildActivityQuery({ since: date, until: date })))),
          Promise.all(dailyDates.map(date => safeCount(app.sdk, 'import_sets', 'sys_import_set', buildActivityQuery({ since: date, until: date })))),
          Promise.all(dailyDates.map(date => safeCount(app.sdk, 'import_rows', 'sys_import_set_row', buildActivityQuery({ since: date, until: date })))),
        ]);

        const inboundMetrics = [restTransactions, tableApi, graphql, inboundEmail, soap];
        const data = {
          window: { query, since: argv.since || null, until: argv.until || null },
          inbound_automation: {
            metrics: inboundMetrics,
            configured: configured.slice(0, 4),
          },
          asynchronous_automation: {
            total_count: flowTotal.count,
            states: stateRows(flowStates.groups),
            async_business_rules_configured: asyncBusinessRules.count,
            daily_flow_executions: dailyDates.map((date, index) => ({ date, count: dailyFlows[index].count })),
          },
          scheduled_work: {
            scheduled_scripts_configured: configured.find(row => row.label === 'Scheduled scripts')?.count ?? null,
            scheduler_transactions: schedulerTransactions.count,
            scheduler_transaction_time: safeStatsResult(schedulerStats),
            import_sets: importSets.count,
            import_rows: importRows.count,
            daily_import_activity: dailyDates.map((date, index) => ({ date, import_sets: dailyImportSets[index].count, import_rows: dailyImportRows[index].count })),
          },
          query_and_security_controls: [beforeQueryRules, scriptedAcls, readAcls, writeAcls, deleteAcls, createAcls, executeAcls],
          data_volume: dataVolume,
          transactions: {
            total_count: transactions.groups.reduce((total, group) => total + groupCount(group), 0),
            types: summarizeTransactions(transactions.groups),
            ...(transactions.unavailable ? { unavailable: transactions.unavailable } : {}),
          },
          context: { instance_url: app.getEffectiveInstance(), timezone: 'UTC' },
        };
        app.ok({ ...data, _formatted: formatInstanceGlance(data) }, {
          summary: `Instance glance for ${app.getEffectiveInstance()}`,
        });
      }),
    }),
    handler: wrap(async (_argv, app) => {
      app.ok({
        command: 'instance',
        subcommands: ['glance'],
        _formatted: 'Run "jsn instance glance" for an instance report.\n',
      }, { summary: 'Instance inspection commands' });
    }),
  };
}