// Tests for scopes commands — structure + rich detail formatter

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Scopes Command Structure', () => {
  it('should export scopesCmd', async () => {
    const { scopesCmd } = await import('../src/commands/dev/scopes.js');
    assert.strictEqual(typeof scopesCmd, 'function');
  });

  it('should define all subcommands', async () => {
    const { scopesCmd } = await import('../src/commands/dev/scopes.js');
    const wrap = (fn) => fn;
    const cmd = scopesCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    for (const n of ['list', 'show', 'set', 'create']) {
      assert.ok(names.includes(n), `missing subcommand: ${n}`);
    }
  });
});

describe('formatScopeDetail', () => {
  it('renders scope fields and a record link', async () => {
    const { formatScopeDetail } = await import('../src/commands/dev/scopes.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_scope'
          ? [{
              sys_id: 'abc123',
              name: 'My App',
              scope: 'x_my_app',
              short_description: 'My app description',
              active: 'true',
              version: '1.2.3',
              release_date: '2026-07-01',
              sys_class_name: 'Store Application',
              sys_created_on: '2026-08-01 10:00:00',
              sys_updated_on: '2026-08-11 09:00:00',
            }]
          : [],
      },
    };

    const detail = await formatScopeDetail(app, { sys_id: 'abc123', name: 'My App' });

    assert.strictEqual(detail.name, 'My App');
    assert.strictEqual(detail.scope, 'x_my_app');
    assert.strictEqual(detail.version, '1.2.3');
    assert.strictEqual(detail.release_date, '2026-07-01');
    assert.strictEqual(detail.store_link, 'https://store.servicenow.com/store/apps?q=x_my_app');
    assert.strictEqual(detail.link, 'https://dev.service-now.com/sys_scope.do?sys_id=abc123');
    assert.ok(detail._formatted.includes('Scope: My App'));
    assert.ok(detail._formatted.includes('Scope value: x_my_app'));
    assert.ok(detail._formatted.includes('Version:     1.2.3'));
    assert.ok(detail._formatted.includes('Released:    2026-07-01'));
    assert.ok(detail._formatted.includes('Store:       https://store.servicenow.com/store/apps?q=x_my_app'));
    assert.ok(detail._formatted.includes('Link:        https://dev.service-now.com/sys_scope.do?sys_id=abc123'));
  });

  it('omits the store link for custom (non-store) applications', async () => {
    const { formatScopeDetail } = await import('../src/commands/dev/scopes.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_scope'
          ? [{ sys_id: 'c1', name: 'My Custom App', scope: 'x_custom', sys_class_name: 'Custom Application' }]
          : [],
      },
    };
    const detail = await formatScopeDetail(app, { sys_id: 'c1', name: 'My Custom App' });
    assert.strictEqual(detail.store_link, '');
    assert.ok(!detail._formatted.includes('Store:'));
  });

  it('falls back to the passed record when the fetch fails', async () => {
    const { formatScopeDetail } = await import('../src/commands/dev/scopes.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async () => { throw new Error('boom'); },
      },
    };
    const detail = await formatScopeDetail(app, { sys_id: 'x1', name: 'Minimal', scope: 'x_minimal' });
    assert.strictEqual(detail.name, 'Minimal');
    assert.strictEqual(detail.link, 'https://dev.service-now.com/sys_scope.do?sys_id=x1');
  });
});

describe('resolveScope', () => {
  // The records behind the issue-190 repro: two sys_scope rows share
  // scope=global — the canonical Global record (sys_id=global) and a
  // third-party app (Xplore) that also reports scope=global.
  const GLOBAL = { sys_id: 'global', name: 'Global', scope: 'global' };
  const XPLORE = { sys_id: '0f6ab99a0f36060094f3c09ce1050ee8', name: 'Xplore: Developer Toolkit', scope: 'global' };

  // Mock sdk.list that routes on the sysparm_query field and value.
  function mockSdk(route) {
    return {
      async list(table, params) {
        assert.strictEqual(table, 'sys_scope');
        const q = params.get('sysparm_query') || '';
        for (const [prefix, records] of Object.entries(route)) {
          if (q.startsWith(prefix)) return records;
        }
        return [];
      },
    };
  }

  it('prefers the canonical sys_id=global record when scope=global has duplicates', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    // sys_id=global misses (no such literal row query match in this mock's
    // routing shape), scope=global returns BOTH records — resolver must pick
    // the canonical one, not records[0].
    const sdk = mockSdk({ 'sys_id=global': [], 'scope=global': [XPLORE, GLOBAL] });
    const rec = await resolveScope(sdk, 'global');
    assert.strictEqual(rec.sys_id, 'global');
  });

  it('resolves the literal sys_id "global" via sys_id query (issue 190)', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const sdk = mockSdk({ 'sys_id=global': [GLOBAL] });
    const rec = await resolveScope(sdk, 'global');
    assert.strictEqual(rec.sys_id, 'global');
  });

  it('resolves an explicit 32-hex sys_id (issue 190)', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const sdk = mockSdk({ 'sys_id=0f6ab99a0f36060094f3c09ce1050ee8': [XPLORE] });
    const rec = await resolveScope(sdk, '0f6ab99a0f36060094f3c09ce1050ee8');
    assert.strictEqual(rec.sys_id, '0f6ab99a0f36060094f3c09ce1050ee8');
  });

  it('resolves by scope value when unambiguous', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const app = { sys_id: 'abc', name: 'My App', scope: 'x_my_app' };
    const sdk = mockSdk({ 'sys_id=x_my_app': [], 'scope=x_my_app': [app] });
    const rec = await resolveScope(sdk, 'x_my_app');
    assert.strictEqual(rec.sys_id, 'abc');
  });

  it('falls back to name when sys_id and scope both miss', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const app = { sys_id: 'abc', name: 'My App', scope: 'x_my_app' };
    const sdk = mockSdk({ 'name=My App': [app] });
    const rec = await resolveScope(sdk, 'My App');
    assert.strictEqual(rec.sys_id, 'abc');
  });

  it('throws Scope not found when nothing matches', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const sdk = mockSdk({});
    await assert.rejects(() => resolveScope(sdk, 'nope'), /Scope not found: nope/);
  });

  it('throws an ambiguous error naming the candidates when a non-global scope value ties', async () => {
    const { resolveScope } = await import('../src/commands/dev/scopes.js');
    const a = { sys_id: 'aaa', name: 'App A', scope: 'x_dup' };
    const b = { sys_id: 'bbb', name: 'App B', scope: 'x_dup' };
    const sdk = mockSdk({ 'sys_id=x_dup': [], 'scope=x_dup': [a, b], 'name=x_dup': [] });
    await assert.rejects(
      () => resolveScope(sdk, 'x_dup'),
      (err) => {
        assert.match(err.message, /[Aa]mbiguous/);
        assert.match(err.message, /aaa/);
        assert.match(err.message, /bbb/);
        return true;
      },
    );
  });
});
