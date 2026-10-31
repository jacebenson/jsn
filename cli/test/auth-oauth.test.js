// Tests for auth command structure and handler logic

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
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

describe('OAuth URL', () => {
  it('builds the default OAuth URL and exchanges its matching S256 verifier', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const saves = [];
    const auth = new AuthManager({ config: {} }, {
      credentialStore: {
        load: () => null,
        save: (...args) => saves.push(args),
        delete: () => {},
      },
    });
    const instance = 'https://dev12345.service-now.com';
    const parsed = new URL(auth.buildAuthURL(instance));
    assert.strictEqual(parsed.origin, instance);
    assert.strictEqual(parsed.pathname, '/oauth_auth.do');
    for (const [key, value] of Object.entries({
      response_type: 'code', redirect_uri: '/sdk-oauth.do',
      code_challenge_method: 'S256', scope: 'openid', approval_prompt: 'force',
    })) assert.strictEqual(parsed.searchParams.get(key), value, key);
    assert.ok(parsed.searchParams.get('client_id'));
    assert.ok(parsed.searchParams.get('state'));

    const previousFetch = globalThis.fetch;
    let exchanged;
    globalThis.fetch = async (url, options) => {
      assert.strictEqual(String(url), `${instance}/oauth_token.do`);
      exchanged = new URLSearchParams(options.body);
      const body = JSON.stringify({ access_token: 'test-token', expires_in: 3600 });
      return { ok: true, json: async () => JSON.parse(body), text: async () => body };
    };
    try {
      await auth.loginWithCode(instance, 'test-code');
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.strictEqual(exchanged.get('code'), 'test-code');
    assert.strictEqual(exchanged.get('grant_type'), 'authorization_code');
    assert.strictEqual(exchanged.get('client_id'), parsed.searchParams.get('client_id'));
    const verifier = exchanged.get('code_verifier');
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.strictEqual(createHash('sha256').update(verifier).digest('base64url'), parsed.searchParams.get('code_challenge'));
    assert.strictEqual(saves[0][1].access_token, 'test-token');
  });

  it('should normalize instance URL before building', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const auth = new AuthManager({ config: {} });
    const url = auth.buildAuthURL('dev12345.service-now.com');

    assert.ok(url.startsWith('https://dev12345.service-now.com/'));
  });

  it('keeps pending PKCE state separate for concurrent same-instance profiles', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const tempConfigHome = mkdtempSync(path.join(tmpdir(), 'jsn-auth-pkce-concurrent-'));
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    const saves = [];
    const auth = new AuthManager({ config: {} }, {
      credentialStore: {
        load: () => null,
        save: (instance, credentials, username) => saves.push({ instance, credentials, username }),
        delete: () => {},
      },
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const token = options.body.includes('alice-code') ? 'alice-token' : 'bob-token';
      const body = JSON.stringify({ access_token: token, refresh_token: 'refresh', expires_in: 3600 });
      return { ok: true, json: async () => JSON.parse(body), text: async () => body };
    };
    try {
      const instance = 'https://shared-pkce.example.com';
      auth.buildAuthURL(instance, undefined, 'alice');
      auth.buildAuthURL(instance, undefined, 'bob');

      await auth.loginWithCode(instance, 'alice-code', 'alice');
      await auth.loginWithCode(instance, 'bob-code', 'bob');
    } finally {
      globalThis.fetch = previousFetch;
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      rmSync(tempConfigHome, { recursive: true, force: true });
    }

    assert.deepStrictEqual(saves.map(({ username, credentials }) => [username, credentials.access_token]), [
      ['alice', 'alice-token'],
      ['bob', 'bob-token'],
    ]);
  });

});
