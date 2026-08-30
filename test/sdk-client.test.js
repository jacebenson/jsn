import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('SDKClient', () => {
  it('exports SDKClient class', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    assert.ok(SDKClient);
    assert.strictEqual(typeof SDKClient, 'function');
  });

  it('constructs with baseURL and authProvider', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
    assert.strictEqual(client.timeout, 30000);
  });

  it('strips trailing slash from baseURL', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com/', auth);
    assert.strictEqual(client.baseURL, 'https://test.service-now.com');
  });

  it('accepts custom timeout', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth, { timeout: 60000 });
    assert.strictEqual(client.timeout, 60000);
  });

  it('uses persisted Basic Auth credentials for requests', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = {
      getCredentials: async () => ({
        auth_method: 'basic',
        username: 'admin',
        password: 'secret',
      }),
    };
    const client = new SDKClient('https://test.service-now.com', auth);
    const request = new Request('https://test.service-now.com/api/now/table/incident');

    await client._setAuth(request);

    assert.strictEqual(
      request.headers.get('Authorization'),
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
  });

  it('uses browser session credentials for requests', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = {
      getCredentials: async () => ({
        auth_method: 'gck',
        access_token: 'gck-token',
        cookies: 'JSESSIONID=session-id',
      }),
    };
    const client = new SDKClient('https://test.service-now.com', auth);
    const request = new Request('https://test.service-now.com/api/now/table/incident');

    await client._setAuth(request);

    assert.strictEqual(request.headers.get('X-UserToken'), 'gck-token');
    assert.strictEqual(request.headers.get('Cookie'), 'JSESSIONID=session-id');
    assert.strictEqual(request.headers.get('Authorization'), null);
  });

  it('extracts HTML script output', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<HTML><BODY><PRE>*** Script: Hello<BR/>*** Script: World<BR/></PRE></BODY></HTML>';
    const output = client._extractScriptOutput(html);
    assert.ok(output.includes('Hello'));
    assert.ok(output.includes('World'));
  });

  it('extracts script output with <br> tags', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<pre>Line 1<br>Line 2<br>Line 3</pre>';
    const output = client._extractScriptOutput(html);
    assert.ok(output.includes('Line 1'));
    assert.ok(output.includes('Line 2'));
    assert.ok(output.includes('Line 3'));
  });

  it('extracts script output with HTML entities', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);

    const html = '<pre>&lt;test&gt; &amp; &quot;quoted&quot;</pre>';
    const output = client._extractScriptOutput(html);
    assert.strictEqual(output, '<test> & "quoted"');
  });

  it('has core CRUD methods', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const coreMethods = ['list', 'get', 'create', 'update', 'delete', 'request', 'rawRequest', 'aggregateCount', 'executeScript', 'exportUpdateSet'];
    for (const method of coreMethods) {
      assert.strictEqual(typeof SDKClient.prototype[method], 'function', `Missing method: ${method}`);
    }
  });

  it('exportUpdateSet hits the fluent endpoint with CSRF + scope', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const calls = [];
    const client = new SDKClient('https://dev.example.service-now.com', { isAuthenticated: () => true, getCredentials: async () => ({ username: 'admin' }) });
    client._warmSession = async () => 'JSESSIONID=abc';
    client._getScriptsPageCSRF = async () => 'csrf-token-123';
    client.rawRequest = async (endpoint, opts) => { calls.push({ endpoint, opts }); return '<xml/>'; };

    const xml = await client.exportUpdateSet('set123', 'scope456');
    assert.strictEqual(xml, '<xml/>');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].endpoint.includes('/fluent_update_set_export.do'));
    assert.ok(calls[0].endpoint.includes('sysparm_ck=csrf-token-123'));
    assert.ok(calls[0].endpoint.includes('sysparm_sys_id=set123'));
    assert.ok(calls[0].endpoint.includes('sysparm_app_sys_id=scope456'));
    assert.ok(calls[0].opts.headers.Cookie.includes('JSESSIONID=abc'));
  });

  it('does not have domain-specific methods', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const forbiddenPatterns = ['ListForm', 'ListList', 'GetSP', 'ListSP'];
    const protoProps = Object.getOwnPropertyNames(SDKClient.prototype);
    for (const prop of protoProps) {
      for (const pattern of forbiddenPatterns) {
        assert.ok(!prop.includes(pattern), `Should not have domain method: ${prop}`);
      }
    }
  });
});
