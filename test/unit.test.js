import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeInstanceURL } from '../src/config.js';

// ─── Config tests ───

describe('Config', () => {
  it('should normalize instance URLs', () => {
    assert.strictEqual(normalizeInstanceURL('dev12345.service-now.com'), 'https://dev12345.service-now.com');
    assert.strictEqual(normalizeInstanceURL('https://dev12345.service-now.com/'), 'https://dev12345.service-now.com');
    assert.strictEqual(normalizeInstanceURL('http://dev.local'), 'http://dev.local');
  });
});

// ─── SDK tests ───

describe('SDK', () => {
  it('should export SDKClient class', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    assert.ok(SDKClient);
    assert.strictEqual(typeof SDKClient, 'function');
  });

  it('should construct with baseURL and authProvider', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
    assert.strictEqual(client.timeout, 30000);
  });

  it('should strip trailing slash from baseURL', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com/', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
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
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-auth-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect auth status for a configured instance', async () => {
    const { AuthManager } = await import('../src/auth.js');

    const configProvider = {
      getEffectiveInstance: () => 'https://dev383416.service-now.com',
    };
    const auth = new AuthManager(configProvider);

    // This should find the credential from the keyring (set up by Go version)
    const isAuth = auth.isAuthenticated();
    assert.strictEqual(typeof isAuth, 'boolean');
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

// ─── Architecture tests (like Go's architecture_test.go) ───

describe('SDK Architecture', () => {
  it('should not have domain-specific helper methods on Client', async () => {
    const { SDKClient } = await import('../src/sdk.js');

    // Core CRUD methods — must be present
    const coreMethods = ['list', 'get', 'create', 'update', 'delete', 'request', 'rawRequest', 'aggregateCount', 'executeScript', 'getCurrentUser'];
    for (const method of coreMethods) {
      assert.strictEqual(typeof SDKClient.prototype[method], 'function', `SDKClient must have method: ${method}`);
    }

    // Domain-specific methods should NOT be in SDK
    const forbiddenPatterns = ['ListForm', 'ListList', 'GetSP', 'ListSP'];
    const protoProps = Object.getOwnPropertyNames(SDKClient.prototype);
    for (const prop of protoProps) {
      for (const pattern of forbiddenPatterns) {
        assert.ok(!prop.includes(pattern), `SDKClient should NOT have domain method: ${prop}`);
      }
    }
  });
});
