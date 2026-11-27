// SLA definitions (contract_sla) and the task SLAs (task_sla) on one record, read-only.
// Display labels are presentation only; every lookup and parent check uses raw sys_ids.
import { errNotFound, errUsage } from './errors.js';

const SYS_ID = /^[0-9a-f]{32}$/;
const TABLE = /^[a-z][a-z0-9_]{0,79}$/;
const TASK_LIMIT = 100;
const EMPTY_LIST = 'No readable SLA definitions on this page. ACLs can hide rows, so an empty page does not prove there are none.';
const EMPTY_TASK = 'No readable task SLAs. ACLs can hide rows, so an empty list does not prove there are none.';
const LIST_FIELDS = 'sys_id,name,collection,type,target,duration_type,duration,schedule_source,schedule,schedule_source_field,active,sys_scope';
export const SLA_FIELDS = {
  list: LIST_FIELDS,
  show: `${LIST_FIELDS},relative_duration_works_on,timezone_source,timezone,retroactive,set_start_to,retroactive_pause,start_condition,pause_condition,when_to_resume,resume_condition,stop_condition,reset_condition,reset_action,cancel_condition,when_to_cancel,condition_class,flow,workflow`,
  task: 'sys_id,number,sys_class_name',
  task_sla: 'sys_id,task,sla,stage,has_breached,active,start_time,end_time,planned_end_time,business_duration,business_percentage,business_time_left',
};
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const ref = value => raw(value) ? { sys_id: raw(value), name: shown(value) || null } : null;
const malformed = detail => Object.assign(new Error(`Malformed SLA response: ${detail}`), { code: 'malformed_response' });
const identifierError = what => errUsage(`Provide ${what}, with no ^ or line breaks.`);

async function read(sdk, table, query, fields, limit, offset = 0) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields, sysparm_display_value: 'all', sysparm_limit: String(limit), sysparm_offset: String(offset) }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !SYS_ID.test(raw(row.sys_id)))) throw malformed(`expected ${table} rows with sys_ids`);
  return rows;
}

function definition(row) {
  const relative = ref(row.duration_type);
  return { sys_id: raw(row.sys_id), name: raw(row.name), table: raw(row.collection), type: raw(row.type) || null, target: raw(row.target) || null,
    duration: relative ? null : shown(row.duration) || null, relative_duration: relative,
    schedule_source: raw(row.schedule_source) || null, schedule: ref(row.schedule), schedule_source_field: raw(row.schedule_source_field) || null,
    active: raw(row.active) === 'true', scope: ref(row.sys_scope) };
}

const condition = (row, field) => raw(row[field]) ? { query: raw(row[field]), text: shown(row[field]) } : null;
function fullDefinition(row) {
  const data = definition(row);
  return { ...data, relative_duration_works_on: data.relative_duration ? raw(row.relative_duration_works_on) || null : null,
    timezone_source: raw(row.timezone_source) || null, timezone: raw(row.timezone) || null,
    retroactive_start: raw(row.retroactive) === 'true' ? { set_start_to: raw(row.set_start_to) || null, retroactive_pause: raw(row.retroactive_pause) === 'true' } : null,
    conditions: Object.fromEntries(['start', 'pause', 'resume', 'stop', 'reset', 'cancel'].map(name => [name, condition(row, `${name}_condition`)])),
    when_to_resume: raw(row.when_to_resume) || null, when_to_cancel: raw(row.when_to_cancel) || null, reset_action: raw(row.reset_action) || null,
    condition_class: ref(row.condition_class), flow: ref(row.flow), workflow: ref(row.workflow) };
}

export async function listSlas(sdk, { table, active, limit = 50, offset = 0 } = {}) {
  if (table !== undefined && (typeof table !== 'string' || !TABLE.test(table))) throw errUsage('--table must be a table name such as incident.');
  if (active !== undefined && typeof active !== 'boolean') throw errUsage('--active is a flag: --active or --no-active.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 201) throw errUsage('--offset must be a nonnegative safe integer.');
  const query = [table && `collection=${table}`, active !== undefined && `active=${active}`, 'ORDERBYname^ORDERBYsys_id'].filter(Boolean).join('^');
  const rows = await read(sdk, 'contract_sla', query, SLA_FIELDS.list, limit + 1, offset);
  const records = rows.slice(0, limit).map(definition);
  const hasMore = rows.length > limit;
  return { records, count: records.length, pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null }, ...(records.length ? {} : { visibility: EMPTY_LIST }) };
}

export async function showSla(sdk, identifier) {
  if (typeof identifier !== 'string' || !identifier.trim() || /[\^\r\n]/.test(identifier)) throw identifierError('an SLA definition name or 32-character sys_id');
  const bySysId = SYS_ID.test(identifier);
  const rows = await read(sdk, 'contract_sla', bySysId ? `sys_id=${identifier}` : `name=${identifier}^ORDERBYsys_id`, SLA_FIELDS.show, 2);
  if (!rows.length) throw errNotFound('SLA definition', identifier);
  if (rows.length > 1) throw errUsage(`More than one SLA definition is named ${identifier} (${rows.map(row => raw(row.sys_id)).join(', ')}). Pass a sys_id.`);
  if (bySysId && raw(rows[0].sys_id) !== identifier) throw malformed(`contract_sla returned a different record than ${identifier}`);
  return fullDefinition(rows[0]);
}

// task_sla.task references task, so task resolves a record of any task class by number or sys_id.
export async function findTask(sdk, identifier) {
  if (typeof identifier !== 'string' || !identifier.trim() || /[\^\r\n]/.test(identifier)) throw identifierError('a task number such as INC0010001, or a 32-character task sys_id');
  const bySysId = SYS_ID.test(identifier);
  const rows = await read(sdk, 'task', `${bySysId ? 'sys_id' : 'number'}=${identifier}^ORDERBYsys_id`, SLA_FIELDS.task, 2);
  if (!rows.length) throw errNotFound('task', identifier);
  if (rows.length > 1) throw errUsage(`More than one task is numbered ${identifier} (${rows.map(row => `${raw(row.sys_class_name)} ${raw(row.sys_id)}`).join(', ')}). Pass a sys_id.`);
  const [row] = rows;
  if (bySysId ? raw(row.sys_id) !== identifier : raw(row.number).toLowerCase() !== identifier.toLowerCase()) throw malformed(`task returned a different record than ${identifier}`);
  return { sys_id: raw(row.sys_id), number: raw(row.number), table: raw(row.sys_class_name) };
}

const percent = value => raw(value) === '' || !Number.isFinite(Number(raw(value))) ? null : Number(raw(value));
// The 2010 engine kept a breach in stage rather than has_breached. An unreadable flag is null, never false.
const taskSla = row => ({ sys_id: raw(row.sys_id), definition: ref(row.sla), stage: raw(row.stage) || null,
  has_breached: raw(row.stage) === 'breached' || raw(row.has_breached) === 'true' || (raw(row.has_breached) === 'false' ? false : null), active: raw(row.active) === 'true',
  start_time: raw(row.start_time) || null, end_time: raw(row.end_time) || null, planned_end_time: raw(row.planned_end_time) || null,
  business_elapsed: shown(row.business_duration) || null, business_percentage: percent(row.business_percentage), business_time_left: shown(row.business_time_left) || null });

export async function taskSlas(sdk, identifier) {
  const task = await findTask(sdk, identifier);
  const rows = await read(sdk, 'task_sla', `task=${task.sys_id}^ORDERBYstart_time^ORDERBYsys_id`, SLA_FIELDS.task_sla, TASK_LIMIT + 1);
  if (rows.some(row => raw(row.task) !== task.sys_id)) throw malformed(`a task_sla row belongs to another task than ${task.sys_id}`);
  const records = rows.slice(0, TASK_LIMIT).map(taskSla);
  return { task, records, count: records.length, breached: records.filter(row => row.has_breached).length, breach_unknown: records.filter(row => row.has_breached === null).length,
    more: rows.length > TASK_LIMIT, ...(records.length ? {} : { visibility: EMPTY_TASK }) };
}

const CANCEL = { no_match: 'when the start condition stops matching', on_condition: 'when the cancel condition matches', never: 'never' };
const RESUME = { no_match: 'when the pause condition stops matching', on_condition: 'when the resume condition matches' };
const named = r => r ? `${r.name || '(not readable)'} [${r.sys_id}]` : '(none)';
function scheduleText(d) {
  if (d.schedule_source === 'no_schedule') return 'no schedule (24x7)';
  if (d.schedule_source === 'task_field') return `the schedule in task field ${d.schedule_source_field || '(none)'}`;
  return d.schedule ? `schedule ${d.schedule.name || d.schedule.sys_id}` : 'no schedule set';
}
const durationText = d => d.relative_duration ? `relative duration ${d.relative_duration.name || d.relative_duration.sys_id}` : d.duration || 'no duration';
const definitionLine = d => `${d.name} [${d.sys_id}]${d.active ? '' : ' (inactive)'}: ${d.table}, ${d.type || 'no type'}${d.target ? ` (${d.target})` : ''}, ${durationText(d)} on ${scheduleText(d)}; scope ${d.scope?.name || d.scope?.sys_id || 'unknown'}`;
const conditionLine = (label, c) => `  ${label}: ${c ? `${c.text || c.query} (${c.query})` : '(none)'}`;

function showLines(d) {
  const c = d.conditions;
  return [definitionLine(d),
    ...(d.relative_duration ? [`  Relative duration works on: ${d.relative_duration_works_on || 'unknown'}`] : []),
    `  Time zone source: ${d.timezone_source || '(none)'}${d.timezone ? ` (${d.timezone})` : ''}`,
    `  Retroactive start: ${d.retroactive_start ? `yes, from ${d.retroactive_start.set_start_to || '(no field)'}${d.retroactive_start.retroactive_pause ? ', with retroactive pause time' : ''}` : 'no'}`,
    conditionLine('Start', c.start), `  Cancels ${CANCEL[d.when_to_cancel] || d.when_to_cancel || 'when the start condition stops matching'}`,
    ...(d.when_to_cancel === 'on_condition' ? [conditionLine('Cancel', c.cancel)] : []),
    conditionLine('Pause', c.pause), `  Resumes ${RESUME[d.when_to_resume] || d.when_to_resume || 'when the pause condition stops matching'}`,
    ...(d.when_to_resume === 'on_condition' ? [conditionLine('Resume', c.resume)] : []),
    conditionLine('Stop', c.stop),
    `${conditionLine('Reset', c.reset)}${c.reset ? `; ${d.reset_action === 'complete' ? 'completes' : 'cancels'} the running task SLA and attaches a new one` : ''}`,
    `  Condition class: ${d.condition_class ? named(d.condition_class) : 'default (com.snc.sla.default_conditionclass)'}`,
    `  Flow: ${named(d.flow)}`, ...(d.workflow ? [`  Workflow: ${named(d.workflow)}`] : [])];
}

function taskSlaLines(t) {
  const percentText = t.business_percentage === null ? '' : ` (${t.business_percentage}%)`;
  return [`  ${named(t.definition)}: ${(t.stage || 'no stage').replace(/_/g, ' ')}, ${t.has_breached ? 'breached' : t.has_breached === false ? 'not breached' : 'breach unknown'}${t.active ? '' : ', inactive'}`,
    `    started ${t.start_time || '(none)'}, breach ${t.planned_end_time || '(none)'}${t.end_time ? `, stopped ${t.end_time}` : ''}; business elapsed ${t.business_elapsed || '(none)'}${percentText}, ${t.business_time_left || '(none)'} left`];
}

export function formatSlas(data, mode) {
  if (mode === 'show') return ['SLA definition (read-only)', ...showLines(data)].join('\n');
  if (mode === 'task') {
    const lines = [`Task SLAs on ${data.task.number || data.task.sys_id} (${data.task.table}) [${data.task.sys_id}] (read-only; times in UTC)`, ...data.records.flatMap(taskSlaLines)];
    if (!data.count) lines.push(EMPTY_TASK);
    if (data.more) lines.push(`More than ${TASK_LIMIT} task SLAs; only the first ${TASK_LIMIT} by start time are shown.`);
    return lines.join('\n');
  }
  const lines = ['SLA definitions (read-only)', ...data.records.map(d => `  ${definitionLine(d)}`)];
  if (!data.count) lines.push(EMPTY_LIST);
  lines.push(`Page: ${data.count} definition(s), offset ${data.pagination.offset}${data.pagination.has_more ? `; more available, next offset ${data.pagination.next_offset}` : '; no further readable rows'}.`);
  return lines.join('\n');
}
