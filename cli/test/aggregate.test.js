import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands, findCommand, wrapHandler } from './support/command-test-helpers.js';
import { makeApp } from './support/app-test-helpers.js';

describe('Aggregate API', () => {
  it('builds a grouped Stats API request', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://dev.example.service-now.com', {});
    let call;
    client.request = async (endpoint, options) => {
      call = { endpoint, options };
      return { result: { stats: [{ count: '3', priority: '1' }] } };
    };

    const result = await client.aggregate('incident', {
      query: 'active=true',
      groupBy: ['priority', 'state'],
      count: true,
      averageFields: ['response_time'],
      orderBy: 'priority',
    });

    assert.deepStrictEqual(result, { stats: [{ count: '3', priority: '1' }] });
    const url = new URL(call.endpoint);
    assert.strictEqual(url.pathname, '/api/now/stats/incident');
    assert.strictEqual(url.searchParams.get('sysparm_query'), 'active=true');
    assert.strictEqual(url.searchParams.get('sysparm_group_by'), 'priority,state');
    assert.strictEqual(url.searchParams.get('sysparm_count'), 'true');
    assert.strictEqual(url.searchParams.get('sysparm_avg_fields'), 'response_time');
    assert.strictEqual(url.searchParams.get('sysparm_order_by'), 'priority');
    assert.strictEqual(call.options.method, 'GET');
  });

  it('normalizes numeric-keyed grouped responses into groups', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://dev.example.service-now.com', {});
    client.request = async () => ({ result: {
      '1': { stats: { count: '2' }, groupby_fields: [{ field: 'priority', value: '2' }] },
      '0': { stats: { count: '3' }, groupby_fields: [{ field: 'priority', value: '1' }] },
    } });
    const result = await client.aggregate('incident', { groupBy: ['priority'] });
    assert.deepStrictEqual(result.groups.map(g => g.stats.count), ['3', '2']);
  });

  it('passes a per-call timeout through aggregateCount', async () => {
    const { SDKClient } = await import('../src/sdk.js');
    const client = new SDKClient('https://dev.example.service-now.com', {});
    let call;
    client.request = async (endpoint, options) => {
      call = { endpoint, options };
      return { result: { stats: { count: '42' } } };
    };

    const result = await client.aggregateCount('task', '', { timeout: 120000 });

    assert.strictEqual(result, 42);
    assert.strictEqual(call.options.timeout, 120000);
  });

  it('exposes records aggregate as a grouped command', async () => {
    const { recordsCmd } = await import('../src/commands/records.js');
    const cmd = recordsCmd(wrapHandler);
    const aggregate = findCommand(captureSubcommands(cmd), 'aggregate');
    assert.ok(aggregate, 'aggregate subcommand exists');

    const sdk = {
      aggregate: async (table, options) => {
        assert.strictEqual(table, 'incident');
        assert.deepStrictEqual(options.groupBy, ['priority', 'state']);
        return { stats: [{ count: '3' }] };
      },
    };
    const app = makeApp({ sdk });
    await aggregate.handler({ app, table: 'incident', query: 'active=true', 'group-by': 'priority,state', count: true });
    assert.deepStrictEqual(app.lastOk.data.stats, [{ count: '3' }]);
    assert.deepStrictEqual(app.lastOk.data.group_by, ['priority', 'state']);
  });
});
