import { describe, it } from 'node:test';
import assert from 'node:assert';

function buildApp(sdk) {
  const app = {
    sdk,
    requireInstance() {},
    getEffectiveInstance: () => 'https://dev.example.service-now.com',
    ok: (data, opts) => { app.lastOk = { data, opts }; },
  };
  return app;
}

describe('transactions command', () => {
  it('classifies known transaction types conservatively', async () => {
    const { classifyTransactionType } = await import('../src/commands/transactions.js');
    assert.strictEqual(classifyTransactionType('rest'), 'api');
    assert.strictEqual(classifyTransactionType('batch_rest'), 'api');
    assert.strictEqual(classifyTransactionType('form'), 'ui');
    assert.strictEqual(classifyTransactionType('list'), 'ui');
    assert.strictEqual(classifyTransactionType('scheduler'), 'job');
    assert.strictEqual(classifyTransactionType('other'), 'unknown');
    assert.strictEqual(classifyTransactionType('', 'JOB: Clean logs'), 'job');
  });

  it('expands a date-only equality to the complete UTC day', async () => {
    const { normalizeTransactionQuery } = await import('../src/commands/transactions.js');
    assert.strictEqual(
      normalizeTransactionQuery('sys_created_on=2026-08-25'),
      'sys_created_on>=2026-08-25^sys_created_on<2026-08-26',
    );
  });

  it('uses a safe one-day window when no query is supplied', async () => {
    const { transactionsCmd } = await import('../src/commands/transactions.js');
    let call;
    const sdk = { aggregate: async (table, options) => {
      call = { table, options };
      return { groups: [] };
    } };
    const app = buildApp(sdk);
    const command = transactionsCmd((fn) => fn);
    await command.handler({ app }, app);

    assert.strictEqual(call.table, 'syslog_transaction');
    assert.strictEqual(call.options.query, 'sys_created_on>=javascript:gs.daysAgoStart(1)');
    assert.strictEqual(app.lastOk.data.query, call.options.query);
  });

  it('provides a compact human-readable table', async () => {
    const { transactionsCmd } = await import('../src/commands/transactions.js');
    const sdk = { aggregate: async () => ({ groups: [{
      stats: { count: '10', avg: { response_time: '73.5' }, min: { response_time: '9' }, max: { response_time: '236659' } },
      groupby_fields: [{ field: 'type', value: 'rest' }],
    }] }) };
    const app = buildApp(sdk);
    const command = transactionsCmd((fn) => fn);
    await command.handler({ app, query: 'sys_created_on=2026-08-25' }, app);

    assert.match(app.lastOk.data._formatted, /CLASS\s+TYPE/);
    assert.match(app.lastOk.data._formatted, /api\s+rest/);
    assert.match(app.lastOk.data._formatted, /73\.5 ms/);
  });

  it('queries syslog_transaction by type and reports latency fields', async () => {
    const { transactionsCmd } = await import('../src/commands/transactions.js');
    let call;
    const sdk = {
      aggregate: async (table, options) => {
        call = { table, options };
        return { groups: [{
          stats: { count: '10', avg: { response_time: '73.5' }, min: { response_time: '9' }, max: { response_time: '236659' } },
          groupby_fields: [{ field: 'type', value: 'rest' }],
        }] };
      },
    };
    const app = buildApp(sdk);
    const command = transactionsCmd((fn) => fn);
    await command.handler({ app, query: 'sys_created_on>=2026-01-01^sys_created_on<=2026-01-07' }, app);

    assert.strictEqual(call.table, 'syslog_transaction');
    assert.deepStrictEqual(call.options.groupBy, ['type']);
    assert.deepStrictEqual(call.options.averageFields, ['response_time']);
    assert.strictEqual(app.lastOk.data.types[0].class, 'api');
    assert.strictEqual(app.lastOk.data.types[0].avg_response_time_ms, 73.5);
    assert.strictEqual(app.lastOk.data.types[0].max_response_time_ms, 236659);
  });

  it('builds bounded Client Transaction Timings groups with filters and unavailable metrics', async () => {
    const { topTransactionsCmd } = await import('../src/commands/transactions.js');
    let call;
    const sdk = {
      aggregate: async (table, options) => {
        call = { table, options };
        return { groups: [{
          stats: { count: '12', avg: { response_time: '41.5' }, max: { response_time: '99' } },
          groupby_fields: [
            { field: 'type', value: 'form' },
            { field: 'table', value: 'incident' },
            { field: 'view', value: 'ess' },
          ],
        }, {
          stats: { count: '2' },
          groupby_fields: [{ field: 'type', value: 'list' }],
        }] };
      },
    };
    const app = buildApp(sdk);
    await topTransactionsCmd((fn) => fn).handler({
      type: 'form', table: 'incident', view: 'ess', query: 'active=true', limit: 1, window: 2, app,
    }, app);

    assert.equal(call.table, 'syslog_transaction');
    assert.deepEqual(call.options.groupBy, ['type', 'table', 'view']);
    assert.match(call.options.query, /active=true/);
    assert.match(call.options.query, /sys_created_on>=javascript:gs.daysAgoStart\(2\)/);
    assert.equal(app.lastOk.data.groups.length, 1);
    assert.equal(app.lastOk.data.groups[0].count, 12);
    assert.equal(app.lastOk.data.groups[0].min_response_time_ms, null);
    assert.match(app.lastOk.data._formatted, /TYPE\s+TABLE\s+VIEW/);
  });
});
