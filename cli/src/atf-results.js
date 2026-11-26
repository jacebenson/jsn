import { errUsage } from './errors.js';

// sys_atf_test_result_step extends sys_atf_test_result_item; the base class's own rows are the run's log lines.
const STEP = 'sys_atf_test_result_step';
const ITEM = 'sys_atf_test_result_item';
const fields = {
  sys_atf_test_result: 'sys_id,test,status,parent,start_time',
  sys_atf_test_suite_result: 'sys_id,number,test_suite,status,parent,start_time',
  [STEP]: 'sys_id,test_result,order,step,status,summary,output,start_time,end_time',
  [ITEM]: 'sys_id,test_result,type,output,start_time',
};
const STEP_LIMIT = 200;
const TEST_LIMIT = 50;
const LOG_LIMIT = 200;
const TEXT_LIMIT = 16384;
const FAILED = ['failure', 'error'];
const SYS_ID = /^[0-9a-f]{32}$/i;
// Display labels are presentation only. Never use them as join keys.
const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const text = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');

async function read(sdk, table, query, limit) {
  const rows = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: query, sysparm_fields: fields[table], sysparm_limit: String(limit), sysparm_display_value: 'all' }))
    .catch(err => { throw Object.assign(err, { table: err.table ?? table }); });
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Object.assign(new Error(`Malformed table response for ${table}`), { code: 'malformed_response' });
  return rows;
}
async function one(sdk, table, id) {
  const rows = await read(sdk, table, `sys_id=${id}`, 1);
  if (rows.some(row => raw(row.sys_id) !== id)) throw new Error(`${table} returned a different record identity.`);
  return rows[0];
}
function children(table, rows, ids, limit) {
  if (rows.some(row => !ids.includes(raw(row.test_result)))) throw new Error(`${table} returned rows for another test result.`);
  return { count: Math.min(rows.length, limit), has_more: rows.length > limit, rows: rows.slice(0, limit) };
}

// A step that failed keeps its whole output, because the failure is often the last line of a long log.
function stepRecord(row) {
  const status = raw(row.status), summary = raw(row.summary), output = raw(row.output), whole = FAILED.includes(status);
  return { sys_id: raw(row.sys_id), test_result: raw(row.test_result), order: raw(row.order), step: raw(row.step), step_name: text(row.step), status, status_label: text(row.status),
    summary: whole ? summary : summary.slice(0, TEXT_LIMIT), output: whole ? output : output.slice(0, TEXT_LIMIT), output_length: output.length,
    truncated: !whole && Math.max(summary.length, output.length) > TEXT_LIMIT, start_time: raw(row.start_time), end_time: raw(row.end_time) };
}
function logRecord(row) {
  const message = raw(row.output);
  return { sys_id: raw(row.sys_id), test_result: raw(row.test_result), type: raw(row.type), time: raw(row.start_time), message: message.slice(0, TEXT_LIMIT), message_length: message.length, truncated: message.length > TEXT_LIMIT };
}
const testRecord = row => ({ sys_id: raw(row.sys_id), test: raw(row.test), test_name: text(row.test), status: raw(row.status), status_label: text(row.status), started: raw(row.start_time) });
const suiteRecord = row => ({ sys_id: raw(row.sys_id), number: raw(row.number), test_suite: raw(row.test_suite), test_suite_name: text(row.test_suite), status: raw(row.status), status_label: text(row.status), started: raw(row.start_time) });

export function assertResultId(id) {
  if (typeof id !== 'string' || !SYS_ID.test(id)) throw errUsage('Provide the ATF result as a 32-character hexadecimal sys_id from jsn atf run.');
}

/**
 * Step detail for a sys_atf_test_result (every step, in order) or a sys_atf_test_suite_result (its
 * failed tests and their failed steps), plus the result's log lines when asked. Null when the id is
 * neither, as for a progress tracker whose run has no result yet.
 */
export async function readAtfResultDetail(sdk, id, { logs = false } = {}) {
  assertResultId(id);
  const test = await one(sdk, 'sys_atf_test_result', id);
  const suite = test ? null : await one(sdk, 'sys_atf_test_suite_result', id);
  if (!test && !suite) return null;
  let tests, failedTests = null, failedSuites = null;
  if (test) tests = [test];
  else {
    // A suite of suites: child suite results are listed, not followed.
    const failed = `parent=${id}^statusIN${FAILED.join(',')}^ORDERBYstart_time`;
    const [rows, suiteRows] = await Promise.all([read(sdk, 'sys_atf_test_result', failed, TEST_LIMIT + 1), read(sdk, 'sys_atf_test_suite_result', failed, TEST_LIMIT + 1)]);
    for (const [table, list] of [['sys_atf_test_result', rows], ['sys_atf_test_suite_result', suiteRows]]) if (list.some(row => raw(row.parent) !== id)) throw new Error(`${table} returned rows from another suite result.`);
    tests = rows.slice(0, TEST_LIMIT);
    failedTests = { count: tests.length, has_more: rows.length > TEST_LIMIT, records: tests.map(testRecord) };
    failedSuites = { count: Math.min(suiteRows.length, TEST_LIMIT), has_more: suiteRows.length > TEST_LIMIT, records: suiteRows.slice(0, TEST_LIMIT).map(suiteRecord) };
  }
  const ids = tests.map(row => raw(row.sys_id));
  const stepQuery = test ? `test_result=${id}^ORDERBYorder` : `test_resultIN${ids.join(',')}^statusIN${FAILED.join(',')}^ORDERBYorder`;
  const [stepRows, logRows] = await Promise.all([
    ids.length ? read(sdk, STEP, stepQuery, STEP_LIMIT + 1) : [],
    logs && ids.length ? read(sdk, ITEM, `test_resultIN${ids.join(',')}^sys_class_name=${ITEM}^ORDERBYrecorded_at`, LOG_LIMIT + 1) : [],
  ]);
  const steps = children(STEP, stepRows, ids, STEP_LIMIT);
  const lines = children(ITEM, logRows, ids, LOG_LIMIT);
  return {
    result_record: test
      ? { table: 'sys_atf_test_result', ...testRecord(test), suite_result: raw(test.parent) || null }
      : { table: 'sys_atf_test_suite_result', ...suiteRecord(suite), parent_suite_result: raw(suite.parent) || null },
    ...(failedTests ? { failed_tests: failedTests, failed_suites: failedSuites } : {}),
    steps: { table: STEP, count: steps.count, has_more: steps.has_more, records: steps.rows.map(stepRecord) },
    ...(logs ? { logs: { table: ITEM, count: lines.count, has_more: lines.has_more, records: lines.rows.map(logRecord) } } : {}),
  };
}

const NOTABLE = /assert|fail|error|exception|refused|security restricted/i;
const SHOWN = 12;
const clip = line => line.length > 300 ? `${line.slice(0, 300)}…` : line;

// The lines a person reads first: assertions, errors and refusals, else the opening lines.
function why(step, indent) {
  const lines = (step.output || step.summary).replace(/<[^>]+>/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const hits = [...new Set(lines.filter(line => NOTABLE.test(line)))];
  const pick = hits.length ? hits : lines;
  const out = pick.slice(0, SHOWN).map(line => `${indent}${clip(line)}`);
  if (pick.length > SHOWN) out.push(`${indent}(+${pick.length - SHOWN} more line(s), --json for the whole output)`);
  return out;
}

function testBlock(data, testResult, indent) {
  const steps = data.steps.records.filter(step => step.test_result === testResult);
  const out = steps.flatMap(step => [`${indent}${step.order.padStart(3)}  ${step.status.padEnd(8)} ${step.step_name}`, ...(FAILED.includes(step.status) ? why(step, `${indent}       `) : [])]);
  if (data.logs) {
    const lines = data.logs.records.filter(line => line.test_result === testResult);
    out.push('', `${indent}Log lines (${lines.length}):`, ...lines.map(line => `${indent}  ${line.time} ${line.type} ${clip(line.message.replace(/\s+/g, ' ').trim())}`));
  }
  return out;
}

export function formatAtfResult(data) {
  const record = data.result_record;
  const lines = [];
  if (record.table === 'sys_atf_test_result') {
    lines.push(`${record.test_name || record.test}: ${record.status_label || record.status}`, `${record.table} ${record.sys_id}${record.started ? `, started ${record.started} UTC` : ''}`, '');
    lines.push(data.steps.count ? `Steps (${data.steps.count}):` : 'No step results were readable: the test stopped before its first step, is still running, or ACLs hide them.', ...testBlock(data, record.sys_id, '  '));
  } else {
    lines.push(`${record.test_suite_name || record.test_suite}: ${record.status_label || record.status}`, `${record.table} ${record.sys_id}${record.number ? ` (${record.number})` : ''}${record.started ? `, started ${record.started} UTC` : ''}`, '');
    const { failed_tests: tests, failed_suites: suites } = data;
    if (!tests.count && !suites.count) lines.push('No failed or errored test or child suite results were readable for this suite result.');
    if (tests.count) lines.push(`Failed tests (${tests.count}):`, ...tests.records.flatMap(test => [`  ${test.test_name || test.test}: ${test.status_label || test.status} (sys_atf_test_result ${test.sys_id})`, ...testBlock(data, test.sys_id, '    ')]));
    if (tests.has_more) lines.push('', `More failed tests exist than the ${tests.count} read.`);
    if (suites.count) lines.push(...(tests.count ? [''] : []), `Failed child suites (${suites.count}), each shown by jsn atf results <id>:`, ...suites.records.map(child => `  ${child.test_suite_name || child.test_suite}: ${child.status_label || child.status} (sys_atf_test_suite_result ${child.sys_id})`));
    if (suites.has_more) lines.push('', `More failed child suites exist than the ${suites.count} read.`);
  }
  if (data.steps.has_more) lines.push('', `More step results exist than the ${data.steps.count} read.`);
  if (data.logs?.has_more) lines.push('', `More log lines exist than the ${data.logs.count} read.`);
  return lines.join('\n');
}
