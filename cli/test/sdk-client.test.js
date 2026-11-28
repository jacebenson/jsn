import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('SDKClient', () => {
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

  it('serializes parsed multiline script fields without changing their type or contents', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const auth = { getCredentials: () => ({ auth_method: 'oauth', access_token: 'test-token' }) };
    const client = new SDKClient('https://test.service-now.com', auth);
    const payload = { script: 'var Example = Class.create();\nExample.prototype = {};\n' };
    const previousFetch = globalThis.fetch;
    let requestBody;
    globalThis.fetch = async (request) => {
      requestBody = await request.text();
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: payload }) };
    };
    try {
      await client.update('sys_script_include', 'record-123', payload);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepStrictEqual(JSON.parse(requestBody), payload);
    assert.strictEqual(JSON.parse(requestBody).script, payload.script);
  });

  it('replaces rotated OAuth cookies instead of sending duplicate cookie names', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const responses = [
      ['JSESSIONID=old; Path=/'],
      ['JSESSIONID=new; Path=/'],
      ['glide_user=abc; Path=/'],
    ];
    const calls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (request) => {
      calls.push({ url: request.url, cookie: request.headers.get('cookie') });
      return {
        ok: true,
        headers: {
          getSetCookie: () => responses.shift(),
          get: (name) => name === 'x-usertoken-response' ? 'user-token' : null,
        },
        text: async () => '{"result":[]}',
      };
    };
    try {
      const client = new SDKClient('https://test.service-now.com', {
        getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
      });
      const cookies = await client._warmSession();
      assert.strictEqual(cookies, 'JSESSIONID=new; glide_user=abc');
      assert.strictEqual(calls[1].cookie, 'JSESSIONID=old');
      assert.strictEqual(calls[2].cookie, 'JSESSIONID=new');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('keeps cookies rotated during Basic session bootstrap', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const responses = [
      ['JSESSIONID=old; Path=/'],
      ['JSESSIONID=rotated; Path=/'],
    ];
    const calls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (request) => {
      calls.push({ url: request.url, cookie: request.headers.get('cookie') });
      const setCookie = responses.shift();
      return {
        ok: true,
        headers: {
          getSetCookie: () => setCookie,
          get: (name) => name === 'x-usertoken-response' ? 'user-token' : null,
        },
        text: async () => '{"result":[]}',
      };
    };
    try {
      const client = new SDKClient('https://test.service-now.com', {
        getCredentials: async () => ({ auth_method: 'basic', username: 'admin', password: 'secret' }),
      });
      const cookies = await client._warmSession();
      assert.strictEqual(cookies, 'JSESSIONID=rotated');
      assert.strictEqual(calls[1].cookie, 'JSESSIONID=old');
      assert.strictEqual(client.sessionUserToken, 'user-token');
    } finally {
      globalThis.fetch = previousFetch;
    }
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
    // A script that prints the text "&lt;" arrives as "&amp;lt;" and must come back as "&lt;", not "<".
    assert.strictEqual(client._extractScriptOutput('<PRE>*** Script: &amp;lt;b&amp;gt; &amp;amp;</PRE>'), '*** Script: &lt;b&gt; &amp;');
  });

  it('uploads binary attachments without embedding file bytes in a background script', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client.executeScript = async () => assert.fail('attachment upload must not execute a background script');
    let call;
    client.request = async (endpoint, opts) => {
      call = { endpoint, opts };
      return { result: { sys_id: 'attachment-123' } };
    };

    const table = 'incident';
    const sysID = 'record-123';
    const fileName = 'report.bin';
    const content = Buffer.from([0, 255, 1, 2, 128]);
    const created = await client.addAttachment(table, sysID, content, fileName);

    assert.deepStrictEqual(created, { sys_id: 'attachment-123' });
    assert.strictEqual(call.endpoint, 'https://test.service-now.com/api/now/attachment/file?table_name=incident&table_sys_id=record-123&file_name=report.bin');
    assert.strictEqual(call.opts.method, 'POST');
    assert.strictEqual(call.opts.headers['Content-Type'], 'application/octet-stream');
    assert.deepStrictEqual(call.opts.body, content);
  });

  it('keeps OAuth and Basic session authentication on binary attachment uploads', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (request) => {
      calls.push(request);
      return {
        ok: true,
        status: 200,
        text: async () => '{"result":{"sys_id":"attachment-123"}}',
      };
    };
    try {
      for (const auth_method of ['oauth', 'basic']) {
        const client = new SDKClient('https://test.service-now.com', {
          getCredentials: async () => auth_method === 'oauth'
            ? { auth_method, access_token: 'test-token' }
            : { auth_method, username: 'admin', password: 'secret' },
        });
        client._warmSession = async () => 'JSESSIONID=session';
        client.sessionUserToken = 'user-token';
        await client.addAttachment('incident', 'record-123', Buffer.from('hello'), 'hello.txt');
      }
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.strictEqual(calls.length, 2);
    for (const request of calls) {
      assert.strictEqual(request.headers.get('cookie'), 'JSESSIONID=session');
      assert.strictEqual(request.headers.get('x-usertoken'), 'user-token');
      assert.strictEqual(request.headers.get('authorization'), null);
      assert.strictEqual(Buffer.from(await request.arrayBuffer()).toString(), 'hello');
    }
  });

  it('reports a clear error when the attachment endpoint rejects the file as too large', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client.request = async () => {
      throw Object.assign(new Error('Request Entity Too Large'), { status: 413 });
    };

    await assert.rejects(
      () => client.addAttachment('incident', 'record-1', Buffer.from('hello'), 'hello.txt'),
      /Attachment is too large for the ServiceNow attachment endpoint/,
    );
  });

  it('rejects known server-side script failures instead of returning output', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client._warmSession = async () => '';
    client._getScriptsPageCSRF = async () => 'csrf-token';
    // The platform's own lines, as a PDI prints a runtime error and a syntax error.
    client.rawRequest = async () => '<PRE>Script execution error: Script Identifier: null.null.script, Error Description: undefined is not a function., Script ES Level: 0<BR/>'
      + 'Evaluator: com.glide.script.RhinoEcmaError: undefined is not a function.<BR/>   script : Line(1) column(0)<BR/></PRE>';
    await assert.rejects(
      () => client.executeScript('gs.print("test")', ''),
      /^Error: Background script failed: Script execution error: Script Identifier: null\.null\.script, Error Description: undefined is not a function\., Script ES Level: 0\n/,
    );
    client.rawRequest = async () => '<PRE>Evaluator: com.glide.script.RhinoEcmaError: "foo" is not defined.<BR/></PRE>';
    await assert.rejects(() => client.executeScript('foo.bar()', ''), /^Error: Background script failed: Evaluator: com\.glide\.script\.RhinoEcmaError: "foo" is not defined\.\n/);
    client.rawRequest = async () => '<PRE>Script compilation error: Script Identifier: null.null.script, Error Description: invalid flag after regular expression (null.null.script; line 1), Script ES Level: 0, Interpreted Mode: true<BR/>'
      + 'Javascript compiler exception: invalid flag after regular expression (null.null.script; line 1) in:<BR/></PRE>';
    await assert.rejects(() => client.executeScript('/a/q', ''), /^Error: Background script failed: Script compilation error: Script Identifier: null\.null\.script, Error Description: invalid flag/);
  });

  it('returns a finished script whose printed text mentions an error', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client._warmSession = async () => '';
    client._getScriptsPageCSRF = async () => 'csrf-token';
    // gs.print(gr.message) over syslog rows: the platform prefixes every printed line with its source.
    const printed = ['*** Script: TypeError: Cannot read property "x" from undefined', '*** Script: ReferenceError: g_form is not defined',
      '*** Script: undefined is not a function.', '*** Script: Evaluator: com.glide.script.RhinoEcmaError: "foo" is not defined.', '*** Script: Script execution error: logged by a rule'];
    client.rawRequest = async () => `<PRE>${printed.join('<BR/>')}<BR/></PRE>`;
    assert.strictEqual(await client.executeScript('gs.print(gr.message)', ''), printed.join('\n'));
  });

  it('rejects a KittyScript-rejected sandbox expression with the instance reason', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client._warmSession = async () => '';
    client._getScriptsPageCSRF = async () => 'csrf-token';
    // Real dev366743 output: the rejection arrives as script output, not HTTP.
    client.rawRequest = async () => '<PRE>KittyScript validation failed for null.null.script with error: Access to GlideRecord.insert is not allowed\n'
      + "Source code:\nnew GlideRecord('sys_properties').insert(): com.snc.kittyscript.SecurityCallbackException: "
      + 'Access to GlideRecord.insert is not allowed:\tcom.glide.script.fencing.sandbox.KittyScriptSecurityCallback.checkProperty\n'
      + 'Background message, type:error, message: Access to GlideRecord.insert is not allowed</PRE>';

    await assert.rejects(
      () => client.executeScript("new GlideRecord('sys_properties').insert()", '', { sandbox: true }),
      /Background script failed: KittyScript: Access to GlideRecord\.insert is not allowed\n/,
    );
  });

  it('rejects a KittyScript syntax error instead of returning it as output', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'test-token' }),
    });
    client._warmSession = async () => '';
    client._getScriptsPageCSRF = async () => 'csrf-token';
    client.rawRequest = async () => '<PRE>KittyScript validation failed for null.null.script with error: Syntax error: '
      + "Expected end of expression but found 'a' at position 4\nSource code:\nvar a=1;: com.snc.kittyscript.ParserException</PRE>";

    await assert.rejects(
      () => client.executeScript('var a=1;', '', { sandbox: true }),
      /Background script failed: KittyScript: Syntax error: Expected end of expression but found 'a' at position 4\n/,
    );
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

});

describe('Request domain header override', () => {
  it('omits the configured header only on explicitly unscoped requests', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://test.service-now.com', {
      getCredentials: async () => ({ auth_method: 'gck', access_token: 'test-token' }),
    }, { domain: 'profile-domain' });
    const previousFetch = globalThis.fetch;
    const domains = [];
    globalThis.fetch = async request => {
      domains.push(request.headers.get('X-Now-Domain'));
      return new Response('{}');
    };
    try {
      await client.request(`${client.baseURL}/api/now/ui/concoursepicker/current`, { domain: '' });
      await client.request(`${client.baseURL}/api/now/table/domain`);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(domains, [null, 'profile-domain']);
    assert.equal(client.domain, 'profile-domain');
  });
});
