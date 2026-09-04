// Tests for jsn eval scope resolution (issue #161)
// eval must default to the active scope from apps.current_app (same
// source as the banner), overriding only when --scope is explicit.

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// Mutable state the context mock closures read at call time.
// (mock.module snapshots named exports at registration, so tests mutate
// this object instead of the exported bindings.)
const state = {
  currentUserSysId: 'user123',
  activeScope: 'x_myapp',
};

function makeSdk(overrides = {}) {
  return {
    resolveScope: async (scope) => (scope === 'global' ? null : `scope-${scope}`),
    executeScript: async () => 'ok',
    ...overrides,
  };
}

function makeApp(sdk) {
  return {
    sdk,
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok: (data, opts) => ({ data, opts }),
  };
}

describe('eval scope resolution (issue #161)', () => {
  let evalCmd;

  beforeEach(async () => {
    state.currentUserSysId = 'user123';
    state.activeScope = 'x_myapp';
    mock.module('../src/context.js', {
      namedExports: {
        getCurrentUser: async () => ({ sys_id: state.currentUserSysId }),
        getCurrentApplication: async () => ({ scope: state.activeScope, appSysId: 'app123' }),
      },
    });
    ({ evalCmd } = await import('../src/commands/eval.js'));
  });

  afterEach(() => {
    mock.reset();
  });

  it('defaults to the active scope when --scope is omitted', async () => {
    let execScope = null;
    const sdk = makeSdk({
      executeScript: async (_script, scope) => { execScope = scope; return 'ok'; },
    });
    const cmd = evalCmd((fn) => fn);
    await cmd.handler({ app: makeApp(sdk), script: 'gs.info(1);' }, makeApp(sdk));

    assert.strictEqual(execScope, 'scope-x_myapp', 'executeScript should receive the resolved scope sys_id');
  });

  it('explicit --scope overrides the active scope', async () => {
    let execScope = null;
    const sdk = makeSdk({
      executeScript: async (_script, scope) => { execScope = scope; return 'ok'; },
    });
    const cmd = evalCmd((fn) => fn);
    await cmd.handler(
      { app: makeApp(sdk), script: 'gs.info(1);', scope: 'x_other' },
      makeApp(sdk)
    );

    assert.strictEqual(execScope, 'scope-x_other', 'explicit --scope should win (resolved sys_id)');
  });

  it('falls back to global when no active scope exists', async () => {
    state.activeScope = 'global';
    let execScope = 'unset';
    const sdk = makeSdk({
      executeScript: async (_script, scope) => { execScope = scope; return 'ok'; },
    });
    const cmd = evalCmd((fn) => fn);
    await cmd.handler({ app: makeApp(sdk), script: 'gs.info(1);' }, makeApp(sdk));

    assert.strictEqual(execScope, '', 'executeScript should receive empty scope → global fallback');
  });

  it('reports when the active scope cannot be resolved', async () => {
    state.activeScope = 'ghost_scope';
    const sdk = makeSdk({
      resolveScope: async () => null, // not found
    });
    const cmd = evalCmd((fn) => fn);
    await assert.rejects(
      () => cmd.handler({ app: makeApp(sdk), script: 'gs.info(1);' }, makeApp(sdk)),
      /Scope not found: ghost_scope/
    );
  });

  it('still requires --script, --file, or --stdin', async () => {
    const sdk = makeSdk();
    const cmd = evalCmd((fn) => fn);
    await assert.rejects(
      () => cmd.handler({ app: makeApp(sdk) }, makeApp(sdk)),
      /--script, --file, or --stdin is required/
    );
  });
});
