import { errNotFound, errUsage } from './errors.js';

const fields = {
  sys_flow_context: 'sys_id,name,flow,snapshot,state,error_state,error_message,reporting,run_time,sys_created_on,source_table,source_record,is_test_run,attributes',
  sys_hub_flow: 'sys_id,name,latest_snapshot',
  sys_hub_action_type_definition: 'sys_id,name,latest_snapshot',
  sys_flow_log: 'sys_id,context,level,action,message,sys_created_on',
  sys_hub_step_instance: 'sys_id,label,order,step_type',
  sys_hub_action_instance_v2: 'sys_id,action_type,order,comment',
};
const LOG_LIMIT = 20;
// sys_flow_log.level choices: -1 Debug, 0 Information, 1 Warning, 2 Error.
const ERROR_LEVEL = '2';
// The instance's own default for com.snc.process_flow.reporting.serialized.val_size_limit.
const VALUE_LIMIT = 16384;
// Basic keeps runtime states and durations only; Full and Trace also keep input and output values.
const VALUES_KEPT = { OFF: false, BASIC: false, FULL: true, TRACE: true };
// Display labels are presentation only. Never use them as join keys.
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const stripHtml = value => value.replace(/<[^>]+>/g, '');

async function read(sdk, table, query, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields[table], sysparm_limit: String(limit), sysparm_display_value: 'all' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  return rows;
}
async function byIds(sdk, table, ids) {
  const rows = await read(sdk, table, `sys_idIN${ids.join(',')}`, ids.length);
  if (rows.some(row => !ids.includes(raw(row.sys_id)))) throw new Error(`${table} returned a different record identity.`);
  return new Map(rows.map(row => [raw(row.sys_id), row]));
}
function parseAttributes(value) {
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

export async function showFlowExecution(sdk, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) throw errUsage('Provide the execution as a 32-character hexadecimal sys_id from jsn flows executions.');
  const context = (await byIds(sdk, 'sys_flow_context', [id])).get(id);
  if (!context) throw errNotFound('Flow execution (sys_flow_context)', id);
  const attributes = parseAttributes(raw(context.attributes));
  const type = attributes.type || null;
  const definitionTable = type === 'ACTION' ? 'sys_hub_action_type_definition' : 'sys_hub_flow';
  const definitionId = raw(context.flow);
  const [definitions, logRows] = await Promise.all([
    /^[0-9a-f]{32}$/i.test(definitionId) ? byIds(sdk, definitionTable, [definitionId]) : new Map(),
    read(sdk, 'sys_flow_log', `context=${id}^level=${ERROR_LEVEL}^ORDERBYorder^ORDERBYsys_id`, LOG_LIMIT + 1),
  ]);
  if (logRows.some(row => raw(row.context) !== id)) throw new Error('sys_flow_log returned rows with a mismatched context.');
  const definition = definitions.get(definitionId);
  const snapshot = raw(context.snapshot) || null;
  const latest = definition ? raw(definition.latest_snapshot) || null : null;
  const records = logRows.slice(0, LOG_LIMIT).map(row => {
    const message = raw(row.message);
    return { sys_id: raw(row.sys_id), created: raw(row.sys_created_on), path: raw(row.action), message: message.slice(0, VALUE_LIMIT), message_length: message.length, truncated: message.length > VALUE_LIMIT };
  });
  // The log path is the run's name, then instance sys_ids from the outside in: logic blocks, the
  // flow's action instance, then the step inside that action. An action run has only the step.
  const failing = records.map(record => ({ record, ids: record.path.match(/[0-9a-f]{32}/gi) || [] })).filter(item => item.ids.length);
  const ids = [...new Set(failing.flatMap(item => item.ids))];
  const [actions, steps] = ids.length ? await Promise.all([byIds(sdk, 'sys_hub_action_instance_v2', ids), byIds(sdk, 'sys_hub_step_instance', ids)]) : [new Map(), new Map()];
  const level = String(attributes.reporting || raw(context.reporting)).toUpperCase() || null;
  return {
    execution: { sys_id: id, name: text(context.name), type, state: raw(context.state), state_label: text(context.state), error_state: raw(context.error_state) || null, error_message: raw(context.error_message) || null, started: raw(context.sys_created_on), run_time: raw(context.run_time) || null, source_table: raw(context.source_table) || null, source_record: raw(context.source_record) || null, source_display: text(context.source_record) || null, is_test_run: raw(context.is_test_run) === 'true' },
    version: { definition_table: definitionTable, definition: definitionId || null, snapshot, latest_snapshot: latest, is_latest: definition && snapshot && latest ? snapshot === latest : null },
    step_data: { recorded: Boolean(level) && level !== 'OFF', values_recorded: VALUES_KEPT[level] ?? null, reporting: level },
    failed_steps: failing.map(({ record, ids: path }) => {
      const action = actions.get(path.findLast(item => actions.has(item)));
      const step = steps.get(path.findLast(item => steps.has(item)));
      return { log: record.sys_id, path: record.path, instances: path,
        action: action ? { sys_id: raw(action.sys_id), order: raw(action.order), name: text(action.action_type).trim(), comment: raw(action.comment) } : null,
        step: step ? { sys_id: raw(step.sys_id), order: raw(step.order), name: text(step.label).trim(), step_type: text(step.step_type) } : null,
        message: record.message, message_length: record.message_length, truncated: record.truncated };
    }),
    log: { table: 'sys_flow_log', count: records.length, has_more: logRows.length > LOG_LIMIT, records },
  };
}

function short({ message, message_length: length }) {
  const clean = stripHtml(message);
  const shown = (clean.match(/^[\w.$]+(?:Exception|Error): .+/m)?.[0] ?? clean.split('\n')[0]).slice(0, 200);
  const rest = clean.length - shown.length + length - message.length;
  return rest > 0 ? `${shown} (+${rest} chars, --json for all)` : shown;
}

function describeStep({ action, step, instances }) {
  const inner = step && `${step.order} ${step.name}${step.step_type ? ` (${step.step_type})` : ''}`;
  if (action) return `Step ${action.order} ${action.name}${action.comment ? `: ${action.comment}` : ''}${inner ? `, at its step ${inner}` : ''}`;
  return inner ? `Step ${inner}` : `Instances ${instances.join(' > ')} (not found as an action or step instance)`;
}

export function formatFlowExecution(data) {
  const { execution: run, version, step_data: stepData, failed_steps: failed, log } = data;
  const kind = (run.type || 'flow').toLowerCase();
  const lines = [`${run.name} (${kind}): ${run.state_label}`, `Started ${run.started} UTC${run.run_time ? `, run time ${run.run_time} s` : ''}${run.source_table ? `, from ${run.source_table} ${run.source_display || run.source_record || ''}`.trimEnd() : ''}${run.is_test_run ? ' (test run)' : ''}`];
  if (run.error_message) lines.push(`Error: ${stripHtml(run.error_message)}`);
  lines.push(version.is_latest === null
    ? `Version: snapshot ${version.snapshot || 'not recorded'}; ${version.definition ? `the ${kind} definition is not readable` : 'the run has no definition reference'}, so whether it has changed since is unknown.`
    : `Version: snapshot ${version.snapshot}, ${version.is_latest ? `the ${kind}'s latest snapshot` : `not the ${kind}'s latest snapshot (now ${version.latest_snapshot}), so the ${kind} has changed since this run`}.`);
  lines.push(!stepData.reporting ? 'This run does not record its reporting level.'
    : stepData.values_recorded ? `Reporting was ${stepData.reporting} for this run: step statuses, inputs and outputs are in Workflow Studio's execution details. This command reads only the flow log.`
    : stepData.values_recorded === null ? `Reporting was ${stepData.reporting} for this run, at a level the run does not record, so whether inputs and outputs were kept is unknown. This command reads only the flow log.`
    : stepData.recorded ? `Reporting was ${stepData.reporting} for this run: step states and durations are in Workflow Studio's execution details, but no inputs or outputs were kept. This command reads only the flow log.`
      : `Reporting was ${stepData.reporting} for this run, so no step statuses, inputs or outputs were kept. Runs after the level is raised keep them (Workflow Studio Reporting settings, or com.snc.process_flow.reporting.level).`);
  lines.push('');
  if (!log.count) lines.push('No Error rows in sys_flow_log were readable for this run; an empty read does not prove none were logged.');
  else if (!failed.length) lines.push('The flow log names no failed step.');
  else lines.push('Failed steps from the flow log:', ...failed.flatMap(item => [`  ${describeStep(item)}`, `    ${short(item)}`]));
  const named = new Set(failed.map(step => step.log));
  const other = log.records.filter(record => !named.has(record.sys_id));
  if (other.length) lines.push('', 'Other errors in the flow log:', ...other.map(record => `  ${record.path || '(engine)'}: ${short(record)}`));
  if (log.has_more) lines.push('', `More error rows exist than the ${log.count} read.`);
  return lines.join('\n');
}
