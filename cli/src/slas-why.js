// jsn slas why: for one record, would each active SLA definition on its table attach now, and do its start,
// pause and stop conditions match? Condition strings only evaluate on the server, so one background script
// tests them with the call SLAConditionBase makes. The script only reads.
import { AppError, CodeAPI } from './errors.js';
import { SYS_ID, TABLE, checkDefinition, checkTask, listSlas, showSla, taskSlas } from './slas.js';

const MARK = 'JSN_SLA_WHY:';
const LIMIT = 100;
const NAMES = ['start', 'pause', 'resume', 'stop', 'cancel'];
const empty = table => `No readable active SLA definitions on ${table}. ACLs can hide rows, so an empty list does not prove there are none.`;
const NO_TASK_SLAS = 'No readable task SLAs on the record. ACLs can hide rows, so a definition shown as not attached may still be attached.';
const malformed = () => new AppError(CodeAPI, 'The SLA condition check returned no readable result.');

// The table and ids are validated, so they are safe inside quotes. ES5, as background scripts run.
// The condition class is resolved as TaskSLAController does: the definition's class record, else the property.
function whyScript(table, taskId, ids) {
  return `(function () {
  var out = { definitions: [] }, ids = ${JSON.stringify(ids)}, names = ${JSON.stringify(NAMES)};
  var task = new GlideRecord('${table}');
  out.found = task.get('${taskId}');
  out.case_sensitive = gs.getProperty('com.snc.sla.condition.case_sensitive', 'false') == 'true';
  out.default_class = gs.getProperty('com.snc.sla.default_conditionclass', 'SLAConditionBase');
  for (var i = 0; out.found && i < ids.length; i++) {
    var sla = new GlideRecord('contract_sla');
    if (!sla.get(ids[i])) continue;
    var row = { sys_id: ids[i], condition_class: out.default_class, when_to_cancel: sla.getValue('when_to_cancel'), when_to_resume: sla.getValue('when_to_resume'), conditions: {}, errors: [], changes: [] };
    var cls = new GlideRecord('sla_condition_class'), include = new GlideRecord('sys_script_include');
    if (sla.getValue('condition_class') && cls.get(sla.getValue('condition_class')) && cls.getValue('class_name') && include.get(cls.getValue('class_name'))) row.condition_class = include.getValue('name');
    for (var n = 0; n < names.length; n++) {
      var query = sla.getValue(names[n] + '_condition');
      row.conditions[names[n]] = null;
      if (!query) continue;
      if (/VALCHANGES|CHANGESFROM|CHANGESTO/.test(query)) row.changes.push(names[n]);
      try { row.conditions[names[n]] = !!SNC.Filter.checkRecord(task, query, true, out.case_sensitive); }
      catch (e) { row.conditions[names[n]] = false; row.errors.push(names[n]); }
    }
    out.definitions.push(row);
  }
  gs.print('${MARK}' + JSON.stringify(out));
})();`;
}

const stage = t => (t.stage || 'no stage').replace(/_/g, ' ');
const named = (names, one, many) => `The ${names.join(' and ')} ${names.length > 1 ? many : one}`;
function verdict(d, r, task) {
  const live = d.task_slas.filter(t => t.active), c = r.conditions, custom = d.condition_class !== 'SLAConditionBase';
  let text;
  if (live.length) text = `Attached: ${live.map(stage).join(', ')}.`;
  else if (!d.active) text = 'Not attached: the definition is inactive, and the SLA engine tests only active ones.';
  else if (d.table !== task.table) text = `Not attached: it is defined on ${d.table}, and the SLA engine tests only definitions on the record's own table, ${task.table}.`;
  else if (custom) text = 'Not attached.';
  else if (c.start === null) text = 'Not attached: it has no start condition, so it never attaches.';
  else if (!c.start) text = 'Not attached: the start condition does not match the record.';
  else if (c.stop) text = 'Not attached: the start condition matches, but so does the stop condition, which stops it attaching.';
  else if (r.when_to_cancel === 'on_condition' && c.cancel) text = 'Not attached: the start condition matches, but so does the cancel condition, which stops it attaching.';
  else text = 'Not attached, though the start condition matches and nothing stops it. The SLA engine tests conditions only when the record is saved, so it attaches at the next update unless a contract or service offering rule stops it.';
  if (custom) text += ` It uses the ${d.condition_class} condition class, which decides for itself; only its condition strings were tested.`;
  if (d.changes.length) text += ` ${named(d.changes, 'condition uses', 'conditions use')} a changes operator, which matches only while an update is saved, so it reads as no match here.`;
  if (d.errors.length) text += ` ${named(d.errors, 'condition', 'conditions')} threw an error when tested, which the SLA engine counts as no match.`;
  return text;
}

export async function whySlas(sdk, { task: identifier, definition } = {}) {
  checkTask(identifier);
  if (definition !== undefined) checkDefinition(definition);
  const named = definition === undefined ? null : await showSla(sdk, definition);
  const { task, records: taskSlaRows, more: moreTaskSlas } = await taskSlas(sdk, identifier);
  if (!TABLE.test(task.table)) throw malformed();
  const { records, pagination } = named ? { records: [named], pagination: { has_more: false } } : await listSlas(sdk, { table: task.table, active: true, limit: LIMIT });
  let out = { case_sensitive: null, definitions: [] };
  if (records.length) {
    const ids = records.map(d => d.sys_id);
    if (!SYS_ID.test(task.sys_id) || !ids.every(sysId => SYS_ID.test(sysId))) throw malformed();
    const line = String(await sdk.executeScript(whyScript(task.table, task.sys_id, ids), 'global', { rollback: false, finished: /JSN_SLA_WHY:\{/ })).match(/JSN_SLA_WHY:(\{[^\r\n]*\})/);
    if (!line) throw malformed();
    try { out = JSON.parse(line[1]); } catch { throw malformed(); }
    if (out?.found === false) throw new AppError(CodeAPI, `The background script could not read ${task.table} ${task.sys_id}.`);
    const names = list => Array.isArray(list) && list.every(name => NAMES.includes(name));
    const rowOk = (r, i) => r && r.sys_id === ids[i] && typeof r.condition_class === 'string' && r.condition_class !== '' && names(r.errors) && names(r.changes)
      && NAMES.every(name => [true, false, null].includes(r.conditions?.[name])) && [r.when_to_cancel, r.when_to_resume].every(v => v === null || typeof v === 'string');
    if (out?.found !== true || typeof out.case_sensitive !== 'boolean' || !Array.isArray(out.definitions) || out.definitions.length !== ids.length || !out.definitions.every(rowOk)) throw malformed();
  }
  const rows = records.map((d, i) => {
    const r = out.definitions[i];
    const shown = ['start', 'pause', 'stop', ...(r.when_to_resume === 'on_condition' ? ['resume'] : []), ...(r.when_to_cancel === 'on_condition' ? ['cancel'] : [])];
    const row = { sys_id: d.sys_id, name: d.name, table: d.table, active: d.active, condition_class: r.condition_class,
      conditions: Object.fromEntries(shown.map(name => [name, r.conditions[name]])), changes: r.changes.filter(name => shown.includes(name)), errors: r.errors.filter(name => shown.includes(name)),
      task_slas: taskSlaRows.filter(t => t.definition?.sys_id === d.sys_id).map(t => ({ sys_id: t.sys_id, stage: t.stage, active: t.active })) };
    return { ...row, verdict: verdict(row, r, task) };
  });
  return { task, case_sensitive: out.case_sensitive, records: rows, count: rows.length, attached: rows.filter(d => d.task_slas.some(t => t.active)).length,
    more: pagination.has_more, more_task_slas: moreTaskSlas, ...(!rows.length ? { visibility: empty(task.table) } : !taskSlaRows.length ? { visibility: NO_TASK_SLAS } : {}) };
}

const STATE = { true: 'matches', false: 'no match', null: 'empty' };
export function formatSlaWhy(data) {
  const lines = [`Why SLAs attach to ${data.task.number || data.task.sys_id} (${data.task.table}) [${data.task.sys_id}] (read-only background script; conditions tested against the record as saved)`];
  for (const d of data.records) {
    lines.push(`  ${d.name} [${d.sys_id}]`, `    ${Object.entries(d.conditions).map(([name, value]) => `${name} ${STATE[value]}`).join(', ')}`,
      ...d.task_slas.filter(t => !t.active).map(t => `    earlier task SLA [${t.sys_id}]: ${stage(t)}`), `    ${d.verdict}`);
  }
  if (data.visibility) lines.push(data.visibility);
  if (data.more) lines.push(`More than ${LIMIT} active definitions on ${data.task.table}; only the first ${LIMIT} by name were tested.`);
  if (data.more_task_slas) lines.push('More than 100 task SLAs on the record; attachment is judged from the first 100 by start time.');
  if (data.case_sensitive !== null) lines.push(`Conditions were matched ${data.case_sensitive ? 'case-sensitively' : 'ignoring case'}, as com.snc.sla.condition.case_sensitive sets. Contract and service offering rules were not tested.`);
  return lines.join('\n');
}
