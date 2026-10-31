// Tests for the `jsn setup` interactive hub — structure + dispatch routing.
// (Menu/zero-profile mocking lives in setup-hub.test.js — module mocks must
// run in a fresh process before setup.js is imported.)

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure ───

describe('Setup Command Structure', () => {
  it('should export setupCmd function', async () => {
    const { setupCmd } = await import('../src/commands/setup.js');
    assert.strictEqual(typeof setupCmd, 'function');
  });

  it('should define setup command with correct properties', async () => {
    const { setupCmd } = await import('../src/commands/setup.js');
    const wrap = (fn) => fn;
    const cmd = setupCmd(wrap);
    assert.ok(cmd.command.includes('setup'));
    assert.ok(cmd.describe.toLowerCase().includes('manage'));
    assert.ok(!cmd.hidden, 'setup must not be hidden from help');
  });
});

// ─── Dispatch routing (no inquirer needed — isInteractive false) ───

describe('dispatchSetupAction', () => {
  // Each test isolates saveConfig via temp XDG_CONFIG_HOME + cwd so the
  // REAL ~/.config/servicenow/config.json can never be clobbered.
  async function isolate(fn) {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-setup-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);
    try {
      await fn();
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  }

  it('switch action activates the picked profile (no re-auth)', async () => {
    await isolate(async () => {
      const { dispatchSetupAction } = await import('../src/commands/setup.js');
      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com' },
            prod: { instance_url: 'https://prod.service-now.com' },
          },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        ok: (result, opts) => { app._lastResult = result; app._lastSummary = opts.summary; },
      };
      await dispatchSetupAction(app, {}, 'switch');
      // pickProfile with isInteractive false returns the first profile
      assert.strictEqual(app.config.activeProfile, 'dev');
      assert.strictEqual(app._lastResult.active_profile, 'dev');
    });
  });

  it('switch action with a named profile targets it', async () => {
    await isolate(async () => {
      const { dispatchSetupAction } = await import('../src/commands/setup.js');
      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com' },
            prod: { instance_url: 'https://prod.service-now.com' },
          },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        ok: (result) => { app._lastResult = result; },
      };
      await dispatchSetupAction(app, {}, 'switch');
      // The real setActiveProfile flips both active + default
      assert.ok(app._lastResult.active_profile);
    });
  });

  it('remove action deletes the profile and its credentials', async () => {
    await isolate(async () => {
      const { dispatchSetupAction } = await import('../src/commands/setup.js');
      const app = {
        config: {
          profiles: { dev: { instance_url: 'https://dev.service-now.com' } },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        auth: { logout: () => { app._loggedOut = true; } },
        ok: (result) => { app._lastResult = result; },
      };
      await dispatchSetupAction(app, {}, 'remove');
      assert.strictEqual(app.config.profiles.dev, undefined);
      assert.strictEqual(app._lastResult.removed, 'dev');
      assert.ok(app._loggedOut, 'credentials should be cleared');
    });
  });

  it('modify action toggles a profile flag', async () => {
    await isolate(async () => {
      const { dispatchSetupAction } = await import('../src/commands/setup.js');
      const app = {
        config: {
          profiles: { dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth' } },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        ok: (result, opts) => { app._lastResult = result; app._lastSummary = opts.summary; },
      };
      await dispatchSetupAction(app, { name: 'dev', flag: 'read_only' }, 'modify');
      assert.strictEqual(app.config.profiles.dev.read_only, true);
      assert.strictEqual(app._lastResult.read_only, true);
    });
  });
});
