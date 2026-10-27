import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { select, search, confirm, input, password, PromptCancelled } from '../src/prompts.js';
import { renderAppError } from '../src/errors.js';

for (const [name, prompt, extra] of [
  ['select', select, { choices: [{ name: 'One', value: 'one' }] }],
  ['search', search, { source: () => [{ name: 'One', value: 'one' }] }],
  ['confirm', confirm, {}], ['input', input, {}], ['password', password, {}],
]) {
  test(`Escape cancels ${name} and cleans up keyboard listeners`, async () => {
    const stream = new PassThrough();
    const output = new PassThrough();
    const originalListeners = stream.listenerCount('keypress');
    const pending = prompt({ message: 'Choose', ...extra }, { input: stream, output });
    const cancelled = assert.rejects(pending, PromptCancelled);
    setImmediate(() => stream.write('\x1b'));
    await cancelled;
    assert.equal(stream.listenerCount('keypress'), originalListeners);
  });
}

test('arrow keys and Enter still select an answer', async () => {
  const stream = new PassThrough();
  const output = new PassThrough();
  const pending = select({ message: 'Choose', choices: ['One', 'Two'] }, { input: stream, output });
  setImmediate(() => stream.write('\x1b[B\r'));
  assert.equal(await pending, 'Two');
  assert.equal(stream.listenerCount('keypress'), 0);
});

test('prompt cancellation exits cleanly instead of rendering an error', () => {
  const result = renderAppError(new PromptCancelled());
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, 'Cancelled.\n');
});
