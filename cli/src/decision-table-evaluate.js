import { assertSafeExactMatch } from './helpers.js';
import { AppError, CodeForbidden, errUsage } from './errors.js';
import { resolveRecord, unwrapSysId, isSysId } from './resolve-record.js';
import { formatDecisionValue } from './decision-table-inspection.js';

// Decision Builder's own test panel calls this Generic API route; it only evaluates and writes nothing.
export const EVALUATE_PATH = '/api/sn_decision_table/generic/evaluate_decision_table';
const MULTI_RESULT = 'sys_decision_multi_result';
const MAX_ROWS = 500;
const ACCESS = 'Decision table evaluation needs the Decision Builder plugin (sn_decision_table) and one of the roles decision_table_admin, decision_table_reader or change_manager';

const raw = (record, field) => {
  const value = record?.[field];
  return value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
};
const malformed = (detail) => Object.assign(new Error(`Malformed decision table evaluation: ${detail}`), { code: 'malformed_response' });
const denied = (detail, cause) => new AppError(CodeForbidden, `${ACCESS}. ${detail}`, 'Ask an admin for one of those roles, or check that the sn_decision_table plugin is active.', 403, cause);

export function parseDecisionInputs(specs) {
  const given = new Map();
  for (const spec of specs == null ? [] : [specs].flat()) {
    const text = String(spec);
    const at = text.indexOf('=');
    const name = at < 0 ? '' : text.slice(0, at).trim();
    if (!name) throw errUsage(`--input expects name=value, got "${text}"`);
    if (given.has(name)) throw errUsage(`--input ${name} is given more than once`);
    given.set(name, text.slice(at + 1));
  }
  return given;
}

async function childRows(sdk, table, parentField, parentId, fields) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: `${parentField}=${parentId}^ORDERBYorder`, sysparm_fields: `sys_id,${parentField},${fields}`, sysparm_display_value: 'false', sysparm_limit: String(MAX_ROWS + 1) }));
  if (rows.length > MAX_ROWS) throw new Error(`Decision table has more than ${MAX_ROWS} ${table} rows; refusing to evaluate on a partial read.`);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || raw(row, parentField) !== parentId) throw new Error(`A ${table} row does not belong to decision table ${parentId}; refusing to evaluate on an unfiltered read.`);
  }
  return rows;
}

// The evaluator answers an unknown name, a missing mandatory input, a choice label or a non-boolean
// with its default decision as if the input were real, so each is refused here first.
async function checkInputs(sdk, inputs, given) {
  const byName = new Map(inputs.map((row) => [raw(row, 'element'), row]));
  const unknown = [...given.keys()].filter((name) => !byName.has(name));
  if (unknown.length) throw errUsage(`Unknown decision input(s): ${unknown.join(', ')}. This table's inputs: ${[...byName.keys()].join(', ') || 'none'}. Names are case-sensitive.`);
  const missing = inputs.filter((row) => raw(row, 'mandatory') === 'true' && raw(row, 'active') !== 'false' && !given.has(raw(row, 'element'))).map((row) => raw(row, 'element'));
  if (missing.length) throw errUsage(`Missing mandatory decision input(s): ${missing.join(', ')}. Pass --input name=value (name= sends an empty value).`);
  const values = {};
  const resolvedFrom = {};
  for (const [name, value] of given) {
    const row = byName.get(name);
    const type = raw(row, 'internal_type');
    values[name] = value;
    if (!value) continue;
    if (type === 'boolean' && value !== 'true' && value !== 'false') throw errUsage(`Input ${name} is True/False; pass true or false, not "${value}".`);
    if (type === 'choice') {
      assertSafeExactMatch(raw(row, 'name'));
      const choices = await sdk.listStrict('sys_choice', new URLSearchParams({ sysparm_query: `name=${raw(row, 'name')}^element=${name}`, sysparm_fields: 'name,element,value,label', sysparm_display_value: 'false', sysparm_limit: String(MAX_ROWS) }));
      const own = choices.filter((choice) => raw(choice, 'name') === raw(row, 'name') && raw(choice, 'element') === name);
      if (own.length && !own.some((choice) => raw(choice, 'value') === value)) {
        const label = own.find((choice) => raw(choice, 'label').toLowerCase() === value.toLowerCase());
        throw errUsage(`Input ${name} has no choice "${value}"${label ? ` ("${value}" is the label of value "${raw(label, 'value')}")` : ''}. Choices: ${[...new Set(own.map((choice) => raw(choice, 'value')))].join(', ')}.`);
      }
    }
    if (type === 'reference' && !isSysId(value)) {
      const table = raw(row, 'reference');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw errUsage(`Input ${name} is a reference with no readable target table; pass a sys_id.`);
      const record = await resolveRecord(sdk, { table, identifier: value, identifierField: 'number', resource: `${table} record`, fields: ['number'], displayValue: 'false', partial: false });
      if (raw(record, 'number') !== value || !isSysId(unwrapSysId(record))) throw errUsage(`Input ${name}: no ${table} record numbered ${value}; pass a sys_id.`);
      values[name] = unwrapSysId(record);
      resolvedFrom[name] = value;
    }
  }
  return { values, resolvedFrom };
}

function answerOf(answers, multi) {
  if (!Array.isArray(answers) || answers.some((item) => !item || typeof item !== 'object')) throw malformed('a decision answer is not a list of values');
  if (multi) return { elements: Object.fromEntries(answers.map((item) => [raw(item, 'name'), { value: raw(item, 'value'), display_value: raw(item, 'displayValue') }])) };
  return { value: raw(answers[0], 'value'), display_value: raw(answers[0], 'displayValue') };
}

function formatEvaluation(data) {
  const lines = [`Decision table: ${data.decision_table.name} (${data.decision_table.sys_id})`];
  for (const [name, value] of Object.entries(data.inputs)) lines.push(`Input ${name} = ${value}${data.resolved_from?.[name] ? ` (from ${data.resolved_from[name]})` : ''}`);
  for (const match of data.matches) {
    const answer = match.answer.elements
      ? Object.entries(match.answer.elements).map(([name, element]) => `${name}: ${formatDecisionValue(element.value, element.display_value)}`).join(', ')
      : formatDecisionValue(match.answer.value, match.answer.display_value);
    lines.push(`Decision ${match.label || match.sys_id}${match.default ? ' (default)' : ''}: ${answer}`);
  }
  if (!data.matches.length) lines.push('No decision matched, and the table has no default decision.');
  return lines.join('\n') + '\n';
}

export async function evaluateDecisionTable(sdk, identifier, { inputs: specs, allMatches = false } = {}) {
  const given = parseDecisionInputs(specs);
  const table = await resolveRecord(sdk, { table: 'sys_decision', identifier, matchField: 'name', resource: 'decision table', fields: ['name', 'answer_table'], displayValue: 'false' });
  const sysId = unwrapSysId(table);
  if (!isSysId(sysId)) throw new Error(`Decision table returned an invalid identifier: ${identifier}`);
  const multi = raw(table, 'answer_table') === MULTI_RESULT;
  const [inputs, decisions, elements] = await Promise.all([
    childRows(sdk, 'sys_decision_input', 'model', sysId, 'name,element,internal_type,mandatory,active,reference'),
    childRows(sdk, 'sys_decision_question', 'decision_table', sysId, 'label,order,active,default_answer'),
    multi ? childRows(sdk, 'sys_decision_multi_result_element', 'model', sysId, 'element') : [],
  ]);
  const { values, resolvedFrom } = await checkInputs(sdk, inputs, given);
  const body = { testInputs: values, isFirstMatch: !allMatches, includeDelta: false, isMultiResultTable: multi, ...(multi ? { answerElementNames: elements.map((row) => raw(row, 'element')) } : {}) };
  let response;
  try {
    response = await sdk.request(`${sdk.baseURL}${EVALUATE_PATH}?${new URLSearchParams({ decisionTableId: sysId })}`, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (error?.status === 403) throw denied('The evaluate API refused this user (HTTP 403).', error);
    if (error?.status === 400 && /does not represent any resource/i.test(error.message)) throw denied('The evaluate API is not available on this instance.', error);
    throw error;
  }
  const result = response?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw malformed('expected a result object keyed by decision sys_id');
  const order = new Map(decisions.map((row, index) => [raw(row, 'sys_id'), index]));
  const matches = Object.entries(result).map(([decisionId, answers]) => {
    if (!isSysId(decisionId)) throw malformed(`"${decisionId}" is not a decision sys_id`);
    const row = decisions[order.get(decisionId)];
    return { sys_id: decisionId, label: raw(row, 'label'), order: raw(row, 'order'), default: raw(row, 'default_answer') === 'true', answer: answerOf(answers, multi) };
  }).sort((a, b) => (order.get(a.sys_id) ?? Infinity) - (order.get(b.sys_id) ?? Infinity));
  // A caller without the roles gets an empty answer with HTTP 200; only a table read with no default can truly match nothing.
  const hasDefault = decisions.some((row) => raw(row, 'default_answer') === 'true' && raw(row, 'active') !== 'false');
  if (!matches.length && (hasDefault || !decisions.length)) throw denied(hasDefault ? 'The evaluator returned no decision, although this table has a default decision.' : 'No decisions of this table are readable, and the evaluator returned none.');
  const data = { decision_table: { sys_id: sysId, name: raw(table, 'name') }, inputs: values, ...(Object.keys(resolvedFrom).length ? { resolved_from: resolvedFrom } : {}), all_matches: allMatches, matches };
  Object.defineProperty(data, '_formatted', { value: formatEvaluation(data), enumerable: false, configurable: true });
  return data;
}
