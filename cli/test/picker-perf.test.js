// Issue #624: the interactive record picker must not serialize the total
// count in front of the first page, and search-as-you-type must not issue one
// request per keystroke. Dedup/ordering guarantees (stale tokens) and the
// "failed count is unknown, never zero" contract stay intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { interactiveList } from '../src/helpers.js';
import { paginatedSearch } from '../src/paginated-search.js';

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
// Longer than the production debounce window (200ms) with room for CI jitter.
const afterDebounce = () => tick(300);

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let visible = '';
  output.on('data', chunk => { visible += chunk; });
  return { input, output, visible: () => visible, lastFrame: () => visible.split('Search: ').at(-1) };
}

const row = id => ({ sys_id: id, name: `Row ${id}` });
const choice = term => ({ name: term ?? 'initial', value: term ?? 'initial' });

// Baseline request count for the rapid-typing case below: the picker issued
// the initial page plus one request per keystroke (1 + 5 = 6). Debounced, the
// same input issues the initial page plus one request for the final term (2).

test('rapid typing inside the debounce window issues one search request, for the final term', async () => {
  const io = terminal();
  const terms = [];
  const pending = paginatedSearch({
    message: 'Find',
    source: term => {
      terms.push(term ?? '');
      return [choice(term)];
    },
  }, io);
  await tick();
  assert.deepEqual(terms, [''], 'the initial page is not debounced');

  io.input.write('abcde');
  await tick(100); // still inside the window
  assert.deepEqual(terms, [''], 'no request while the user is still typing');
  await afterDebounce();
  assert.deepEqual(terms, ['', 'abcde'], 'one request for the final term, not five');

  io.input.write('\r');
  assert.equal((await pending).value, 'abcde');
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('clearing the term loads the unfiltered page immediately and drops the debounced search', async () => {
  const io = terminal();
  const terms = [];
  const pending = paginatedSearch({
    message: 'Find',
    source: term => {
      terms.push(term ?? '');
      return [choice(term)];
    },
  }, io);
  await tick();
  assert.deepEqual(terms, ['']);

  io.input.write('abc');
  await tick(50); // inside the window: 'abc' must still be pending
  io.input.write('\x7f\x7f\x7f');
  await tick(75); // well under the debounce window
  assert.deepEqual(terms, ['', ''], 'clearing loads the unfiltered page right away');

  await afterDebounce();
  assert.deepEqual(terms, ['', ''], 'the cancelled "abc" request never fires');

  io.input.write('\r');
  assert.equal((await pending).value, 'initial');
});

test('closing the picker clears a pending debounce so nothing fires afterwards', async () => {
  const io = terminal();
  const terms = [];
  const pending = paginatedSearch({
    message: 'Find',
    source: term => {
      terms.push(term ?? '');
      return [choice(term)];
    },
  }, io);
  await tick();

  io.input.write('abc');
  await tick(50); // pending debounce
  io.input.write('\u0003'); // Ctrl+C closes the picker immediately
  await assert.rejects(pending, { name: 'PromptCancelled' });
  await afterDebounce();
  assert.deepEqual(terms, [''], 'no request may fire after the picker closed');
});

test('a superseded slow response cannot overwrite the newer filtered page', async () => {
  const io = terminal();
  let releaseOld;
  const pending = paginatedSearch({
    message: 'Find',
    source: term => {
      if (term === 'a') return new Promise(resolve => { releaseOld = resolve; });
      return [{ name: term ?? 'initial', value: term ?? 'initial' }];
    },
  }, io);
  await tick();
  io.input.write('a');
  await afterDebounce();
  assert.equal(typeof releaseOld, 'function', 'the older term issued its request');

  io.input.write('b');
  await afterDebounce();
  releaseOld([{ name: 'stale-a', value: 'stale-a' }]);
  await tick(40);
  assert.match(io.lastFrame(), /❯ ab/);
  assert.doesNotMatch(io.lastFrame(), /stale-a/);

  io.input.write('\r');
  assert.equal((await pending).value, 'ab');
});

function listReturns(rows, onCall = () => {}) {
  return async (table, params) => {
    onCall(table, params);
    return rows;
  };
}

function pickerApp(sdk) {
  return { requireInstance() {}, output: { getFormat: () => 'auto' }, sdk };
}

test('interactiveList renders the first page while a delayed count is in flight, then shows the total', async () => {
  const io = terminal();
  let resolveCount;
  let pages = 0;
  const app = pickerApp({
    aggregateCount: () => new Promise(resolve => { resolveCount = resolve; }),
    list: listReturns([row('1'), row('2')], () => { pages += 1; }),
  });

  const pending = interactiveList({
    app, table: 'incident', singular: 'incident', columns: ['name'],
    promptFn: (config, context = {}) => paginatedSearch(config, { ...io, ...context }),
  });

  await tick(60);
  assert.equal(pages, 1, 'the first page was requested without the count');
  assert.match(io.visible(), /Row 1/, 'the page rendered while the count is still in flight');
  assert.doesNotMatch(io.visible(), /of 25/, 'no invented total before a measurement');

  resolveCount(25);
  await tick(40);
  assert.match(io.visible(), /\(2 of 25 loaded\)/, 'the measured total appears once it lands');

  io.input.write('\r');
  assert.deepEqual(await pending, row('1'));
});

test('a delayed failed count stays unknown and never becomes a zero/empty report', async () => {
  const io = terminal();
  let rejectCount;
  let probeCalls = 0;
  const app = pickerApp({
    aggregateCount: () => new Promise((_resolve, reject) => { rejectCount = reject; }),
    list: async (table, params) => {
      // The existing bounded emptiness probe after a failed aggregate.
      if (params.get('sysparm_fields') === 'sys_id') {
        probeCalls += 1;
        return [row('probe')];
      }
      return [row('1'), row('2')];
    },
  });

  let promptConfig;
  const pending = interactiveList({
    app, table: 'incident', singular: 'incident', columns: ['name'],
    promptFn: (config, context = {}) => {
      promptConfig = config;
      return paginatedSearch(config, { ...io, ...context });
    },
  });

  await tick(60);
  assert.match(io.visible(), /Row 1/);
  rejectCount(new Error('synthetic 403'));
  await tick(60);

  assert.equal(probeCalls, 1, 'the bounded emptiness probe still runs after the failure');
  assert.equal(promptConfig.totalCount, null, 'a failed count is unknown (null), never 0');
  assert.doesNotMatch(io.visible(), /\(0 of 0 loaded\)/);
  assert.doesNotMatch(io.visible(), /No matches/);

  io.input.write('\r');
  assert.deepEqual(await pending, row('1'));
});

test('a count that measures zero after the picker opened closes it as empty', async () => {
  const io = terminal();
  let resolveCount;
  const app = pickerApp({
    aggregateCount: () => new Promise(resolve => { resolveCount = resolve; }),
    list: listReturns([]),
  });

  const pending = interactiveList({
    app, table: 'incident', singular: 'incident', columns: ['name'],
    promptFn: (config, context = {}) => paginatedSearch(config, { ...io, ...context }),
  });
  await tick(40);
  resolveCount(0);
  assert.equal(await pending, null);
});

test('a delayed terminal auth failure surfaces instead of an empty result', async () => {
  const io = terminal();
  let rejectCount;
  const app = pickerApp({
    aggregateCount: () => new Promise((_resolve, reject) => { rejectCount = reject; }),
    list: async () => [row('1')],
  });

  const pending = interactiveList({
    app, table: 'incident', singular: 'incident', columns: ['name'],
    promptFn: (config, context = {}) => paginatedSearch(config, { ...io, ...context }),
  });
  await tick(40);
  const mfa = Object.assign(new Error('mfa required'), { code: 'mfa_required' });
  rejectCount(mfa);
  await assert.rejects(pending, error => error === mfa);
  assert.equal(io.input.listenerCount('keypress'), 0);
});
