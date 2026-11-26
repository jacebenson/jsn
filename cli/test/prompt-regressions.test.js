import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { input, select, search, checkbox, PromptCancelled } from '../src/prompts.js';
import { paginatedSearch } from '../src/paginated-search.js';

function terminal() {
  const stream = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input: stream, output };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
// Search-as-you-type is debounced, so a term needs to outlive the debounce
// window before its request can be observed.
const settle = () => new Promise(resolve => setTimeout(resolve, 260));

test('text preserves punctuation, uppercase and Unicode', async () => {
  const io = terminal();
  const answer = input({ message: 'Name' }, io);
  io.input.write('A.user+é@Example.com!\r');
  assert.equal(await answer, 'A.user+é@Example.com!');
});

test('false validation refuses submission until corrected', async () => {
  const io = terminal();
  let done = false;
  const answer = input({ message: 'Name', validate: value => value === 'ok' }, io).then(value => { done = true; return value; });
  io.input.write('\r');
  await tick();
  assert.equal(done, false);
  io.input.write('ok\r');
  assert.equal(await answer, 'ok');
});

test('select default and checkbox checked choices are preserved', async () => {
  const io = terminal();
  const picked = select({ message: 'Pick', default: 2, choices: [{ name: 'One', value: 1 }, { name: 'Two', value: 2 }] }, io);
  io.input.write('\r');
  assert.equal(await picked, 2);
  const checked = checkbox({ message: 'Check', choices: [{ name: 'One', value: 1, checked: true }, { name: 'Two', value: 2 }] }, io);
  io.input.write('\r');
  assert.deepEqual(await checked, [1]);
});

test('search loads the initial list without typing', async () => {
  const io = terminal();
  const answer = search({ message: 'Find', source: async () => [{ name: 'First', value: 7 }] }, io);
  await tick();
  io.input.write('\r');
  assert.equal(await answer, 7);
});

test('EOF cancels ordinary input and removes its key listener', async () => {
  const io = terminal();
  const answer = input({ message: 'Name' }, io);
  io.input.end();
  await assert.rejects(answer, PromptCancelled);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('pending sources are aborted on Escape without waiting for a response', async () => {
  const io = terminal();
  let signal;
  const answer = paginatedSearch({ message: 'Find', source: (_term, _offset, context) => {
    signal = context.signal;
    return new Promise(() => {});
  } }, io);
  io.input.write('a');
  await tick();
  io.input.write('\x1b');
  assert.equal(await answer, undefined);
  assert.equal(signal.aborted, true);
});

test('newer search wins before an old uncooperative source resolves', async () => {
  const io = terminal();
  let release;
  const answer = paginatedSearch({ message: 'Find', source: term => {
    if (term === 'a') return new Promise(resolve => { release = resolve; });
    return [{ name: 'Fresh', value: term || 'initial' }];
  } }, io);
  await settle();
  io.input.write('a');
  await settle();
  io.input.write('b');
  await settle();
  release([{ name: 'Old', value: 'wrong' }]);
  await tick();
  io.input.write('\r');
  assert.equal((await answer).value, 'ab');
});
