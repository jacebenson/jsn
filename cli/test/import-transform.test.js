import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCmd } from '../src/commands/import.js';
import { isMutationCommand } from '../src/mutations.js';

const SET_ID = 'e'.repeat(32);
const MAP = { sys_id: 'c'.repeat(32), name: 'Staging to incident', target_table: 'incident' };
const row = (n, state, extra = {}) => ({ sys_id: String(n).padStart(32, '0'), sys_import_row: String(n), sys_import_state: state,
  sys_import_state_comment: '', sys_target_table: 'incident', sys_target_sys_id: 'd'.repeat(32), sys_transform_map: MAP.sys_id, ...extra });

function fixture({ set = { sys_id: SET_ID, number: 'ISET0010001', table_name: 'u_staging', state: 'processed', mode: 'asynchronous' },
  rows = [row(1, 'inserted'), row(2, 'error')], after = { state: 'processed', rows: [row(1, 'updated'), row(2, 'inserted')] }, afterSet = {},
  maps = [MAP], output = 'JSN_IMPORT_TRANSFORM:{"error":false}', afterReadError } = {}) {
  const commands = [];
  const builder = { command(c) { commands.push(c); return this; }, epilogue() { return this; } };
  importCmd(fn => fn).builder(builder);
  const handler = commands.find(c => c.command.startsWith('transform ')).handler;
  const reads = [];
  const scripts = [];
  let data;
  let options;
  const app = {
    sdk: {
      listStrict: async (table, params) => {
        reads.push({ table, query: params.get('sysparm_query'), limit: params.get('sysparm_limit') });
        if (scripts.length && afterReadError) throw afterReadError;
        if (table === 'sys_import_set') return set ? [scripts.length ? { ...set, state: after.state, ...afterSet } : set] : [];
        if (table === 'sys_import_set_row') return scripts.length ? after.rows : rows;
        if (table === 'sys_transform_map') return maps;
        return [];
      },
      executeScript: async (script, scope) => {
        scripts.push({ script, scope });
        if (output instanceof Error) throw output;
        return output;
      },
    },
    ok(value, opts) { data = value; options = opts; },
  };
  return { reads, scripts, get data() { return data; }, get options() { return options; },
    run: (args = {}) => handler({ import_set: 'ISET0010001', limit: 200, yes: false, ...args }, app) };
}

async function withExitCode(fn) {
  const previous = process.exitCode;
  try { await fn(); return process.exitCode; } finally { process.exitCode = previous; }
}

test('import transform is a mutation, so read-only profiles refuse it', () => {
  importCmd(fn => fn);
  assert.equal(isMutationCommand({ _: ['import', 'transform', 'ISET0010001'] }), true);
});

test('import transform previews by default: reads the set, its rows and maps without running anything', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.scripts, []);
  assert.equal(f.data.dry_run, true);
  assert.equal(f.data.import_set, 'ISET0010001');
  assert.equal(f.data.rows, 2);
  assert.deepEqual(f.data.transform_maps, [MAP]);
  assert.match(f.data.rerun, /--yes/);
  assert.deepEqual(f.reads.map(r => [r.table, r.query]), [
    ['sys_import_set', 'number=ISET0010001'],
    ['sys_import_set_row', `sys_import_set=${SET_ID}^ORDERBYsys_import_row`],
    ['sys_transform_map', 'source_table=u_staging^active=true^ORDERBYorder']]);
  assert.equal(f.reads[1].limit, '201');
});

test('import transform reruns the maps on the instance and reports the rows it reads back afterwards', async () => {
  const f = fixture();
  const exitCode = await withExitCode(() => f.run({ import_set: SET_ID, yes: true }));
  assert.equal(exitCode, undefined);
  assert.equal(f.reads[0].query, `sys_id=${SET_ID}`);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].scope, 'global');
  assert.match(f.scripts[0].script, new RegExp(`get\\('${SET_ID}'\\)`));
  assert.match(f.scripts[0].script, /setSyncImport\(true\)/);
  assert.match(f.scripts[0].script, /transformAllMaps\(set\)/);
  assert.match(f.scripts[0].script, /== 'processed'[\s\S]*if \(!set\.update\(\)\) throw/);
  assert.match(f.scripts[0].script, /'sys_import_state', 'pending'[\s\S]*getAggregate\('COUNT'\) == 0\) throw[\s\S]*transformAllMaps/);
  assert.deepEqual(f.reads.slice(-2).map(r => r.table), ['sys_import_set', 'sys_import_set_row']);
  assert.equal(f.data.state, 'processed');
  assert.deepEqual(f.data.results.map(r => [r.row, r.status, r.table, r.sys_id]), [
    [1, 'updated', 'incident', 'd'.repeat(32)], [2, 'inserted', 'incident', 'd'.repeat(32)]]);
  assert.deepEqual(f.data.counts, { updated: 1, inserted: 1 });
  assert.equal(f.data.failed, 0);
  assert.match(f.options.summary, /^Transformed ISET0010001: 2 row\(s\)/);
});

test('import transform refuses bad arguments and sets it cannot run on before running anything', async () => {
  const cases = [
    [{}, { import_set: 'ISET1^ORnumber!=x' }, /number \(ISET0010001\) or its 32-hex sys_id/],
    [{}, { limit: 0 }, /--limit must be a positive/],
    [{ set: null }, {}, /No import set ISET0010001 is visible/],
    [{ set: { sys_id: SET_ID, number: 'ISET0010001', table_name: 'u_staging', state: 'loading', mode: 'synchronous' } }, {}, /is loading/],
    [{ set: { sys_id: SET_ID, number: 'ISET0010001', table_name: 'u_staging', state: 'loaded', mode: 'asynchronous' } }, {}, /no pending rows/],
    [{ set: { sys_id: SET_ID, number: 'ISET0099999', table_name: 'u_staging', state: 'processed', mode: 'asynchronous' } }, {}, /read back as a different record/],
    [{ set: { sys_id: SET_ID, number: 'ISET0010001', table_name: 'u_staging', state: 'cancelled', mode: 'asynchronous' } }, {}, /is cancelled/],
    [{ set: { sys_id: "x'); gs.print('", number: 'ISET0010001', table_name: 'u_staging', state: 'loaded', mode: 'asynchronous' } }, {}, /unexpected sys_id/],
    [{ rows: [] }, {}, /No rows of ISET0010001 are visible/],
    [{ rows: [row(1, 'inserted'), row(2, 'inserted'), row(3, 'inserted')] }, { limit: 2 }, /more than --limit 2 rows/],
    [{ maps: [] }, {}, /No active transform map for u_staging is visible/],
  ];
  for (const [setup, args, message] of cases) {
    const f = fixture(setup);
    await assert.rejects(f.run({ yes: true, ...args }), message);
    assert.deepEqual(f.scripts, [], String(message));
  }
});

test('import transform runs a loaded set with pending rows without the reprocess step', async () => {
  const f = fixture({ set: { sys_id: SET_ID, number: 'ISET0010001', table_name: 'u_staging', state: 'loaded', mode: 'asynchronous' },
    rows: [row(1, 'pending'), row(2, 'pending')] });
  const exitCode = await withExitCode(() => f.run({ yes: true }));
  assert.equal(exitCode, undefined);
  assert.match(f.scripts[0].script, /!= 'loaded'\) throw/);
});

test('import transform never reports success when the instance or the rows read back say otherwise', async () => {
  const cases = [
    [{ output: 'JSN_IMPORT_TRANSFORM:{"error":true}' }, /transformer reported an error/],
    [{ after: { state: 'loaded', rows: [row(1, 'updated'), row(2, 'inserted')] } }, /set is loaded/],
    [{ after: { state: 'processed', rows: [row(1, 'updated'), row(2, 'error', { sys_import_state_comment: 'No coalesce' })] } }, /1 row\(s\) failed/],
    [{ after: { state: 'processed', rows: [row(1, 'updated'), row(2, 'pending')] } }, /1 row\(s\) failed/],
    [{ after: { state: 'processed', rows: [] } }, /0 of 2 row\(s\) read back/],
    [{ after: { state: 'processed', rows: [row(1, 'updated'), row(2, 'inserted', { sys_target_sys_id: '' })] } }, /1 row\(s\) failed/],
  ];
  for (const [setup, summary] of cases) {
    const f = fixture(setup);
    const exitCode = await withExitCode(() => f.run({ yes: true }));
    assert.equal(exitCode, 1, String(summary));
    assert.match(f.options.summary, summary);
  }
});

test('import transform that cannot read the set back says the transform ran', async () => {
  const f = fixture({ afterReadError: new Error('API error (status 500)') });
  await assert.rejects(f.run({ yes: true }), /The transform ran, but ISET0010001 could not be read back \(API error \(status 500\)\)/);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.data, undefined);
});

test('import transform without its result marker is an unknown outcome, not success', async () => {
  for (const [output, message] of [['', /outcome is unknown/], ['something else', /outcome is unknown/],
    ['JSN_IMPORT_TRANSFORM:{"error":"true"}', /outcome is unknown/], ['JSN_IMPORT_TRANSFORM:{"error":tru}', /outcome is unknown/],
    [new Error('Request timed out'), /outcome is unknown \(Request timed out\)/],
    [new Error('Background script failed: Import set changed to loaded'), e => /changed to loaded/.test(e.message) && !/unknown/.test(e.message)]]) {
    const f = fixture({ output });
    await assert.rejects(f.run({ yes: true }), message);
    assert.equal(f.data, undefined);
  }
});
