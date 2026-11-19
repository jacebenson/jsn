import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { select, search, checkbox } from '../src/prompts.js';
import { runPrompt } from '../src/prompt-engine.js';
import { paginatedSearch } from '../src/paginated-search.js';
import { authHubPrompt } from '../src/commands/setup.js';

for (const [name, prompt] of [['select', select], ['setup', authHubPrompt]]) {
  test(`${name}: q filters labels instead of exiting; arrows do not wrap`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    let text = '';
    output.on('data', chunk => { text += chunk; });
    const pending = prompt({ message: 'Pick', choices: ['Other', 'Queue', 'Query'].map(name => ({ name, value: name, section: 'Actions' })) }, { input, output });
    input.write('q\x1b[A\x1b[B\x1b[B\r');
    assert.equal(await pending, 'Query');
    assert.match(text, /❯ Queue/);
    assert.match(text, /↑↓ navigate • ⏎ select • type to search • Esc cancel/);
  });
}

test('checkbox keeps hidden selections and confirms all selected values', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const pending = checkbox({ message: 'Pick', choices: ['Alpha', 'Queue'] }, { input, output });
  input.write(' q \r');
  assert.deepEqual(await pending, ['Alpha', 'Queue']);
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('clearing an empty filter restores headings, descriptions and disabled/separator navigation', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const pending = select({ message: 'Pick', default: 'second', choices: [
    { name: 'First', value: 'first', section: 'Start' },
    { type: 'separator', name: '---' },
    { name: 'Blocked', value: 'blocked', disabled: true },
    { name: 'Second', value: 'second', description: 'Details', section: 'End' },
  ] }, { input, output });
  input.write('zzz');
  await tick();
  assert.match(text, /No matches/);
  input.write('\r');
  await tick();
  input.write('\x7f\x7f\x7f\x1b[B\r');
  assert.equal(await pending, 'second');
  assert.match(text, /Start/);
  assert.match(text, /End/);
  assert.match(text, /Details/);
});

for (const [name, prompt] of [['search', search], ['records', paginatedSearch]]) {
  test(`${name}: q is passed to the source and Enter returns its match`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    const terms = [];
    const pending = prompt({ message: 'Pick', source: term => {
      terms.push(term);
      return [{ name: term ? 'Queue' : 'Other', value: term ? 'queue' : 'other' }];
    } }, { input, output });
    await tick();
    input.write('q');
    await tick();
    input.write('\r');
    const answer = await pending;
    assert.equal(name === 'records' ? answer.value : answer, 'queue');
    assert.equal(terms.at(-1), 'q');
  });
}

test('empty final record page stops further loads and preserves last available selection', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const offsets = [];
  const pending = paginatedSearch({ message: 'Pick', totalCount: 99, source: (_term, offset) => {
    offsets.push(offset);
    return offset ? [] : [{ name: 'Only', value: 'only' }];
  } }, { input, output });
  await tick();
  input.write('\x1b[B');
  await tick();
  input.write('\x1b[B\r');
  assert.equal((await pending).value, 'only');
  assert.deepEqual(offsets, [0, 1]);
});
test('narrow terminal redraw erases wrapped rows, not only explicit lines', async () => {
  const input = new PassThrough(), output = new PassThrough();
  output.isTTY = true;
  output.columns = 3;
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const pending = runPrompt({}, { input, output }, {
    init: () => ({}), render: () => ['abcdef', 'x'],
    key: (_state, key, api) => {
      if (key.name === 'return') return { done: true };
      api.redraw();
    },
  });
  input.write('q\r');
  assert.equal(await pending, true);
  assert.ok(text.includes('\x1b[3A\x1b[0J'));
});
