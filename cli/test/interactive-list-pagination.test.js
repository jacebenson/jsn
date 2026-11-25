import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { interactiveList } from '../src/helpers.js';
import { paginatedSearch } from '../src/paginated-search.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({ sys_id: id, name: `Row ${id}` });

for (const code of ['mfa_required', 'mfa_code_rejected']) {
  test(`interactiveList source preserves terminal ${code} identity and metadata`, async () => {
    const failure = Object.assign(new Error('Authentication stopped'), { code, notSent: true });
    const app = {
      requireInstance() {}, output: { getFormat: () => 'auto' },
      sdk: { aggregateCount: async () => 1, list: async () => { throw failure; } },
    };
    await assert.rejects(interactiveList({ app, table: 'test_table', singular: 'record', columns: ['name'],
      promptFn: config => config.source(undefined, 0, {}) }), error => error === failure);
  });
}

test('interactiveList rejects malformed page responses instead of reporting measured emptiness', async () => {
  const app = {
    requireInstance() {}, output: { getFormat: () => 'auto' },
    sdk: { aggregateCount: async () => 1, list: async () => ({ error: 'not a page' }) },
  };
  await assert.rejects(interactiveList({ app, table: 'test_table', singular: 'record', columns: ['name'],
    promptFn: config => config.source(undefined, 0, {}) }), /list returned a non-array result/);
});

for (const unknownCount of [false, true]) {
  test(`interactiveList retries failed pages and stops only at measured empty (unknown count: ${unknownCount})`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    let visible = '';
    output.on('data', chunk => { visible += chunk; });
    const offsets = [];
    let failed = false;
    const app = {
      requireInstance() {}, output: { getFormat: () => 'auto' },
      sdk: {
        aggregateCount: async () => {
          if (unknownCount) throw new Error('count unavailable');
          return 99;
        },
        list: async (table, params) => {
          assert.equal(table, 'test_table');
          assert.equal(params.get('sysparm_display_value'), 'all');
          // Existing bounded emptiness probe after an aggregate failure.
          if (params.get('sysparm_fields') === 'sys_id') {
            assert.equal(params.get('sysparm_query'), 'active=true');
            return [row('probe')];
          }
          assert.equal(params.get('sysparm_query'), 'active=true^ORDERBYDESCsys_updated_on');
          assert.equal(params.get('sysparm_limit'), '1');
          const offset = Number(params.get('sysparm_offset'));
          offsets.push(offset);
          if (offset === 1 && !failed) { failed = true; throw new Error('transient page failure'); }
          return offset < 2 ? [row(String(offset))] : [];
        },
      },
    };
    const pending = interactiveList({ app, table: 'test_table', singular: 'record', columns: ['name'], limit: 1,
      query: 'active=true', promptFn: config => paginatedSearch(config, { input, output }) });
    await tick();
    input.write('\x1b[B');
    await tick();
    assert.match(visible, /transient page failure/);
    assert.match(visible.split('Search: ').at(-1), /load more/);
    assert.doesNotMatch(visible.split('Search: ').at(-1), /No matches/);
    input.write('\x1b[B');
    await tick();
    assert.deepEqual(offsets, [0, 1, 1]);
    assert.match(visible.split('Search: ').at(-1), /❯ Row 1/);
    input.write('\x1b[B');
    await tick();
    assert.deepEqual(offsets, [0, 1, 1, 2]);
    assert.doesNotMatch(visible.split('Search: ').at(-1), /load more/);
    input.write('\x1b[B\r');
    assert.deepEqual(await pending, row('1'));
    assert.deepEqual(offsets, [0, 1, 1, 2]);
  });
}
