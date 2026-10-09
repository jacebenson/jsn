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

describe('platform stats XML collector', () => {
  it('extracts only allowlisted stats and marks missing fields unavailable', async () => {
    const { parsePlatformStatsXml } = await import('../src/commands/platform.js');
    const xml = `<?xml version="1.0"?><xmlstats>
      <cluster.status><node><status>Ready</status><node_type><name>app</name></node_type></node></cluster.status>
      <queue.length>3</queue.length><queue.age>42</queue.age>
      <servlet.active.sessions>7</servlet.active.sessions>
      <memory_pressure>NOMINAL</memory_pressure>
      <semaphores available="16" borrowed="2" maximum_concurrency="16" queue_depth="4" name="Default"/>
      <servlet.metrics><all_transactions><daily count="100" mean="24.5" median="16" ninetypercent="30" max="900"/></all_transactions></servlet.metrics>
      <hostname>secret.example.com</hostname><system_id>full-node-id</system_id>
    </xmlstats>`;
    const result = parsePlatformStatsXml(xml);

    assert.deepStrictEqual(result.node, {
      status: { value: 'Ready', availability: 'available' },
      type: { value: 'app', availability: 'available' },
    });
    assert.deepStrictEqual(result.queue.length, { value: 3, availability: 'available' });
    assert.deepStrictEqual(result.queue.age, { value: 42, availability: 'available' });
    assert.deepStrictEqual(result.active_sessions, { value: 7, availability: 'available' });
    assert.deepStrictEqual(result.memory_pressure, { value: 'NOMINAL', availability: 'available' });
    assert.deepStrictEqual(result.semaphores[0].available, { value: 16, availability: 'available' });
    assert.deepStrictEqual(result.transactions.daily.count, { value: 100, availability: 'available' });
    assert.deepStrictEqual(result.transactions.daily.mean, { value: 24.5, availability: 'available' });
    assert.strictEqual(result.semaphores[0].name, 'Default');
    assert.deepStrictEqual(result.unavailable, []);
    assert.strictEqual(JSON.stringify(result).includes('secret.example.com'), false);
    assert.strictEqual(JSON.stringify(result).includes('full-node-id'), false);
  });

  it('reports missing allowlisted metrics as unavailable instead of zero', async () => {
    const { parsePlatformStatsXml } = await import('../src/commands/platform.js');
    const result = parsePlatformStatsXml('<xmlstats><queue.length>0</queue.length></xmlstats>');
    assert.deepStrictEqual(result.queue.length, { value: 0, availability: 'available' });
    assert.deepStrictEqual(result.queue.age, { value: null, availability: 'unavailable' });
    assert.ok(result.unavailable.includes('node.status'));
    assert.ok(result.unavailable.includes('transactions.daily.count'));
  });

  it('rejects malformed XML', async () => {
    const { parsePlatformStatsXml } = await import('../src/commands/platform.js');
    assert.throws(() => parsePlatformStatsXml('<xmlstats><queue.length>1</xmlstats>'), /malformed XML/i);
  });

  it('classifies bounded response, HTML redirect, and permission responses', async () => {
    const { collectPlatformStats, formatPlatformStats, XMLSTATS_MAX_BYTES } = await import('../src/commands/platform.js');
    const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });
    const success = await collectPlatformStats({ fetchResponse: async () => response('<xmlstats></xmlstats>', 200, { 'content-type': 'text/xml' }) }, 'https://example.service-now.com');
    assert.strictEqual(success.status, 'partial');

    const html = await collectPlatformStats({ fetchResponse: async () => response('<html>login</html>', 200, { 'content-type': 'text/html' }) }, 'https://example.service-now.com');
    assert.strictEqual(html.status, 'login_redirect');

    const forbidden = await collectPlatformStats({ fetchResponse: async () => response('', 403) }, 'https://example.service-now.com');
    assert.strictEqual(forbidden.status, 'permission_denied');

    const tooLarge = await collectPlatformStats({ fetchResponse: async () => response('x'.repeat(XMLSTATS_MAX_BYTES + 1), 200, { 'content-type': 'text/xml' }) }, 'https://example.service-now.com');
    assert.strictEqual(tooLarge.status, 'too_large');

    const timeout = await collectPlatformStats({ fetchResponse: async () => { throw new Error('request timeout'); } }, 'https://example.service-now.com');
    assert.strictEqual(timeout.status, 'timeout');
    assert.match(formatPlatformStats(timeout), /STATUS: timeout/);
  });
});

describe('platform stats command', () => {
  it('uses fixed GET, preserves the envelope, and is read-only', async () => {
    const { platformCmd } = await import('../src/commands/platform.js');
    const { collectCapabilities, mutationPaths } = await import('../src/capabilities.js');
    const calls = [];
    const app = {
      sdk: { fetchResponse: async (...args) => { calls.push(args); return new Response('<xmlstats></xmlstats>', { headers: { 'content-type': 'text/xml' } }); } },
      getEffectiveInstance: () => 'https://example.service-now.com',
      requireInstance: () => {},
      ok: (data, opts) => { app.result = { data, opts }; },
    };
    const commands = [];
    const root = platformCmd((fn) => async (argv) => fn(argv, argv.app));
    root.builder({ command(definition) { commands.push(definition); return this; } });
    const stats = commands.find((command) => command.command === 'stats');
    assert.ok(stats);
    await stats.handler({ app });

    assert.strictEqual(calls[0][0], 'https://example.service-now.com/xmlstats.do');
    assert.strictEqual(calls[0][1].method, 'GET');
    assert.strictEqual(calls[0][0].includes('?'), false);
    assert.strictEqual(app.result.data.status, 'partial');
    assert.strictEqual(collectCapabilities().get('platform').mutationSubcommands.length, 0);
    assert.ok(!mutationPaths().some((path) => path[0] === 'platform' && path[1] === 'stats'));
  });
});
