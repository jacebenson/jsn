// sys_import_set has no `name` or `sys_target_table` field: a run is identified
// by `number` and names its target table in `table_name`. Asking ServiceNow for
// the old columns returned two of four requested fields plus a warning on every
// list, and left `jsn import show <number>` unable to resolve a record.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importCmd } from '../src/commands/import.js';

function chain() {
  const y = {
    commands: [],
    option() { return y; },
    positional() { return y; },
    epilogue() { return y; },
    command(definition) { y.commands.push(definition); return y; },
  };
  return y;
}

function listCommand() {
  const y = chain();
  importCmd(handler => handler).builder(y);
  const list = y.commands.find(command => command.command === 'list');
  assert.ok(list, 'import exposes a list subcommand');
  return list;
}

const ROW = {
  sys_id: { value: 'a'.repeat(32), display_value: 'a'.repeat(32) },
  number: { value: 'IMPORT0001001', display_value: 'IMPORT0001001' },
  table_name: { value: 'u_incident', display_value: 'u_incident' },
  state: { value: 'processed', display_value: 'Processed' },
  sys_created_on: { value: '2026-11-24 18:00:01', display_value: '2026-11-24 18:00:01' },
};

describe('jsn import list', () => {
  it('requests the fields sys_import_set actually has', async () => {
    const calls = [];
    let ok;
    const app = {
      sdk: { list: async (table, params) => { calls.push({ table, fields: params.get('sysparm_fields') }); return [ROW]; } },
      output: { getFormat: () => 'json' },
      getEffectiveInstance: () => 'https://fixture.invalid',
      ok: (data) => { ok = data; },
    };
    await listCommand().handler({ limit: 10, _: ['import', 'list'] }, app);
    assert.match(calls[0].fields, /number/);
    assert.match(calls[0].fields, /table_name/);
    assert.doesNotMatch(calls[0].fields, /sys_target_table/);
    assert.deepStrictEqual(ok.columns, ['number', 'table_name', 'state', 'sys_created_on']);
    assert.equal(ok.missing_columns, undefined, 'no requested column may be absent from sys_import_set');
    assert.equal(ok.records[0].number, 'IMPORT0001001');
    assert.equal(ok.records[0].table_name, 'u_incident');
  });
});
