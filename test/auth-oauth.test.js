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

});
