// Tests for auth command structure and handler logic

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

// ─── Command Structure Tests ───

describe('Auth Command Structure', () => {
  it('should export authCmd function', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    assert.strictEqual(typeof authCmd, 'function');
  });

  it('should define auth command with correct properties', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => fn;
    const cmd = authCmd(wrap);
    assert.ok(cmd.command.includes('auth'));
    assert.ok(cmd.aliases === undefined || Array.isArray(cmd.aliases));
    assert.ok(cmd.describe.toLowerCase().includes('oauth'));
  });

  it('should define login, logout, status, refresh, switch, modify, remove subcommands', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => fn;
    const cmd = authCmd(wrap);
    assert.strictEqual(typeof cmd.builder, 'function');

    const subcommands = [];
    const mockYargs = {
      command: (c) => {
        subcommands.push(typeof c === 'string' ? c : c.command);
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);

    const names = subcommands.map(s => s.split(' ')[0]);
    assert.ok(names.includes('login'));
    assert.ok(names.includes('logout'));
    assert.ok(names.includes('status'));
    assert.ok(names.includes('refresh'));
    assert.ok(names.includes('switch'));
    assert.ok(names.includes('modify'));
    assert.ok(names.includes('remove'));
  });
});

// ─── Handler Tests ───

describe('Auth Command Handlers', () => {
  let mockApp;

  before(() => {
    mockApp = {
      config: {
        instance_url: 'https://test-instance.service-now.com',
        profiles: {},
        format: 'json',
      },
      auth: {
        getCredentials: async () => ({ auth_method: 'oauth', access_token: 'tok', expires_at: 9999999999 }),
        getCredentialsFor: async () => ({ auth_method: 'oauth', access_token: 'tok', refresh_token: 'rtok', expires_at: 9999999999 }),
        isAuthenticated: () => true,
        isAuthenticatedFor: () => true,
        getLastSeen: () => null,
        touchLastSeen: () => {},
        refreshToken: async () => ({ auth_method: 'oauth', access_token: 'new-tok', refresh_token: 'new-rtok', expires_at: 9999999999 }),
        logout: () => {},
      },
      getEffectiveInstance: () => 'https://test-instance.service-now.com',
      ok: () => {},
      err: () => {},
    };
  });

  after(() => {
    // cleanup
  });

  it('auth status should not throw', async () => {
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

    const statusCmd = subcommands.find(s => s.def.startsWith('status'));
    assert.ok(statusCmd, 'status subcommand not found');

    await statusCmd.handler({ app: mockApp, _: ['status'] });
    // Should not throw
    assert.ok(true);
  });

  it('auth refresh should call refreshToken', async () => {
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

    const refreshCmd = subcommands.find(s => s.def.startsWith('refresh'));
    assert.ok(refreshCmd, 'refresh subcommand not found');

    let refreshCalled = false;
    mockApp.auth.refreshToken = async (instance, creds) => {
      refreshCalled = true;
      assert.ok(instance);
      assert.ok(creds);
      return { access_token: 'refreshed', expires_at: 9999999999 };
    };

    await refreshCmd.handler({ app: mockApp, instance: 'https://test-instance.service-now.com', _: ['refresh'] });
    assert.ok(refreshCalled, 'refreshToken should have been called');
  });

  it('auth logout should call logout', async () => {
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

    const logoutCmd = subcommands.find(s => s.def.startsWith('logout'));
    assert.ok(logoutCmd, 'logout subcommand not found');

    let logoutCalled = false;
    mockApp.auth.logout = (instance) => {
      logoutCalled = true;
      assert.ok(instance);
    };

    await logoutCmd.handler({ app: mockApp, instance: 'https://test-instance.service-now.com', _: ['logout'] });
    assert.ok(logoutCalled, 'logout should have been called');
  });
});

// ─── Instance argument resolution (gh-style) ───

describe('resolveInstanceArg', () => {
  let resolveInstanceArg;
  before(async () => {
    ({ resolveInstanceArg } = await import('../src/commands/auth.js'));
  });

  const cfg = {
    profiles: {
      staging: { instance_url: 'https://staging.example.com' },
    },
  };

  it('should pass full URLs through unchanged', () => {
    assert.strictEqual(
      resolveInstanceArg('https://dev12345.service-now.com', cfg),
      'https://dev12345.service-now.com'
    );
  });

  it('should add https:// to a bare host', () => {
    assert.strictEqual(
      resolveInstanceArg('dev12345.service-now.com', cfg),
      'https://dev12345.service-now.com'
    );
  });

  it('should resolve a known profile name to its stored URL', () => {
    assert.strictEqual(
      resolveInstanceArg('staging', cfg),
      'https://staging.example.com'
    );
  });

  it('should append .service-now.com to an unknown bare name (fixes dead-host trap)', () => {
    assert.strictEqual(
      resolveInstanceArg('dev99999', cfg),
      'https://dev99999.service-now.com'
    );
  });
});

// ─── auth switch handler ───

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

// ─── auth modify handler ───

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

// ─── wizard instance resolution (regression: setup → Add skipped URL ask) ───

describe('resolveWizardInstance', () => {
  let origEnv;
  before(() => { origEnv = process.env.SERVICENOW_INSTANCE_URL; });
  after(() => {
    if (origEnv === undefined) delete process.env.SERVICENOW_INSTANCE_URL;
    else process.env.SERVICENOW_INSTANCE_URL = origEnv;
  });

  it('returns empty when only a default profile exists (must ask for URL)', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = {
      config: {
        defaultProfile: 'dev227772',
        profiles: { dev227772: { instance_url: 'https://dev227772.service-now.com' } },
      },
    };
    assert.strictEqual(resolveWizardInstance(app, {}), '');
  });

  it('pre-fills from an explicit --instance override', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} }, _overrideInstance: 'https://dev99999.service-now.com' };
    assert.strictEqual(resolveWizardInstance(app, {}), 'https://dev99999.service-now.com');
  });

  it('pre-fills from argv.instance', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} } };
    assert.strictEqual(resolveWizardInstance(app, { instance: 'https://dev12345.service-now.com' }), 'https://dev12345.service-now.com');
  });

  it('pre-fills from the env var', async () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://dev55555.service-now.com';
    const { resolveWizardInstance } = await import('../src/commands/auth.js');
    const app = { config: { profiles: {} } };
    assert.strictEqual(resolveWizardInstance(app, {}), 'https://dev55555.service-now.com');
  });
});

// ─── auth remove handler ───

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

// ─── OAuth URL construction (Issue #124) ───

describe('OAuth URL', () => {
  it('should build a complete OAuth authorization URL', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ config: {} });
    const url = auth.buildAuthURL('https://dev12345.service-now.com');

    assert.ok(url.startsWith('https://dev12345.service-now.com/oauth_auth.do?'));
    assert.ok(url.includes('response_type=code'));
    assert.ok(url.includes('client_id='));
    assert.ok(url.includes('redirect_uri='));
    // redirect_uri is a path (not a full URL), so it's URL-encoded as %2Fsdk-oauth.do
    assert.ok(url.includes('redirect_uri='));
    assert.ok(url.includes('state='));
    assert.ok(url.includes('code_challenge='));
    assert.ok(url.includes('code_challenge_method=S256'));
    assert.ok(url.includes('scope=openid'));
    assert.ok(url.includes('approval_prompt=force'));

    // Verify it's a valid URL by parsing it
    const parsed = new URL(url);
    assert.strictEqual(parsed.searchParams.get('response_type'), 'code');
    assert.strictEqual(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(parsed.searchParams.get('scope'), 'openid');
    assert.ok(parsed.searchParams.get('client_id'));
    assert.ok(parsed.searchParams.get('state'));
    assert.ok(parsed.searchParams.get('code_challenge'));
  });

  it('should build auth URL without waitFile', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ config: {} });
    const url = auth.buildAuthURL('https://dev12345.service-now.com');

    assert.strictEqual(typeof url, 'string');
    assert.ok(url.length > 80); // Should have many query params
  });

  it('should normalize instance URL before building', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ config: {} });
    const url = auth.buildAuthURL('dev12345.service-now.com');

    assert.ok(url.startsWith('https://dev12345.service-now.com/'));
  });
});
