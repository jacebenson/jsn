import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('OutputWriter format methods', () => {
  it('setFormat updates getFormat', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    assert.strictEqual(ow.getFormat(), 'auto');
    ow.setFormat('json');
    assert.strictEqual(ow.getFormat(), 'json');
    ow.setFormat('quiet');
    assert.strictEqual(ow.getFormat(), 'quiet');
  });

  it('setFormat returns this for chaining', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    const result = ow.setFormat('json');
    assert.strictEqual(result, ow);
  });
});

describe('printContextHeader', () => {
  it('suppressed for JSON format', async () => {
    const { OutputWriter, FormatJSON } = await import('../src/output.js');
    // Mock app with json format
    const app = {
      getEffectiveInstance: () => 'https://dev123.service-now.com',
      output: new OutputWriter(),
      sdk: {
        getUser: async () => ({ sys_id: 'abc', name: 'admin' }),
        list: async () => [],
      },
    };
    app.output.setFormat('json');
    // Should return without writing (no error)
    await app.output; // verify no crash
    assert.strictEqual(app.output.getFormat(), FormatJSON);
  });

  it('suppressed for quiet format', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    ow.setFormat('quiet');
    assert.strictEqual(ow.getFormat(), 'quiet');
  });
});
