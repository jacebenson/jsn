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

  it('formats one metric per line', async () => {
    const { collectPlatformStats, formatPlatformStats } = await import('../src/commands/platform.js');
    const partial = await collectPlatformStats({ fetchResponse: async () => new Response('<xmlstats></xmlstats>', { headers: { 'content-type': 'text/xml' } }) }, 'https://example.service-now.com');
    const report = formatPlatformStats(partial).split('\n');
    assert.strictEqual(report.length, 9);
    assert.deepStrictEqual(report.slice(0, 3), ['STATUS: partial', 'REASON: some allowlisted metrics were unavailable', 'NODE: unavailable / unavailable']);
    assert.deepStrictEqual(formatPlatformStats({ status: 'timeout', reason: 'request timed out' }).split('\n'), ['STATUS: timeout', 'REASON: request timed out', '']);
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

describe('platform health node reads', () => {
  const clusterRow = (n) => ({
    sys_id: { value: `node-${n}` },
    status: 'Ready',
    node_type: 'app',
    node_stats: { value: `node-${n}` },
  });
  const ids = [1, 2, 3, 4, 5, 6].map(n => `node-${n}`);

  // Counting transport: one cluster list plus one stats read per node. Reads can
  // be given individual latency so completion order differs from request order.
  function healthHarness({ rows, failFor = new Set(), latencyByID = new Map(), latencyMs = 5 }) {
    const requests = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const app = {
      requireInstance: () => {},
      getEffectiveInstance: () => 'https://example.service-now.com',
      sdk: {
        async list(table) {
          requests.push({ kind: 'list', table });
          await wait(latencyMs);
          return rows;
        },
        async get(table, sysID) {
          requests.push({ kind: 'get', table, sysID });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await wait(latencyByID.get(sysID) ?? latencyMs);
            if (failFor.has(sysID)) throw new Error(`HTTP 503 reading ${sysID}`);
            return { stats: `<xmlstats><queue.length>${sysID.split('-')[1]}</queue.length></xmlstats>` };
          } finally {
            inFlight -= 1;
          }
        },
      },
      ok: (data, opts) => { app.result = { data, opts }; },
    };
    return { app, requests, get maxInFlight() { return maxInFlight; } };
  }

  async function runHealth(app, argv = {}) {
    const { platformCmd } = await import('../src/commands/platform.js');
    const commands = [];
    const root = platformCmd((fn) => async (a) => fn(a, a.app));
    root.builder({ command(definition) { commands.push(definition); return this; } });
    const health = commands.find((command) => command.command === 'health');
    await health.handler({ ...argv, app });
    return app.result;
  }

  it('reads node stats through the bounded pool and keeps cluster row order', async () => {
    // node-1 finishes last, so a completion-ordered implementation would move it.
    const harness = healthHarness({
      rows: [1, 2, 3, 4, 5, 6].map(clusterRow),
      latencyByID: new Map([['node-1', 45]]),
      latencyMs: 8,
    });

    const result = await runHealth(harness.app, { allNodes: true });

    assert.deepEqual(harness.requests.filter(request => request.kind === 'list').map(request => request.table), ['sys_cluster_state']);
    assert.deepEqual(
      harness.requests.filter(request => request.kind === 'get').map(request => request.sysID).sort(),
      [...ids].sort(),
    );
    assert.equal(harness.requests.length, 7, 'one cluster read plus exactly one stats read per node');
    assert.equal(harness.maxInFlight, 4, 'six node reads must never exceed the pool of four');
    assert.equal(result.data.node_count, 6);
    assert.deepEqual(result.data.nodes.map(node => node.sys_id), ids);
    assert.deepEqual(result.data.nodes.map(node => node.stats.queue.length), [1, 2, 3, 4, 5, 6]);
    assert.equal(result.data.stats_unavailable, 0);
    assert.equal(result.opts.summary, 'Platform health: 6 node(s)');
  });

  it('attributes an unreadable node read and still renders every other node', async () => {
    const harness = healthHarness({
      rows: [1, 2, 3, 4, 5, 6].map(clusterRow),
      failFor: new Set(['node-3']),
      latencyMs: 5,
    });

    const result = await runHealth(harness.app, { allNodes: true });

    assert.equal(harness.requests.length, 7);
    assert.deepEqual(result.data.nodes.map(node => node.sys_id), ids);
    assert.equal(result.data.stats_unavailable, 1);
    const failed = result.data.nodes.find(node => node.sys_id === 'node-3');
    assert.equal(failed.stats, null);
    assert.equal(failed.stats_unavailable, true);
    assert.match(failed.stats_error, /HTTP 503 reading node-3/);
    for (const node of result.data.nodes.filter(item => item.sys_id !== 'node-3')) {
      assert.equal(node.stats_unavailable, undefined);
      assert.equal(node.stats.queue.length, Number(node.sys_id.split('-')[1]));
    }
    assert.equal(result.opts.summary, 'Platform health: 6 node(s), 1 with unreadable stats');
    assert.match(result.data._formatted, /⚠ Node stats unreadable for: node-3/);
    assert.equal(result.data._formatted.split('\n').filter(line => line.startsWith('Ready')).length, 6);
  });

  it('keeps the --node selection to one stats read', async () => {
    const harness = healthHarness({ rows: [1, 2, 3].map(clusterRow) });

    const result = await runHealth(harness.app, { node: 'node-2' });

    assert.equal(harness.requests.filter(request => request.kind === 'get').length, 1);
    assert.deepEqual(result.data.nodes.map(node => node.sys_id), ['node-2']);
    assert.equal(result.data.node_count, 1);
  });
});
