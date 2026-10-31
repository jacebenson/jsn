// Tests for the `jsn setup` hub menu.
// Zero-profile wizard routing lives in setup-wizard.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

function promptWithKey(key) {
  const input = new PassThrough();
  const output = new PassThrough();
  const result = import('../src/commands/setup.js').then(({ authHubMenu }) => {
    const prompt = authHubMenu({ input, output });
    setImmediate(() => input.write(key));
    return prompt;
  });
  return result;
}

describe('authHubMenu', () => {
  it('offers add/switch/remove/modify and returns the picked action', async () => {
    let capturedChoices = null;
    const { authHubMenu } = await import('../src/commands/setup.js');
    const action = await authHubMenu({
      promptFn: async (config) => {
        capturedChoices = config.choices;
        return 'modify';
      },
    });

    assert.strictEqual(action, 'modify');
    const values = capturedChoices.map(c => c.value);
    assert.deepStrictEqual(values, ['status', 'switch', 'add', 'login', 'modify', 'advanced', 'logout', 'remove']);
  });

  it('shows section headings without making them keyboard choices', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', chunk => { rendered += chunk.toString(); });
    const { authHubMenu } = await import('../src/commands/setup.js');
    const pending = authHubMenu({ input, output });
    for (let index = 0; index < 5; index++) {
      await new Promise(resolve => setImmediate(resolve));
      input.write('\x1b[B');
    }
    await new Promise(resolve => setImmediate(resolve));
    input.write('\r');
    assert.equal(await pending, 'advanced');
    for (const heading of ['Connections', 'JSN settings', 'Cleanup']) assert.ok(rendered.includes(heading));
  });

  it('returns undefined when q exits the interactive hub', async () => {
    assert.strictEqual(await promptWithKey('q'), undefined);
  });

  it('returns undefined when Escape exits the interactive hub', async () => {
    assert.strictEqual(await promptWithKey('\x1b'), undefined);
  });
});
