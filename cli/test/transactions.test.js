import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackCredentialArgs, loopbackFixtureEnv } from './support/loopback-credential-fixture.mjs';

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

const EXEC = 'e'.repeat(32);
const pair = (value, display = value) => ({ value, display_value: display });
const activeRow = (n, extra = {}) => ({ session_id: pair(`S${n}`), transaction_id: pair(`t${n}`), node_id: pair('app1.example:node001'), user: pair('admin'), url: pair(`/api/now/table/t${n}`), type: pair('rest', 'REST'), age: pair('1970-01-01 00:01:25', '1 Minute'), business_rule: pair(''), query: pair(''), query_count: pair('12'), db_time: pair('1970-01-01 00:00:02', '2 Seconds'), br_time: pair('1970-01-01 00:00:00', '0 Seconds'), acl_time: pair('1970-01-01 00:00:00', '0 Seconds'), uncancelable: pair('false'), ...extra });
function activeSdk({ html = `<script>var executionID = '${EXEC}';</script>`, trackers = [[{ parent: pair(EXEC), name: pair('Updating Active Transactions in Node app1.example:node001'), state: pair('2', 'Successful') }]], rows = [activeRow(1)], raw } = {}) {
  const calls = [];
  let polls = 0;
  return { calls, baseURL: 'https://dev.example.service-now.com', _warmSession: async () => 'JSESSIONID=fixture',
    rawRequest: async (url, opts) => { calls.push({ url, opts }); if (raw) throw raw; return html; },
    listStrict: async (table, params, opts) => { calls.push({ table, params, opts }); return table === 'sys_execution_tracker' ? trackers[Math.min(polls++, trackers.length - 1)] : rows; } };
}

describe('transactions active', () => {
  it('refreshes every node like the module, then reads v_cluster_transaction in that session with the filters', async () => {
    const { listActiveTransactions, ACTIVE_FIELDS } = await import('../src/active-transactions.js');
    const sdk = activeSdk({ rows: [activeRow(1), activeRow(2), activeRow(3)] });
    const result = await listActiveTransactions(sdk, { 'older-than': '5m', user: 'admin', type: 'REST', limit: 2 }, { sleep: async () => {} });
    assert.equal(sdk.calls[0].url, 'https://dev.example.service-now.com/loading_transactions.do');
    assert.deepEqual(sdk.calls[0].opts, { method: 'GET', headers: { Cookie: 'JSESSIONID=fixture' } });
    assert.equal(sdk.calls[1].table, 'sys_execution_tracker');
    assert.equal(sdk.calls[1].params.get('sysparm_query'), `parent=${EXEC}`);
    const read = sdk.calls[2];
    assert.equal(read.table, 'v_cluster_transaction');
    assert.deepEqual(read.opts, { stateful: true });
    assert.equal(read.params.get('sysparm_query'), 'session_idNSAMEASsnapshot_id^age>=1970-01-01 00:05:00^user=admin^type=rest^ORDERBYDESCage');
    assert.equal(read.params.get('sysparm_fields'), ACTIVE_FIELDS);
    assert.equal(read.params.get('sysparm_display_value'), 'all');
    assert.equal(read.params.get('sysparm_limit'), '3');
    assert.equal(sdk.calls.length, 3);
    assert.equal(result.count, 2);
    assert.equal(result.pagination.has_more, true);
    assert.deepEqual(result.refresh, { execution_id: EXEC, complete: true, nodes: [{ name: 'Updating Active Transactions in Node app1.example:node001', state: 'Successful' }] });
  });

  it('rejects bad filters before any request', async () => {
    const { listActiveTransactions } = await import('../src/active-transactions.js');
    for (const argv of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { 'older-than': 'soon' }, { 'older-than': '0' }, { 'older-than': '31d' }, { user: 'admin^ORuser=guest' }, { user: '' }, { type: 'rest^ORtype=form' }]) {
      const sdk = activeSdk();
      await assert.rejects(listActiveTransactions(sdk, argv), { code: 'usage_error' }, JSON.stringify(argv));
      assert.equal(sdk.calls.length, 0, JSON.stringify(argv));
    }
  });

  it('waits for other nodes, then reports the ones that never answered', async () => {
    const { listActiveTransactions } = await import('../src/active-transactions.js');
    const pending = [{ parent: pair(EXEC), name: pair('Node B'), state: pair('1', 'Running') }];
    let sleeps = 0;
    const settled = await listActiveTransactions(activeSdk({ trackers: [pending, [{ ...pending[0], state: pair('2', 'Successful') }]] }), {}, { sleep: async () => { sleeps++; } });
    assert.equal(settled.refresh.complete, true);
    assert.equal(sleeps, 1);
    sleeps = 0;
    const stuck = await listActiveTransactions(activeSdk({ trackers: [pending] }), {}, { sleep: async () => { sleeps++; } });
    assert.equal(sleeps, 35);
    assert.equal(stuck.refresh.complete, false);
    assert.match(stuck.refresh.warning, /1 node\(s\) did not report/);
    assert.equal(stuck.records.length, 1);
  });

  it('never reports a refused, partial or malformed refresh as a complete listing', async () => {
    const { listActiveTransactions } = await import('../src/active-transactions.js');
    const login = activeSdk({ html: '<html>login.do</html>' });
    await assert.rejects(listActiveTransactions(login, {}), /needs the admin role/);
    assert.equal(login.calls.length, 1);
    const redirected = activeSdk({ raw: Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }) });
    await assert.rejects(listActiveTransactions(redirected, {}), /redirected the Active Transactions refresh/);
    const localOnly = await listActiveTransactions(activeSdk({ html: "var executionID = 'null';" }), {});
    assert.equal(localOnly.refresh.complete, false);
    assert.match(localOnly.refresh.warning, /only this node/);
    const foreign = await listActiveTransactions(activeSdk({ trackers: [[{ parent: pair('f'.repeat(32), EXEC), name: pair('Other'), state: pair('2') }]] }), {});
    assert.equal(foreign.refresh.complete, false);
    assert.match(foreign.refresh.warning, /not readable/);
    await assert.rejects(listActiveTransactions(activeSdk({ rows: ['bad'] }), {}), /Malformed table response for v_cluster_transaction/);
  });

  it('formats one line a transaction with its business rule, SQL and uncancelable mark', async () => {
    const { formatActiveTransactions } = await import('../src/active-transactions.js');
    const text = formatActiveTransactions({ refresh: { warning: 'Only this node.' }, count: 1, pagination: { has_more: true }, records: [activeRow(1, { business_rule: pair('Properties change'), query: pair('SELECT  a\n FROM b'), uncancelable: pair('true'), age: pair('1970-01-01 04:02:09', '4 Hours 2 Minutes') })] });
    assert.match(text, /^Warning: Only this node\.\nAGE\s+USER\s+TYPE\s+NODE\s+SQLS\s+DB\s+BR\s+ACL\s+SESSION\s+URL\n4h02m\s+admin\s+REST\s+node001\s+12\s+2s\s+0s\s+0s\s+S1\s+\/api\/now\/table\/t1 {2}\(uncancelable\)\n/);
    assert.match(text, /\n {8}business rule: Properties change\n {8}sql: SELECT a FROM b\n/);
    assert.match(text, /oldest 1 shown; raise --limit/);
    assert.match(formatActiveTransactions({ refresh: {}, count: 0, pagination: {}, records: [] }), /\(no active transactions\)/);
  });

  it('runs through the real CLI on a read-only profile in one session, and rejects bad input with no request', async () => {
    const calls = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query'), cookie: req.headers.cookie || '' });
      if (url.pathname === '/angular.do') { res.setHeader('Set-Cookie', 'JSESSIONID=fixture-session; Path=/'); res.setHeader('Content-Type', 'application/json'); res.end('{"result":{}}'); return; }
      if (url.pathname === '/loading_transactions.do') { res.setHeader('Content-Type', 'text/html'); res.end(`<script>var executionID = '${EXEC}';</script>`); return; }
      const table = url.pathname.split('/').pop();
      const result = table === 'sys_execution_tracker' ? [{ parent: pair(EXEC), name: pair('Node A'), state: pair('2', 'Successful') }] : table === 'v_cluster_transaction' ? [activeRow(1)] : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-transactions-active-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, ...args], { env, cwd: dir, timeout: 20000 });
    try {
      const envelope = JSON.parse((await run(['transactions', 'active', '--older-than', '1m', '--json'])).stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.records[0].session_id.value, 'S1');
      assert.equal(envelope.data.refresh.complete, true);
      assert.equal('_formatted' in envelope.data, false);
      const read = calls.find(call => call.pathname === '/api/now/table/v_cluster_transaction');
      assert.equal(read.query, 'session_idNSAMEASsnapshot_id^age>=1970-01-01 00:01:00^ORDERBYDESCage');
      for (const pathname of ['/loading_transactions.do', '/api/now/table/v_cluster_transaction']) assert.match(calls.find(call => call.pathname === pathname).cookie, /JSESSIONID=fixture-session/, pathname);
      const human = await run(['transactions', 'active', '--format', 'styled']);
      assert.match(human.stdout, /AGE\s+USER[\s\S]*1m25s\s+admin\s+REST/);
      const before = calls.length;
      for (const args of [['--limit', '0'], ['--older-than', 'soon'], ['--user', 'a^ORuser=b'], ['--query', 'type=rest'], ['--typo']]) {
        await assert.rejects(run(['transactions', 'active', ...args, '--json']), undefined, JSON.stringify(args));
      }
      assert.equal(calls.length, before);
      assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
