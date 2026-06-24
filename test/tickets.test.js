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
