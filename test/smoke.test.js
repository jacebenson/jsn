// Clean up any env variable that might interfere
delete process.env.SERVICENOW_OAUTH_TOKEN;

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { cli } from '../src/cli.js';

describe('CLI smoke tests', () => {
  it('should parse without error', () => {
    assert.ok(cli, 'CLI should be defined');
    assert.ok(typeof cli.parse === 'function', 'CLI should have parse method');
  });
});

describe('Config', () => {
  it('normalizes instance URLs', async () => {
    const { normalizeInstanceURL } = await import('../src/config.js');
    assert.strictEqual(normalizeInstanceURL('dev12345.service-now.com'), 'https://dev12345.service-now.com');
    assert.strictEqual(normalizeInstanceURL('https://dev12345.service-now.com/'), 'https://dev12345.service-now.com');
  });
});

describe('Helpers', () => {
  it('extracts string fields from records', async () => {
    const { getStringField } = await import('../src/helpers.js');
    assert.strictEqual(getStringField({ number: 'INC001' }, 'number'), 'INC001');
    assert.strictEqual(getStringField({ number: { display_value: 'INC001', value: 'abc' } }, 'number'), 'INC001');
    assert.strictEqual(getStringField({}, 'missing'), '');
  });
});

describe('Errors', () => {
  it('creates structured errors', async () => {
    const { errUsage, errAuth, AppError } = await import('../src/errors.js');
    const e = errUsage('test error');
    assert.ok(e instanceof AppError);
    assert.strictEqual(e.code, 'usage_error');
    assert.strictEqual(e.message, 'test error');

    const authErr = errAuth('no token');
    assert.strictEqual(authErr.code, 'auth_error');
    assert.ok(authErr.hint.includes('jsn auth login'));
  });
});

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
});

describe('SDK Architecture', () => {
  it('should not have domain-specific helper methods on Client', async () => {
    const { SDKClient } = await import('../src/sdk.js');

    const coreMethods = ['list', 'get', 'create', 'update', 'delete', 'request', 'rawRequest', 'aggregateCount', 'executeScript'];
    for (const method of coreMethods) {
      assert.strictEqual(typeof SDKClient.prototype[method], 'function', `SDKClient must have method: ${method}`);
    }

    const forbiddenPatterns = ['ListForm', 'ListList', 'GetSP', 'ListSP'];
    const protoProps = Object.getOwnPropertyNames(SDKClient.prototype);
    for (const prop of protoProps) {
      for (const pattern of forbiddenPatterns) {
        assert.ok(!prop.includes(pattern), `SDKClient should NOT have domain method: ${prop}`);
      }
    }
  });
});

after(() => {
  delete process.env.SERVICENOW_OAUTH_TOKEN;
});
