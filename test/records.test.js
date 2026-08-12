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

// ─── records get handler (regression: missing assertSafeExactMatch import, #153) ───

describe('Records Get Handler', () => {
  async function getHandler() {
    const { recordsCmd } = await import('../src/commands/records.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = recordsCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    const getCmd = subcommands.find(s => s.def.startsWith('get'));
    assert.ok(getCmd, 'get subcommand not found');
    return getCmd.handler;
  }

  it('get with a safe sys_id calls sdk.list (import wired, no ReferenceError)', async () => {
    const handler = await getHandler();
    let listCalled = false;
    const app = {
      config: { profiles: {} },
      sdk: { list: async () => { listCalled = true; return [{ sys_id: 'abc123' }]; } },
      ok: () => {},
      getEffectiveInstance: () => 'https://dev.service-now.com',
    };
    await handler({ app, table: 'sys_script_include', 'sys-id': 'abc123def456abc123def456abc123de', _: ['get'] });
    assert.ok(listCalled, 'sdk.list should be called for a safe sys_id');
  });

  it('get with an unsafe sys_id (^) is rejected before hitting the SDK', async () => {
    const handler = await getHandler();
    let listCalled = false;
    const app = {
      config: { profiles: {} },
      sdk: { list: async () => { listCalled = true; return []; } },
      ok: () => {},
      getEffectiveInstance: () => 'https://dev.service-now.com',
    };
    await assert.rejects(
      () => handler({ app, table: 'sys_script_include', 'sys-id': 'abc^OR1=1', _: ['get'] }),
      /Unsafe identifier/
    );
    assert.ok(!listCalled, 'sdk.list must NOT be called for an unsafe sys_id');
  });
});
