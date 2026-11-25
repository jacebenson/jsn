// `jsn columns list --table <table>` is the remediation command the CLI prints
// when ServiceNow omits a requested column, and the one query-validate names on
// a metadata miss. It has to actually filter: the previous post-build monkey
// patch never registered the option, so `--table` was accepted, ignored, and
// returned every table's dictionary rows.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { columnsCmd } from '../src/commands/columns.js';

function chain() {
  const y = {
    commands: [],
    options: [],
    option(name) { y.options.push(name); return y; },
    positional() { return y; },
    epilogue() { return y; },
    command(definition) { y.commands.push(definition); return y; },
  };
  return y;
}

function listCommand() {
  const y = chain();
  columnsCmd(handler => handler).builder(y);
  const list = y.commands.find(command => command.command === 'list');
  assert.ok(list, 'columns exposes a list subcommand');
  return list;
}

function appWith(calls) {
  return {
    sdk: {
      list: async (table, params) => { calls.push({ table, query: params.get('sysparm_query') }); return []; },
      get: async () => null,
    },
    output: { getFormat: () => 'json' },
    getEffectiveInstance: () => 'https://fixture.invalid',
    ok: () => {},
  };
}

const dictionaryQuery = calls => calls.find(call => call.table === 'sys_dictionary')?.query;

describe('jsn columns list --table', () => {
  it('registers --table when the list subcommand builds its options', () => {
    const options = chain();
    listCommand().builder(options);
    assert.ok(options.options.includes('table'), `--table not registered; options: ${options.options.join(', ')}`);
  });

  it('constrains the dictionary query to the requested table', async () => {
    const calls = [];
    await listCommand().handler({ table: 'sys_import_set', limit: 50, _: ['columns', 'list'] }, appWith(calls));
    assert.equal(dictionaryQuery(calls), 'name=sys_import_set^ORDERBYDESCsys_updated_on');
  });

  it('keeps a user filter after the fixed table constraint', async () => {
    const calls = [];
    await listCommand().handler({ table: 'incident', query: 'active=true', limit: 50, _: ['columns', 'list'] }, appWith(calls));
    assert.match(dictionaryQuery(calls), /^name=incident\^active=true/);
  });

  it('refuses a table value that is not a plain identifier', async () => {
    const calls = [];
    await assert.rejects(
      listCommand().handler({ table: 'incident^ORname=sys_user', limit: 50, _: ['columns', 'list'] }, appWith(calls)),
      /--table takes a table name/,
    );
    assert.equal(dictionaryQuery(calls), undefined, 'an invalid table must not reach the instance');
  });

  it('leaves the unfiltered list unchanged', async () => {
    const calls = [];
    await listCommand().handler({ limit: 50, _: ['columns', 'list'] }, appWith(calls));
    assert.equal(dictionaryQuery(calls), 'ORDERBYDESCsys_updated_on');
  });
});
