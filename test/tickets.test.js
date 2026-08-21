// Tests for tickets command — structure tests

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Tickets Command Structure', () => {
  it('should export ticketsCmd', async () => {
    const { ticketsCmd } = await import('../src/commands/tickets.js');
    assert.strictEqual(typeof ticketsCmd, 'function');
  });

  it('should define all CRUD subcommands', async () => {
    const { ticketsCmd } = await import('../src/commands/tickets.js');
    const wrap = (fn) => fn;
    const cmd = ticketsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('show'));
    assert.ok(names.includes('create'));
    assert.ok(names.includes('update'));
    assert.ok(names.includes('delete'));
  });
});

// ─── Handler resolve behavior (via the shared resolver seam) ───

describe('Tickets resolve behavior', () => {
  function makeApp(capture = {}, rows = []) {
    return {
      config: {},
      getEffectiveInstance: () => 'https://dev.service-now.com',
      output: { getFormat: () => 'json' },
      sdk: {
        list: async (_table, params) => {
          capture.query = params.get('sysparm_query');
          capture.displayValue = params.get('sysparm_display_value');
          return rows;
        },
      },
      ok: (data, opts = {}) => ({ data, opts }),
      requireInstance: () => {},
    };
  }

  async function getHandler(idx) {
    const { ticketsCmd } = await import('../src/commands/tickets.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = ticketsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...r) => { subcommands.push(typeof c === 'object' ? c.handler : r[1]); return mockYargs; } };
    cmd.builder(mockYargs);
    return subcommands[idx];
  }

  it('show resolves by number with display values', async () => {
    const capture = {};
    const app = makeApp(capture, [{ sys_id: 's1', number: 'TASK001' }]);
    const show = await getHandler(1);
    await show({ app, number: 'TASK001', _: ['show', 'TASK001'] });
    assert.strictEqual(capture.query, 'number=TASK001');
    assert.strictEqual(capture.displayValue, 'all');
  });

  it('show throws "Ticket not found: <number>" on empty result', async () => {
    const app = makeApp({}, []);
    const show = await getHandler(1);
    await assert.rejects(
      () => show({ app, number: 'NOPE', _: ['show', 'NOPE'] }),
      /Ticket not found: NOPE/
    );
  });
});
