import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importCmd } from '../src/commands/import.js';
import { isMutationCommand } from '../src/mutations.js';
import { parseImportRows } from '../src/import-sets.js';

const TABLE = 'u_staging';
const SELF = { sys_id: 'a'.repeat(32), name: TABLE, super_class: { value: 'b'.repeat(32) } };
const ROW_BASE = { sys_id: 'b'.repeat(32), name: 'sys_import_set_row', super_class: { value: '' } };
const MAP = { sys_id: 'c'.repeat(32), name: 'Staging to incident', target_table: 'incident' };

const DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jsn-import-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let files = 0;
function file(name, text) {
  const dir = path.join(DIR, String(files++));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

const result = (status, extra = {}) => ({ import_set: 'ISET0010001', staging_table: TABLE,
  result: [{ transform_map: MAP.name, table: 'incident', sys_id: 'd'.repeat(32), status, ...extra }] });

function fixture({ fields = ['u_name', 'u_city'], maps = [MAP], parent = ROW_BASE, responses = [], missing = [] } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; }, epilogue() { return this; } };
  importCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command.startsWith('load ')).handler;
  const reads = [];
  const posts = [];
  let data;
  let options;
  const app = {
    sdk: {
      baseURL: 'https://example.test',
      listStrict: async (table, params, opts = {}) => {
        const query = params.get('sysparm_query');
        reads.push({ table, query, limit: params.get('sysparm_limit') });
        let rows = [];
        if (table === 'sys_db_object') rows = query === `name=${TABLE}` ? [SELF] : query === `sys_id=${'b'.repeat(32)}` ? [parent] : [];
        if (table === 'sys_dictionary') rows = fields.map((element, i) => ({ sys_id: String(i).padStart(32, '0'), name: TABLE, element, internal_type: 'string', reference: '' }));
        if (table === 'sys_transform_map') rows = maps;
        if (table === 'incident') rows = query.replace('sys_idIN', '').split(',').filter(id => !missing.includes(id)).map(sys_id => ({ sys_id }));
        if (opts.responseMetadata) opts.responseMetadata.total = rows.length;
        return rows;
      },
      request: async (endpoint, opts) => {
        posts.push({ endpoint, method: opts.method, body: JSON.parse(opts.body) });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    ok(value, opts) { data = value; options = opts; },
  };
  return { reads, posts, get data() { return data; }, get options() { return options; },
    run: (args = {}) => handler({ table: TABLE, limit: 200, yes: false, ...args }, app) };
}

async function withExitCode(fn) {
  const previous = process.exitCode;
  try { await fn(); return process.exitCode; } finally { process.exitCode = previous; }
}

test('import load is a mutation, so read-only profiles refuse it', () => {
  importCmd(fn => fn); // the factory declares the command's capabilities, as buildCLI does
  assert.equal(isMutationCommand({ _: ['import', 'load', TABLE] }), true);
  assert.equal(isMutationCommand({ _: ['import', 'list'] }), false);
});

test('import load previews by default: validates table, columns and maps without sending a row', async () => {
  const f = fixture();
  await f.run({ file: file('rows.json', JSON.stringify([{ u_name: 'a' }, { u_name: 'b', u_city: 'c' }])) });
  assert.deepEqual(f.posts, []);
  assert.equal(f.data.dry_run, true);
  assert.equal(f.data.rows, 2);
  assert.deepEqual(f.data.columns, ['u_name', 'u_city']);
  assert.deepEqual(f.data.transform_maps, [{ sys_id: MAP.sys_id, name: MAP.name, target_table: 'incident' }]);
  assert.match(f.data.rerun, /--yes/);
  assert.ok(f.reads.some(r => r.table === 'sys_transform_map' && r.query === `source_table=${TABLE}^active=true^ORDERBYorder`));
});

test('import load posts each row to the Import Set API and reports each transform outcome', async () => {
  const f = fixture({ responses: [result('inserted'), result('updated', { status_message: 'Matched on name' }), result('ignored')] });
  const exitCode = await withExitCode(() => f.run({ yes: true, file: file('rows.csv', 'u_name,u_city\na,"x, y"\nb,z\nc,\n') }));
  assert.equal(exitCode, undefined);
  assert.deepEqual(f.posts.map(p => [p.method, p.endpoint]), Array(3).fill(['POST', `https://example.test/api/now/import/${TABLE}`]));
  assert.deepEqual(f.posts.map(p => p.body), [{ u_name: 'a', u_city: 'x, y' }, { u_name: 'b', u_city: 'z' }, { u_name: 'c', u_city: '' }]);
  assert.deepEqual(f.data.results.map(r => [r.row, r.status, r.table, r.sys_id]), [
    [1, 'inserted', 'incident', 'd'.repeat(32)], [2, 'updated', 'incident', 'd'.repeat(32)], [3, 'ignored', 'incident', 'd'.repeat(32)]]);
  assert.equal(f.data.results[1].status_message, 'Matched on name');
  assert.deepEqual(f.data.import_sets, ['ISET0010001']);
  assert.deepEqual(f.data.counts, { inserted: 1, updated: 1, ignored: 1 });
  assert.equal(f.data.failed, 0);
  assert.deepEqual(f.reads.filter(r => r.table === 'incident').map(r => [r.query, r.limit]), [[`sys_idIN${'d'.repeat(32)},${'d'.repeat(32)}`, '2']]);
  assert.match(f.options.summary, /^Loaded 3 row\(s\)/);
});

test('import load refuses malformed files and bad arguments before any request', async () => {
  const cases = [
    [{ file: file('rows.json', '{not json') }, /not valid JSON/],
    [{ file: file('rows.json', '{"u_name":"a"}') }, /array of row objects/],
    [{ file: file('rows.json', '[]') }, /no rows/],
    [{ file: file('rows.json', '["a"]') }, /Row 1 is not an object/],
    [{ file: file('rows.json', '[{}]') }, /Row 1 has no columns/],
    [{ file: file('rows.json', '[{"u_name":{"a":1}}]') }, /Row 1 column u_name/],
    [{ file: file('rows.csv', 'u_name,u_city\na\n') }, /Row 1 has 1 field\(s\); the header has 2/],
    [{ file: file('rows.csv', 'u_name\n"a\n') }, /unterminated quote/],
    [{ file: file('rows.csv', 'u_name,u_name\na,b\n') }, /header/],
    [{ file: file('rows.txt', 'u_name\na\n') }, /\.json or \.csv/],
    [{ file: path.join(os.tmpdir(), 'jsn-missing-import.json') }, /Cannot read --file/],
    [{ file: file('rows.json', '[{"u_name":"a"},{"u_name":"b"}]'), limit: 1 }, /2 rows exceed --limit 1/],
    [{ file: file('rows.json', '[{"u_name":"a"}]'), limit: 0 }, /--limit must be a positive/],
    [{ file: file('rows.json', '[{"u_name":"a"}]'), table: 'u_bad;table' }, /staging table name/],
  ];
  for (const [args, message] of cases) {
    const f = fixture();
    await assert.rejects(f.run({ yes: true, ...args }), message);
    assert.deepEqual(f.reads, [], String(message));
    assert.deepEqual(f.posts, [], String(message));
  }
});

test('import load refuses an unknown, non-staging or unmapped table and unknown columns with zero writes', async () => {
  const rows = file('rows.json', '[{"u_name":"a"}]');
  const cases = [
    [fixture(), { table: 'u_missing' }, /u_missing is not visible/],
    [fixture({ parent: { sys_id: 'b'.repeat(32), name: 'task', super_class: { value: '' } } }), {}, /does not extend sys_import_set_row/],
    [fixture({ fields: ['u_city'] }), {}, /Unknown column\(s\) on u_staging: u_name/],
    [fixture({ maps: [] }), {}, /No active transform map for u_staging is visible/],
  ];
  for (const [f, args, message] of cases) {
    await assert.rejects(f.run({ yes: true, file: rows, ...args }), message);
    assert.deepEqual(f.posts, [], String(message));
  }
});

test('import load never reports a row error as success and keeps loading the rows after it', async () => {
  const f = fixture({ responses: [result('error', { error_message: 'Coalesce failed' }), result('inserted')] });
  const exitCode = await withExitCode(() => f.run({ yes: true, file: file('rows.json', '[{"u_name":"a"},{"u_name":"b"}]') }));
  assert.equal(exitCode, 1);
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.data.results.map(r => [r.row, r.status, r.error_message]), [[1, 'error', 'Coalesce failed'], [2, 'inserted', undefined]]);
  assert.equal(f.data.failed, 1);
  assert.match(f.options.summary, /^Import load had errors/);
});

test('import load treats an error message, an unknown status or an empty result as a row error', async () => {
  for (const response of [result('inserted', { error_message: 'Script error' }), result('mystery'), result('inserted', { sys_id: '' }), { import_set: 'ISET0010001', result: [] }]) {
    const f = fixture({ responses: [response] });
    const exitCode = await withExitCode(() => f.run({ yes: true, file: file('rows.json', '[{"u_name":"a"}]') }));
    assert.equal(exitCode, 1);
    assert.equal(f.data.failed, 1);
  }
});

test('import load reads each written target back and fails a row whose record is not there', async () => {
  const other = 'f'.repeat(32);
  const f = fixture({ responses: [result('inserted'), result('updated', { sys_id: other })], missing: [other] });
  const exitCode = await withExitCode(() => f.run({ yes: true, file: file('rows.json', '[{"u_name":"a"},{"u_name":"b"}]') }));
  assert.equal(exitCode, 1);
  assert.deepEqual(f.data.results.map(r => [r.row, r.error_message]), [[1, undefined], [2, `incident ${other} was not found when read back after the load.`]]);
  assert.equal(f.data.failed, 1);
});

test('import load stops at the first failed request and reports the rows it did not send', async () => {
  const f = fixture({ responses: [result('inserted'), Object.assign(new Error('HTTP 500'), { status: 500 })] });
  const exitCode = await withExitCode(() => f.run({ yes: true, file: file('rows.json', '[{"u_name":"a"},{"u_name":"b"},{"u_name":"c"}]') }));
  assert.equal(exitCode, 1);
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.data.results.map(r => [r.row, r.status]), [[1, 'inserted'], [2, 'error']]);
  assert.equal(f.data.not_sent, 1);
  assert.match(f.options.summary, /1 not sent/);
});

test('parseImportRows reads quoted CSV fields, CRLF, a BOM and JSON records envelopes', () => {
  assert.deepEqual(parseImportRows('rows.csv', '\uFEFFu_name,u_note\r\n"Smith, J","said ""hi""\nthen left"\r\n\r\n'),
    [{ u_name: 'Smith, J', u_note: 'said "hi"\nthen left' }]);
  assert.deepEqual(parseImportRows('rows.csv', 'u_name,u_note\n,\na,b\n'), [{ u_name: 'a', u_note: 'b' }]);
  assert.deepEqual(parseImportRows('rows.json', '{"records":[{"u_name":"a","u_count":2,"u_flag":true,"u_empty":null}]}'),
    [{ u_name: 'a', u_count: '2', u_flag: 'true', u_empty: '' }]);
});
