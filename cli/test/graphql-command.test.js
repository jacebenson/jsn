import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function commandHandler() {
  const { graphqlCmd } = await requireCommand();
  const cmd = graphqlCmd((fn) => async (argv) => fn(argv, argv.app));
  const yargs = {
    positional() { return yargs; },
    option() { return yargs; },
  };
  cmd.builder(yargs);
  return cmd.handler;
}

async function requireCommand() {
  return import('../src/commands/graphql.js');
}

describe('graphql command', () => {
  it('registers a whole-command mutation capability', async () => {
    const { collectCapabilities, mutationPaths } = await import('../src/capabilities.js');
    await import('../src/commands/graphql.js');
    assert.deepStrictEqual(collectCapabilities().get('graphql'), { mutationSubcommands: [''] });
    assert.ok(mutationPaths().some((path) => path.length === 1 && path[0] === 'graphql'));
  });

  it('posts a positional document with default variables and preserves data/errors', async () => {
    const calls = [];
    const handler = (await commandHandler());
    const app = {
      sdk: {
        request: async (...args) => {
          calls.push(args);
          return { data: { ok: true }, errors: [{ message: 'partial result' }] };
        },
      },
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok: (value, options) => { app.result = { value, options }; },
    };

    await handler({ app, document: '{ viewer { name } }' });

    assert.strictEqual(calls[0][0], 'https://example.service-now.com/api/now/graphql');
    assert.deepStrictEqual(JSON.parse(calls[0][1].body), {
      query: '{ viewer { name } }',
      variables: {},
    });
    assert.deepStrictEqual(app.result.value, { data: { ok: true }, errors: [{ message: 'partial result' }] });
  });

  it('supports --query, --query-file, --stdin, and JSON variables', async () => {
    const handler = (await commandHandler());
    const tempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-graphql-')), 'query.graphql');
    fs.writeFileSync(tempFile, '{ fileQuery }');
    const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const cases = [
      [{ query: '{ flagQuery }' }, '{ flagQuery }'],
      [{ queryFile: tempFile }, '{ fileQuery }'],
    ];
    for (const [argv, expected] of cases) {
      const calls = [];
      const app = {
        sdk: { request: async (...args) => { calls.push(args); return { data: {} }; } },
        getEffectiveInstance: () => 'https://example.service-now.com',
        ok: () => {},
      };
      await handler({ app, ...argv, variables: '{"limit":1}' });
      assert.strictEqual(JSON.parse(calls[0][1].body).query, expected);
      assert.deepStrictEqual(JSON.parse(calls[0][1].body).variables, { limit: 1 });
    }

    const calls = [];
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: { setEncoding() {}, on(event, callback) { if (event === 'data') callback('{ stdinQuery }'); if (event === 'end') callback(); return this; } },
    });
    try {
      const app = {
        sdk: { request: async (...args) => { calls.push(args); return { data: {} }; } },
        getEffectiveInstance: () => 'https://example.service-now.com',
        ok: () => {},
      };
      await handler({ app, stdin: true });
    } finally {
      Object.defineProperty(process, 'stdin', originalStdinDescriptor);
      fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
    }
    assert.strictEqual(JSON.parse(calls[0][1].body).query, '{ stdinQuery }');
  });

  it('rejects conflicting or malformed input before making a request', async () => {
    const handler = (await commandHandler());
    let requestCount = 0;
    const app = {
      sdk: { request: async () => { requestCount += 1; } },
      getEffectiveInstance: () => 'https://example.service-now.com',
      ok: () => {},
    };
    await assert.rejects(() => handler({ app, document: '{ one }', query: '{ two }' }), /exactly one/i);
    await assert.rejects(() => handler({ app, query: '{ one }', variables: '[]' }), /JSON object/i);
    await assert.rejects(() => handler({ app }), /exactly one/i);
    assert.strictEqual(requestCount, 0);
  });
});

describe('SDK GraphQL transport', () => {
  it('sends the JSON POST payload through authenticated SDK request transport', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const previousFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (request) => {
      captured = request;
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const sdk = new SDKClient('https://example.service-now.com', {
        getCredentials: async () => ({ auth_method: 'oauth', access_token: 'token' }),
      });
      const result = await sdk.request('https://example.service-now.com/api/now/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: '{ viewer { name } }', variables: { limit: 1 } }),
      });
      assert.deepStrictEqual(result, { data: { ok: true } });
      assert.strictEqual(captured.method, 'POST');
      assert.strictEqual(captured.headers.get('content-type'), 'application/json');
      assert.deepStrictEqual(await captured.json(), { query: '{ viewer { name } }', variables: { limit: 1 } });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
