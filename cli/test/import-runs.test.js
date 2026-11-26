import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCmd } from '../src/commands/import.js';
import { isMutationCommand } from '../src/mutations.js';
import { readImportRuns, formatImportRuns } from '../src/import-sets.js';

const SET = 'e'.repeat(32);
const SET2 = 'f'.repeat(32);
const DS = 'd'.repeat(32);
const MAP = 'c'.repeat(32);
const ref = (value, display) => ({ value, display_value: display ?? value });
const set = (sys_id = SET, number = 'ISET0010001', data_source = DS) => ({ sys_id: ref(sys_id), number: ref(number), table_name: ref('u_staging'),
  state: ref('processed', 'Processed'), mode: ref('asynchronous'), data_source: ref(data_source, 'Nightly users'), sys_created_on: ref('2026-11-25 00:00:00') });
const run = (n, setId = SET, extra = {}) => ({ sys_id: ref(String(n).padStart(32, '0')), number: ref(`TH000100${n}`), set: ref(setId, setId === SET ? 'ISET0010001' : 'ISET0010002'),
  sys_transform_map: ref(MAP, 'Users'), state: ref('complete_with_errors', 'Complete with errors'), total: ref('3'), processed: ref('0'), inserts: ref('1'),
  updates: ref('0'), ignored: ref('0'), skipped: ref('0'), errors: ref('2'), completed: ref('2026-11-25 00:01:00'), run_time: ref('1 Second'),
  sys_created_on: ref('2026-11-25 00:01:00'), ...extra });
const row = (n, extra = {}) => ({ sys_id: ref(String(n).padStart(32, 'a')), sys_import_set: ref(SET, 'ISET0010001'), import_set_run: ref('1'.padStart(32, '0'), 'TH0001001'),
  sys_import_row: ref(String(n)), sys_import_state: ref('error', 'Error'), sys_import_state_comment: ref(`Row ${n}: coalesce value missing`),
  sys_row_error: ref(''), sys_target_table: ref('sys_user'), sys_transform_map: ref(MAP, 'Users'), ...extra });
const ds = (extra = {}) => ({ sys_id: ref(DS), name: ref('Nightly users'), type: ref('File'), format: ref('CSV'), import_set_table_name: ref('u_staging'),
  file_retrieval_method: ref('Attachment'), last_run_datetime: ref(''), last_success_import_time: ref('2026-11-25 00:00:00'), ...extra });

function fakeSdk(tables) {
  const calls = [];
  return {
    calls,
    listStrict: async (table, params) => {
      calls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit'), display: params.get('sysparm_display_value') });
      const answer = tables[table];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params.get('sysparm_query')) : (answer ?? []);
    },
  };
}

test('import runs is a read, so read-only profiles allow it', () => {
  importCmd(fn => fn);
  assert.equal(isMutationCommand({ _: ['import', 'runs', 'ISET0010001'] }), false);
});

test('import runs refuses bad input before any request', async () => {
  for (const [target, opts, message] of [
    ['', {}, /import set number or sys_id, or a data source/],
    ['ISET1^ORDERBYnumber', {}, /\^/],
    ['ISET1\nx', {}, /control/],
    ['ISET0010001', { limit: 0 }, /--limit/],
    ['ISET0010001', { limit: 101 }, /--limit/],
    ['ISET0010001', { errors: 201 }, /--errors/],
    ['ISET0010001', { errors: 1.5 }, /--errors/],
  ]) {
    const sdk = fakeSdk({});
    await assert.rejects(readImportRuns(sdk, target, opts), message);
    assert.equal(sdk.calls.length, 0, `no request for ${JSON.stringify(target)}`);
  }
});

test('import runs on an import set reads its runs newest first, the data source and the error rows of the newest run', async () => {
  const sdk = fakeSdk({
    sys_import_set: q => q === 'number=ISET0010001' ? [set()] : [],
    sys_data_source: [ds()],
    sys_import_set_run: [run(2), run(1)],
    sys_import_set_row: [row(2), row(3)],
  });
  const data = await readImportRuns(sdk, 'ISET0010001', { limit: 10, errors: 20 });
  assert.deepEqual(sdk.calls.map(c => [c.table, c.query, c.limit]), [
    ['sys_import_set', 'number=ISET0010001', '1'],
    ['sys_data_source', `sys_id=${DS}`, '1'],
    ['sys_import_set_run', `set=${SET}^ORDERBYDESCsys_created_on^ORDERBYDESCnumber`, '11'],
    ['sys_import_set_row', `sys_import_set=${SET}^sys_import_state=error^ORDERBYsys_import_row`, '21'],
  ]);
  assert.ok(sdk.calls.every(c => c.display === 'all'));
  assert.ok(!/password|connection|jdbc|scp/.test(sdk.calls[1].fields), 'never reads data source secrets');
  assert.deepEqual(data.target, { type: 'import_set', sys_id: SET, name: 'ISET0010001' });
  assert.equal(data.data_source.name, 'Nightly users');
  assert.equal(data.runs.length, 2);
  assert.deepEqual(data.runs[0], { sys_id: '2'.padStart(32, '0'), number: 'TH0001002', import_set: { sys_id: SET, number: 'ISET0010001' },
    transform_map: { sys_id: MAP, name: 'Users' }, state: 'complete_with_errors', total: 3, processed: 0, inserts: 1, updates: 0, ignored: 0,
    skipped: 0, errors: 2, completed: '2026-11-25 00:01:00', run_time: '1 Second', created: '2026-11-25 00:01:00' });
  assert.equal(data.runs_has_more, false);
  assert.equal(data.error_rows.import_set.number, 'ISET0010001');
  assert.equal(data.error_rows.run, 'TH0001002');
  assert.deepEqual(data.error_rows.rows.map(r => [r.row, r.message]), [[2, 'Row 2: coalesce value missing'], [3, 'Row 3: coalesce value missing']]);
  assert.equal(data.error_rows.has_more, false);
});

test('import runs on a data source reads the runs of its sets, then checks each set belongs to it', async () => {
  const sdk = fakeSdk({
    sys_import_set: q => q.startsWith('sys_idIN') ? [set(), set(SET2, 'ISET0010002')] : [],
    sys_data_source: q => q === 'name=Nightly users' ? [ds()] : [],
    sys_import_set_run: [run(3, SET2, { errors: ref('0'), state: ref('complete', 'Complete') }), run(2)],
    sys_import_set_row: [],
  });
  const data = await readImportRuns(sdk, 'Nightly users', { limit: 2, errors: 5 });
  assert.deepEqual(sdk.calls.map(c => [c.table, c.query, c.limit]), [
    ['sys_import_set', 'number=Nightly users', '1'],
    ['sys_data_source', 'name=Nightly users', '2'],
    ['sys_import_set_run', `set.data_source=${DS}^ORDERBYDESCsys_created_on^ORDERBYDESCnumber`, '3'],
    ['sys_import_set', `sys_idIN${SET2},${SET}`, '2'],
    ['sys_import_set_row', `sys_import_set=${SET2}^sys_import_state=error^ORDERBYsys_import_row`, '6'],
  ]);
  assert.deepEqual(data.target, { type: 'data_source', sys_id: DS, name: 'Nightly users' });
  assert.deepEqual(data.runs.map(r => r.import_set.number), ['ISET0010002', 'ISET0010001']);
  assert.deepEqual(data.error_rows.rows, []);
});

test('import runs refuses a run whose set is not the data source asked for', async () => {
  const sdk = fakeSdk({
    sys_import_set: q => q.startsWith('sys_idIN') ? [set(SET, 'ISET0010001', 'b'.repeat(32))] : [],
    sys_data_source: [ds()],
    sys_import_set_run: [run(2)],
  });
  await assert.rejects(readImportRuns(sdk, DS, {}), /does not belong to data source/);
});

test('import runs refuses a run that points at another set', async () => {
  const sdk = fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2, SET2)] });
  await assert.rejects(readImportRuns(sdk, SET, {}), /mismatched set/);
});

test('import runs refuses an error row from another set', async () => {
  const sdk = fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2)],
    sys_import_set_row: [row(2, { sys_import_set: ref(SET2) })] });
  await assert.rejects(readImportRuns(sdk, SET, {}), /mismatched sys_import_set/);
});

test('import runs adds the linked row error message and refuses one that names another row', async () => {
  const errorId = '9'.repeat(32);
  const rowError = rowId => ({ sys_id: ref(errorId), row: ref(rowId), error_code: ref('1'), error_message: ref('Target record not found') });
  const tables = rowId => ({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2)],
    sys_import_set_row: [row(2, { sys_row_error: ref(errorId), sys_import_state_comment: ref('') })], sys_import_set_row_error: [rowError(rowId)] });
  const good = fakeSdk(tables('2'.padStart(32, 'a')));
  const data = await readImportRuns(good, SET, {});
  assert.deepEqual(good.calls.at(-1).query, `sys_idIN${errorId}`);
  assert.deepEqual(data.error_rows.rows[0].message, 'Target record not found');
  assert.equal(data.error_rows.rows[0].error_code, '1');
  await assert.rejects(readImportRuns(fakeSdk(tables('b'.repeat(32))), SET, {}), /another row/);
  assert.equal((await readImportRuns(fakeSdk(tables('')), SET, {})).error_rows.rows[0].message, 'Target record not found', 'an unfilled row reference is not a mismatch');
});

test('import runs pages runs and error rows with one row of lookahead', async () => {
  const sdk = fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(3), run(2), run(1)],
    sys_import_set_row: [row(1), row(2)] });
  const data = await readImportRuns(sdk, SET, { limit: 2, errors: 1 });
  assert.deepEqual(data.runs.map(r => r.number), ['TH0001003', 'TH0001002']);
  assert.equal(data.runs_has_more, true);
  assert.equal(data.error_rows.rows.length, 1);
  assert.equal(data.error_rows.has_more, true);
});

test('import runs says so when nothing matches, and never reports a missing target as an empty history', async () => {
  await assert.rejects(readImportRuns(fakeSdk({}), 'ISET0099999', {}), /Import set or data source not found/);
  const sdk = fakeSdk({ sys_data_source: [ds(), ds({ sys_id: ref('b'.repeat(32)) })] });
  await assert.rejects(readImportRuns(sdk, 'Nightly users', {}), /2 data sources are named/);
});

test('import runs on a set no transform has run on reports no runs and reads no rows', async () => {
  const sdk = fakeSdk({ sys_import_set: [set(SET, 'ISET0010001', '')] });
  const data = await readImportRuns(sdk, SET, {});
  assert.deepEqual(data.runs, []);
  assert.equal(data.data_source, null);
  assert.equal(data.error_rows, null);
  assert.deepEqual(sdk.calls.map(c => c.table), ['sys_import_set', 'sys_import_set_run']);
  assert.deepEqual(data.notes, ['No transform run of ISET0010001 is visible to this identity: none has run, or sys_import_set_run is ACL-hidden.']);
  const source = await readImportRuns(fakeSdk({ sys_data_source: [ds()] }), DS, {});
  assert.deepEqual(source.notes, ['No transform run of Nightly users is visible to this identity: none has run, its import sets were cleaned up, or sys_import_set_run is ACL-hidden.']);
  assert.match(formatImportRuns(source), /last success 2026-11-25 00:00:00[\s\S]*\(no runs\)[\s\S]*cleaned up/);
});

test('import runs never shows a run that counted errors as having no error rows', async () => {
  const data = await readImportRuns(fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2)], sys_import_set_row: [] }), SET, {});
  assert.deepEqual(data.error_rows.rows, []);
  assert.deepEqual(data.notes, ['TH0001002 counted 2 error(s), but no error row of ISET0010001 is visible to this identity.']);
  assert.match(formatImportRuns(data), /none visible to this identity/);
  const clean = await readImportRuns(fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2, SET, { errors: ref('0') })], sys_import_set_row: [] }), SET, {});
  assert.deepEqual(clean.notes, []);
  assert.match(formatImportRuns(clean), /left them:\n {2}none\n/);
});

test('import runs never reports a denied or malformed response as success', async () => {
  const denied = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readImportRuns(fakeSdk({ sys_import_set: denied }), 'ISET0010001', {}), /Forbidden/);
  await assert.rejects(readImportRuns(fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: denied }), SET, {}), /Forbidden/);
  await assert.rejects(readImportRuns(fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: ['junk'] }), SET, {}), /Malformed/);
  await assert.rejects(readImportRuns(fakeSdk({ sys_import_set: [{ ...set(), sys_id: ref(SET2) }] }), SET, {}), /different record/);
});

test('import runs command prints the newest run and its error rows', async () => {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; }, epilogue() { return this; } };
  importCmd(fn => fn).builder(builder);
  const { handler } = commands.find(c => c.command.startsWith('runs '));
  let data;
  let options;
  const app = { requireInstance() {}, output: { getFormat: () => 'auto' },
    sdk: fakeSdk({ sys_import_set: [set()], sys_data_source: [ds()], sys_import_set_run: [run(2)], sys_import_set_row: [row(2)] }),
    ok(value, opts) { data = value; options = opts; } };
  await handler({ target: 'ISET0010001', limit: 10, errors: 20 }, app);
  assert.match(options.summary, /ISET0010001: 1 run\(s\), newest TH0001002 complete_with_errors with 2 error\(s\)/);
  assert.match(data._formatted, /TH0001002/);
  assert.match(data._formatted, /Row 2: coalesce value missing/);
  assert.equal(Object.keys(data).includes('_formatted'), false);
});
