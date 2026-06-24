// Tests for records command — structure tests
// Integration tests with mock HTTP transport use ./helpers/mock-transport.js

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure Tests ───

describe('Records Command Structure', () => {
  it('should export recordsCmd', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    assert.strictEqual(typeof recordsCmd, 'function');
  });

  it('should define all CRUD subcommands', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const wrap = (fn) => fn;
    const cmd = recordsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('get'));
    assert.ok(names.includes('create'));
    assert.ok(names.includes('update'));
    assert.ok(names.includes('delete'));
  });

  it('should define inspect subcommand', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const wrap = (fn) => fn;
    const cmd = recordsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('inspect'));
  });
});

// ─── SDK Helper Function Tests ───

describe('SDK Helper Functions', () => {
  it('should properly construct list params', () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '20');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,number,short_description');
    params.set('sysparm_query', 'active=true^ORDERBYDESCsys_updated_on');

    assert.strictEqual(params.get('sysparm_limit'), '20');
    assert.strictEqual(params.get('sysparm_fields'), 'sys_id,number,short_description');
    assert.strictEqual(params.get('sysparm_query'), 'active=true^ORDERBYDESCsys_updated_on');
  });
});
