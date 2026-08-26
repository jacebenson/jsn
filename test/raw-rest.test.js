import { describe, it } from 'node:test';
import assert from 'node:assert';

function appFor(sdk) {
  const app = {
    sdk,
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok: (data, opts) => { app.result = { data, opts }; },
  };
  return app;
}

describe('raw REST command', () => {
  it('uses rawRequest and preserves XML text when --raw is set', async () => {
    const { restCmd } = await import('../src/commands/dev/rest.js');
    let called;
    const app = appFor({
      rawRequest: async (url, options) => {
        called = { url, options };
        return '<?xml version="1.0"?><stats><value>1</value></stats>';
      },
      request: async () => { throw new Error('JSON request should not run'); },
    });
    const command = restCmd((fn) => fn);
    await command.handler({ app, endpoint: 'xmlstats.do', raw: true, method: 'GET' }, app);

    assert.strictEqual(called.url, 'https://dev.example.service-now.com/xmlstats.do');
    assert.strictEqual(called.options.method, 'GET');
    assert.strictEqual(app.result.data, '<?xml version="1.0"?><stats><value>1</value></stats>');
  });
});
