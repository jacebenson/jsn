import { getStringField } from './helpers.js';

export const FLOW_CONTEXT_CANDIDATE_FIELDS = [
  'name', 'flow', 'flow_catalog_model', 'execution_id', 'state', 'status',
  'started', 'start_time', 'started_at', 'ended', 'end_time', 'ended_at', 'completed_on',
  'sys_created_on', 'sys_updated_on', 'duration', 'run_time',
  'execution_duration', 'execution_state', 'wait_for', 'waiting_for', 'error', 'error_message',
  'exception', 'message', 'source_record', 'engine_major_version', 'origins',
  'calling_source',
];

function findValue(record, names) {
  for (const name of names) {
    const result = getStringField(record, name).trim();
    if (result) return { value: result, field: name };
  }
  return { value: '', field: null };
}

function dateValue(input) {
  if (!input) return null;
  const date = new Date(String(input).replace(' ', 'T') + (String(input).includes('Z') ? '' : 'Z'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function secondsFromDuration(input) {
  if (!input) return null;
  if (/^\d+(\.\d+)?$/.test(input)) return Number(input);
  const parts = input.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function isWaiting(status) {
  return /wait|queue|pause|pending/i.test(status);
}

function isRunning(status) {
  return /running|executing|processing/i.test(status);
}

export function normalizeFlowContext(record, { now = new Date() } = {}) {
  const status = findValue(record, ['state', 'status', 'execution_state']);
  const runtimeStarted = findValue(record, ['started', 'start_time', 'started_at']);
  const started = runtimeStarted.value ? runtimeStarted : findValue(record, ['sys_created_on']);
  const ended = findValue(record, ['ended', 'end_time', 'ended_at', 'completed_on']);
  const duration = findValue(record, ['duration', 'run_time', 'execution_duration']);
  const waitFor = findValue(record, ['wait_for', 'waiting_for']);
  const error = findValue(record, ['error', 'error_message', 'exception', 'message']);
  const startedDate = dateValue(started.value);
  const runtimeStartedDate = dateValue(runtimeStarted.value);
  const endedDate = dateValue(ended.value);
  const explicitDuration = secondsFromDuration(duration.value);
  const durationSeconds = explicitDuration ?? (runtimeStartedDate && endedDate ? Math.max(0, (endedDate - runtimeStartedDate) / 1000) : null);
  const ageSeconds = startedDate ? Math.max(0, (new Date(now) - startedDate) / 1000) : null;
  const runtimeAgeSeconds = runtimeStartedDate ? Math.max(0, (new Date(now) - runtimeStartedDate) / 1000) : null;

  return {
    sys_id: findValue(record, ['sys_id']).value,
    flow: findValue(record, ['name', 'flow', 'flow_catalog_model']).value || '(deleted flow)',
    execution_id: findValue(record, ['execution_id']).value,
    status: status.value,
    started: started.value || null,
    ended: ended.value || null,
    duration_seconds: durationSeconds == null ? null : Math.round(durationSeconds),
    waiting_age_seconds: isWaiting(status.value) && ageSeconds != null ? Math.round(ageSeconds) : null,
    execution_age_seconds: isRunning(status.value) && runtimeAgeSeconds != null ? Math.round(runtimeAgeSeconds) : null,
    wait_for: waitFor.value || null,
    error: error.value || null,
    version: findValue(record, ['engine_major_version']).value || null,
    source_record: findValue(record, ['source_record']).value || null,
    field_mapping: {
      status: status.field,
      started: started.field,
      ended: ended.field,
      duration: duration.field || (durationSeconds != null ? 'derived' : null),
      wait_for: waitFor.field,
      error: error.field,
    },
    missing_fields: ['started', 'ended', 'duration'].filter(field => {
      const mapping = { started: started.field, ended: ended.field, duration: duration.field || (durationSeconds != null ? 'derived' : null) };
      return !mapping[field];
    }),
  };
}

export function formatFlowContextSummary(summary) {
  const lines = ['', '▶ FLOW EXECUTIONS', '─'.repeat(72), `  Total matching: ${summary.total_count ?? '(unavailable)'}`, `  Sampled: ${summary.sample_count}`, ''];
  for (const [flow, metrics] of Object.entries(summary.by_flow).sort(([a], [b]) => a.localeCompare(b))) {
    const statuses = Object.entries(metrics.statuses).map(([status, count]) => `${status}: ${count}`).join(', ');
    const duration = metrics.duration_seconds.count > 0
      ? `${metrics.duration_seconds.min}s-${metrics.duration_seconds.max}s, avg ${metrics.duration_seconds.average}s`
      : '(no completed durations)';
    lines.push(`  ${flow} (${metrics.count}${metrics.sampled ? `, ${metrics.sampled} sampled` : ''})`);
    lines.push(`    Status: ${statuses}`);
    lines.push(`    Duration sample: ${duration}`);
    if (metrics.waiting_count > 0) lines.push(`    Waiting sample: ${metrics.waiting_count}`);
  }
  return lines.join('\n') + '\n';
}

export function mergeFlowContextStats(groups, sampledSummary, totalCount) {
  const byFlow = {};
  for (const group of groups || []) {
    const fields = Object.fromEntries((group.groupby_fields || []).map(field => [field.field, field.value]));
    const flow = fields.name || '(deleted flow)';
    const status = fields.state || fields.status || '(unknown)';
    const bucket = byFlow[flow] ||= { count: 0, sampled: 0, statuses: {}, waiting_count: 0, duration_seconds: { count: 0, min: null, max: null, average: null } };
    const count = Number(group.stats?.count ?? 0);
    bucket.count += Number.isFinite(count) ? count : 0;
    bucket.statuses[status] = (bucket.statuses[status] || 0) + (Number.isFinite(count) ? count : 0);
  }
  for (const [flow, sample] of Object.entries(sampledSummary.by_flow)) {
    const bucket = byFlow[flow] ||= { count: 0, sampled: 0, statuses: {}, waiting_count: 0, duration_seconds: { count: 0, min: null, max: null, average: null } };
    bucket.sampled = sample.count;
    if (bucket.count === 0) bucket.count = sample.count;
    bucket.waiting_count = sample.waiting_count;
    bucket.duration_seconds = sample.duration_seconds;
  }
  return { total_count: totalCount, sample_count: sampledSummary.count, by_flow: byFlow };
}

export function buildFlowContextQuery({ record, since, until, query } = {}) {
  const parts = [];
  for (const [label, value, operator] of [['record', record, '='], ['since', since, '>='], ['until', until, '<=']]) {
    if (value == null || value === '') continue;
    if (/[\\^<>=]/.test(value)) throw new Error(`invalid --${label}: use a timestamp or sys_id without query operators`);
    parts.push(`${label === 'record' ? 'source_record' : 'sys_created_on'}${operator}${value}`);
  }
  if (query) parts.push(query);
  parts.push('ORDERBYDESCsys_created_on');
  return parts.join('^');
}

export function summarizeFlowContexts(executions) {
  const byFlow = {};
  for (const execution of executions) {
    const flow = execution.flow || '(deleted flow)';
    const bucket = byFlow[flow] ||= { count: 0, statuses: {}, waiting_count: 0, duration_seconds: { count: 0, min: null, max: null, average: null, _sum: 0 } };
    bucket.count += 1;
    const status = execution.status || '(unknown)';
    bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
    if (execution.waiting_age_seconds != null) bucket.waiting_count += 1;
    if (execution.duration_seconds != null) {
      const stats = bucket.duration_seconds;
      stats.count += 1;
      stats.min = stats.min == null ? execution.duration_seconds : Math.min(stats.min, execution.duration_seconds);
      stats.max = stats.max == null ? execution.duration_seconds : Math.max(stats.max, execution.duration_seconds);
      stats._sum += execution.duration_seconds;
      stats.average = Math.round(stats._sum / stats.count);
    }
  }
  for (const bucket of Object.values(byFlow)) delete bucket.duration_seconds._sum;
  return { count: executions.length, by_flow: byFlow };
}

export async function discoverFlowContextFields(sdk) {
  const fallback = new Set(['sys_id', ...FLOW_CONTEXT_CANDIDATE_FIELDS]);
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `name=sys_flow_context^elementIN${FLOW_CONTEXT_CANDIDATE_FIELDS.join(',')}`);
    params.set('sysparm_fields', 'element');
    params.set('sysparm_limit', '100');
    const dictionary = await sdk.list('sys_dictionary', params);
    const discovered = new Set(['sys_id']);
    for (const row of dictionary) {
      const element = getStringField(row, 'element');
      if (element) discovered.add(element);
    }
    return discovered.size > 1 ? discovered : fallback;
  } catch {
    return fallback;
  }
}
