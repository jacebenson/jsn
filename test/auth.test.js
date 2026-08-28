// Tests for auth command structure and handler logic

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

  it('auth status authentication checks never refresh or persist credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    let saves = 0;
    let loads = 0;
    const manager = new AuthManager({
      getUsername: () => 'alice',
      getEffectiveInstance: () => 'https://readonly-status.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore: {
      load: () => { loads++; return { auth_method: 'oauth', access_token: 'old', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 60 }; },
      save: () => { saves++; },
      delete: () => {},
    } });
    assert.strictEqual(manager.isAuthenticated(), false);
    assert.strictEqual(manager.isAuthenticatedFor('https://readonly-status.example.com', { authMethod: 'oauth', username: 'alice' }), false);
    assert.strictEqual(saves, 0);
    assert.ok(loads > 0);
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

  it('auth status should include structured diagnostics in the JSON envelope', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const instance = 'https://diagnostic-status.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, instance_url: instance, profiles: {
        diagnostic: { instance_url: instance, auth_method: 'oauth' },
      } },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => true,
        getAuthState: () => ({ auth_method: 'oauth', auth_source: 'file', state: 'available' }),
        probeCurrentUser: async () => ({
          status: 'failed', code: 'permission_denied', message: 'safe message', hint: 'safe hint',
        }),
      },
      ok: (data, opts) => new OutputWriter({ format: 'json', writer: { write: (text) => chunks.push(text) } }).ok(data, opts),
    };
    const wrap = (fn) => async (argv) => fn(argv, argv.app);
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, _: ['status'] });
    const envelope = JSON.parse(chunks.join(''));
    assert.strictEqual(envelope.ok, true);
    assert.strictEqual(envelope.data.profiles[0].diagnostics.auth_method, 'oauth');
    assert.strictEqual(envelope.data.profiles[0].diagnostics.probe.code, 'permission_denied');
    assert.strictEqual(envelope.data.profiles[0].diagnostics.probe.message, 'safe message');
  });

  it('auth status passes each profile instance and identity to every auth path', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const calls = [];
    const profiles = {
      first: { instance_url: 'https://first.example.com', username: 'alice', auth_method: 'oauth' },
      second: { instance_url: 'https://second.example.com', username: 'bob', auth_method: 'basic' },
    };
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles },
      auth: {
        ...mockApp.auth,
        isAuthenticated: () => true,
        isAuthenticatedFor: (...args) => { calls.push(['authenticated', ...args]); return false; },
        getLastSeen: (...args) => { calls.push(['last_seen', ...args]); return null; },
        getAuthState: (...args) => { calls.push(['state', ...args]); return { auth_method: args[1].authMethod, auth_source: 'unavailable', state: 'missing' }; },
        hasLegacyCredentials: (...args) => { calls.push(['legacy', ...args]); return false; },
        probeCurrentUser: async (...args) => { calls.push(['probe', ...args.slice(0, 3)]); return { status: 'not_attempted', code: 'missing_credentials', classification: 'unavailable' }; },
      },
      ok: () => {},
    };
    const subcommands = [];
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const mockYargs = { command: (c, ...rest) => { subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] }); return mockYargs; } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, _: ['status'] });
    assert.deepStrictEqual(calls.filter(([kind]) => kind !== 'probe'), [
      ['authenticated', 'https://first.example.com', { username: 'alice', authMethod: 'oauth' }],
      ['last_seen', 'https://first.example.com', { username: 'alice', authMethod: 'oauth' }],
      ['state', 'https://first.example.com', { authMethod: 'oauth', username: 'alice' }],
      ['legacy', 'https://first.example.com', { username: 'alice', authMethod: 'oauth' }],
      ['authenticated', 'https://second.example.com', { username: 'bob', authMethod: 'basic' }],
      ['last_seen', 'https://second.example.com', { username: 'bob', authMethod: 'basic' }],
      ['state', 'https://second.example.com', { authMethod: 'basic', username: 'bob' }],
      ['legacy', 'https://second.example.com', { username: 'bob', authMethod: 'basic' }],
    ]);
    assert.deepStrictEqual(calls.filter(([kind]) => kind === 'probe').map(([, instance, , options]) => [instance, options]), [
      ['https://first.example.com', { authMethod: 'oauth', username: 'alice' }],
      ['https://second.example.com', { authMethod: 'basic', username: 'bob' }],
    ]);
  });

  it('auth status focuses diagnostics with --profile while preserving profile fields', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const output = [];
    const profiles = {
      first: { instance_url: 'https://first.example.com', auth_method: 'oauth' },
      second: { instance_url: 'https://second.example.com', auth_method: 'basic' },
    };
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => true,
        getAuthState: (instance) => ({ auth_method: instance.includes('second') ? 'basic' : 'oauth', auth_source: 'file', state: 'available' }),
        probeCurrentUser: async () => ({ status: 'succeeded' }),
      },
      ok: (data) => output.push(data),
    };
    const wrap = (fn) => async (argv) => fn(argv, argv.app);
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, profile: 'second', _: ['status'] });
    assert.deepStrictEqual(output[0].profiles.map(p => p.name), ['second']);
    assert.strictEqual(output[0].profiles[0].authenticated, true);
    assert.strictEqual(output[0].profiles[0].diagnostics.probe.status, 'succeeded');
  });

  it('migrates GCK credentials to the verified username key without touching another profile', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const instance = 'https://gck-migration.example.com';
    const otherInstance = 'https://other-gck.example.com';
    const records = new Map([
      [`${instance}\\0`, { auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=cookie' }],
      [`${otherInstance}\\0bob`, { auth_method: 'gck', access_token: 'other-token', cookies: 'sid=other' }],
    ]);
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => instance, getAuthMethod: () => 'gck' }, {
      credentialStore: {
        load: (url, username) => records.get(`${url}\\0${username || ''}`) || null,
        save: (url, credentials, username) => records.set(`${url}\\0${username || ''}`, { ...credentials }),
        delete: (url, username) => records.delete(`${url}\\0${username || ''}`),
      },
    });
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: { browser: { instance_url: instance, auth_method: 'gck' } } },
      auth,
      getSDKForProfile: () => ({ getCurrentUser: async () => ({ user_name: 'alice' }) }),
      sdk: null,
      ok: () => {},
    };
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def.startsWith('login')).handler({
      app, instance, headers: 'curl -H "X-UserToken: token" -H "Cookie: sid=cookie"', _: ['login'],
    });
    assert.deepStrictEqual(records.get(`${instance}\\0alice`).username, 'alice');
    assert.strictEqual(records.has(`${instance}\\0`), false);
    assert.deepStrictEqual(records.get(`${otherInstance}\\0bob`), { auth_method: 'gck', access_token: 'other-token', cookies: 'sid=other' });
  });

  it('focused auth status keeps configured default instance semantics', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const output = [];
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        activeProfile: 'second',
        defaultProfile: 'first',
        profiles: {
          first: { instance_url: 'https://default.example.com', auth_method: 'oauth' },
          second: { instance_url: 'https://focused.example.com', auth_method: 'basic' },
        },
      },
      auth: { ...mockApp.auth, isAuthenticatedFor: () => false, hasLegacyCredentials: () => false },
      ok: (data) => output.push(data),
    };
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, profile: 'second', _: ['status'] });
    assert.strictEqual(output[0].default_instance, 'https://default.example.com');
    assert.strictEqual(output[0].profiles[0].default, false);
  });

  it('marks only the configured default profile when profiles share an instance URL', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const output = [];
    const instance = 'https://shared-default.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, defaultProfile: 'first', profiles: {
        first: { instance_url: instance, auth_method: 'oauth' },
        second: { instance_url: instance, auth_method: 'oauth' },
      } },
      auth: { ...mockApp.auth, isAuthenticatedFor: () => false, hasLegacyCredentials: () => false },
      ok: (data) => output.push(data),
    };
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, _: ['status'] });
    assert.deepStrictEqual(output[0].profiles.map(profile => profile.default), [true, false]);
  });

  it('username-less non-active refresh saves under the bare target identity', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const originalFetch = globalThis.fetch;
    const saves = [];
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'new-refresh' }) });
    try {
      const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://active.example.com', getAuthMethod: () => 'oauth' }, {
        credentialStore: { load: () => null, save: (...args) => saves.push(args), delete: () => {} },
      });
      await auth.refreshToken('https://target.example.com', { auth_method: 'oauth', refresh_token: 'old-refresh' }, null);
      assert.strictEqual(saves[0][2], null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('probe results classify success without exposing credential material', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const manager = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://probe.example.com', getAuthMethod: () => 'oauth' }, {
      credentialStore: { load: () => ({ auth_method: 'oauth', access_token: 'secret', expires_at: 9999999999 }), save: () => {}, delete: () => {} },
    });
    const result = await manager.probeCurrentUser('https://probe.example.com', {
      getCurrentUser: async () => ({ user_name: 'alice' }),
    });
    assert.deepStrictEqual(result, { status: 'succeeded', classification: 'authenticated' });
    assert.strictEqual(JSON.stringify(result).includes('secret'), false);
  });

  it('auth status diagnostics never serialize credential secrets', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const output = [];
    const secret = 'super-secret-token-and-cookie';
    const instance = 'https://redaction-status.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: { redacted: { instance_url: instance, auth_method: 'gck' } } },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => true,
        getAuthState: () => ({ auth_method: 'gck', auth_source: 'gck', state: 'available', access_token: secret, cookies: secret }),
        probeCurrentUser: async () => ({ status: 'failed', code: 'unauthorized', message: 'safe', hint: 'safe' }),
      },
      ok: (data) => output.push(data),
    };
    const wrap = (fn) => async (argv) => fn(argv, argv.app);
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, _: ['status'] });
    assert.doesNotMatch(JSON.stringify(output[0]), new RegExp(secret));
  });

  it('auth status supports --get-compatible diagnostics paths', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const instance = 'https://get-status.example.com';
    const app = {
      ...mockApp,
      config: { ...mockApp.config, profiles: { getme: { instance_url: instance, auth_method: 'oauth' } } },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => false,
        getAuthState: () => ({ auth_method: 'oauth', auth_source: 'unavailable', state: 'missing' }),
        hasLegacyCredentials: () => false,
        probeCurrentUser: async () => ({ status: 'not_attempted', code: 'missing_credentials', message: 'safe', hint: 'safe' }),
      },
      ok: (data, opts) => new OutputWriter({ format: 'json', jqFilter: 'data.profiles[0].diagnostics.probe.code', writer: { write: (text) => chunks.push(text) } }).ok(data, opts),
    };
    const wrap = (fn) => async (argv) => fn(argv, argv.app);
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c, ...rest) => {
      subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
      return mockYargs;
    } };
    cmd.builder(mockYargs);
    await subcommands.find(s => s.def === 'status').handler({ app, _: ['status'] });
    assert.strictEqual(JSON.parse(chunks.join('')), 'missing_credentials');
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

  it('auth status probes through AuthManager and keeps the SDK probe read-only', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://probe-status.example.com';
    const output = [];
    const sdkOptions = [];
    const probeCalls = [];
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => instance,
      getAuthMethod: () => 'oauth',
    }, {
      credentialStore: {
        load: () => ({ auth_method: 'oauth', access_token: 'tok', expires_at: 9999999999 }),
        save: () => {},
        delete: () => {},
      },
    });
    const originalProbe = auth.probeCurrentUser.bind(auth);
    auth.probeCurrentUser = async (probeInstance, sdk) => {
      probeCalls.push({ instance: probeInstance, sdk });
      return originalProbe(probeInstance, sdk);
    };
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        instance_url: instance,
        profiles: { probe: { instance_url: instance, auth_method: 'oauth' } },
      },
      sdk: {
        getCurrentUser: async (options) => {
          sdkOptions.push(options);
          return { user_name: 'probe-user' };
        },
      },
      auth,
      getEffectiveInstance: () => instance,
      ok: (result) => output.push(result),
    };
    const cmd = authCmd((fn) => async (argv) => fn(argv, argv.app));
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);

    const statusCmd = subcommands.find(s => s.def === 'status');
    await statusCmd.handler({ app, _: ['status'] });

    assert.strictEqual(probeCalls.length, 1);
    assert.strictEqual(probeCalls[0].instance, instance);
    assert.deepStrictEqual(sdkOptions, [{ touchLastSeen: false }]);
    assert.strictEqual(output[0].profiles[0].verified, true);
    assert.strictEqual(output[0].profiles[0].verified_as, 'probe-user');
  });

  it('auth status uses the safe source vocabulary at the command boundary', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const instance = 'https://safe-source.example.com';
    const output = [];
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        instance_url: instance,
        profiles: { safe: { instance_url: instance, auth_method: 'oauth' } },
      },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => true,
        isAuthenticated: () => true,
        getAuthState: () => ({ auth_method: 'oauth', auth_source: 'unavailable', state: 'available' }),
        getAuthSource: () => { throw new Error('legacy source seam must not be called'); },
      },
      ok: (result) => output.push(result),
    };
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    const statusCmd = subcommands.find(s => s.def === 'status');
    await statusCmd.handler({ app, _: ['status'] });
    assert.strictEqual(output[0].profiles[0].auth_source, 'unavailable');
    assert.strictEqual(JSON.stringify(output[0]).includes('legacy'), false);
  });

  it('auth status keeps legacy detection separate from the source vocabulary', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const instance = 'https://legacy-status.example.com';
    const output = [];
    let authStateCalls = 0;
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        instance_url: instance,
        profiles: { legacy: { instance_url: instance, auth_method: 'oauth' } },
      },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => false,
        isAuthenticated: () => false,
        getAuthState: () => {
          authStateCalls += 1;
          return { auth_method: 'oauth', auth_source: 'unavailable', state: 'missing' };
        },
        getAuthSource: () => { throw new Error('legacy source seam must not be called'); },
        hasLegacyCredentials: () => true,
      },
      ok: (result) => output.push(result),
    };
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    const statusCmd = subcommands.find(s => s.def === 'status');
    await statusCmd.handler({ app, _: ['status'] });
    assert.strictEqual(authStateCalls, 1);
    assert.strictEqual(output[0].profiles[0].legacy, true);
    assert.strictEqual(output[0].profiles[0].auth_source, 'legacy');
  });

  it('auth status omits auth_source for unauthenticated non-legacy profiles', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const instance = 'https://missing-status.example.com';
    const output = [];
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        instance_url: instance,
        profiles: { missing: { instance_url: instance, auth_method: 'oauth' } },
      },
      auth: {
        ...mockApp.auth,
        isAuthenticatedFor: () => false,
        getAuthState: () => ({ auth_method: 'oauth', auth_source: 'unavailable', state: 'missing' }),
        hasLegacyCredentials: () => false,
      },
      ok: (result) => output.push(result),
    };
    const cmd = authCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    const statusCmd = subcommands.find(s => s.def === 'status');
    await statusCmd.handler({ app, _: ['status'] });
    const { diagnostics: _diagnostics, ...legacyProfile } = output[0].profiles[0];
    assert.strictEqual(JSON.stringify(legacyProfile).includes('auth_source'), false);
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

  it('auth refresh passes the target profile username to refreshToken', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const instance = 'https://target-refresh.example.com';
    const calls = [];
    const app = {
      ...mockApp,
      config: {
        ...mockApp.config,
        activeProfile: 'active',
        profiles: {
          active: { instance_url: 'https://active-refresh.example.com', username: 'alice', auth_method: 'oauth' },
          target: { instance_url: instance, username: 'bob', auth_method: 'oauth' },
        },
      },
      auth: {
        ...mockApp.auth,
        getCredentialsFor: async () => ({ auth_method: 'oauth', refresh_token: 'old-refresh' }),
        refreshToken: async (...args) => {
          calls.push(args);
          return { access_token: 'refreshed', expires_at: 9999999999 };
        },
      },
    };
    const cmd = authCmd((fn) => async (argv) => { await fn(argv, argv.app); });
    const subcommands = [];
    const mockYargs = {
      command: (c, ...rest) => {
        subcommands.push({ def: typeof c === 'string' ? c : c.command, handler: typeof c === 'object' ? c.handler : rest[1] });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);

    await subcommands.find(s => s.def.startsWith('refresh')).handler({ app, instance, _: ['refresh'] });
    assert.deepStrictEqual(calls[0].slice(0, 3), [instance, { auth_method: 'oauth', refresh_token: 'old-refresh' }, 'bob']);
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

describe('AuthManager credential store boundary', () => {
  it('uses the injected store for basic and browser-session login operations', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const calls = [];
    const credentialStore = {
      load(instance, username) {
        calls.push(['load', instance, username]);
        return { auth_method: 'basic', username: 'admin', password: 'secret' };
      },
      save(instance, credentials, username) {
        calls.push(['save', instance, credentials, username]);
      },
      delete() {},
    };
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => 'https://injected.example.com',
    }, { credentialStore });

    await auth.loginWithPassword('https://injected.example.com', 'admin');
    assert.deepStrictEqual(calls.map(([operation, instance, , username]) => [operation, instance, username]), [
      ['load', 'https://injected.example.com', undefined],
      ['save', 'https://injected.example.com', 'admin'],
    ]);

    calls.length = 0;
    const gckAuth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => 'https://injected.example.com',
    }, { credentialStore: {
      load: () => null,
      save(instance, credentials, username) {
        calls.push(['save', instance, credentials, username]);
      },
      delete() {},
    } });
    await gckAuth.loginWithGck(
      'https://injected.example.com',
      'curl -H "X-UserToken: token" -H "Cookie: JSESSIONID=cookie"'
    );
    assert.strictEqual(calls[0][0], 'save');
    assert.strictEqual(calls[0][1], 'https://injected.example.com');
  });

  it('exposes credential operations through AuthManager for command boundaries', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const calls = [];
    const credentialStore = {
      load: (...args) => { calls.push(['load', ...args]); return 'credentials'; },
      save: (...args) => { calls.push(['save', ...args]); return 'saved'; },
      delete: (...args) => { calls.push(['delete', ...args]); return 'deleted'; },
    };
    const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => '' }, { credentialStore });
    assert.strictEqual(auth.loadCredentials('instance', 'user'), 'credentials');
    assert.strictEqual(auth.saveCredentials('instance', { token: true }, 'user'), 'saved');
    assert.strictEqual(auth.deleteCredentials('instance', 'user'), 'deleted');
    assert.deepStrictEqual(calls.map(([operation, ...args]) => [operation, ...args]), [
      ['load', 'instance', 'user'],
      ['save', 'instance', { token: true }, 'user'],
      ['delete', 'instance', 'user'],
    ]);
  });

  it('keeps setup credential paths on the AuthManager boundary', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/commands/auth.js', import.meta.url), 'utf8'));
    assert.doesNotMatch(source, /(?<!\.)\b(loadCredentials|saveCredentials|deleteCredentials)\(/);
    assert.match(source, /app\.auth\.loadCredentials\(/);
    assert.match(source, /app\.auth\.saveCredentials\(/);
  });
});

describe('unconfigured environment authentication', () => {
  async function withEnv(values, fn) {
    const previous = {};
    for (const [key, value] of Object.entries(values)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('resolves unconfigured OAuth env credentials through AuthManager and SDK', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const { SDKClient } = await import('../src/sdk.js');
    const instance = 'https://env-oauth.example.com';
    await withEnv({ SERVICENOW_OAUTH_TOKEN: 'oauth-token', SN_USERNAME: undefined, SN_PASSWORD: undefined }, async () => {
      const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => instance }, {
        credentialStore: { load: () => null, save() {}, delete() {} },
      });
      assert.strictEqual(auth.isAuthenticated(), true);
      assert.deepStrictEqual(await auth.getCredentials(), {
        auth_method: 'oauth', access_token: 'oauth-token', auth_source: 'env_token',
      });
      const sdk = new SDKClient(instance, auth);
      assert.deepStrictEqual(await sdk.authProvider.getCredentials(), await auth.getCredentials());
    });
  });

  it('resolves unconfigured Basic env credentials when OAuth is absent', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://env-basic.example.com';
    await withEnv({ SERVICENOW_OAUTH_TOKEN: undefined, SN_USERNAME: 'env-user', SN_PASSWORD: 'env-pass' }, async () => {
      const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => instance }, {
        credentialStore: { load: () => null, save() {}, delete() {} },
      });
      assert.strictEqual(auth.isAuthenticated(), true);
      assert.deepStrictEqual(await auth.getCredentialsFor(instance), {
        auth_method: 'basic', username: 'env-user', password: 'env-pass', auth_source: 'env_basic',
      });
    });
  });

  it('ignores conflicting environment methods for an explicitly configured profile', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://configured-gck.example.com';
    await withEnv({ SERVICENOW_OAUTH_TOKEN: 'oauth-token', SN_USERNAME: 'env-user', SN_PASSWORD: 'env-pass' }, async () => {
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'gck',
      }, { credentialStore: { load: () => null, save() {}, delete() {} } });
      assert.strictEqual(auth.isAuthenticated(), false);
      assert.strictEqual(auth.isAuthenticatedFor(instance, { authMethod: 'gck' }), false);
      assert.strictEqual(auth.getAuthState(instance, { authMethod: 'gck' }).auth_source, 'unavailable');
    });
  });
});

describe('AuthManager refresh lifecycle blockers', () => {
  it('redacts provider response bodies from OAuth exchange failures', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const originalFetch = globalThis.fetch;
    const secret = 'access-token=do-not-leak';
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => `{"error":"invalid_grant","detail":"${secret}"}` });
    try {
      const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => 'https://exchange.example.com' }, {
        credentialStore: { load: () => null, save() {}, delete() {} },
      });
      await assert.rejects(
        () => auth.exchangeCode('https://exchange.example.com', 'client', 'code', { code_verifier: 'verifier' }),
        (error) => error.code === 'auth_error'
          && error.message.includes('status 400')
          && !error.message.includes(secret)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('redacts provider response bodies from OAuth refresh failures', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const originalFetch = globalThis.fetch;
    const secret = 'refresh-token=do-not-leak';
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => `{"error":"invalid_grant","detail":"${secret}"}` });
    try {
      const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => 'https://refresh.example.com' }, {
        credentialStore: { load: () => null, save() {}, delete() {} },
      });
      await assert.rejects(
        () => auth.refreshToken('https://refresh.example.com', { auth_method: 'oauth', refresh_token: 'old-refresh' }),
        (error) => error.code === 'auth_error'
          && error.message.includes('status 401')
          && !error.message.includes(secret)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('saves refreshed OAuth credentials under the target profile username', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const originalFetch = globalThis.fetch;
    const saves = [];
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }) });
    try {
      const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://refresh.example.com', getAuthMethod: () => 'oauth' }, {
        credentialStore: { load: () => null, save: (...args) => saves.push(args), delete: () => {} },
      });
      await auth.refreshToken('https://refresh.example.com', { auth_method: 'oauth', refresh_token: 'old-refresh' }, 'bob');
      assert.strictEqual(saves[0][2], 'bob');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-OAuth refresh without network or persistence', async () => {
    const { AuthManager } = await import('../src/auth.js');
    let saves = 0;
    const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://refresh.example.com' }, {
      credentialStore: { load: () => null, save: () => { saves++; }, delete: () => {} },
    });
    await assert.rejects(() => auth.refreshToken('https://refresh.example.com', { auth_method: 'gck', refresh_token: 'not-oauth' }), /only OAuth credentials support refresh/);
    assert.strictEqual(saves, 0);
  });

  it('treats an explicitly missing profile auth method as unconfigured', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://unconfigured.example.com', getAuthMethod: () => 'gck' }, {
      credentialStore: { load: () => ({ auth_method: 'oauth', access_token: 'token' }), save: () => {}, delete: () => {} },
    });
    assert.strictEqual(auth.getAuthState('https://unconfigured.example.com', { authMethod: undefined, username: 'alice' }).auth_method, 'unconfigured');
    assert.deepStrictEqual(auth.getCredentialsFor('https://unconfigured.example.com', 'alice', { authMethod: undefined }), { auth_method: 'oauth', access_token: 'token' });
  });
});

describe('AuthManager authenticated probe seam', () => {
  it('reports a successful read-only probe without exposing the current user', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const calls = [];
    const auth = new AuthManager({
      getUsername: () => 'admin',
      getEffectiveInstance: () => 'https://probe.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore: {
      load: () => ({ auth_method: 'oauth', access_token: 'token', auth_source: 'keyring' }),
      save: () => { throw new Error('probe must not save credentials'); },
      delete: () => { throw new Error('probe must not delete credentials'); },
    } });
    const sdk = {
      getCurrentUser: async (options) => {
        calls.push(options);
        return { user_name: 'admin', name: 'Administrator', sys_id: 'secret-id' };
      },
    };

    const result = await auth.probeCurrentUser('https://probe.example.com', sdk);

    assert.deepStrictEqual(result, { status: 'succeeded', classification: 'authenticated' });
    assert.deepStrictEqual(calls, [{ touchLastSeen: false }]);
    assert.strictEqual(JSON.stringify(result).includes('admin'), false);
  });

  it('does not attempt a probe when credentials are unavailable', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => 'https://probe.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore: { load: () => null, save() {}, delete() {} } });
    let attempts = 0;
    const sdk = { getCurrentUser: async () => { attempts += 1; } };

    const result = await auth.probeCurrentUser('https://probe.example.com', sdk);

    assert.deepStrictEqual(result, {
      status: 'not_attempted',
      code: 'missing_credentials',
      classification: 'unavailable',
      message: 'Credentials are not available for this profile.',
      hint: 'Run: jsn auth login',
    });
    assert.strictEqual(attempts, 0);
  });

  it('classifies safe permission, unauthorized, network, and unknown probe failures', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({
      getUsername: () => 'admin',
      getEffectiveInstance: () => 'https://probe.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore: {
      load: () => ({ auth_method: 'oauth', access_token: 'token' }), save() {}, delete() {},
    } });
    const cases = [
      [{ code: 'api_error', status: 403, message: 'API error (status 403): secret detail' }, 'permission_denied'],
      [{ code: 'api_error', status: 401, message: 'API error (status 401): secret detail' }, 'unauthorized'],
      [{ code: 'network_error', message: 'Network error: secret host' }, 'network'],
      [{ code: 'some_other_error', message: 'contains secret-token' }, 'unknown'],
    ];

    for (const [error, code] of cases) {
      const result = await auth.probeCurrentUser('https://probe.example.com', {
        getCurrentUser: async () => { throw error; },
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.code, code);
      assert.strictEqual(result.classification, {
        permission_denied: 'permission_denied', unauthorized: 'unauthorized', network: 'network_error', unknown: 'unknown',
      }[code]);
      assert.strictEqual(JSON.stringify(result).includes('secret'), false);
      assert.ok(result.message);
      assert.ok(result.hint);
    }
  });

  it('keeps refresh and browser-session failures distinct without fallback', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const makeAuth = (method, credentials) => new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => 'https://probe.example.com',
      getAuthMethod: () => method,
    }, { credentialStore: { load: () => credentials, save() {}, delete() {} } });

    const refreshable = await makeAuth('oauth', {
      auth_method: 'oauth', access_token: 'old-token', refresh_token: 'refresh-token', expires_at: 1,
    }).probeCurrentUser('https://probe.example.com', { getCurrentUser: async () => { throw new Error('should not run'); } });
    assert.deepStrictEqual(refreshable, {
      status: 'not_attempted', code: 'refresh_required', classification: 'refresh_required',
      message: 'Credentials require refresh before probing.',
      hint: 'Run: jsn auth refresh',
    });

    const browser = await makeAuth('gck', { auth_method: 'gck', access_token: 'browser-token', cookies: '' })
      .probeCurrentUser('https://probe.example.com', { getCurrentUser: async () => { throw new Error('should not run'); } });
    assert.deepStrictEqual(browser, {
      status: 'not_attempted', code: 'invalid_browser_session', classification: 'browser_session_invalid',
      message: 'Browser session credentials are incomplete or invalid.',
      hint: 'Capture a fresh ServiceNow browser request and run: jsn auth login --gck',
    });
  });
});

describe('AuthManager configured auth source precedence', () => {
  it('marks a stored source from another method unavailable and malformed', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({
      getUsername: () => 'alice',
      getEffectiveInstance: () => 'https://configured-basic-source.example.com',
      getAuthMethod: () => 'basic',
    }, { credentialStore: {
      load: () => ({ auth_method: 'basic', auth_source: 'gck', username: 'alice', password: 'password' }),
      save() {}, delete() {},
    } });

    assert.deepStrictEqual(auth.getAuthState('https://configured-basic-source.example.com'), {
      auth_method: 'basic', auth_source: 'unavailable', state: 'malformed',
    });
  });

  it('does not report stored OAuth source when basic is explicitly configured', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({
      getUsername: () => 'alice',
      getEffectiveInstance: () => 'https://configured-basic.example.com',
      getAuthMethod: () => 'basic',
    }, { credentialStore: {
      load: () => ({ auth_method: 'oauth', auth_source: 'file', access_token: 'token' }),
      save: () => {},
      delete: () => {},
    } });

    assert.strictEqual(auth.getAuthSource('https://configured-basic.example.com'), 'unavailable');
  });

  it('reports a stored source only when it matches the configured method', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({
      getUsername: () => 'alice',
      getEffectiveInstance: () => 'https://configured-basic.example.com',
      getAuthMethod: () => 'basic',
    }, { credentialStore: {
      load: () => ({ auth_method: 'basic', auth_source: 'file', username: 'alice', password: 'secret' }),
      save: () => {},
      delete: () => {},
    } });

    assert.strictEqual(auth.getAuthSource('https://configured-basic.example.com'), 'file');
  });
});

describe('AuthManager safe auth state seam', () => {
  let previousXdgConfigHome;
  let isolatedXdgConfigHome;
  let credentialStore;

  beforeEach(() => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    isolatedXdgConfigHome = mkdtempSync(path.join(tmpdir(), 'jsn-auth-diagnostics-'));
    process.env.XDG_CONFIG_HOME = isolatedXdgConfigHome;
    credentialStore = {
      load: () => null,
      save: () => { throw new Error('credential store save must not be called'); },
      delete: () => { throw new Error('credential store delete must not be called'); },
    };
  });

  afterEach(() => {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    rmSync(isolatedXdgConfigHome, { recursive: true, force: true });
  });

  it('uses the injected credential store instead of the OS keyring backend', async () => {
    const { AuthManager } = await import('../src/auth.js');
    let loads = 0;
    credentialStore.load = () => {
      loads += 1;
      return { auth_method: 'oauth', access_token: 'test-token', auth_source: 'keyring' };
    };
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => 'https://injected-store.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore });
    assert.deepStrictEqual(auth.getAuthState('https://injected-store.example.com'), {
      auth_method: 'oauth', auth_source: 'keyring', state: 'available',
    });
    assert.strictEqual(loads, 1);
  });

  it('classifies OAuth environment credentials without exposing the token', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const previous = process.env.SERVICENOW_OAUTH_TOKEN;
    process.env.SERVICENOW_OAUTH_TOKEN = 'secret-access-token';
    try {
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => 'https://oauth.example.com',
      }, { credentialStore });
      const state = auth.getAuthState('https://oauth.example.com');
      assert.deepStrictEqual(state, {
        auth_method: 'unconfigured',
        auth_source: 'env_token',
        state: 'available',
      });
      assert.strictEqual(JSON.stringify(state).includes('secret-access-token'), false);
    } finally {
      if (previous === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN;
      else process.env.SERVICENOW_OAUTH_TOKEN = previous;
    }
  });

  it('classifies Basic Auth environment credentials without exposing the password', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const previousUser = process.env.SN_USERNAME;
    const previousPassword = process.env.SN_PASSWORD;
    process.env.SN_USERNAME = 'admin';
    process.env.SN_PASSWORD = 'secret-password';
    try {
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => 'https://basic.example.com',
      }, { credentialStore });
      const state = auth.getAuthState('https://basic.example.com');
      assert.deepStrictEqual(state, {
        auth_method: 'unconfigured',
        auth_source: 'env_basic',
        state: 'available',
      });
      assert.strictEqual(JSON.stringify(state).includes('secret-password'), false);
    } finally {
      if (previousUser === undefined) delete process.env.SN_USERNAME;
      else process.env.SN_USERNAME = previousUser;
      if (previousPassword === undefined) delete process.env.SN_PASSWORD;
      else process.env.SN_PASSWORD = previousPassword;
    }
  });

  it('reports configured browser-session credentials as available without secrets', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://gck-state-${Date.now()}.service-now.com`;
    credentialStore.load = () => ({
      auth_method: 'gck',
      auth_source: 'gck',
      access_token: 'secret-user-token',
      cookies: 'JSESSIONID=secret-cookie',
    });
    const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'gck',
      }, { credentialStore });
      const state = auth.getAuthState(instance);
      assert.strictEqual(state.auth_method, 'gck');
      assert.strictEqual(state.auth_source, 'gck');
      assert.strictEqual(state.state, 'available');
      assert.strictEqual(JSON.stringify(state).includes('secret-cookie'), false);
  });

  it('does not report OAuth when no authentication method is configured', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://unconfigured-${Date.now()}.service-now.com`;
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => instance,
      getAuthMethod: () => null,
    }, { credentialStore });
    const state = auth.getAuthState(instance);
    assert.strictEqual(state.auth_method, 'unconfigured');
    assert.strictEqual(state.state, 'missing');
  });

  it('does not create credential storage while reading auth state', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(path.join(tmpdir(), 'jsn-auth-readonly-'));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const { AuthManager } = await import('../src/auth.js');
      const instance = 'https://readonly-missing.service-now.com';
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'oauth',
      }, { credentialStore });
      auth.getAuthState(instance);
      assert.strictEqual(existsSync(path.join(xdg, 'servicenow', 'credentials')), false);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('classifies malformed OAuth token fields as malformed', async () => {
    const { classifyCredentialState } = await import('../src/auth.js');
    assert.strictEqual(classifyCredentialState(null, 'oauth'), 'missing');
    assert.strictEqual(classifyCredentialState({ access_token: 'token', expires_at: 1 }, 'oauth'), 'expired');
    assert.strictEqual(classifyCredentialState({ access_token: 'token', expires_at: 1, refresh_token: 'refresh' }, 'oauth'), 'refreshable');
    assert.strictEqual(classifyCredentialState({ access_token: 'token', expires_at: 'not-a-time' }, 'oauth'), 'malformed');
    assert.strictEqual(classifyCredentialState({ access_token: 'token', refresh_token: {} }, 'oauth'), 'malformed');
    assert.strictEqual(classifyCredentialState({ access_token: {} }, 'oauth'), 'malformed');
  });

  it('does not expose or accept an untrusted stored auth method', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://untrusted-method-${Date.now()}.service-now.com`;
    credentialStore.load = () => ({
      auth_method: 'password-secret',
      auth_source: 'token-secret',
      access_token: 'secret-access-token',
    });
    const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'oauth',
      }, { credentialStore });
      assert.deepStrictEqual(auth.getAuthState(instance), {
        auth_method: 'oauth',
        auth_source: 'unavailable',
        state: 'malformed',
      });
  });

  it('maps legacy credentials without a stored source to an allowlisted source', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://legacy-source-${Date.now()}.service-now.com`;
    credentialStore.load = () => ({
      auth_method: 'oauth',
      access_token: 'secret-access-token',
    });
    const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'oauth',
      }, { credentialStore });
      const state = auth.getAuthState(instance);
      assert.ok(['keyring', 'file', 'unavailable'].includes(state.auth_source));
      assert.notStrictEqual(state.auth_source, 'stored');
      assert.strictEqual(state.state, 'available');
  });

  it('normalizes an untrusted stored auth source as malformed', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://untrusted-source-${Date.now()}.service-now.com`;
    credentialStore.load = () => ({
      auth_method: 'oauth',
      auth_source: 'token-secret',
      access_token: 'secret-access-token',
    });
    const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'oauth',
      }, { credentialStore });
      assert.deepStrictEqual(auth.getAuthState(instance), {
        auth_method: 'oauth',
        auth_source: 'unavailable',
        state: 'malformed',
      });
  });

  it('keeps the configured method authoritative over environment credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://configured-env-${Date.now()}.service-now.com`;
    const previousToken = process.env.SERVICENOW_OAUTH_TOKEN;
    const previousUser = process.env.SN_USERNAME;
    const previousPassword = process.env.SN_PASSWORD;
    process.env.SERVICENOW_OAUTH_TOKEN = 'oauth-token';
    process.env.SN_USERNAME = 'admin';
    process.env.SN_PASSWORD = 'basic-password';
    try {
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'gck',
      }, { credentialStore });
      assert.deepStrictEqual(auth.getAuthState(instance), {
        auth_method: 'gck', auth_source: 'unavailable', state: 'missing',
      });
    } finally {
      if (previousToken === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN;
      else process.env.SERVICENOW_OAUTH_TOKEN = previousToken;
      if (previousUser === undefined) delete process.env.SN_USERNAME;
      else process.env.SN_USERNAME = previousUser;
      if (previousPassword === undefined) delete process.env.SN_PASSWORD;
      else process.env.SN_PASSWORD = previousPassword;
    }
  });

  it('keeps an unconfigured method unconfigured despite stored credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://unconfigured-stored-${Date.now()}.service-now.com`;
    credentialStore.load = () => ({
      auth_method: 'basic', username: 'admin', password: 'secret', auth_source: 'file',
    });
    const auth = new AuthManager({
      getUsername: () => null,
      getEffectiveInstance: () => instance,
      getAuthMethod: () => null,
    }, { credentialStore });
    assert.deepStrictEqual(auth.getAuthState(instance), {
      auth_method: 'unconfigured', auth_source: 'file', state: 'available',
    });
  });

  it('keeps configured OAuth authoritative over Basic environment credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://configured-basic-${Date.now()}.service-now.com`;
    const previousUser = process.env.SN_USERNAME;
    const previousPassword = process.env.SN_PASSWORD;
    delete process.env.SERVICENOW_OAUTH_TOKEN;
    process.env.SN_USERNAME = 'admin';
    process.env.SN_PASSWORD = 'basic-password';
    try {
      const auth = new AuthManager({
        getUsername: () => null,
        getEffectiveInstance: () => instance,
        getAuthMethod: () => 'oauth',
      }, { credentialStore });
      assert.deepStrictEqual(auth.getAuthState(instance), {
        auth_method: 'oauth', auth_source: 'unavailable', state: 'missing',
      });
    } finally {
      if (previousUser === undefined) delete process.env.SN_USERNAME;
      else process.env.SN_USERNAME = previousUser;
      if (previousPassword === undefined) delete process.env.SN_PASSWORD;
      else process.env.SN_PASSWORD = previousPassword;
    }
  });
});

// ─── auth switch handler ───

describe('AuthManager review blocker regressions', () => {
  it('logout deletes only the explicitly selected username on a shared instance', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const deleted = [];
    const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://shared.example.com' }, {
      credentialStore: { load: () => null, save() {}, delete: (...args) => deleted.push(args) },
    });
    auth.logout('https://shared.example.com', 'bob');
    assert.deepStrictEqual(deleted, [['https://shared.example.com', 'bob']]);
  });

  it('resolves OAuth environment credentials for the selected profile', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const previous = process.env.SERVICENOW_OAUTH_TOKEN;
    process.env.SERVICENOW_OAUTH_TOKEN = 'profile-oauth-token';
    try {
      const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://profile-oauth.example.com', getAuthMethod: () => 'oauth' }, { credentialStore: { load: () => null, save() {}, delete() {} } });
      assert.deepStrictEqual(auth.getCredentialsFor('https://profile-oauth.example.com', 'alice', { authMethod: 'oauth' }), { auth_method: 'oauth', access_token: 'profile-oauth-token', auth_source: 'env_token' });
      assert.strictEqual(auth.isAuthenticatedFor('https://profile-oauth.example.com', { username: 'alice', authMethod: 'oauth' }), true);
    } finally {
      if (previous === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN;
      else process.env.SERVICENOW_OAUTH_TOKEN = previous;
    }
  });

  it('does not authenticate a configured method through another method', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => 'https://method.example.com', getAuthMethod: () => 'gck' }, { credentialStore: { load: () => ({ access_token: 'oauth-token' }), save() {}, delete() {} } });
    assert.strictEqual(auth.isAuthenticatedFor('https://method.example.com', { username: 'alice', authMethod: 'gck' }), false);
    assert.throws(() => auth.getCredentialsFor('https://method.example.com', 'alice', { authMethod: 'gck' }));
  });

  it('keeps configured GCK authoritative over conflicting OAuth and Basic env credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const previousOAuth = process.env.SERVICENOW_OAUTH_TOKEN;
    const previousUser = process.env.SN_USERNAME;
    const previousPassword = process.env.SN_PASSWORD;
    process.env.SERVICENOW_OAUTH_TOKEN = 'wrong-oauth';
    process.env.SN_USERNAME = 'wrong-basic';
    process.env.SN_PASSWORD = 'wrong-password';
    const instance = 'https://configured-gck.example.com';
    const store = {
      load: () => ({ auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=browser' }),
      save() {}, delete() {},
    };
    try {
      const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => instance, getAuthMethod: () => 'gck' }, { credentialStore: store });
      assert.deepStrictEqual(await auth.getCredentials(), { auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=browser' });
      assert.strictEqual(auth.isAuthenticated(), true);
      assert.strictEqual(auth.isAuthenticatedFor(instance, { username: 'alice', authMethod: 'gck' }), true);
    } finally {
      if (previousOAuth === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN; else process.env.SERVICENOW_OAUTH_TOKEN = previousOAuth;
      if (previousUser === undefined) delete process.env.SN_USERNAME; else process.env.SN_USERNAME = previousUser;
      if (previousPassword === undefined) delete process.env.SN_PASSWORD; else process.env.SN_PASSWORD = previousPassword;
    }
  });

  it('keeps configured Basic authoritative over conflicting OAuth env credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const previousOAuth = process.env.SERVICENOW_OAUTH_TOKEN;
    process.env.SERVICENOW_OAUTH_TOKEN = 'wrong-oauth';
    const instance = 'https://configured-basic.example.com';
    const store = {
      load: () => ({ auth_method: 'basic', username: 'stored-user', password: 'stored-password' }),
      save() {}, delete() {},
    };
    try {
      const auth = new AuthManager({ getUsername: () => 'alice', getEffectiveInstance: () => instance, getAuthMethod: () => 'basic' }, { credentialStore: store });
      assert.deepStrictEqual(await auth.getCredentials(), { auth_method: 'basic', username: 'stored-user', password: 'stored-password' });
      assert.strictEqual(auth.isAuthenticated(), true);
    } finally {
      if (previousOAuth === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN; else process.env.SERVICENOW_OAUTH_TOKEN = previousOAuth;
    }
  });

  it('isolates same instance and username credential resolution by selected method', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://same-identity.example.com';
    const store = {
      load: () => ({ auth_method: 'oauth', access_token: 'oauth-token' }),
      save() {}, delete() {},
    };
    const identity = { getUsername: () => 'alice', getEffectiveInstance: () => instance };
    const oauth = new AuthManager({ ...identity, getAuthMethod: () => 'oauth' }, { credentialStore: store });
    const gck = new AuthManager({ ...identity, getAuthMethod: () => 'gck' }, { credentialStore: store });
    assert.strictEqual(oauth.isAuthenticatedFor(instance, { username: 'alice', authMethod: 'oauth' }), true);
    assert.strictEqual(gck.isAuthenticatedFor(instance, { username: 'alice', authMethod: 'gck' }), false);
    assert.throws(() => gck.getCredentialsFor(instance, 'alice', { authMethod: 'gck' }));
  });

  it('builds profile SDK/auth transport without command-owned credential closures', async () => {
    const { App } = await import('../src/app.js');
    const app = new App({ profiles: { first: { instance_url: 'https://first.example.com', username: 'alice', auth_method: 'gck' } }, activeProfile: 'first', defaultProfile: 'first' });
    const sdk = app.getSDKForProfile('https://first.example.com', { username: 'alice', authMethod: 'gck' });
    assert.strictEqual(sdk.baseURL, 'https://first.example.com');
    assert.strictEqual(typeof sdk.authProvider.getCredentials, 'function');
    assert.notStrictEqual(sdk.authProvider, app.auth);
  });

  it('uses the selected method through both active and profile SDK credential resolution', async () => {
    const { App } = await import('../src/app.js');
    const previousOAuth = process.env.SERVICENOW_OAUTH_TOKEN;
    process.env.SERVICENOW_OAUTH_TOKEN = 'wrong-oauth';
    const instance = 'https://sdk-method.example.com';
    try {
      const app = new App({ profiles: { first: { instance_url: instance, username: 'alice', auth_method: 'gck' } }, activeProfile: 'first', defaultProfile: 'first' });
      app.auth.credentialStore = {
        load: () => ({ auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=browser' }),
        save() {}, delete() {},
      };
      const profileSdk = app.getSDKForProfile(instance, { username: 'alice', authMethod: 'gck' });
      assert.deepStrictEqual(await app.sdk.authProvider.getCredentials(), { auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=browser' });
      assert.deepStrictEqual(await profileSdk.authProvider.getCredentials(), { auth_method: 'gck', access_token: 'browser-token', cookies: 'sid=browser' });
    } finally {
      if (previousOAuth === undefined) delete process.env.SERVICENOW_OAUTH_TOKEN; else process.env.SERVICENOW_OAUTH_TOKEN = previousOAuth;
    }
  });

  it('never falls back to bearer for browser-session credentials', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const headers = new Headers();
    const sdk = new SDKClient('https://gck.example.com', { getCredentials: async () => ({ auth_method: 'gck', access_token: 'browser', cookies: 'sid=cookie' }) });
    await sdk._setAuth({ headers });
    assert.strictEqual(headers.get('X-UserToken'), 'browser');
    assert.strictEqual(headers.get('Cookie'), 'sid=cookie');
    assert.strictEqual(headers.get('Authorization'), null);
  });

  it('classifies missing-instance and SDK construction probe outcomes', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getUsername: () => null, getEffectiveInstance: () => '', getAuthMethod: () => 'oauth' }, { credentialStore: { load: () => null, save() {}, delete() {} } });
    assert.deepStrictEqual(auth.probeUnavailable('missing_instance'), { status: 'not_attempted', code: 'missing_instance', classification: 'unavailable', message: 'No instance is configured for this profile.', hint: 'Set an instance URL and run: jsn auth login' });
    assert.deepStrictEqual(auth.probeUnavailable('sdk_construction_failed'), { status: 'not_attempted', code: 'sdk_construction_failed', classification: 'configuration_error', message: 'The authenticated probe could not be initialized for this profile.', hint: 'Check the profile configuration and run: jsn auth status again' });
  });
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
      // This is what the real App exposes. The wizard must not treat it as
      // an explicit instance when adding a new profile.
      getEffectiveInstance: () => 'https://dev227772.service-now.com',
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

// ─── auth status styled output (visual pin) ───
//
// Golden test: the styled (TTY) rendering of `jsn auth status` must stay
// byte-identical across the output.js → auth.js rendering move. The payload
// below exercises every badge branch: default marker, auth ✓/✗, verified
// ✅/⚠️, stale hint, 🔒 read_only, ⚡ skip_confirmations, name/username/
// instance-only rows.
//
// The expected string is the COMPLETE styled stdout for the envelope —
// summary line included — because auth status ships its visual as
// data._formatted (the summary is suppressed when _formatted is present).

export const AUTH_STATUS_FIXTURE = {
  default_instance: 'https://dev.service-now.com',
  authenticated: true,
  profiles: [
    {
      name: 'dev',
      instance: 'https://dev.service-now.com',
      authenticated: true,
      auth_source: 'oauth',
      verified: true,
      verified_as: 'admin',
      last_seen: 1000,
      days_since_last_seen: 3,
      stale: false,
      default: true,
      read_only: true,
      skip_confirmations: true,
      include_counts: true,
    },
    {
      name: 'prod',
      instance: 'https://prod.service-now.com',
      authenticated: false,
      verified: false,
      days_since_last_seen: 10,
      stale: true,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
    {
      // no name, no username → instance-only row
      instance: 'https://anon.service-now.com',
      authenticated: true,
      verified: null,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
    {
      // username but no name → "instance (as username)" row
      username: 'bob',
      instance: 'https://bob.service-now.com',
      authenticated: true,
      verified: null,
      default: false,
      read_only: false,
      skip_confirmations: false,
    },
  ],
};

export const AUTH_STATUS_STYLED_GOLDEN =
  '4 profile(s)\n' +
  '\n' +
  '\n' +
  '* ✓ dev — https://dev.service-now.com 🔒 ⚡ ✅\n' +
  '  ✗ prod — https://prod.service-now.com ⚠️ (10d ago — may have been released)\n' +
  '  ✓ https://anon.service-now.com\n' +
  '  ✓ https://bob.service-now.com (as bob)\n';

describe('auth status styled output (visual pin)', () => {
  it('renders the profiles envelope byte-identically via OutputWriter', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const { renderAuthStatus } = await import('../src/commands/auth.js');

    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)), isTTY: true };

    // The handler ships data._formatted built by renderAuthStatus; the
    // OutputWriter then writes it verbatim (summary suppressed).
    const data = { ...AUTH_STATUS_FIXTURE, _formatted: renderAuthStatus(AUTH_STATUS_FIXTURE, '4 profile(s)') };
    ow.ok(data, { summary: '4 profile(s)' });

    assert.strictEqual(chunks.join(''), AUTH_STATUS_STYLED_GOLDEN);
  });
});

// ─── OAuth URL construction (Issue #124) ───

describe('OAuth URL', () => {
  it('should build a complete OAuth authorization URL', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ config: {} });
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const tempConfigHome = mkdtempSync(path.join(tmpdir(), 'jsn-auth-pkce-'));
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    let url;
    try {
      url = auth.buildAuthURL('https://dev12345.service-now.com');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      rmSync(tempConfigHome, { recursive: true, force: true });
    }

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

  it('refresh --profile selects the named same-instance profile', async () => {
    const { authCmd } = await import('../src/commands/auth.js');
    const calls = [];
    const instance = 'https://shared.example.com';
    const app = {
      config: { profiles: {
        alice: { instance_url: instance, username: 'alice', auth_method: 'oauth', domain_separation: false },
        bob: { instance_url: instance, username: 'bob', auth_method: 'oauth', domain_separation: false },
      }, activeProfile: 'alice', defaultProfile: 'alice' },
      auth: {
        getCredentialsFor: (...args) => { calls.push(['get', ...args]); return { auth_method: 'oauth', refresh_token: 'rt' }; },
        refreshToken: (...args) => { calls.push(['refresh', ...args]); return { expires_at: 1 }; },
      },
      getSDKForProfile: () => ({ list: async () => [] }),
      ok() {},
    };
    const commands = [];
    const yargs = { command(c) { commands.push(c); return yargs; } };
    authCmd((fn) => async (argv) => fn(argv, argv.app)).builder(yargs);
    const refresh = commands.find(c => c.command.startsWith('refresh'));
    await refresh.handler({ app, profile: 'bob', instance });
    assert.strictEqual(calls[0][2], 'bob');
    assert.strictEqual(calls[1][3], 'bob');
  });

  it('wait-file OAuth login persists credentials under the selected profile username', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const root = mkdtempSync(path.join(tmpdir(), 'jsn-oauth-wait-'));
    const codeFile = path.join(root, 'code');
    const saved = [];
    const auth = new AuthManager({ getUsername: () => 'alice' }, {
      credentialStore: {
        load: () => null,
        save: (...args) => saved.push(args),
        delete() {},
      },
    });
    auth.exchangeCode = async () => ({ auth_method: 'oauth', access_token: 'token' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(codeFile, 'auth-code');
    try {
      await auth.buildAuthURL('https://shared.example.com', codeFile, 'bob');
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0][2], 'bob');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not delete ambiguous bare credentials for a username-less shared profile', async () => {
    const { removeProfile } = await import('../src/commands/auth.js');
    const deleted = [];
    const instance = 'https://shared-bare.example.com';
    const app = {
      config: { profiles: {
        first: { instance_url: instance },
        second: { instance_url: instance },
      }, activeProfile: 'first', defaultProfile: 'first' },
      auth: { logout: (...args) => deleted.push(args) },
      ok() {},
    };
    await removeProfile(app, 'second');
    assert.deepStrictEqual(deleted, []);
  });
});
