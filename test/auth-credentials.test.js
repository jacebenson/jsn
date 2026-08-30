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
it('keeps an explicit username-less profile on the bare credential identity', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const records = new Map([
      ['https://shared.example.com\\0alice', { auth_method: 'oauth', access_token: 'alice-token', auth_source: 'file', last_seen: 11 }],
      ['https://shared.example.com\\0', { auth_method: 'oauth', access_token: 'bare-token', auth_source: 'file', last_seen: 22 }],
    ]);
    const manager = new AuthManager({
      getUsername: () => 'alice',
      getEffectiveInstance: () => 'https://shared.example.com',
      getAuthMethod: () => 'oauth',
    }, { credentialStore: {
      load: (url, username) => records.get(`${url}\\0${username || ''}`) || null,
      save: () => {},
      delete: () => {},
    } });
    const options = { authMethod: 'oauth', username: undefined };
    assert.strictEqual(manager.getLastSeen('https://shared.example.com', options), 22);
    assert.strictEqual(manager.getAuthSource('https://shared.example.com', options), 'file');
    assert.strictEqual(manager.hasLegacyCredentials('https://shared.example.com', options), false);
    assert.strictEqual(manager.isAuthenticatedFor('https://shared.example.com', options), true);
    assert.strictEqual(manager.createProfileProvider('https://shared.example.com', options).getCredentials().access_token, 'bare-token');
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
describe('credential identity regressions', () => {
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
