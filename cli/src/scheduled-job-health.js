// Scheduler health and one job's "why didn't it run": read-only, from
// sys_trigger (the scheduler's queue), sysauto_script (the job definitions,
// whose child classes share the table), sys_cluster_state (the live nodes),
// sys_scheduler_job_history (15-minute run windows, kept 7 days) and
// syslog_transaction (scheduler rows, response_time in ms).
// Nothing here runs, recovers or changes a job.

import { errUsage, errNotFoundHint } from './errors.js';

// Node-group template rows: their next_action stays stale by design; per-node children carry `parent`.
export const NODE_GROUPS = ['ALL NODES', 'ACTIVE NODES', 'PRIMARY NODES'];
export const OVERDUE_MINUTES = 60;
export const LONG_RUN_MS = 3600000;
const STARTUP = '9';
const DISABLED = '2';
const PAUSED = '-1776';
const ERROR_STATES = ['-1', '-2'];
const MAX_NODES = 200;
const MAX_ROWS = 20;
const HISTORY_WINDOWS = 8;
const LONG_RUNS = 5;
const TRIGGER_FIELDS = 'sys_id,name,state,next_action,system_id,claimed_by,trigger_type,document,document_key,job_classification,last_error,error_count,run_count,parent';
const JOB_FIELDS = 'sys_id,name,active,run_as,run_type,run_start,conditional,sys_class_name';
const LONG_FIELDS = 'sys_id,sys_created_on,url,response_time,system_id';
const HISTORY_FIELDS = 'job_classification,time_range_start,time_range_end,count,average,max_duration,avg_lateness,max_lateness';
const LONG_QUERY = `type=scheduler^response_time>${LONG_RUN_MS}^sys_created_on>=javascript:gs.daysAgoStart(7)^ORDERBYDESCsys_created_on`;
const SYS_ID = /^[0-9a-f]{32}$/;

const raw = (row, field) => {
  const value = row?.[field];
  return String((value && typeof value === 'object' ? value.value : value) ?? '');
};
const display = (row, field) => {
  const value = row?.[field];
  return String((value && typeof value === 'object' ? value.display_value : value) ?? '');
};
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const malformed = table => Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
const identity = table => new Error(`${table} returned a different record identity.`);
// Raw glide_date_time values are UTC "YYYY-MM-DD HH:MM:SS".
const minutesSince = (value, now) => {
  const at = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(at) ? null : Math.floor((now - at) / 60000);
};
// An encoded query cannot carry ^ or a line break inside a value.
const queryable = (value, what) => {
  if (/[\^\r\n]/.test(value)) throw errUsage(`${what} "${value}" contains ^ or a line break, which an encoded query cannot carry.`);
  return value;
};

async function read(sdk, table, query, fields, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: 'all' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(table);
  return rows;
}

async function bounded(sdk, table, query, fields, limit, map) {
  const rows = await read(sdk, table, query, fields, limit + 1);
  return { items: rows.slice(0, limit).map(map), truncated: rows.length > limit };
}

async function readNodes(sdk) {
  const rows = await read(sdk, 'sys_cluster_state', 'ORDERBYsystem_id', 'system_id,status', MAX_NODES + 1);
  // Every instance has at least one node row; none is an ACL-filtered read, and judging nodes from it would call every pinned job dead.
  if (!rows.length) throw errUsage('No node rows were readable in sys_cluster_state (reading it needs admin); scheduler health was not computed.');
  if (rows.length > MAX_NODES) throw errUsage(`More than ${MAX_NODES} sys_cluster_state rows; scheduler health was not computed.`);
  return rows.map(row => ({ system_id: raw(row, 'system_id'), status: raw(row, 'status') }));
}

const liveNodes = nodes => nodes.filter(node => node.status === 'online').map(node => node.system_id);

function trigger(row) {
  return {
    sys_id: raw(row, 'sys_id'), name: raw(row, 'name'), state: raw(row, 'state'), state_label: display(row, 'state'),
    next_action: raw(row, 'next_action'), system_id: raw(row, 'system_id'), claimed_by: raw(row, 'claimed_by'),
    trigger_type: raw(row, 'trigger_type'), trigger_type_label: display(row, 'trigger_type'),
    document: raw(row, 'document'), document_key: raw(row, 'document_key'), job_classification: raw(row, 'job_classification'),
    last_error: raw(row, 'last_error'), error_count: Number(raw(row, 'error_count')) || 0, run_count: Number(raw(row, 'run_count')) || 0, parent: raw(row, 'parent'),
  };
}

function longRun(row) {
  return { sys_id: raw(row, 'sys_id'), logged: raw(row, 'sys_created_on'), job: raw(row, 'url').replace(/^JOB: /, ''), response_time_ms: Number(raw(row, 'response_time')), system_id: raw(row, 'system_id') };
}

function nodeStatus(nodes, systemId) {
  return nodes.find(node => node.system_id === systemId)?.status || 'missing';
}

// Pinned to a node that is not live (a parent job, not a startup job). The dashboard's Stuck Jobs counts missing nodes only; an offline node is flagged too.
function pinnedToDeadNode(item, live) {
  return Boolean(item.system_id) && !NODE_GROUPS.includes(item.system_id) && !live.includes(item.system_id) && !item.parent && item.trigger_type !== STARTUP;
}

export async function readSchedulerHealth(sdk, { limit = 20, now = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw errUsage('--limit must be an integer from 1 to 500.');
  const nodes = await readNodes(sdk);
  const live = liveNodes(nodes);
  // Grouped as two ^NQ branches: the platform reads a bare ^OR as a new branch, so
  // `term^term^term^ORsystem_idISEMPTY` would match every trigger with no node and
  // skip the state, time and type filters entirely.
  const overdueFilter = `stateIN0,2^next_action<javascript:gs.minutesAgoStart(${OVERDUE_MINUTES})^trigger_typeNOT IN${DISABLED},${STARTUP}`;
  const overdue = await bounded(sdk, 'sys_trigger',
    `${overdueFilter}^system_idNOT IN${NODE_GROUPS.join(',')}^NQ${overdueFilter}^system_idISEMPTY^ORDERBYnext_action`,
    TRIGGER_FIELDS, limit, row => ({ ...trigger(row), late_minutes: minutesSince(raw(row, 'next_action'), now) }));
  const erroring = await bounded(sdk, 'sys_trigger', 'stateIN-1,-2^ORerror_count>0^ORDERBYDESCsys_updated_on', TRIGGER_FIELDS, limit, trigger);
  const dead = await bounded(sdk, 'sys_trigger',
    `system_idISNOTEMPTY^system_idNOT IN${[...NODE_GROUPS, ...live].join(',')}^parentISEMPTY^trigger_type!=${STARTUP}^ORDERBYsystem_id`,
    TRIGGER_FIELDS, limit, row => ({ ...trigger(row), node_status: nodeStatus(nodes, raw(row, 'system_id')) }));
  dead.items = dead.items.filter(item => pinnedToDeadNode(item, live));
  const runAs = await bounded(sdk, 'sysauto_script', 'active=true^run_as.active=false^ORDERBYname', JOB_FIELDS, limit,
    row => ({ sys_id: raw(row, 'sys_id'), name: raw(row, 'name'), run_as: raw(row, 'run_as'), run_as_name: display(row, 'run_as'), run_type: raw(row, 'run_type') }));
  const long = await bounded(sdk, 'syslog_transaction', LONG_QUERY, LONG_FIELDS, limit, longRun);
  // A trigger can be overdue, erroring and on a dead node at once; count it once.
  const flagged = new Set([overdue, erroring, dead].flatMap(part => part.items.map(item => item.sys_id))).size + runAs.items.length + long.items.length;
  return { nodes, overdue_minutes: OVERDUE_MINUTES, long_run_ms: LONG_RUN_MS, limit, overdue, erroring, dead_node: dead, inactive_run_as: runAs, long_running: long, flagged };
}

async function resolveJob(sdk, name) {
  const field = SYS_ID.test(name) ? 'sys_id' : 'name';
  const rows = await read(sdk, 'sysauto_script', `${field}=${name}`, JOB_FIELDS, MAX_ROWS + 1);
  if (rows.some(row => !same(raw(row, field), name))) throw identity('sysauto_script');
  if (rows.length > 1) throw errUsage(`More than one scheduled job is named "${name}": ${rows.map(row => raw(row, 'sys_id')).join(', ')}. Pass a sys_id.`);
  if (!rows.length) return null;
  const row = rows[0];
  return { sys_id: raw(row, 'sys_id'), name: raw(row, 'name'), class: raw(row, 'sys_class_name'), active: raw(row, 'active') === 'true', run_type: raw(row, 'run_type'),
    run_start: raw(row, 'run_start'), run_as: raw(row, 'run_as'), run_as_name: display(row, 'run_as'), conditional: raw(row, 'conditional') === 'true' };
}

async function readTriggers(sdk, job, name) {
  const field = job ? 'document_key' : SYS_ID.test(name) ? 'sys_id' : 'name';
  const key = job ? job.sys_id : name;
  const rows = await read(sdk, 'sys_trigger', `${field}=${key}^ORDERBYparent`, TRIGGER_FIELDS, MAX_ROWS + 1);
  if (rows.some(row => !same(raw(row, field), key))) throw new Error(job ? 'sys_trigger returned a row for another job.' : identity('sys_trigger').message);
  if (rows.length > MAX_ROWS) throw errUsage(`More than ${MAX_ROWS} sys_trigger rows match "${name}"; pass the job's sys_id.`);
  return rows.map(trigger);
}

async function readRunAs(sdk, id) {
  const rows = await read(sdk, 'sys_user', `sys_id=${id}`, 'sys_id,user_name,active', 1);
  if (!rows.length) return { sys_id: id, missing: true };
  if (raw(rows[0], 'sys_id') !== id) throw identity('sys_user');
  return { sys_id: id, user_name: raw(rows[0], 'user_name'), active: raw(rows[0], 'active') === 'true' };
}

async function readHistory(sdk, classification) {
  if (!(await read(sdk, 'sys_db_object', 'name=sys_scheduler_job_history', 'name', 1)).length) return { available: false, classification, windows: [] };
  const rows = await read(sdk, 'sys_scheduler_job_history', `job_classification=${queryable(classification, 'Job classification')}^ORDERBYDESCtime_range_start`, HISTORY_FIELDS, HISTORY_WINDOWS);
  if (rows.some(row => !same(raw(row, 'job_classification'), classification))) throw new Error('sys_scheduler_job_history returned a row for another job classification.');
  const number = (row, field) => Number(raw(row, field));
  return { available: true, classification, windows: rows.map(row => ({ start: raw(row, 'time_range_start'), end: raw(row, 'time_range_end'), runs: number(row, 'count'),
    average_ms: number(row, 'average'), max_ms: number(row, 'max_duration'), average_wait_ms: number(row, 'avg_lateness'), max_wait_ms: number(row, 'max_lateness') })) };
}

function triggerFindings(item, nodes, live, now) {
  const label = `Trigger ${item.name} (${item.sys_id})`;
  if (item.trigger_type === DISABLED) return [{ code: 'trigger_disabled', message: `${label} has trigger type Disabled, so it never fires.` }];
  if (item.state === PAUSED) return [{ code: 'paused', message: `${label} is Paused; the scheduler skips it until it is resumed.` }];
  const out = [];
  if (ERROR_STATES.includes(item.state)) out.push({ code: 'error_state', message: `${label} is in state ${item.state_label || item.state}${item.last_error ? `; last error: ${item.last_error}` : ''}.` });
  else if (item.error_count) out.push({ code: 'errors_recorded', message: `${label} has recorded ${item.error_count} error(s)${item.last_error ? `; last error: ${item.last_error}` : ''}.` });
  if (NODE_GROUPS.includes(item.system_id) || item.trigger_type === STARTUP) return out;
  const late = minutesSince(item.next_action, now);
  if (['0', '2'].includes(item.state) && late !== null && late > OVERDUE_MINUTES) out.push({ code: 'overdue', message: `${label} is ${item.state_label || item.state}, and its next action (${item.next_action} UTC) is ${late} minutes past.` });
  if (pinnedToDeadNode(item, live)) {
    const status = nodeStatus(nodes, item.system_id);
    out.push({ code: 'dead_node', message: `${label} is pinned to node ${item.system_id}, which ${status === 'missing' ? 'is not in sys_cluster_state' : `sys_cluster_state shows as ${status}`}; only that node would run it.` });
  }
  return out;
}

function whyFindings({ job, triggers, run_as: runAs, nodes, long_runs: longRuns, long_runs_truncated: more }, now) {
  if (job && !job.active) return [{ code: 'job_inactive', message: 'The job is inactive, so the scheduler does not run it.' }];
  if (job && !triggers.length) {
    if (job.run_type === 'on_demand') return [{ code: 'on_demand', message: 'The job runs on demand only; it has no sys_trigger row until someone runs it.' }];
    if (job.run_type === 'once') return [{ code: 'ran_once', message: 'The job runs once; the platform removes its sys_trigger row after that run, so it will not run again.' }];
    return [{ code: 'no_trigger', message: `No sys_trigger row points at this job, so the scheduler has nothing to run (run type ${job.run_type}).` }];
  }
  const live = liveNodes(nodes);
  const out = triggers.flatMap(item => triggerFindings(item, nodes, live, now));
  if (runAs?.missing) out.push({ code: 'run_as_missing', message: `Run as points at sys_user ${runAs.sys_id}, which was not found or not readable.` });
  else if (runAs && !runAs.active) out.push({ code: 'inactive_run_as', message: `Run as user ${runAs.user_name} is inactive.` });
  if (job?.conditional) out.push({ code: 'conditional', message: 'The job is conditional: it runs only when its condition script returns true. jsn does not evaluate the condition.' });
  if (longRuns.length) {
    const longest = Math.round(Math.max(...longRuns.map(run => run.response_time_ms)) / 60000);
    out.push({ code: 'long_run', message: more ? `More than ${longRuns.length} runs in the last 7 days took over an hour; the longest of the newest ${longRuns.length} took ${longest} minutes.` : `${longRuns.length} run(s) in the last 7 days took over an hour; the longest took ${longest} minutes.` });
  }
  return out;
}

export async function explainScheduledJob(sdk, name, { now = Date.now() } = {}) {
  name = typeof name === 'string' ? name.trim() : '';
  if (!name || name.length > 200 || /[\^\r\n]/.test(name)) throw errUsage('Provide a scheduled job name or sys_id (no ^ or line breaks, at most 200 characters).');
  // Nodes first: an empty sys_cluster_state means this identity cannot read scheduler tables, so empty job or trigger reads would prove nothing.
  const nodes = await readNodes(sdk);
  const job = await resolveJob(sdk, name);
  const triggers = await readTriggers(sdk, job, name);
  if (!job && !triggers.length) throw errNotFoundHint('Scheduled job', name, 'No scheduled job or sys_trigger row has that name or sys_id. List jobs with: jsn scheduledjobs list');
  const runAs = job?.run_as ? await readRunAs(sdk, job.run_as) : null;
  const classification = triggers.find(item => item.job_classification)?.job_classification;
  const history = classification ? await readHistory(sdk, classification) : null;
  const jobName = queryable(triggers[0]?.name || job.name, 'Job name');
  const longRows = await read(sdk, 'syslog_transaction', LONG_QUERY.replace('^response_time', `^url=JOB: ${jobName}^response_time`), LONG_FIELDS, LONG_RUNS + 1);
  const data = { query: name, job, triggers, run_as: runAs, nodes, history, long_runs: longRows.slice(0, LONG_RUNS).map(longRun), long_runs_truncated: longRows.length > LONG_RUNS };
  return { ...data, findings: whyFindings(data, now) };
}

const pad = (rows) => {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, detail]) => `    ${name.padEnd(width)}  ${detail}`);
};
const minutes = ms => `${Math.round(ms / 60000)} min`;

export function formatSchedulerHealth(data) {
  const live = liveNodes(data.nodes);
  const section = (title, part, line) => [
    `  ${title} (${part.items.length}${part.truncated ? ', more not shown' : ''})`,
    ...(part.items.length ? pad(part.items.map(line)) : ['    none']),
  ];
  return [
    'Scheduler health',
    `  Nodes: ${live.length} of ${data.nodes.length} node(s) online${live.length ? ` (${live.join(', ')})` : ''}`,
    ...section(`Overdue by more than ${data.overdue_minutes} minutes`, data.overdue, item => [item.name, `${item.state_label}, next action ${item.next_action} UTC${item.late_minutes === null ? '' : `, ${item.late_minutes} min late`}`]),
    ...section('Erroring', data.erroring, item => [item.name, `${item.state_label}, ${item.error_count} error(s)${item.last_error ? `: ${item.last_error}` : ''}`]),
    ...section('Pinned to a dead node', data.dead_node, item => [item.name, `${item.system_id} (${item.node_status})`]),
    ...section('Running as an inactive user', data.inactive_run_as, item => [item.name, item.run_as_name || item.run_as]),
    ...section('Scheduler runs over an hour, last 7 days', data.long_running, item => [item.job, `${minutes(item.response_time_ms)}, logged ${item.logged} UTC on ${item.system_id}`]),
    data.flagged ? `${data.flagged} flagged. Explain one: jsn scheduledjobs why "<name>"` : 'Nothing flagged.',
  ].join('\n');
}

export function formatScheduledJobWhy(data) {
  const lines = [];
  if (data.job) {
    const runAs = data.run_as ? `${data.run_as.user_name || data.run_as.sys_id}${data.run_as.missing ? ' (not found)' : data.run_as.active ? '' : ' (inactive)'}` : 'system';
    lines.push(`Scheduled job: ${data.job.name} (${data.job.sys_id})`,
      `  Class        ${data.job.class}`, `  Active       ${data.job.active}`, `  Run type     ${data.job.run_type}`, `  Run as       ${runAs}`, `  Conditional  ${data.job.conditional}`);
  } else lines.push(`Trigger: ${data.triggers[0].name} (no scheduled job definition found)`);
  lines.push(`Triggers (${data.triggers.length})`, ...(data.triggers.length ? pad(data.triggers.map(item => [item.name,
    `${item.state_label}, ${item.trigger_type_label}, next ${item.next_action || '(none)'} UTC${item.system_id ? `, node ${item.system_id}` : ''}${item.error_count ? `, ${item.error_count} error(s)` : ''}`])) : ['    none']));
  if (data.history) {
    lines.push(`History (${data.history.classification})`);
    if (!data.history.available) lines.push('    sys_scheduler_job_history is not on this instance');
    else lines.push(...(data.history.windows.length ? data.history.windows.map(w => `    ${w.start} UTC  ${w.runs} run(s), average ${w.average_ms} ms, max ${w.max_ms} ms, average wait ${w.average_wait_ms} ms`) : ['    no runs in the last 7 days']));
  }
  if (data.long_runs.length) lines.push(`Runs over an hour, last 7 days (${data.long_runs.length}${data.long_runs_truncated ? ', more not shown' : ''})`, ...data.long_runs.map(run => `    ${run.logged} UTC  ${minutes(run.response_time_ms)} on ${run.system_id}`));
  lines.push('Findings', ...(data.findings.length ? data.findings.map(f => `  - ${f.code}: ${f.message}`) : ['  No cause found in the trigger, node, run-as user or history.']));
  return lines.join('\n');
}
