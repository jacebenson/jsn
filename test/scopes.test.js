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
