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
    let defaultsConfigured = false;
    let saved;
    mock.module('../src/config.js', { namedExports: { saveConfig: config => { saved = structuredClone(config); } } });

    mock.module('../src/commands/auth.js', {
      namedExports: {
        loginWizard: async () => { wizardCalled = true; return { instanceURL: 'https://dev.service-now.com', profileName: 'dev', loggedIn: false }; },
        modifyProfile: async () => {},
        loginProfile: async () => {},
        showAuthStatus: async () => {},
        switchProfile: async () => {},
        logoutProfile: async () => {},
        removeConnection: async () => {},
      },
    });
    mock.module('../src/helpers.js', { namedExports: { canUsePicker: () => true } });
    mock.module('@inquirer/prompts', {
      namedExports: {
        select: async () => { selectCalled = true; return 'add'; },
      },
    });

    mock.module('../src/setup-preferences.js', { namedExports: {
      configureGlobalDefaults: async config => { defaultsConfigured = true; config.connectionDefaults = {}; config.docs = { source: 'hosted' }; },
      configureDocumentation: async () => { throw new Error('must not ask documentation questions'); },
      connectionPreferences: () => ({ read_only: false, skip_confirmations: false, include_counts: true }),
    } });

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
    assert.equal(defaultsConfigured, false, 'first run must not prompt for defaults');
    assert.deepEqual(saved.connectionDefaults, { read_only: false, skip_confirmations: false, include_counts: true });
    assert.equal(saved.docs, undefined);
    assert.ok(!selectCalled, 'hub menu must NOT be shown with zero profiles');
    wizardCalled = false;
    await cmd.handler({ app, 'configure-defaults': true });
    assert.ok(defaultsConfigured, 'explicit defaults switch must reach the existing settings operation');
    assert.equal(wizardCalled, false);
    await assert.rejects(cmd.handler({ app, 'configure-docs': true }), /must not ask documentation questions/);
  });
});
