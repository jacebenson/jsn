// Tests for the cmdb command — structure + relationship traversal with a
// mocked sdk layer (no live instance).

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { collectHandlers, makeApp, makeSDK } from './support/cmdb-fixtures.js';

describe('cmdb command structure', () => {
  it('exports cmdbCmd', async () => {
    const { cmdbCmd } = await import('../src/commands/cmdb.js');
    assert.strictEqual(typeof cmdbCmd, 'function');
  });

  it('defines the relationships subcommand', async () => {
    const subs = await collectHandlers();
    assert.ok(subs.some((s) => s.command === 'relationships'));
  });

  it('defines list and show subcommands', async () => {
    const subs = await collectHandlers();
    assert.ok(subs.some((s) => s.command === 'list'));
    assert.ok(subs.some((s) => s.command.startsWith('show ')));
  });

  it('uses optional [subcommand] so bare `jsn cmdb` shows help, not a yargs error', async () => {
    const { cmdbCmd } = await import('../src/commands/cmdb.js');
    const cmd = cmdbCmd((fn) => fn);
    assert.match(cmd.command, /cmdb \[subcommand\]/);
    assert.doesNotMatch(cmd.command, /cmdb <subcommand>/);
  });
});
describe('cmdb list — CI listing', () => {
  async function run(argv) {
    const { sdk, listCalls } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const sub = subs.find((s) => s.command === 'list');
    await sub.handler({ query: undefined, columns: undefined, limit: 20, offset: 0, count: true, app, ...argv });
    return { app, listCalls };
  }

  it('lists cmdb_ci with default columns and display values', async () => {
    const { listCalls, app } = await run({});
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci');
    assert.ok(ciCall, 'should query cmdb_ci');
    assert.strictEqual(ciCall.fields, 'sys_id,name,operational_status,ip_address');
    assert.strictEqual(ciCall.display, 'all');
    const data = app.okCalls[0].data;
    assert.strictEqual(data.table, 'cmdb_ci');
    assert.strictEqual(data.pagination.total, 42);
    assert.strictEqual(data.records.length, 4);
    assert.ok(Array.isArray(app.okCalls[0].opts.breadcrumbs));
  });

  it('honors custom columns and encoded query', async () => {
    const { listCalls, app } = await run({ query: 'sys_class_name=cmdb_ci_server', columns: 'name,ip_address' });
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci');
    assert.strictEqual(ciCall.query, 'sys_class_name=cmdb_ci_server');
    assert.strictEqual(ciCall.fields, 'sys_id,name,ip_address');
    assert.strictEqual(app.okCalls[0].data.columns.join(','), 'name,ip_address');
  });
});
