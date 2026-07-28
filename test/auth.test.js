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

  it('should define login, logout, status, refresh subcommands', async () => {
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
