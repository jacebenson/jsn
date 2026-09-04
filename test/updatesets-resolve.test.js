// resolveUpdateSetByName scope-resolution fallbacks (issue #168).
// Live import AFTER mock.module so the context bindings updateSets.js consumes
// are the mocked ones (updatesets.js must not be loaded earlier in this file).

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

const SETS = {
  setA: { sys_id: 'set-A', application: { display_value: 'Global', value: 'global' } },
  setB: { sys_id: 'set-B', application: { display_value: 'MyApp', value: 'x_my_app' } },
  setC: { sys_id: 'set-C', application: { display_value: 'Other', value: 'x_other' } },
};

describe('resolveUpdateSetByName fallbacks (#168)', () => {
  let state;
  beforeEach(() => {
    state = { appSysId: '', currentSysId: 'set-B' };
    mock.module('../src/context.js', {
      namedExports: {
        requireCurrentUserSysId: async () => 'user1',
        getCurrentApplication: async () => ({ scope: 'global', appSysId: state.appSysId }),
        getCurrentUpdateSet: async () => (state.currentSysId ? { sys_id: state.currentSysId, name: 'Default' } : null),
        setCurrentApplication: async () => {},
        setCurrentUpdateSet: async () => {},
      },
    });
  });
  afterEach(() => mock.reset());

  it('falls back to the current update set sys_id when apps.current_app pref is missing', async () => {
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = { sdk: { list: async () => [SETS.setA, SETS.setB, SETS.setC] } };
    const resolved = await resolveUpdateSetByName(app, 'Default');
    assert.strictEqual(resolved.sys_id, 'set-B');
  });

  it('falls back to a unique Global-scope set when no current set is known', async () => {
    state.currentSysId = null;
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = { sdk: { list: async () => [SETS.setA, SETS.setB] } };
    const resolved = await resolveUpdateSetByName(app, 'Default');
    assert.strictEqual(resolved.sys_id, 'set-A');
  });

  it('prefers the current-scope set when the preference exists (unchanged behavior)', async () => {
    state.appSysId = 'x_my_app'; // pref set → scope match wins over current-set id
    state.currentSysId = 'set-C';
    const { resolveUpdateSetByName } = await import('../src/commands/updatesets.js');
    const app = { sdk: { list: async () => [SETS.setA, SETS.setB, SETS.setC] } };
    const resolved = await resolveUpdateSetByName(app, 'Default');
    assert.strictEqual(resolved.sys_id, 'set-B');
  });
});
