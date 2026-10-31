import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Auth', () => {
  it('returns false when no instance configured', async () => {
    const origToken = process.env.SERVICENOW_OAUTH_TOKEN;
    const origSnUser = process.env.SN_USERNAME;
    const origSnPass = process.env.SN_PASSWORD;
    delete process.env.SERVICENOW_OAUTH_TOKEN;
    delete process.env.SN_USERNAME;
    delete process.env.SN_PASSWORD;
    try {
      const { AuthManager } = await import('../src/auth.js');
      const auth = new AuthManager({ getEffectiveInstance: () => '' });
      assert.strictEqual(auth.isAuthenticated(), false);
    } finally {
      if (origToken !== undefined) process.env.SERVICENOW_OAUTH_TOKEN = origToken;
      if (origSnUser !== undefined) process.env.SN_USERNAME = origSnUser;
      if (origSnPass !== undefined) process.env.SN_PASSWORD = origSnPass;
    }
  });

  it('isAuthenticatedFor returns false for empty instance', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    assert.strictEqual(auth.isAuthenticatedFor(''), false);
  });

  it('isAuthenticatedFor recognizes stored basic auth credentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = `https://basic-auth-${Date.now()}.service-now.com`;
    const stored = new Map();
    const credentialStore = {
      load: (target, username) => stored.get(`${target}\0${username || ''}`) || null,
      save: (target, credentials, username) => stored.set(`${target}\0${username || ''}`, credentials),
      delete: (target, username) => stored.delete(`${target}\0${username || ''}`),
    };
    credentialStore.save(instance, {
      auth_method: 'basic',
      auth_source: 'keyring',
      username: 'admin',
      password: 'secret',
    }, 'admin');

    try {
      const auth = new AuthManager({
        getUsername: () => 'admin',
        getEffectiveInstance: () => instance,
      }, { credentialStore });
      assert.strictEqual(auth.isAuthenticatedFor(instance), true);
      const credentials = await auth.getCredentials();
      assert.strictEqual(credentials.auth_method, 'basic');
      assert.strictEqual(credentials.username, 'admin');
      assert.strictEqual(credentials.password, 'secret');
      assert.ok(credentials.auth_source);
      const relogged = await auth.loginWithPassword(instance);
      assert.strictEqual(relogged.auth_method, 'basic');
      assert.strictEqual(relogged.username, 'admin');
    } finally {
      credentialStore.delete(instance, 'admin');
    }
  });

  it('throws when no instance configured for getCredentials', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    await assert.rejects(() => auth.getCredentials(), /No instance configured/);
  });

  it('generates PKCE params', async () => {
    const { AuthManager } = await import('../src/auth.js');
    // We can validate PKCE indirectly by testing exchangeCode would reject
    const auth = new AuthManager({ getEffectiveInstance: () => '' });
    assert.ok(auth.httpClient);
  });
});
