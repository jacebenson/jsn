// Pre-fix regression: imports ONLY pre-existing modules and drives an existing
// public entrypoint (`records list` handler). On the base commit this file must
// fail by assertion (the unsupported operator is sent to ServiceNow), never by
// a missing-module error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsCmd } from '../src/commands/records.js';

const id = letter => letter.repeat(32);

function fixture() {
  const commands = [];
  const builder = { command(entry) { commands.push(entry); return this; } };
  recordsCmd(fn => fn).builder(builder);
  const handler = commands.find(entry => entry.command === 'list').handler;
  const recordReads = [];
  let data;
  const sdk = {
    username: 'alice',
    async list(table, params) {
      if (table === 'sys_db_object') {
        const query = params.get('sysparm_query');
        if (query === 'name=incident') return [{ sys_id: id('a'), name: 'incident', super_class: '' }];
        return [];
      }
      if (table === 'sys_dictionary') {
        return [
          { sys_id: id('b'), name: 'incident', element: 'active', internal_type: 'boolean', reference: '' },
          { sys_id: id('c'), name: 'incident', element: 'short_description', internal_type: 'string', reference: '' },
        ];
      }
      recordReads.push(Object.fromEntries(params));
      return [{ sys_id: id('d'), number: 'INC0001' }];
    },
    aggregateCount: async () => 1,
  };
  const app = {
    sdk,
    session: { username: 'alice', profileName: 'work' },
    config: { activeProfile: 'work', defaultProfile: 'work', profiles: {} },
    getEffectiveInstance: () => 'https://dev1.service-now.com',
    requireInstance() {},
    ok(value) { data = value; },
    output: { getFormat: () => 'json' },
  };
  return { app, recordReads, get data() { return data; },
    run: (query) => handler({ table: 'incident', query, limit: 5, offset: 0 }, app) };
}

test('records list rejects an operator typo instead of returning a broad false success', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.run('short_descriptionSTARTWITHprinter'),
    error => /validation state is invalid/.test(error?.message || ''));
  assert.equal(f.data, undefined, 'no success payload may be emitted');
  assert.deepEqual(f.recordReads, [], 'the invalid filter must never reach the Table API');
});

test('records list still returns data for a legitimate query', async () => {
  const f = fixture();
  await f.run('active=true');
  assert.equal(f.data.count, 1);
  assert.equal(f.recordReads.length, 1);
  assert.equal(f.recordReads[0].sysparm_query, 'active=true');
});
