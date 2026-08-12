// Tests for updatesets commands — structure + rich detail formatter

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure ───

describe('UpdateSets Command Structure', () => {
  it('should export updateSetsCmd', async () => {
    const { updateSetsCmd } = await import('../src/commands/dev/updatesets.js');
    assert.strictEqual(typeof updateSetsCmd, 'function');
  });

  it('should define all subcommands', async () => {
    const { updateSetsCmd } = await import('../src/commands/dev/updatesets.js');
    const wrap = (fn) => fn;
    const cmd = updateSetsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    for (const n of ['list', 'show', 'set', 'current', 'create', 'complete', 'delete', 'export']) {
      assert.ok(names.includes(n), `missing subcommand: ${n}`);
    }
  });
});

// ─── Rich detail formatter ───

describe('formatUpdateSetDetail', () => {
  it('renders header fields plus children filenames newest-first', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/dev/updatesets.js');

    const calls = [];
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table, params) => {
          calls.push({ table, query: params.get('sysparm_query') });
          if (table === 'sys_update_set') {
            return [{
              sys_id: 'abc123',
              name: 'My Feature',
              state: { display_value: 'In progress', value: 'in progress' },
              application: { display_value: 'My App', value: 'x_my_app' },
              parent: { display_value: 'Parent Set', value: 'par001' },
              sys_created_on: { display_value: '2026-08-01 10:00:00', value: '2026-08-01' },
              sys_updated_on: { display_value: '2026-08-11 09:00:00', value: '2026-08-11' },
            }];
          }
          // sys_update_xml children — newest first per the ORDERBY
          return [
            { name: 'b.xml', sys_updated_on: '2026-08-11 09:00:00' },
            { name: 'a.xml', sys_updated_on: '2026-08-10 09:00:00' },
          ];
        },
      },
    };

    const detail = await formatUpdateSetDetail(app, { sys_id: 'abc123', name: 'My Feature' });

    assert.strictEqual(detail.name, 'My Feature');
    assert.strictEqual(detail.state, 'In progress');
    assert.strictEqual(detail.application, 'My App');
    assert.strictEqual(detail.parent, 'Parent Set');
    assert.deepStrictEqual(detail.children, ['b.xml', 'a.xml']);
    assert.strictEqual(detail.link, 'https://dev.service-now.com/sys_update_set.do?sys_id=abc123');
    assert.ok(detail._formatted.includes('Update set: My Feature'));
    assert.ok(detail._formatted.includes('Parent:    Parent Set'));
    assert.ok(detail._formatted.includes('Updates:   2'));
    assert.ok(detail._formatted.includes('    b.xml'));
    // open set → set/parent/complete hints
    assert.deepStrictEqual(detail.hints.map(h => h.action), ['set', 'parent', 'complete']);
  });

  it('closed sets get a cannot-set hint and no complete hint', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/dev/updatesets.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_update_set'
          ? [{ sys_id: 'x1', name: 'Shipped', state: { display_value: 'Complete', value: 'complete' }, application: 'Global' }]
          : [],
      },
    };
    const detail = await formatUpdateSetDetail(app, { sys_id: 'x1', name: 'Shipped' });
    assert.deepStrictEqual(detail.hints.map(h => h.action), ['set', 'parent']);
    assert.ok(detail.hints[0].description.includes('Cannot set as current'));
  });

  it('shows Updates: 0 when a set has no children', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/dev/updatesets.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_update_set'
          ? [{ sys_id: 'x1', name: 'Empty', state: 'Complete', application: 'Global' }]
          : [],
      },
    };
    const detail = await formatUpdateSetDetail(app, { sys_id: 'x1', name: 'Empty' });
    assert.deepStrictEqual(detail.children, []);
    assert.ok(detail._formatted.includes('Updates:   0'));
  });
});
