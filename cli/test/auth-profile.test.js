// Tests for auth command structure and handler logic

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Auth commands persist profile changes through saveConfig(). Keep every auth
// test away from the developer's real ~/.config/servicenow/config.json,
// including tests that call helpers directly instead of going through a
// deliberately isolated fixture.
let originalAuthTestXdg;
let originalAuthTestCwd;
let authTestConfigHome;

before(() => {
  originalAuthTestXdg = process.env.XDG_CONFIG_HOME;
  originalAuthTestCwd = process.cwd();
  authTestConfigHome = mkdtempSync(path.join(tmpdir(), 'jsn-auth-file-test-'));
  process.env.XDG_CONFIG_HOME = authTestConfigHome;
  process.chdir(authTestConfigHome);
});

after(() => {
  process.chdir(originalAuthTestCwd);
  if (originalAuthTestXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalAuthTestXdg;
  rmSync(authTestConfigHome, { recursive: true, force: true });
});

describe('Auth Command Switch Handler', () => {
  it('should set the active profile via setActiveProfile', async () => {
    // setActiveProfile calls saveConfig() which writes the REAL global config.
    // Isolate with a temp XDG_CONFIG_HOME + cwd so tests can never clobber
    // the user's ~/.config/servicenow/config.json (see PR review note).
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { authCmd } = await import('../src/commands/auth.js');
      const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };

      const cmd = authCmd(wrap);
      const subcommands = [];
      const mockYargs = {
        command: (c, ...rest) => {
          subcommands.push({ def: typeof c === 'string' ? c : c.command, builder: typeof c === 'object' ? c.builder : rest[0], handler: typeof c === 'object' ? c.handler : rest[1] });
          return mockYargs;
        },
      };
      cmd.builder(mockYargs);

      const switchCmd = subcommands.find(s => s.def.startsWith('switch'));
      assert.ok(switchCmd, 'switch subcommand not found');

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

      await switchCmd.handler({ app, name: 'prod', _: ['switch'] });
      assert.strictEqual(app.config.activeProfile, 'prod');
      assert.strictEqual(app.config.defaultProfile, 'prod');
      assert.strictEqual(app._lastResult.active_profile, 'prod');
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });
});

describe('Auth Command Modify Handler', () => {
  it('should toggle read_only and persist via saveConfig', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { authCmd } = await import('../src/commands/auth.js');
      const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };

      const cmd = authCmd(wrap);
      const subcommands = [];
      const mockYargs = {
        command: (c, ...rest) => {
          subcommands.push({ def: typeof c === 'string' ? c : c.command, builder: typeof c === 'object' ? c.builder : rest[0], handler: typeof c === 'object' ? c.handler : rest[1] });
          return mockYargs;
        },
      };
      cmd.builder(mockYargs);

      const modifyCmd = subcommands.find(s => s.def.startsWith('modify'));
      assert.ok(modifyCmd, 'modify subcommand not found');

      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth' },
          },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        ok: (result, opts) => { app._lastResult = result; app._lastSummary = opts.summary; },
      };

      await modifyCmd.handler({ app, name: 'dev', flag: 'read_only', _: ['modify'] });
      assert.strictEqual(app.config.profiles.dev.read_only, true);
      assert.strictEqual(app._lastResult.read_only, true);

      // Config persisted to disk under the temp XDG_CONFIG_HOME
      const { loadConfig } = await import('../src/config.js');
      const onDisk = loadConfig();
      assert.strictEqual(onDisk.profiles.dev.read_only, true);

      // Toggle back off
      await modifyCmd.handler({ app, name: 'dev', flag: 'read_only', _: ['modify'] });
      assert.strictEqual(app.config.profiles.dev.read_only, false);
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });

  it('should toggle skip_confirmations', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { modifyProfile } = await import('../src/commands/auth.js');
      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth' },
          },
        },
        isInteractive: () => false,
        ok: (result, opts) => { app._lastResult = result; app._lastSummary = opts.summary; },
      };

      await modifyProfile(app, { name: 'dev', flag: 'skip_confirmations' });
      assert.strictEqual(app.config.profiles.dev.skip_confirmations, true);
      assert.strictEqual(app._lastResult.skip_confirmations, true);
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });

  it('should throw for a missing profile', async () => {
    const { modifyProfile } = await import('../src/commands/auth.js');
    const app = {
      config: { profiles: {} },
      isInteractive: () => false,
      ok: () => {},
    };
    await assert.rejects(() => modifyProfile(app, { name: 'nope' }), /Profile not found/);
  });

  it('should clear the domain via auth modify --domain clear', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-domain-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { modifyProfile } = await import('../src/commands/auth.js');
      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth', domain_separation: true, domain: 'acme-id' },
          },
        },
        isInteractive: () => false,
        auth: { getCredentials: async () => ({}) },
        ok: (result, opts) => { app._lastResult = result; app._lastSummary = opts.summary; },
      };

      await modifyProfile(app, { name: 'dev', domain: 'clear' });
      assert.strictEqual(app.config.profiles.dev.domain, '');
      assert.strictEqual(app._lastSummary, 'Domain cleared for dev');
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });

  it('should reject domain set when domain separation is not installed', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-nods-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { modifyProfile } = await import('../src/commands/auth.js');
      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth' },
          },
        },
        isInteractive: () => false,
        ok: () => {},
      };

      await assert.rejects(
        () => modifyProfile(app, { name: 'dev', domain: 'ACME' }),
        /Domain separation is not installed/,
      );
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });
});

describe('Auth Command Remove Handler', () => {
  it('should remove the profile and clear credentials', async () => {
    // saveConfig() writes the REAL global config — isolate like the switch test.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origCwd = process.cwd();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'jsn-auth-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.chdir(tmpDir);

    try {
      const { authCmd } = await import('../src/commands/auth.js');
      const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };

      const cmd = authCmd(wrap);
      const subcommands = [];
      const mockYargs = {
        command: (c, ...rest) => {
          subcommands.push({ def: typeof c === 'string' ? c : c.command, builder: typeof c === 'object' ? c.builder : rest[0], handler: typeof c === 'object' ? c.handler : rest[1] });
          return mockYargs;
        },
      };
      cmd.builder(mockYargs);

      const removeCmd = subcommands.find(s => s.def.startsWith('remove'));
      assert.ok(removeCmd, 'remove subcommand not found');

      const app = {
        config: {
          profiles: {
            dev: { instance_url: 'https://dev.service-now.com' },
          },
          defaultProfile: 'dev',
          activeProfile: 'dev',
        },
        isInteractive: () => false,
        auth: { logout: () => { app._loggedOut = true; } },
        ok: (result) => { app._lastResult = result; },
      };

      await removeCmd.handler({ app, name: 'dev', _: ['remove'] });
      assert.strictEqual(app.config.profiles.dev, undefined);
      assert.strictEqual(app.config.defaultProfile, '');
      assert.strictEqual(app.config.activeProfile, '');
      assert.strictEqual(app._lastResult.removed, 'dev');
      assert.ok(app._loggedOut, 'credentials should be cleared when no other profile uses the instance');
    } finally {
      process.chdir(origCwd);
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });
});
describe('profile targeting regressions', () => {
  it('remove deletes the removed profile username while preserving same-instance credentials', async () => {
      const { removeProfile } = await import('../src/commands/auth.js');
      const deleted = [];
      const instance = 'https://shared.example.com';
      const app = {
        config: { profiles: {
          alice: { instance_url: instance, username: 'alice' },
          bob: { instance_url: instance, username: 'bob' },
        }, activeProfile: 'alice', defaultProfile: 'alice' },
        auth: { logout: (...args) => deleted.push(args) },
        ok() {},
      };
      await removeProfile(app, 'bob');
      assert.deepStrictEqual(deleted, [[instance, 'bob']]);
      assert.ok(app.config.profiles.alice);
    });
});
