// Tests for the `jsn setup` hub menu.
// mock.module must run BEFORE setup.js (and its real auth.js dependency)
// is imported in this process — hence this file tests ONLY the menu.
// Zero-profile wizard routing lives in setup-wizard.test.js.

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';

afterEach(() => {
  mock.reset();
});

describe('authHubMenu', () => {
  it('should offer add/switch/remove/modify and return the picked action', async () => {
    let capturedChoices = null;
    mock.module('@inquirer/prompts', {
      namedExports: {
        select: async (config) => {
          capturedChoices = config.choices;
          return 'modify';
        },
      },
    });

    const { authHubMenu } = await import('../src/commands/setup.js');
    const action = await authHubMenu({});

    assert.strictEqual(action, 'modify');
    const values = capturedChoices.map(c => c.value);
    assert.deepStrictEqual(values, ['add', 'switch', 'remove', 'modify']);
  });
});
