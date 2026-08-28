import { parseNodeStatsXml } from './commands/platform.js';

function valueOf(value) {
  if (value && typeof value === 'object') return value.value ?? value.display_value;
  return value;
}

function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

async function platform(sdk) {
  const rows = await sdk.list('sys_cluster_state', { sysparm_fields: 'sys_id,status,node_type,node_stats', sysparm_limit: '100' });
  const nodes = [];
  for (const row of rows) {
    const id = valueOf(row.node_stats);
    if (!id) continue;
    const stats = await sdk.get('sys_cluster_node_stats', id);
    nodes.push({
      sys_id: valueOf(row.sys_id),
      status: valueOf(row.status),
      node_type: valueOf(row.node_type),
      stats: parseNodeStatsXml(stats?.stats || ''),
    });
  }
  return { metrics: { node_count: nodes.length, nodes }, security: { raw_xml: 'excluded', log_content: 'excluded' } };
}

async function transactions(sdk) {
  const query = 'sys_created_on>=javascript:gs.daysAgoStart(1)';
  const result = await sdk.aggregate('syslog_transaction', { query, groupBy: ['type'], count: true, averageFields: ['response_time'], minimumFields: ['response_time'], maximumFields: ['response_time'] });
  const types = (result?.groups || []).map(group => {
    const type = group.groupby_fields?.find(f => f.field === 'type')?.value || 'unknown';
    const stats = group.stats || {};
    const metric = (name, field) => numeric(typeof stats[name] === 'object' ? stats[name]?.[field] : stats[name]);
    return { type, count: numeric(stats.count) ?? 0, avg_response_time_ms: metric('avg', 'response_time'), min_response_time_ms: metric('min', 'response_time'), max_response_time_ms: metric('max', 'response_time') };
  });
  return { query, metrics: { transaction_types: types } };
}

async function logSummary(sdk) {
  const result = await sdk.aggregate('syslog', { query: 'sys_created_on>=javascript:gs.daysAgoStart(1)', groupBy: ['source', 'level'], count: true });
  const groups = (result?.groups || []).map(group => ({
    source: group.groupby_fields?.find(f => f.field === 'source')?.value || '',
    severity: group.groupby_fields?.find(f => f.field === 'level')?.value || '',
    count: numeric(group.stats?.count) ?? 0,
  }));
  return { query: 'sys_created_on>=javascript:gs.daysAgoStart(1)', metrics: { log_groups: groups }, security: { content: 'excluded' } };
}

async function countTables(sdk, tables) {
  const counts = {};
  for (const table of tables) counts[table] = await sdk.aggregateCount(table, 'sys_created_on>=javascript:gs.daysAgoStart(1)');
  return { metrics: { counts } };
}

async function flows(sdk) {
  const query = 'sys_created_on>=javascript:gs.daysAgoStart(1)';
  const result = await sdk.aggregate('sys_flow_context', { query, groupBy: ['state'], count: true, averageFields: ['duration'] });
  const states = (result?.groups || []).map(group => ({
    state: group.groupby_fields?.find(f => f.field === 'state')?.value || 'unknown',
    count: numeric(group.stats?.count) ?? 0,
    avg_duration: numeric(group.stats?.avg?.duration),
  }));
  return { query, metrics: { flow_states: states } };
}

async function eventQueue(sdk) {
  const result = await sdk.aggregate('sysevent', { query: 'stateINready,processing,error^sys_created_on>=javascript:gs.daysAgoStart(1)', groupBy: ['state'], count: true });
  const states = (result?.groups || []).map(group => ({
    state: group.groupby_fields?.find(f => f.field === 'state')?.value || 'unknown',
    count: numeric(group.stats?.count),
  }));
  return { query: 'stateINready,processing,error^sys_created_on>=javascript:gs.daysAgoStart(1)', metrics: { event_queue: states } };
}

const COLLECTORS = [
  ['platform_health', platform],
  ['transactions', transactions],
  ['error_warning_summary', logSummary],
  ['event_queue', eventQueue],
  ['ecc_queue', (sdk) => countTables(sdk, ['ecc_queue'])],
  ['flow_executions', flows],
  ['record_counts', (sdk) => countTables(sdk, ['incident', 'change_request', 'problem'])],
  ['scheduled_and_cleanup', (sdk) => countTables(sdk, ['sys_trigger', 'sysauto_script'])],
];

function statusForError(err) {
  const message = String(err?.message || err);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/permission|forbidden|access denied|401|403/i.test(message)) return 'permission_denied';
  if (/not found|does not exist|invalid table|404/i.test(message)) return 'unsupported';
  if (/network|fetch|connect/i.test(message)) return 'unavailable';
  return 'query_failure';
}

async function runCollector(name, fn, sdk) {
  const start = new Date().toISOString();
  try {
    const data = await fn(sdk);
    return { name, status: 'success', reason: null, start_time: start, finish_time: new Date().toISOString(), data };
  } catch (err) {
    return { name, status: statusForError(err), reason: String(err?.message || err), start_time: start, finish_time: new Date().toISOString(), data: null };
  }
}

export async function capturePerformance({ sdk }) {
  const collectors = await Promise.all(COLLECTORS.map(([name, fn]) => runCollector(name, fn, sdk)));
  return { status: collectors.every(c => c.status === 'success') ? 'complete' : 'incomplete', collectors };
}
