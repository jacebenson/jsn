import { describe, it, mock } from 'node:test';
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
    const lines = app.lastOk.data._formatted.split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /^form\s+incident\s+ess\s+12\s/);
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
    assert.match(stuck.refresh.warning, /1 node\(s\) did not report and may be missing \(Node B: Running\)/);
    assert.equal(stuck.records.length, 1);
    sleeps = 0;
    const failed = await listActiveTransactions(activeSdk({ trackers: [[{ ...pending[0], state: pair('3', 'Failed') }, { ...pending[0], name: pair('Node C'), state: pair('') }]] }), {}, { sleep: async () => { sleeps++; } });
    assert.equal(sleeps, 0);
    assert.equal(failed.refresh.complete, false);
    assert.match(failed.refresh.warning, /2 node\(s\) did not report and may be missing \(Node B: Failed; Node C: no state\)/);
  });

  it('never calls an empty list complete unless the session can see its own refresh', async () => {
    const { listActiveTransactions } = await import('../src/active-transactions.js');
    const unseen = activeSdk({ rows: [] });
    const blind = await listActiveTransactions(unseen, { user: 'nobody' }, { sleep: async () => {} });
    assert.equal(blind.refresh.complete, false);
    assert.match(blind.refresh.warning, /not visible to this session/);
    const own = unseen.calls[3];
    assert.equal(own.params.get('sysparm_query'), 'session_idSAMEASsnapshot_id');
    assert.equal(own.params.get('sysparm_limit'), '1');
    assert.deepEqual(own.opts, { stateful: true });
    const seen = activeSdk({ rows: [] });
    const list = seen.listStrict;
    seen.listStrict = async (table, params, opts) => { const rows = await list(table, params, opts); return params.get('sysparm_query') === 'session_idSAMEASsnapshot_id' ? [{ session_id: pair('mine') }] : rows; };
    const empty = await listActiveTransactions(seen, { user: 'nobody' }, { sleep: async () => {} });
    assert.equal(empty.refresh.complete, true);
    assert.equal(empty.count, 0);
    const busy = activeSdk();
    await listActiveTransactions(busy, {}, { sleep: async () => {} });
    assert.equal(busy.calls.length, 3);
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
    const text = formatActiveTransactions({ refresh: { warning: 'Only this node.' }, count: 1, pagination: { limit: 1, has_more: true }, records: [activeRow(1, { business_rule: pair('Properties change'), query: pair('SELECT  a\n FROM b'), uncancelable: pair('true'), age: pair('1970-01-01 04:02:09', '4 Hours 2 Minutes') })] });
    assert.match(text, /^Warning: Only this node\.\nAGE\s+USER\s+TYPE\s+NODE\s+SQLS\s+DB\s+BR\s+ACL\s+SESSION\s+URL\n4h02m\s+admin\s+REST\s+node001\s+12\s+2s\s+0s\s+0s\s+S1\s+\/api\/now\/table\/t1 {2}\(uncancelable\)\n/);
    assert.match(text, /\n {8}business rule: Properties change\n {8}sql: SELECT a FROM b\n/);
    assert.match(text, /oldest 1 shown; raise --limit/);
    assert.match(formatActiveTransactions({ refresh: {}, count: 100, pagination: { limit: 100, has_more: true }, records: [] }), /oldest 100 shown; narrow with --older-than, --user or --type\)/);
    assert.match(formatActiveTransactions({ refresh: {}, count: 0, pagination: {}, records: [] }), /\(no active transactions\)/);
  });

  it('runs through the real CLI on a read-only profile in one session, and rejects bad input with no request', async () => {
    const calls = [];
    let state = '2';
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams.get('sysparm_query'), cookie: req.headers.cookie || '' });
      if (url.pathname === '/angular.do') { res.setHeader('Set-Cookie', 'JSESSIONID=fixture-session; Path=/'); res.setHeader('Content-Type', 'application/json'); res.end('{"result":{}}'); return; }
      if (url.pathname === '/loading_transactions.do') { res.setHeader('Content-Type', 'text/html'); res.end(`<script>var executionID = '${EXEC}';</script>`); return; }
      const table = url.pathname.split('/').pop();
      const result = table === 'sys_execution_tracker' ? [{ parent: pair(EXEC), name: pair('Node A'), state: pair(state) }] : table === 'v_cluster_transaction' ? [activeRow(1)] : [];
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
        await assert.rejects(run(['transactions', 'active', ...args, '--json']), { code: 2 }, JSON.stringify(args));
      }
      assert.equal(calls.length, before);
      const refused = await run(['transactions', 'kill', 'S1', '--yes', '--expect-transaction', 't1', '--json']).then(() => null, error => error);
      assert.match(`${refused.stdout}${refused.stderr}`, /read-only/);
      assert.equal(calls.length, before);
      state = '3';
      assert.equal(JSON.parse((await run(['transactions', 'active', '--json', '--verbose'])).stdout).summary, 'Active transactions: 1; refresh incomplete');
      assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/angular.do'));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function killSdk({ reads = [[activeRow(1, { snapshot_id: pair('ME') })], []], own = [{ session_id: pair('ME') }], pages = [`var executionID = '${EXEC}';`], output = 'JSN_TRANSACTION_KILL:sent', cancellations = [{ cancel_reason: pair('Killed by admin'), cancel_requested_time: pair('2026-11-25 08:00:00'), node_id: pair('app1.example:node001'), session: pair('S1'), transaction_id: pair('t1'), url: pair('/x') }] } = {}) {
  const calls = [];
  let read = 0, page = 0;
  const tracker = [{ parent: pair(EXEC), name: pair('Node A'), state: pair('2', 'Successful') }];
  return { calls, baseURL: 'https://dev.example.service-now.com', _warmSession: async () => 'JSESSIONID=fixture',
    rawRequest: async url => { calls.push({ url }); return pages[Math.min(page++, pages.length - 1)]; },
    listStrict: async (table, params) => { calls.push({ table, query: params.get('sysparm_query') }); return table === 'sys_execution_tracker' ? tracker : table === 'syslog_cancellation' ? cancellations : params.get('sysparm_query') === 'session_idSAMEASsnapshot_id' ? own : reads[Math.min(read++, reads.length - 1)]; },
    executeScript: async (script, scope) => { calls.push({ script, scope }); return output; } };
}
const scripts = sdk => sdk.calls.filter(call => call.script);
const tx = id => id.padEnd(32, '0');

describe('transactions kill', () => {
  it('is a mutation, so read-only profiles refuse it', async () => {
    const { isMutationCommand } = await import('../src/mutations.js');
    await import('../src/commands/transactions.js');
    assert.equal(isMutationCommand({ _: ['transactions', 'kill'] }), true);
    assert.equal(isMutationCommand({ _: ['transactions', 'active'] }), false);
    assert.equal(isMutationCommand({ _: ['transactions'] }), false);
  });

  it('refuses bad, missing, own and uncancelable sessions, and previews without --yes, sending nothing', async () => {
    const { killTransaction, formatKillTransaction } = await import('../src/active-transactions.js');
    for (const session of ['', "S1'", "S1');gs.print('x", 'a^ORsession_id=b', 'x'.repeat(129)]) {
      const sdk = killSdk();
      await assert.rejects(killTransaction(sdk, { session, yes: true, 'expect-transaction': 't1' }), { code: 'usage_error' }, session);
      assert.equal(sdk.calls.length, 0, session);
    }
    const missing = killSdk({ reads: [[]] });
    await assert.rejects(killTransaction(missing, { session: 'S9', yes: true, 'expect-transaction': 't9' }), /not found: S9/);
    const unseen = killSdk({ reads: [[]], own: [] });
    await assert.rejects(killTransaction(unseen, { session: 'S9', yes: true, 'expect-transaction': 't9' }), /S9 was not listed, but the list may be incomplete: The refreshed list was not visible/);
    const own = killSdk({ reads: [[activeRow(1, { session_id: pair('ME'), snapshot_id: pair('ME') })]] });
    await assert.rejects(killTransaction(own, { session: 'ME', yes: true, 'expect-transaction': 't1' }), /its own request/);
    const stuck = killSdk({ reads: [[activeRow(1, { uncancelable: pair('true'), snapshot_id: pair('ME') })]] });
    await assert.rejects(killTransaction(stuck, { session: 'S1', yes: true, 'expect-transaction': 't1' }), /uncancelable[\s\S]*--force sends Force Kill/);
    for (const argv of [{ yes: true }, { yes: true, 'expect-transaction': '' }, { yes: true, 'expect-transaction': "t1'" }, { 'expect-transaction': 'a^b' }]) {
      const sdk = killSdk();
      await assert.rejects(killTransaction(sdk, { session: 'S1', ...argv }), { code: 'usage_error' }, JSON.stringify(argv));
      assert.equal(sdk.calls.length, 0, JSON.stringify(argv));
    }
    const finished = killSdk();
    await assert.rejects(killTransaction(finished, { session: 'S1', yes: true, 'expect-transaction': 't9' }), /it may have finished; preview again\) not found: t9/);
    const other = killSdk({ reads: [[activeRow(2, { snapshot_id: pair('ME') })]] });
    await assert.rejects(killTransaction(other, { session: 'S1', yes: true, 'expect-transaction': 't2' }), /not found: S1/);
    const preview = killSdk();
    const result = await killTransaction(preview, { session: 'S1' });
    assert.deepEqual(result.rerun, ['jsn transactions kill S1 --yes --expect-transaction t1']);
    assert.match(formatKillTransaction(result), /^Would send Kill to session S1 on node001:\n[\s\S]*To send it, run:\n {2}jsn transactions kill S1 --yes --expect-transaction t1\n$/);
    assert.equal(result.dry_run, true);
    assert.equal(result.method, 'kill');
    assert.equal('snapshot_id' in result.transactions[0], false);
    for (const sdk of [missing, unseen, own, stuck, finished, other, preview]) assert.equal(scripts(sdk).length, 0);
    assert.equal(preview.calls.find(call => call.table === 'v_cluster_transaction').query, 'session_id=S1');
  });

  it("sends the Kill UI action's call on the transaction's node, then confirms it ended from a fresh refresh and the cancellation log", async () => {
    const { killTransaction, formatKillTransaction } = await import('../src/active-transactions.js');
    const sdk = killSdk({ reads: [[activeRow(1, { transaction_id: pair(tx('a1')), snapshot_id: pair('ME') })], []] });
    let sleeps = 0;
    const result = await killTransaction(sdk, { session: 'S1', yes: true, 'expect-transaction': tx('a1') }, { sleep: async () => { sleeps++; } });
    const [sent] = scripts(sdk);
    assert.equal(sent.scope, 'global');
    assert.match(sent.script, /var session = 'S1', nodes = \["app1\.example:node001"\]/);
    assert.match(sent.script, /if \(nodes\[i\] == here\) GlideTransactionManager\.kill\(session\);/);
    assert.match(sent.script, /GlideClusterMessage\.postScript\("GlideTransactionManager\.kill\('" \+ session \+ "'\);", nodes\[i\]\)/);
    assert.equal(result.ended, true);
    assert.equal(sleeps, 1);
    assert.equal(sdk.calls.filter(call => call.url?.endsWith('/loading_transactions.do')).length, 2);
    assert.equal(sdk.calls.find(call => call.table === 'syslog_cancellation').query, `transaction_idIN${tx('a1')}`);
    assert.equal(result.cancellations.length, 1);
    // syslog_cancellation.node_id is a sys_id, so the line leaves it out; the first line names the node.
    assert.match(formatKillTransaction(result), /^Kill sent to session S1 on node001\.\nEnded: the transaction is no longer running\.\nCancellation logged: Killed by admin at 2026-11-25 08:00:00\n$/);
  });

  it('sends Force Kill for an uncancelable transaction only with --force', async () => {
    const { killTransaction } = await import('../src/active-transactions.js');
    const sdk = killSdk({ reads: [[activeRow(1, { uncancelable: pair('true'), snapshot_id: pair('ME') })], []] });
    const result = await killTransaction(sdk, { session: 'S1', yes: true, 'expect-transaction': 't1', force: true }, { sleep: async () => {} });
    assert.equal(result.method, 'forceKill');
    assert.match(scripts(sdk)[0].script, /GlideTransactionManager\.forceKill\(session\)[\s\S]*GlideTransactionManager\.forceKill\('/);
    assert.doesNotMatch(scripts(sdk)[0].script, /\.kill\(/);
  });

  it('kills only the previewed transaction when the worker session name runs on two nodes', async () => {
    const { killTransaction, formatKillTransaction } = await import('../src/active-transactions.js');
    const rows = [activeRow(1, { transaction_id: pair(tx('c1')), snapshot_id: pair('ME') }), activeRow(1, { transaction_id: pair(tx('c2')), node_id: pair('app2.example:node002'), uncancelable: pair('true'), snapshot_id: pair('ME') })];
    const listing = killSdk({ reads: [rows] });
    const preview = await killTransaction(listing, { session: 'S1' });
    assert.equal(scripts(listing).length, 0);
    assert.deepEqual(preview.rerun, [`jsn transactions kill S1 --yes --expect-transaction ${tx('c1')}`, `jsn transactions kill S1 --yes --expect-transaction ${tx('c2')} --force`]);
    assert.match(formatKillTransaction(preview), new RegExp(`^Session S1 is running 2 transactions:\\n[\\s\\S]*Each command kills one of them; run only the one you mean:\\n  jsn transactions kill S1 --yes --expect-transaction ${tx('c1')}  # node001 /api/now/table/t1\\n  jsn transactions kill S1 --yes --expect-transaction ${tx('c2')} --force  # node002 /api/now/table/t1\\n$`));
    const partial = killSdk({ reads: [rows.slice(0, 1)], pages: ["var executionID = 'null';"] });
    await assert.rejects(killTransaction(partial, { session: 'S1', yes: true, 'expect-transaction': tx('c2') }), /Transaction c20+ was not listed, but the list may be incomplete: .*only this node/);
    assert.equal(scripts(partial).length, 0);
    const sdk = killSdk({ reads: [rows, [rows[1]]] });
    const result = await killTransaction(sdk, { session: 'S1', yes: true, 'expect-transaction': tx('c1') }, { sleep: async () => {} });
    assert.equal(scripts(sdk).length, 1);
    assert.match(scripts(sdk)[0].script, /nodes = \["app1\.example:node001"\]/);
    assert.equal(result.method, 'kill');
    assert.equal(result.ended, true);
  });

  it('never reports a kill as done while the transaction is listed, the refresh is partial, or the script did not confirm', async () => {
    const { killTransaction, formatKillTransaction } = await import('../src/active-transactions.js');
    const { killTransactionCmd } = await import('../src/commands/transactions.js');
    const row = activeRow(1, { transaction_id: pair(tx('b2')), snapshot_id: pair('ME') });
    let sleeps = 0;
    const alive = await killTransaction(killSdk({ reads: [[row]], cancellations: [] }), { session: 'S1', yes: true, 'expect-transaction': tx('b2') }, { sleep: async () => { sleeps++; } });
    assert.equal(alive.ended, false);
    assert.equal(sleeps, 5);
    assert.equal(alive.still_running.length, 1);
    assert.match(formatKillTransaction(alive), /Still running after 5 re-reads, 2 seconds apart[\s\S]*No cancellation logged/);
    const partial = await killTransaction(killSdk({ reads: [[row], []], pages: [`var executionID = '${EXEC}';`, "var executionID = 'null';"] }), { session: 'S1', yes: true, 'expect-transaction': tx('b2') }, { sleep: async () => {} });
    assert.equal(partial.ended, false);
    assert.match(formatKillTransaction(partial), /Not confirmed: .*only this node/);
    const blind = await killTransaction(killSdk({ reads: [[row], []], own: [] }), { session: 'S1', yes: true, 'expect-transaction': tx('b2') }, { sleep: async () => {} });
    assert.equal(blind.ended, false);
    assert.match(formatKillTransaction(blind), /Not confirmed: The refreshed list was not visible/);
    const silent = killSdk({ reads: [[row]], output: '' });
    await assert.rejects(killTransaction(silent, { session: 'S1', yes: true, 'expect-transaction': tx('b2') }), /no confirmation that it ran/);
    assert.equal(silent.calls.filter(call => call.table === 'syslog_cancellation').length, 0);
    const app = buildApp(killSdk({ reads: [[row]], cancellations: [] }));
    const previous = process.exitCode;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const run = killTransactionCmd(fn => fn).handler({ session: 'S1', yes: true, 'expect-transaction': tx('b2'), app }, app).finally(() => { settled = true; });
      while (!settled) { await new Promise(resolve => setImmediate(resolve)); mock.timers.tick(2000); }
      await run;
      assert.equal(process.exitCode, 1);
      assert.match(app.lastOk.opts.summary, /not confirmed ended/);
    } finally { mock.timers.reset(); process.exitCode = previous; }
  });
});

describe('transactions active --watch', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

  it('rejects bad watch options before any request', async () => {
    const { watchActiveTransactions, watchOptions } = await import('../src/active-transactions.js');
    assert.throws(() => watchOptions({ interval: 5 }), /need --watch/);
    assert.throws(() => watchOptions({ timeout: 5 }), /need --watch/);
    assert.equal(watchOptions({}), null);
    for (const argv of [{ interval: 1 }, { interval: 301 }, { interval: 2.5 }, { timeout: -1 }, { timeout: 86401 }, { limit: 0 }, { 'older-than': 'soon' }]) {
      const sdk = activeSdk();
      await assert.rejects(watchActiveTransactions(sdk, { watch: true, timeout: 4, ...argv }, { emit() {}, ...clock() }), { code: 'usage_error' }, JSON.stringify(argv));
      assert.equal(sdk.calls.length, 0, JSON.stringify(argv));
    }
  });

  it('refreshes every interval until the timeout, reads only, then reports a summary', async () => {
    const { watchActiveTransactions } = await import('../src/active-transactions.js');
    const sdk = activeSdk();
    const events = [];
    const summary = await watchActiveTransactions(sdk, { watch: true, interval: 5, timeout: 12, limit: 3 }, { emit: event => events.push(event), ...clock() });
    assert.deepEqual(events.map(event => event.type), ['transactions_active', 'transactions_active', 'transactions_active', 'watch_summary']);
    assert.deepEqual(summary, { type: 'watch_summary', reason: 'timeout', snapshots: 3, failed_refreshes: 0, duration_ms: 12000 });
    assert.equal(events[0].records[0].session_id.value, 'S1');
    assert.equal(sdk.calls.filter(call => call.table === 'v_cluster_transaction').every(call => call.params.get('sysparm_limit') === '4'), true);
    assert.equal(sdk.calls.every(call => call.table || call.opts.method === 'GET'), true);
  });

  it('stops on Ctrl-C without another refresh', async () => {
    const { watchActiveTransactions } = await import('../src/active-transactions.js');
    const sdk = activeSdk();
    const controller = new AbortController();
    const events = [];
    const summary = await watchActiveTransactions(sdk, { watch: true }, { signal: controller.signal, emit: event => { events.push(event); controller.abort(); }, ...clock() });
    assert.equal(summary.reason, 'cancelled');
    assert.equal(summary.snapshots, 1);
    assert.equal(sdk.calls.filter(call => call.url).length, 1);
  });

  it('stops on Ctrl-C while a node is still reporting, with no snapshot the cancel cut short', async () => {
    const { watchActiveTransactions } = await import('../src/active-transactions.js');
    const sdk = activeSdk({ trackers: [[{ parent: pair(EXEC), name: pair('Node B'), state: pair('1', 'Running') }]] });
    const controller = new AbortController();
    const events = [];
    const summary = await watchActiveTransactions(sdk, { watch: true }, { signal: controller.signal, emit: event => events.push(event), now: () => 0, sleep: async () => controller.abort() });
    assert.deepEqual(events.map(event => event.type), ['watch_summary']);
    assert.equal(summary.reason, 'cancelled');
    assert.equal(summary.snapshots, 0);
    assert.equal(sdk.calls.filter(call => call.table === 'sys_execution_tracker').length, 1);
    assert.equal(sdk.calls.filter(call => call.table === 'v_cluster_transaction').length, 0);
  });

  it('ends at once on a refusal that a retry cannot fix', async () => {
    const { watchActiveTransactions } = await import('../src/active-transactions.js');
    const notAdmin = activeSdk({ html: '<html>login.do</html>' });
    await assert.rejects(watchActiveTransactions(notAdmin, { watch: true }, { emit() {}, ...clock() }), /needs the admin role/);
    assert.equal(notAdmin.calls.length, 1);
    for (const code of ['auth_error', 'forbidden']) {
      const denied = activeSdk({ raw: Object.assign(new Error('denied'), { code }) });
      await assert.rejects(watchActiveTransactions(denied, { watch: true }, { emit() {}, ...clock() }), { code });
      assert.equal(denied.calls.length, 1, code);
    }
  });

  it('carries on after a failed refresh, but three in a row end the watch', async () => {
    const { watchActiveTransactions, formatWatchEvent } = await import('../src/active-transactions.js');
    const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    const flaky = activeSdk();
    const raw = flaky.rawRequest;
    let n = 0;
    flaky.rawRequest = async (...args) => { if (n++ === 0) throw redirect; return raw(...args); };
    const events = [];
    await watchActiveTransactions(flaky, { watch: true, interval: 2, timeout: 3 }, { emit: event => events.push(event), ...clock() });
    assert.deepEqual(events.map(event => event.type), ['refresh_failed', 'transactions_active', 'watch_summary']);
    assert.match(formatWatchEvent(events[0]), /refresh failed, retrying: .*The instance redirected/);
    assert.match(formatWatchEvent(events[1]), /^--- 00:00:02 UTC: 1 active\nAGE/);
    const every = activeSdk();
    let m = 0;
    every.rawRequest = async (...args) => { if (m++ % 2 === 0) throw redirect; return raw(...args); };
    const alternating = [];
    await watchActiveTransactions(every, { watch: true, interval: 2, timeout: 9 }, { emit: event => alternating.push(event), ...clock() });
    assert.deepEqual(alternating.map(event => event.type), ['refresh_failed', 'transactions_active', 'refresh_failed', 'transactions_active', 'refresh_failed', 'watch_summary']);
    assert.equal(alternating[5].failed_refreshes, 3);
    assert.match(formatWatchEvent(alternating[5]), /^watch ended \(timeout\): 2 refresh\(es\), 3 failed, 9s$/);
    const down = activeSdk({ raw: redirect });
    await assert.rejects(watchActiveTransactions(down, { watch: true, interval: 2 }, { emit() {}, ...clock() }), /redirected/);
    assert.equal(down.calls.length, 3);
  });

  // Windows timers can wake a few milliseconds early. The watch must still end
  // at the deadline instead of taking one more snapshot than asked for.
  it('ends at the deadline even when the timer wakes early', async () => {
    const { watchActiveTransactions } = await import('../src/active-transactions.js');
    const events = [];
    let t = 0;
    // The first wakeup lands 5 ms early; later ones keep time, so the loop
    // cannot spin and a wrong break shows up as a frame, not a hang.
    let wakes = 0;
    await watchActiveTransactions(activeSdk(), { watch: true, interval: 2, timeout: 1 }, {
      emit: event => events.push(event), now: () => t, sleep: async ms => { t += ms - (wakes++ === 0 ? 5 : 0); },
    });
    assert.deepEqual(events.map(event => event.type), ['transactions_active', 'watch_summary']);
    assert.equal(events[1].snapshots, 1);
  });

  it('streams newline-delimited JSON through the real CLI and ends at --timeout', async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/loading_transactions.do') { res.setHeader('Content-Type', 'text/html'); res.end(`var executionID = '${EXEC}';`); return; }
      const table = url.pathname.split('/').pop();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: table === 'sys_execution_tracker' ? [{ parent: pair(EXEC), name: pair('Node A'), state: pair('2') }] : table === 'v_cluster_transaction' ? [activeRow(1)] : {} }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-transactions-watch-')));
    fs.mkdirSync(path.join(dir, 'servicenow'));
    fs.writeFileSync(path.join(dir, 'servicenow/config.json'), JSON.stringify({ default_profile: 'fixture', profiles: { fixture: { instance_url: `http://127.0.0.1:${server.address().port}`, auth_method: 'basic', read_only: true } } }));
    const env = loopbackFixtureEnv({ HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, JSN_DATA_HOME: path.join(dir, 'data'), SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture-secret', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_HEADER: '1', JSN_NO_PROMPTS: '1' });
    const cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'transactions', 'active', '--watch', '--interval', '2', '--timeout', '1', '--json'], { env, cwd: dir, timeout: 20000 });
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(events.map(event => event.type), ['transactions_active', 'watch_summary']);
      assert.equal(events[0].records[0].session_id.value, 'S1');
      assert.equal(events[1].reason, 'timeout');
      requests = 0;
      const refused = await promisify(execFile)(process.execPath, [...loopbackCredentialArgs, cli, 'transactions', 'active', '--interval', '2', '--json'], { env, cwd: dir, timeout: 20000 }).then(() => null, error => error);
      assert.match(`${refused.stdout}${refused.stderr}`, /need --watch/);
      assert.equal(refused.code, 2);
      assert.equal(requests, 0);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
