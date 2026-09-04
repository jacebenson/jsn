// Tests for updatesets commands — structure + rich detail formatter

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure ───

describe('UpdateSets Command Structure', () => {
  it('should export updateSetsCmd', async () => {
    const { updateSetsCmd } = await import('../src/commands/updatesets.js');
    assert.strictEqual(typeof updateSetsCmd, 'function');
  });

  it('should define all subcommands', async () => {
    const { updateSetsCmd } = await import('../src/commands/updatesets.js');
    const wrap = (fn) => fn;
    const cmd = updateSetsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    for (const n of ['list', 'show', 'export', 'set', 'create', 'complete', 'ignore', 'parent']) {
      assert.ok(names.includes(n), `missing subcommand: ${n}`);
    }
  });
});

// ─── Rich detail formatter ───

describe('formatUpdateSetDetail', () => {
  it('renders header fields plus children filenames newest-first', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/updatesets.js');

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
              'application.scope': { display_value: 'x_my_app', value: 'x_my_app' },
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
    assert.strictEqual(detail.application, 'My App/x_my_app');
    assert.strictEqual(detail.parent, 'Parent Set');
    assert.deepStrictEqual(detail.children, [{ name: 'b.xml', type: '?' }, { name: 'a.xml', type: '?' }]);
    assert.strictEqual(detail.link, 'https://dev.service-now.com/sys_update_set.do?sys_id=abc123');
    assert.ok(detail._formatted.includes('Update set: My Feature'));
    assert.ok(detail._formatted.includes('Parent:    Parent Set'));
    assert.ok(detail._formatted.includes('Updates:   2'));
    assert.ok(detail._formatted.includes('    b.xml'));
    // open set → set/parent/export/complete/ignore hints
    assert.deepStrictEqual(detail.hints.map(h => h.action), ['set', 'parent', 'export', 'complete', 'ignore']);
  });

  it('closed sets get a cannot-set hint and no complete hint', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/updatesets.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_update_set'
          ? [{ sys_id: 'x1', name: 'Shipped', state: { display_value: 'Complete', value: 'complete' }, application: 'Global' }]
          : [],
      },
    };
    const detail = await formatUpdateSetDetail(app, { sys_id: 'x1', name: 'Shipped' });
    assert.deepStrictEqual(detail.hints.map(h => h.action), ['set', 'parent', 'export']);
    assert.ok(detail.hints[0].description.includes('Cannot set as current'));
  });

  it('classes children by type (name fallback) and flags risky items', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/updatesets.js');
    const H = (x) => x.repeat(32);
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: {
        list: async (table) => table === 'sys_update_set'
          ? [{ sys_id: 's1', name: 'Review Me', state: { display_value: 'In progress', value: 'in progress' }, application: 'Global' }]
          : [
              { name: `sys_security_acl_${H('a')}` },            // risky via name prefix
              { name: `sys_script_${H('b')}` },                  // risky via name prefix
              { name: 'x_my_app.MyRule', sys_class_name: 'sys_script_include' }, // risky via class
              { name: `sys_properties_${H('c')}` },              // not risky
            ],
      },
    };
    const detail = await formatUpdateSetDetail(app, { sys_id: 's1', name: 'Review Me' });
    assert.deepStrictEqual(detail.by_type, {
      sys_security_acl: 1,
      sys_script: 1,
      sys_script_include: 1,
      sys_properties: 1,
    });
    assert.strictEqual(detail.risky_count, 3);
    assert.deepStrictEqual(detail.children.map((c) => c.type),
      ['sys_security_acl', 'sys_script', 'sys_script_include', 'sys_properties']);
    assert.ok(detail._formatted.includes('By type:'));
    assert.ok(detail._formatted.includes('Risky:  3'));
  });

  it('shows Updates: 0 when a set has no children', async () => {
    const { formatUpdateSetDetail } = await import('../src/commands/updatesets.js');
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

// ─── Scope mismatch warning ───

describe('formatUpdateSetLabel', () => {
  it('shows app/system scope names together', async () => {
    const { formatUpdateSetLabel } = await import('../src/commands/updatesets.js');
    const label = formatUpdateSetLabel({
      name: 'Default',
      state: 'In progress',
      application: { display_value: 'test', value: '0fbc46c58335c314f7bfc670ceaad3dc' },
      'application.scope': { display_value: 'x_8821_test', value: 'x_8821_test' },
    });
    assert.strictEqual(label, 'Default [In progress] (test/x_8821_test)');
  });

  it('falls back to display name when scope is unavailable', async () => {
    const { formatUpdateSetLabel } = await import('../src/commands/updatesets.js');
    const label = formatUpdateSetLabel({
      name: 'Global Set',
      state: 'Complete',
      application: { display_value: 'Global', value: 'global' },
    });
    assert.strictEqual(label, 'Global Set [Complete] (Global)');
  });
});

// ─── Scope mismatch warning ───

describe('scopeMismatchWarning', () => {
  it('returns empty when the update set is in the current app (same sys_id)', async () => {
    const { scopeMismatchWarning } = await import('../src/commands/updatesets.js');
    const warn = scopeMismatchWarning(
      { display_value: 'test', value: '0fbc46c58335c314f7bfc670ceaad3dc' },
      { scope: 'x_8821_test', appSysId: '0fbc46c58335c314f7bfc670ceaad3dc' },
    );
    assert.strictEqual(warn, '');
  });

  it('warns when the update set is in a different app', async () => {
    const { scopeMismatchWarning } = await import('../src/commands/updatesets.js');
    const warn = scopeMismatchWarning(
      { display_value: 'Global', value: 'abc123' },
      { scope: 'x_8821_test', appSysId: '0fbc46c58335c314f7bfc670ceaad3dc' },
    );
    assert.ok(warn.includes('in app "Global"'));
    assert.ok(warn.includes('jsn scopes set Global'));
  });

  it('handles a plain-string application field (non-display-value path)', async () => {
    const { scopeMismatchWarning } = await import('../src/commands/updatesets.js');
    const warn = scopeMismatchWarning('global', { scope: 'x_8821_test', appSysId: '0fbc46c58335c314f7bfc670ceaad3dc' });
    assert.ok(warn.includes('in app "global"'));
  });

  it('returns empty when either side is missing', async () => {
    const { scopeMismatchWarning } = await import('../src/commands/updatesets.js');
    assert.strictEqual(scopeMismatchWarning(null, { scope: 'x_8821_test', appSysId: 'x' }), '');
    assert.strictEqual(scopeMismatchWarning({ display_value: 'test', value: 'x' }, null), '');
    assert.strictEqual(scopeMismatchWarning({ display_value: 'test' }, { scope: 'x_8821_test', appSysId: '' }), '');
  });
});

// ─── Name resolution (duplicate "Default" sets) ───

describe('resolveUpdateSetByName', () => {
  const CURRENT_APP_ID = '0fbc46c58335c314f7bfc670ceaad3dc'; // test scope

  const buildApp = (updateSets) => ({
    sdk: {
      list: async (table, params) => {
        const q = params.get('sysparm_query') || '';
        if (table === 'sys_user') {
          return [{ sys_id: 'user1' }];
        }
        if (table === 'sys_user_preference') {
          // apps.current_app → current test scope
          return [{ value: { display_value: CURRENT_APP_ID, value: CURRENT_APP_ID } }];
        }
        if (table === 'sys_scope') {
          return [{ scope: 'x_8821_test' }];
        }
        if (table === 'sys_update_set') {
          return updateSets.filter((r) => q.includes(`name=${r.name}`));
        }
        return [];
      },
    },
  });

  it('prefers the set in the current scope when names collide', async () => {
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = buildApp([
      { sys_id: 'global-default', name: 'Default', application: { display_value: 'Global', value: 'global' }, state: 'in progress' },
      { sys_id: 'test-default', name: 'Default', application: { display_value: 'test', value: CURRENT_APP_ID }, state: 'in progress' },
      { sys_id: 'cs-default', name: 'Default', application: { display_value: 'Creator Studio', value: 'cs-scope-id' }, state: 'in progress' },
    ]);
    const resolved = await resolveUpdateSetByName(app, 'Default');
    assert.strictEqual(getSysId(resolved), 'test-default');
  });

  it('returns the only match when the name is unique', async () => {
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = buildApp([
      { sys_id: 'only-one', name: 'AI in a Box 3.1.6', application: { display_value: 'Global', value: 'global' }, state: 'complete' },
    ]);
    const resolved = await resolveUpdateSetByName(app, 'AI in a Box 3.1.6');
    assert.strictEqual(getSysId(resolved), 'only-one');
  });

  it('throws when the name is not found', async () => {
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = buildApp([]);
    await assert.rejects(() => resolveUpdateSetByName(app, 'Nope'), /not found/);
  });
});

function getSysId(r) {
  return r?.sys_id?.value ?? r?.sys_id;
}

// ─── Export handler ───

describe('updatesets export', () => {
  const XML = '<?xml version="1.0" encoding="utf-8"?>\n<unload>\n  <sys_update_set>\n    <sys_id>abc123</sys_id>\n    <name>My Feature</name>\n  </sys_update_set>\n</unload>';

  // Pull the export subcommand object out of the yargs chain so its handler
  // can be invoked directly with a mocked app.
  async function findExportCmd() {
    const { updateSetsCmd } = await import('../src/commands/updatesets.js');
    const cmd = updateSetsCmd((fn) => fn);
    let found = null;
    const mockYargs = {
      command: (c) => {
        if (typeof c === 'object' && c.command?.startsWith('export ')) found = c;
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    assert.ok(found, 'export subcommand not found');
    return found;
  }

  function makeApp(sdkOverrides = {}) {
    const writes = [];
    const sdk = {
      list: async (table) => {
        if (table === 'sys_update_set') {
          return [{ sys_id: 'abc123', name: 'My Feature', application: { display_value: 'Global', value: 'global' }, state: 'in progress' }];
        }
        return [];
      },
      exportUpdateSet: async () => XML,
      ...sdkOverrides,
    };
    const app = {
      requireInstance: () => {},
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk,
      ok: (data, opts) => { app._ok = { data, opts }; return app._ok; },
    };
    return { app, writes };
  }

  it('writes raw XML to stdout by default (no --json, no --out)', async () => {
    const exportCmd = await findExportCmd();
    const { app } = makeApp();
    let stdout = '';
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    try {
      await exportCmd.handler({ app, name: 'My Feature' }, app);
    } finally {
      process.stdout.write = orig;
    }
    assert.strictEqual(stdout, XML + '\n');
  });

  it('returns the XML in the JSON envelope when --json is passed', async () => {
    const exportCmd = await findExportCmd();
    const { app } = makeApp();
    await exportCmd.handler({ app, name: 'My Feature', json: true }, app);
    assert.strictEqual(app._ok.data.xml, XML);
    assert.strictEqual(app._ok.data.sys_id, 'abc123');
    assert.strictEqual(app._ok.data.bytes, Buffer.byteLength(XML));
  });

  it('writes to --out file and reports the path', async () => {
    const exportCmd = await findExportCmd();
    const { app } = makeApp();
    await exportCmd.handler({ app, name: 'My Feature', out: '/tmp/jsn-export-test.xml' }, app);
    const fs = await import('node:fs');
    assert.strictEqual(fs.readFileSync('/tmp/jsn-export-test.xml', 'utf-8'), XML);
    assert.strictEqual(app._ok.data.out, '/tmp/jsn-export-test.xml');
    assert.strictEqual(app._ok.data.bytes, Buffer.byteLength(XML));
    fs.rmSync('/tmp/jsn-export-test.xml', { force: true });
  });

  it('calls exportUpdateSet with the resolved sys_id and scope', async () => {
    const exportCmd = await findExportCmd();
    let hit = null;
    const { app } = makeApp({
      exportUpdateSet: async (sysID, appSysId) => { hit = { sysID, appSysId }; return XML; },
    });
    await exportCmd.handler({ app, name: 'My Feature' }, app);
    assert.deepStrictEqual(hit, { sysID: 'abc123', appSysId: 'global' });
  });

  it('throws a clear error when the response is not XML', async () => {
    const exportCmd = await findExportCmd();
    const { app } = makeApp({ exportUpdateSet: async () => '<html><body>Login</body></html>' });
    await assert.rejects(
      () => exportCmd.handler({ app, name: 'My Feature' }, app),
      /non-XML response/,
    );
  });

  it('resolves the set by name first (list call before export)', async () => {
    const exportCmd = await findExportCmd();
    const order = [];
    const { app } = makeApp({
      list: async (table) => {
        order.push('list');
        if (table === 'sys_update_set') {
          return [{ sys_id: 'abc123', name: 'My Feature', application: { display_value: 'Global', value: 'global' }, state: 'in progress' }];
        }
        return [];
      },
      exportUpdateSet: async () => { order.push('export'); return XML; },
    });
    await exportCmd.handler({ app, name: 'My Feature' }, app);
    assert.deepStrictEqual(order, ['list', 'export']);
  });
});
