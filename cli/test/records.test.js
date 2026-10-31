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

  it('uses optional [subcommand] so bare invocation shows help, not a yargs error', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const wrap = (fn) => fn;
    const cmd = recordsCmd(wrap);
    // Regression: this was '<subcommand>' (required), so bare `jsn records`
    // died with "Not enough non-option arguments" before the handler ran.
    assert.match(cmd.command, /records \[subcommand\]/);
    assert.doesNotMatch(cmd.command, /records <subcommand>/);
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

// ─── cmdb_rel_ci list defaults + relationship breadcrumbs ───

describe('records list — cmdb_rel_ci', () => {
  async function listHandler() {
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
    return subcommands.find((s) => s.def === 'list').handler;
  }

  function makeApp(sdkRows) {
    return {
      config: { profiles: {} },
      sdk: {
        list: async () => sdkRows,
        aggregateCount: async () => 0,
      },
      okCalls: [],
      ok(data, opts) { this.okCalls.push({ data, opts }); },
      requireInstance() {},
      output: { getFormat: () => 'auto' },
      getEffectiveInstance: () => 'https://dev.service-now.com',
    };
  }

  const REL_ROW = {
    sys_id: 'rel001',
    parent: { display_value: 'CMS App FLX', value: 'p1234567890abcdef1234567890abcd', link: 'https://dev/api/now/table/cmdb_ci/p1234567890abcdef1234567890abcd' },
    type: { display_value: 'Depends on::Used by', value: 't1', link: 'https://dev/api/now/table/cmdb_rel_type/t1' },
    child: { display_value: 'Java Server FLX', value: 'c1234567890abcdef1234567890abcd', link: 'https://dev/api/now/table/cmdb_ci/c1234567890abcdef1234567890abcd' },
  };

  it('defaults to parent/type/child columns and formats display values', async () => {
    const handler = await listHandler();
    const app = makeApp([REL_ROW]);
    await handler({ app, table: 'cmdb_rel_ci', 'sys-id': undefined, query: undefined, columns: undefined, limit: 20, offset: 0, count: false, _: ['list'] });
    const data = app.okCalls[0].data;
    assert.deepStrictEqual(data.columns, ['parent', 'type', 'child']);
    assert.strictEqual(data.records[0].parent, 'CMS App FLX');
    assert.strictEqual(data.records[0].type, 'Depends on::Used by');
    assert.strictEqual(data.records[0].child, 'Java Server FLX');
  });

  it('relationshipBreadcrumbs emits relationships + impact hints with raw sys_ids', async () => {
    const { relationshipBreadcrumbs } = await import('../src/commands/records.js');
    const crumbs = relationshipBreadcrumbs(REL_ROW);
    assert.strictEqual(crumbs.length, 2);
    const relCrumb = crumbs.find((c) => c.action === 'relationships');
    assert.ok(relCrumb.cmd.includes('--ci c1234567890abcdef1234567890abcd'), 'child sys_id should drive the walk');
    const impactCrumb = crumbs.find((c) => c.action === 'impact');
    assert.ok(impactCrumb.cmd.includes('--ci p1234567890abcdef1234567890abcd'), 'parent sys_id should drive impact analysis');
  });

  it('relationshipBreadcrumbs handles string-valued refs (display_value=true shape)', async () => {
    const { relationshipBreadcrumbs } = await import('../src/commands/records.js');
    const crumbs = relationshipBreadcrumbs({ parent: 'p1', child: 'c1', type: 't1' });
    assert.strictEqual(crumbs.length, 2);
    assert.ok(crumbs[0].cmd.includes('--ci c1'));
    assert.ok(crumbs[1].cmd.includes('--ci p1'));
  });
});
