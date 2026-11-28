import { errUsage } from './errors.js';

const fields = {
  sys_atf_test: 'sys_id,name,active',
  sys_atf_step: 'sys_id,test,order,active,step_config,description,notes',
  sys_variable_value: 'sys_id,document,document_key,variable,variable.element,variable.internal_type,order,value',
};
const STEP_LIMIT = 200;
const VALUE_LIMIT = 1000;
const TEXT_LIMIT = 16384;
const SCRIPT_LINES = 20;
const SYS_ID = /^[0-9a-f]{32}$/i;
// Display labels are presentation only. Never use them as join keys.
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');

async function read(sdk, table, query, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields[table], sysparm_limit: String(limit), sysparm_display_value: 'all' }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  return rows;
}

function assertTestRef(test) {
  if (typeof test !== 'string' || !test.trim() || test !== test.trim() || /[\^*\r\n]/.test(test)) throw errUsage('Provide the ATF test as its sys_id or exact name (no ^ or *).');
}

// A script input shows its first lines unless asked for whole; any other value is cut at 16 KB.
function inputRecord(row, full) {
  const type = raw(row['variable.internal_type']), value = raw(row.value), script = type.startsWith('script');
  const lines = value.split('\n');
  const shown = script && !full && lines.length > SCRIPT_LINES ? lines.slice(0, SCRIPT_LINES).join('\n') : value;
  const kept = script && full ? shown : shown.slice(0, TEXT_LIMIT);
  return { sys_id: raw(row.sys_id), name: raw(row['variable.element']) || text(row.variable), label: text(row.variable), variable: raw(row.variable), type, value: kept, value_length: value.length, truncated: kept.length < value.length };
}

/**
 * A test's steps in order with the input values set on each (sys_variable_value rows whose
 * document is sys_atf_step), named by the input variable's element. Null when no test matches.
 */
export async function readAtfSteps(sdk, test, { full = false } = {}) {
  assertTestRef(test);
  const byId = SYS_ID.test(test);
  const tests = await read(sdk, 'sys_atf_test', byId ? `sys_id=${test}` : `name=${test}`, 2);
  // The instance matches names and sys_ids without regard to case, as atf run does.
  if (tests.some(row => (byId ? raw(row.sys_id) : raw(row.name)).toLowerCase() !== test.toLowerCase())) throw new Error('sys_atf_test returned a different record identity.');
  if (tests.length > 1) throw errUsage(`More than one ATF test is named "${test}" (${tests.map(row => raw(row.sys_id)).join(', ')}). Pass the sys_id.`);
  if (!tests.length) return null;
  const id = raw(tests[0].sys_id);
  const stepRows = await read(sdk, 'sys_atf_step', `test=${id}^ORDERBYorder`, STEP_LIMIT + 1);
  if (stepRows.some(row => raw(row.test) !== id)) throw new Error('sys_atf_step returned steps of another test.');
  const steps = stepRows.slice(0, STEP_LIMIT), ids = steps.map(row => raw(row.sys_id));
  const valueRows = ids.length ? await read(sdk, 'sys_variable_value', `document=sys_atf_step^document_keyIN${ids.join(',')}^ORDERBYorder`, VALUE_LIMIT + 1) : [];
  if (valueRows.some(row => raw(row.document) !== 'sys_atf_step' || !ids.includes(raw(row.document_key)))) throw new Error('sys_variable_value returned values of another record.');
  const values = valueRows.slice(0, VALUE_LIMIT);
  return {
    test: { table: 'sys_atf_test', sys_id: id, name: raw(tests[0].name), active: raw(tests[0].active) === 'true' },
    steps: { table: 'sys_atf_step', count: steps.length, has_more: stepRows.length > STEP_LIMIT, records: steps.map(row => ({
      sys_id: raw(row.sys_id), order: raw(row.order), active: raw(row.active) === 'true', step_config: raw(row.step_config), step_config_name: text(row.step_config),
      description: raw(row.description), notes: raw(row.notes),
      inputs: values.filter(value => raw(value.document_key) === raw(row.sys_id)).map(value => inputRecord(value, full)),
    })) },
    input_values: { table: 'sys_variable_value', count: values.length, has_more: valueRows.length > VALUE_LIMIT },
  };
}

export function formatAtfSteps(data) {
  const lines = [`${data.test.name}${data.test.active ? '' : ' (inactive)'}`, `sys_atf_test ${data.test.sys_id}`, ''];
  if (!data.steps.count) lines.push('No steps were readable: the test has none, or ACLs hide them.');
  else lines.push(`Steps (${data.steps.count}):`);
  for (const step of data.steps.records) {
    const description = step.description.replace(/\s+/g, ' ').trim();
    const about = description && description !== step.step_config_name ? `: ${description}` : '';
    lines.push(`  ${step.order.padStart(3)}  ${step.step_config_name || step.step_config}${about}${step.active ? '' : ' (inactive)'}`);
    for (const input of step.inputs) {
      const body = input.value.replace(/\r/g, '').split('\n');
      if (body.length === 1 && !input.truncated) lines.push(`         ${input.name}:${body[0] ? ` ${body[0]}` : ''}`);
      else lines.push(`         ${input.name}:`, ...body.map(line => `           ${line}`));
      if (input.truncated) lines.push(`           (${input.value_length - input.value.length} more character(s)${input.type.startsWith('script') ? ', --full for the whole script' : ''})`);
    }
  }
  if (data.steps.count && !data.input_values.count) lines.push('', 'No input values were readable: every input is at its default, or ACLs hide them.');
  if (data.steps.has_more) lines.push('', `More steps exist than the ${data.steps.count} read.`);
  if (data.input_values.has_more) lines.push('', `More input values exist than the ${data.input_values.count} read; later steps may show none.`);
  return lines.join('\n');
}
