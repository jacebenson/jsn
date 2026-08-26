import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('platform health XML parser', () => {
  it('extracts whitelisted node metrics and excludes sensitive fields', async () => {
    const { parseNodeStatsXml } = await import('../src/commands/platform.js');
    const xml = `<?xml version="1.0"?><xmlstats created="Sat Mar 07 18:22:26 PST 2026">
      <db.url>jdbc:postgresql://secret.example/db</db.url>
      <queue.length>3</queue.length><queue.age>42</queue.age>
      <servlet.active.sessions>7</servlet.active.sessions>
      <memory_pressure>NOMINAL</memory_pressure>
      <semaphores><semaphores name="Default" available="16" borrowed="2" queue_depth="4" queue_depth_limit="150" maximum_concurrency="16"/></semaphores>
      <all_transactions><daily count="100" mean="24.5" median="16" ninetypercent="30" max="900"/></all_transactions>
    </xmlstats>`;
    const result = parseNodeStatsXml(xml);

    assert.strictEqual(result.created, 'Sat Mar 07 18:22:26 PST 2026');
    assert.strictEqual(result.queue.length, 3);
    assert.strictEqual(result.queue.age, 42);
    assert.strictEqual(result.active_sessions, 7);
    assert.strictEqual(result.memory_pressure, 'NOMINAL');
    assert.deepStrictEqual(result.semaphores[0], {
      name: 'Default', available: 16, borrowed: 2, queue_depth: 4,
      queue_depth_limit: 150, maximum_concurrency: 16,
    });
    assert.deepStrictEqual(result.transactions.daily, {
      count: 100, mean: 24.5, median: 16, ninetypercent: 30, max: 900,
    });
    assert.strictEqual(JSON.stringify(result).includes('jdbc'), false);
  });

  it('selects one cluster node by sys_id and supports explicit all-nodes mode', async () => {
    const { selectClusterRows } = await import('../src/commands/platform.js');
    const rows = [
      { sys_id: { value: 'node-1' } },
      { sys_id: { value: 'node-2' } },
    ];

    assert.deepStrictEqual(selectClusterRows(rows, 'node-2', false), [rows[1]]);
    assert.deepStrictEqual(selectClusterRows(rows, undefined, true), rows);
  });
});
