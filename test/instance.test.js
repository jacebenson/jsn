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

describe('instance glance command', () => {
  it('builds a bounded activity query from dates', async () => {
    const { buildActivityQuery, formatDuration } = await import('../src/commands/instance.js');
    assert.strictEqual(
      buildActivityQuery({ since: '2026-08-25', until: '2026-08-25' }),
      'sys_created_on>=2026-08-25^sys_created_on<2026-08-26',
    );
    assert.strictEqual(buildActivityQuery({}), 'sys_created_on>=javascript:gs.daysAgoStart(1)');
    assert.strictEqual(buildActivityQuery({ query: 'state=WAITING' }), 'state=WAITING');
    assert.strictEqual(formatDuration(40900), '40.9 seconds');
    assert.strictEqual(formatDuration(163800000), '45.5 hours');
  });

  it('formats the report into readable sections', async () => {
    const { formatInstanceGlance } = await import('../src/commands/instance.js');
    const output = formatInstanceGlance({
      window: { since: '2026-08-19', until: '2026-08-25', query: 'sys_created_on>=2026-08-19^sys_created_on<2026-08-26' },
      context: { instance_url: 'https://dev.example.service-now.com' },
      inbound_automation: {
        metrics: [{ label: 'REST transactions', count: 176429 }],
      },
      asynchronous_automation: {
        total_count: 5191,
        states: [{ state: 'COMPLETE', count: 5157 }, { state: 'ERROR', count: 7 }],
        async_business_rules_configured: 94,
        daily_flow_executions: [{ date: '2026-08-19', count: 742 }],
      },
      scheduled_work: {
        scheduled_scripts_configured: 1258,
        scheduler_transactions: 157448,
        scheduler_transaction_time: { avg_ms: 40900, max_ms: 163080000 },
        import_sets: 17,
        import_rows: 13239,
        daily_import_activity: [{ date: '2026-08-19', import_sets: 3, import_rows: 2332 }],
      },
      query_and_security_controls: [{ label: 'Scripted access controls', count: 5552 }],
      data_volume: [{ label: 'Task records', count: 112873293 }],
      transactions: { total_count: 176429, types: [{ type: 'rest', count: 176429, avg_response_time_ms: 40900, max_response_time_ms: 163080000 }] },
    });

    assert.match(output, /1\. INBOUND AUTOMATION/);
    assert.match(output, /REST transactions: 176,429/);
    assert.match(output, /2\. ASYNCHRONOUS AUTOMATION/);
    assert.match(output, /2026-08-19\s+742/);
    assert.match(output, /3\. SCHEDULED WORK/);
    assert.match(output, /Average scheduler transaction time: 40\.9 seconds/);
    assert.match(output, /5\. DATA VOLUME/);
    assert.match(output, /\s+rest\n\s+Count: 176,429\n\s+Average response: 40\.9 seconds\n\s+Maximum response: 45\.3 hours/);
  });

  it('collects the report in parallel and preserves unavailable tables', async () => {
    const { instanceCmd } = await import('../src/commands/instance.js');
    const calls = [];
    const sdk = {
      aggregateCount: async (table, query) => {
        calls.push({ method: 'count', table, query });
        if (table === 'problem') throw new Error('403 forbidden');
        return table === 'task' ? 42 : 2;
      },
      aggregate: async (table, options) => {
        calls.push({ method: 'aggregate', table, options });
        if (table === 'sys_flow_context') return { groups: [
          { groupby_fields: [{ field: 'state', value: 'COMPLETE' }], stats: { count: '7' } },
          { groupby_fields: [{ field: 'state', value: 'ERROR' }], stats: { count: '2' } },
        ] };
        if (!options.groupBy?.length) return { stats: { avg: { response_time: '73.5' }, max: { response_time: '236659' } } };
        return { groups: [{
          groupby_fields: [{ field: 'type', value: 'rest' }],
          stats: { count: '10', avg: { response_time: '73.5' }, max: { response_time: '236659' } },
        }] };
      },
    };
    const app = buildApp(sdk);
    const command = instanceCmd(fn => fn);
    let glance;
    const mockYargs = { command: definition => { glance = definition; return mockYargs; } };
    command.builder(mockYargs);
    await glance.handler({ app, since: '2026-08-25', until: '2026-08-25' }, app);

    assert.strictEqual(app.lastOk.data.window.query, 'sys_created_on>=2026-08-25^sys_created_on<2026-08-26');
    assert.strictEqual(app.lastOk.data.data_volume.find(row => row.label === 'Task records').count, 42);
    assert.strictEqual(app.lastOk.data.data_volume.find(row => row.label === 'Problems').unavailable, '403 forbidden');
    assert.strictEqual(app.lastOk.data.inbound_automation.metrics.find(row => row.label === 'REST transactions').count, 2);
    assert.deepStrictEqual(app.lastOk.data.asynchronous_automation.states, [
      { state: 'COMPLETE', count: 7 },
      { state: 'ERROR', count: 2 },
    ]);
    assert.strictEqual(app.lastOk.data.transactions.types[0].avg_response_time_ms, 73.5);
    assert.strictEqual(app.lastOk.data.scheduled_work.scheduler_transaction_time.avg_ms, 73.5);
    assert.match(app.lastOk.data._formatted, /INSTANCE AT A GLANCE/);
    assert.match(app.lastOk.data._formatted, /Daily flow executions/);
    assert.ok(calls.some(call => call.table === 'syslog_transaction'));
  });

  it('limits data-volume count concurrency and gives those counts more time', async () => {
    const { instanceCmd } = await import('../src/commands/instance.js');
    const dataVolumeTables = new Set(['task', 'incident', 'sc_task', 'sc_req_item', 'sc_request', 'problem', 'change_request', 'cmdb_ci']);
    const calls = [];
    let active = 0;
    let maximum = 0;
    const sdk = {
      aggregateCount: async (table, query, options) => {
        if (dataVolumeTables.has(table) && query === '') {
          calls.push({ table, options });
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
        }
        return 1;
      },
      aggregate: async () => ({ groups: [] }),
    };
    const app = buildApp(sdk);
    const command = instanceCmd(fn => fn);
    let glance;
    const mockYargs = { command: definition => { glance = definition; return mockYargs; } };
    command.builder(mockYargs);

    await glance.handler({ app, daily: false }, app);

    assert.strictEqual(calls.length, dataVolumeTables.size);
    assert.ok(maximum <= 2, `expected at most 2 concurrent data-volume counts, got ${maximum}`);
    assert.ok(calls.every(call => call.options.timeout === 120000));
  });

  it('explains the deadline when a data-volume count times out', async () => {
    const { instanceCmd } = await import('../src/commands/instance.js');
    const sdk = {
      aggregateCount: async (table, query) => {
        if (table === 'cmdb_ci' && query === '') throw new Error('Request timed out');
        return 1;
      },
      aggregate: async () => ({ groups: [] }),
    };
    const app = buildApp(sdk);
    const command = instanceCmd(fn => fn);
    let glance;
    const mockYargs = { command: definition => { glance = definition; return mockYargs; } };
    command.builder(mockYargs);

    await glance.handler({ app, daily: false }, app);

    assert.strictEqual(
      app.lastOk.data.data_volume.find(row => row.label === 'CMDB CI records').unavailable,
      'Request timed out after 120 seconds',
    );
  });
});
