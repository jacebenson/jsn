import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeInstanceURL } from '../src/config.js';

// ─── Config tests ───

describe('Config', () => {
  it('should normalize instance URLs', () => {
    assert.strictEqual(normalizeInstanceURL('dev12345.service-now.com'), 'https://dev12345.service-now.com');
    assert.strictEqual(normalizeInstanceURL('https://dev12345.service-now.com/'), 'https://dev12345.service-now.com');
    assert.strictEqual(normalizeInstanceURL('https://dev354702.service-now.com/now/nav/ui/classic/params/target/ui_page.do%3Fsys_id%3D6391693b931b031087b0f14fdd03d6f1'), 'https://dev354702.service-now.com');
    assert.strictEqual(normalizeInstanceURL('http://dev.local'), 'http://dev.local');
  });
});

// ─── SDK tests ───

describe('SDK', () => {
  it('should construct with baseURL and authProvider', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
    assert.strictEqual(client.timeout, 30000);
  });

  it('should extract HTML script output', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<HTML><BODY><PRE>*** Script: Hello<BR/>*** Script: World<BR/></PRE></BODY></HTML>';
    const output = client._extractScriptOutput(html);
    assert.ok(output.includes('Hello'));
    assert.ok(output.includes('World'));
  });
});

// ─── Auth tests ───

describe('Auth', () => {
  it('detects available and missing stored credentials for the selected instance', async () => {
    const { AuthManager } = await import('../src/auth.js');
    const instance = 'https://auth-test.example.invalid';
    let credentials = { auth_method: 'gck', auth_source: 'gck', access_token: 'token', cookies: 'session=value' };
    const auth = new AuthManager({
      getEffectiveInstance: () => instance,
      getAuthMethod: () => 'gck',
    }, { credentialStore: { load: () => credentials } });

    assert.strictEqual(auth.isAuthenticated(), true);
    credentials = null;
    assert.strictEqual(auth.isAuthenticated(), false);
  });

  it('should return false when no instance configured', async () => {
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
});
