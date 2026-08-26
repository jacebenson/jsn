import { getStringField } from './helpers.js';

export const FLOW_CONTEXT_CANDIDATE_FIELDS = [
  'name', 'flow', 'flow_catalog_model', 'execution_id', 'state', 'status',
  'started', 'start_time', 'started_at', 'ended', 'end_time', 'ended_at',
  'sys_created_on', 'sys_updated_on', 'duration', 'run_time',
  'execution_duration', 'wait_for', 'waiting_for', 'error', 'error_message',
  'exception', 'message', 'source_record', 'engine_major_version', 'origins',
  'calling_source',
];

function value(record, names) {
  for (const name of names) {
    const result = getStringField(record, name).trim();
    if (result) return result;
  }
  return '';
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
  return /wait|queue|pause|pending|running/i.test(status);
}

export function normalizeFlowContext(record, { now = new Date() } = {}) {
  const status = value(record, ['state', 'status', 'execution_state']);
  const started = value(record, ['started', 'start_time', 'started_at', 'sys_created_on']);
  const ended = value(record, ['ended', 'end_time', 'ended_at', 'completed_on']);
  const startedDate = dateValue(started);
  const endedDate = dateValue(ended);
  const explicitDuration = secondsFromDuration(value(record, ['duration', 'run_time', 'execution_duration']));
  const durationSeconds = explicitDuration ?? (startedDate && endedDate ? Math.max(0, (endedDate - startedDate) / 1000) : null);
  const waitingAgeSeconds = isWaiting(status) && startedDate
    ? Math.max(0, (new Date(now) - startedDate) / 1000)
    : null;
  const error = value(record, ['error', 'error_message', 'exception', 'message']);

  return {
    sys_id: value(record, ['sys_id']),
    flow: value(record, ['name', 'flow', 'flow_catalog_model']) || '(deleted flow)',
    execution_id: value(record, ['execution_id']),
    status,
    started: started || null,
    ended: ended || null,
    duration_seconds: durationSeconds == null ? null : Math.round(durationSeconds),
    waiting_age_seconds: waitingAgeSeconds == null ? null : Math.round(waitingAgeSeconds),
    wait_for: value(record, ['wait_for', 'waiting_for']) || null,
    error: error || null,
    version: value(record, ['engine_major_version']) || null,
    source_record: value(record, ['source_record']) || null,
  };
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
