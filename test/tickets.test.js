import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ticketsCmd } from '../src/commands/tickets.js';
import { makeApp } from './support/app-test-helpers.js';
import { captureCommands, findHandler, wrapHandler } from './support/command-test-helpers.js';

const command = ticketsCmd(wrapHandler);

describe('Tickets Command Structure', () => {
  it('should export ticketsCmd', () => {
    assert.strictEqual(typeof ticketsCmd, 'function');
  });
  it('should define all CRUD subcommands', () => {
    const names = captureCommands(command).map(s => s.command.split(' ')[0]);
    for (const name of ['list', 'show', 'create', 'update', 'delete']) assert.ok(names.includes(name));
  });
});

describe('Tickets resolve behavior', () => {
  it('show resolves by number with display values and returns the ticket', async () => {
    const rows = [{ sys_id: 's1', number: 'TASK001' }];
    const calls = [];
    const app = makeApp({ sdk: {
      list: async (table, params) => { calls.push([table, Object.fromEntries(params)]); return rows; },
    } });
    await findHandler(command, 'show')({ app, number: 'TASK001', _: ['show', 'TASK001'] });
    assert.deepStrictEqual(calls, [['task', { sysparm_query: 'number=TASK001', sysparm_limit: '1', sysparm_display_value: 'all' }]]);
    assert.deepStrictEqual(app.outputCalls, [{ data: rows[0], opts: { summary: 'Ticket TASK001' } }]);
  });

  it('show throws "Ticket not found: <number>" on empty result', async () => {
    const app = makeApp();
    await assert.rejects(
      () => findHandler(command, 'show')({ app, number: 'NOPE', _: ['show', 'NOPE'] }),
      /Ticket not found: NOPE/
    );
  });
});
