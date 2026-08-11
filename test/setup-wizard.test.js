// Tests for `jsn setup` zero-profile routing to the login wizard.
// This file mocks ../src/commands/auth.js BEFORE setup.js is imported —
// mock.module is a no-op for already-cached modules, so this MUST be a
// separate test file (node --test runs each file in its own process).

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';

afterEach(() => {
  mock.reset();
});

describe('Setup Handler — zero profiles', () => {
  it('routes straight to the login wizard (no hub menu)', async () => {
    let wizardCalled = false;
    let selectCalled = false;

    mock.module('../src/commands/auth.js', {
      namedExports: {
        loginWizard: async () => { wizardCalled = true; return { instanceURL: 'https://dev.service-now.com', profileName: 'dev', loggedIn: false }; },
        modifyProfile: async () => {},
        removeProfile: async () => {},
        pickProfile: async () => 'dev',
      },
    });
    mock.module('@inquirer/prompts', {
      namedExports: {
        select: async () => { selectCalled = true; return 'add'; },
      },
    });

    const { setupCmd } = await import('../src/commands/setup.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = setupCmd(wrap);

    const app = {
      config: { profiles: {}, format: 'json' },
      isInteractive: () => true,
      ok: () => {},
    };

    await cmd.handler({ app, _: ['setup'] });
    assert.ok(wizardCalled, 'loginWizard should be called with zero profiles');
    assert.ok(!selectCalled, 'hub menu must NOT be shown with zero profiles');
  });
});
