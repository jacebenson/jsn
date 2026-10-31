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

describe('Auth command handlers', () => {

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
        probeCurrentUser: async () => ({ status: 'failed' }),
        getAuthState: () => ({ auth_method: 'oauth', auth_source: 'file', state: 'available' }),
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
it('rejects conflicting login selectors and configured auth methods', async () => {
    const { validateLoginSelectors } = await import('../src/commands/auth.js');
    assert.throws(() => validateLoginSelectors({ basic: true, gck: true }), /mutually exclusive/i);
    assert.throws(() => validateLoginSelectors({ password: true, headers: 'Cookie: sid=x' }), /mutually exclusive/i);
    assert.throws(() => validateLoginSelectors({ basic: true }, { auth_method: 'gck' }), /configured for gck/i);
    assert.throws(() => validateLoginSelectors({ gck: true }, { auth_method: 'basic' }), /configured for basic/i);
    assert.doesNotThrow(() => validateLoginSelectors({ basic: true }, { auth_method: 'basic' }));
    assert.doesNotThrow(() => validateLoginSelectors({ gck: true }, { auth_method: 'gck' }));
  });

it('rejects conflicting selectors at the login command boundary before auth starts', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    let started = false;
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: {} },
      isInteractive: () => false,
      auth: {
        ...mockApp.auth,
        loginWithPassword: async () => { started = true; },
        loginWithGck: async () => { started = true; },
      },
    };
    const subcommands = [];
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    const login = subcommands.find(s => s.def.startsWith('login')).handler;
    await assert.rejects(login({ app, instance: 'shared', basic: true, headers: 'Cookie: sid=x', _: ['login'] }), /mutually exclusive/i);
    assert.strictEqual(started, false);
  });

it('dispatches normal browser-session login and preserves its configured method', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const calls = [];
    const instance = 'https://gck-login.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: { browser: { instance_url: instance, auth_method: 'gck' } } },
      auth: {
        ...mockApp.auth,
        login: async () => {},
        loginWithGck: async (...args) => { calls.push(args); return { auth_method: 'gck' }; },
      },
      getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'alice' }) }),
      sdk: null,
    };
    const subcommands = [];
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const mockYargs = { command: (c, ...rest) => { subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] }); return mockYargs; } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def.startsWith('login')).handler({
      app, instance, headers: 'curl -H "X-UserToken: token" -H "Cookie: sid=cookie"', _: ['login'],
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1].includes('X-UserToken'), true);
    assert.strictEqual(app.config.profiles.browser.auth_method, 'gck');
  });

it('persists new basic logins under the returned username and keeps it on the profile', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://new-basic.example.com';
    const records = new Map();
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => instance,
      getAuthMethod: () => 'basic',
    }, { credentialStore: {
      load: (url, username) => records.get(`${url}\\0${username || ''}`) || null,
      save: (url, credentials, username) => records.set(`${url}\\0${username || ''}`, { ...credentials }),
      delete: () => {},
    } });
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: {} },
      auth,
      isInteractive: () => false,
      getSDKForProfile: () => ({ getCurrentUser: async () => null }),
      sdk: null,
      ok: () => {},
    };
    const oldUser = process.env.SN_USERNAME;
    const oldPassword = process.env.SN_PASSWORD;
    process.env.SN_USERNAME = 'new-admin';
    process.env.SN_PASSWORD = 'secret';
    try {
      const subcommands = [];
      const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
      const mockYargs = { command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      } };
      cmd.builder(mockYargs);
      await subcommands.find(s => s.def.startsWith('login')).handler({
        app, instance, basic: true, _: ['login'],
      });
      assert.strictEqual(records.get(`${instance}\\0new-admin`).username, 'new-admin');
      const profile = Object.values(app.config.profiles)[0];
      assert.strictEqual(profile.username, 'new-admin');
    } finally {
      if (oldUser === undefined) delete process.env.SN_USERNAME; else process.env.SN_USERNAME = oldUser;
      if (oldPassword === undefined) delete process.env.SN_PASSWORD; else process.env.SN_PASSWORD = oldPassword;
    }
  });

it('explicit --profile targets that profile without invoking the interactive picker', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const calls = [];
    const instance = 'https://named-profile.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: {
        named: { instance_url: instance, auth_method: 'oauth', username: 'alice' },
        other: { instance_url: 'https://other-profile.example.com', auth_method: 'oauth' },
      } },
      isInteractive: () => true,
      auth: { ...mockApp.auth, login: async (...args) => calls.push(args) },
      getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'alice' }) }),
      sdk: null,
      ok: () => {},
    };
    const subcommands = [];
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def.startsWith('login')).handler({ app, profile: 'named', _: ['login'] });
    assert.deepStrictEqual(calls[0], [instance, 'alice']);
    assert.strictEqual(app.config.profiles.named.instance_url, instance);
  });

});

describe('auth login method selection', () => {
  it('recognizes browser session authentication explicitly', async () => {
    const { shouldUseGckAuth } = await import('../src/commands/auth.js');
    assert.strictEqual(shouldUseGckAuth({ gck: true }), true);
    assert.strictEqual(shouldUseGckAuth({ headers: 'X-UserToken: token' }), true);
    assert.strictEqual(shouldUseGckAuth({}), false);
  });

  it('uses the stored Basic Auth method for an existing profile', async () => {
    const { shouldUseBasicAuth } = await import('../src/commands/auth.js');
    const instance = 'https://cmdbpetadebraptor1.service-now.com';
    const config = {
      profiles: {
        snugb: { instance_url: instance, auth_method: 'basic' },
      },
    };

    assert.strictEqual(shouldUseBasicAuth({}, config, instance), true);
  });

  it('keeps OAuth as the default for new or OAuth profiles', async () => {
    const { shouldUseBasicAuth } = await import('../src/commands/auth.js');
    const config = {
      profiles: {
        dev: { instance_url: 'https://dev.service-now.com', auth_method: 'oauth' },
      },
    };

    assert.strictEqual(shouldUseBasicAuth({}, config, 'https://new.service-now.com'), false);
    assert.strictEqual(shouldUseBasicAuth({}, config, 'https://dev.service-now.com'), false);
  });
});
describe('profile-selected login regressions', () => {
  it('login --profile uses the named same-instance profile identity', async () => {
      const { authCmd } = await import('../src/commands/auth.js');
      const calls = [];
      const instance = 'https://shared.example.com';
      const app = {
        config: { profiles: {
          alice: { instance_url: instance, username: 'alice', auth_method: 'oauth' },
          bob: { instance_url: instance, username: 'bob', auth_method: 'oauth' },
        }, activeProfile: 'alice', defaultProfile: 'alice' },
        auth: {
          loginWithCode: (...args) => { calls.push(args); return Promise.resolve(); },
          migrateLegacyCredential() {},
        },
        sdk: { getCurrentUser: async () => ({ user_name: 'bob' }) },
        getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'bob' }) }),
        ok() {},
      };
      const commands = [];
      const yargs = { command(c) { commands.push(c); return yargs; } };
      authCmd((fn) => async (argv) => fn(argv, argv.app)).builder(yargs);
      const login = commands.find(c => c.command.startsWith('login'));
      await login.handler({ app, profile: 'bob', instance, code: 'auth-code' });
      assert.deepStrictEqual(calls[0], [instance, 'auth-code', 'bob']);
      assert.strictEqual(app.config.profiles.bob.username, 'bob');
      assert.strictEqual(app.config.profiles.alice.username, 'alice');
    });
});
