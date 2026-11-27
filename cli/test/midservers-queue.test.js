// Tests for `jsn midservers queue` (issue #663) — read-only ECC queue view.
// All provider access is mocked; no live instance is involved.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { midserversCmd } from '../src/commands/midservers.js';
import {
  buildInputErrorQuery,
  buildWaitingQuery,
  formatQueueReport,
  midNameFromAgent,
  parseOlderThan,
  parseQueueGroups,
  routingAgentForName,
  sortQueueRows,
  summarizeAgents,
  validateLimit,
} from '../src/midserver-queue.js';
import { mutationPaths } from '../src/capabilities.js';
import { OutputWriter } from '../src/output.js';

const HEX = 'a'.repeat(32);

function collectCommands(command) {
  const commands = [];
  const yargs = { command(child) { commands.push(child); return yargs; } };
  command.builder(yargs);
  return commands;
}

function queueCommand() {
  return collectCommands(midserversCmd(handler => handler)).find(child => child.command === 'queue [identifier]');
}

function group(agent, topic, count) {
  const fields = [{ field: 'agent', value: agent }];
  if (topic !== undefined) fields.push({ field: 'topic', value: topic });
  return { stats: { count: String(count) }, groupby_fields: fields };
}

function midRecord({ name = 'mid-a', status = 'Up', validated = 'Yes', host = 'host-a' } = {}) {
  return {
    sys_id: { value: HEX, display_value: HEX },
    name: { value: name, display_value: name },
    status: { value: status, display_value: status },
    validated: { value: validated === 'Yes' ? 'true' : validated, display_value: validated },
    host_name: { value: host, display_value: host },
  };
}

function oldestRecord(agent, created = '2026-11-20 08:00:00') {
  return {
    sys_id: { value: 'b'.repeat(32), display_value: 'b'.repeat(32) },
    topic: { value: 'SystemCommand', display_value: 'SystemCommand' },
    name: { value: `probe-${agent}`, display_value: `probe-${agent}` },
    state: { value: 'ready', display_value: 'ready' },
    priority: { value: '2', display_value: 'Standard' },
    sys_created_on: { value: created, display_value: created },
  };
}

function makeApp({
  waitingGroups = [],
  inputGroups = [],
  waitingCount,
  inputCount,
  agentRecords = [],
  oldest = () => [],
  aggregateRejectsTopic = false,
  instanceRequired = () => {},
} = {}) {
  const calls = { aggregate: [], count: [], list: [], listStrict: [] };
  let topicAttempts = 0;
  const sdk = {
    async aggregate(table, options) {
      calls.aggregate.push({ table, ...options });
      if (options.query.includes('queue=input')) return { groups: inputGroups };
      if (options.groupBy.includes('topic')) {
        topicAttempts += 1;
        if (aggregateRejectsTopic && topicAttempts === 1) {
          const error = new Error('Invalid field topic');
          error.code = 'api_error';
          throw error;
        }
      }
      return { groups: waitingGroups };
    },
    async aggregateCount(table, query) {
      calls.count.push({ table, query });
      if (query.includes('queue=input')) return inputCount ?? inputGroups.reduce((n, g) => n + Number(g.stats.count), 0);
      return waitingCount ?? waitingGroups.reduce((n, g) => n + Number(g.stats.count), 0);
    },
    async list(table, params) {
      calls.list.push({ table, params });
      const query = params.get('sysparm_query') || '';
      if (table === 'ecc_agent') {
        if (query.startsWith('nameIN')) return agentRecords;
        const name = query.match(/^name=([^^]+)/)?.[1];
        return name ? agentRecords.filter(record => record.name?.value === name || record.name === name) : [];
      }
      return [];
    },
    async listStrict(table, params) {
      calls.listStrict.push({ table, params });
      return oldest(params.get('sysparm_query') || '');
    },
  };
  const writes = [];
  const output = new OutputWriter({ format: 'json', writer: { write: text => writes.push(text) } });
  const app = {
    sdk,
    calls,
    writes,
    output,
    instanceRequired: false,
    ok(data, opts) { this.lastOk = { data, opts }; output.ok(data, opts); },
    err(error) { output.err(error); },
    requireInstance() { app.instanceRequired = true; instanceRequired(); },
    getEffectiveInstance: () => 'https://example.service-now.com',
  };
  return app;
}

async function runQueue(app, argv = {}) {
  const command = queueCommand();
  await command.handler({ olderThan: '15m', limit: 25, ...argv }, app);
  return app.lastOk.data;
}

describe('midservers queue — argument parsing', () => {
  it('defaults to 15m and accepts minutes, hours and days', () => {
    assert.deepEqual(parseOlderThan(undefined), { text: '15m', minutes: 15, seconds: 900 });
    assert.equal(parseOlderThan('15m').minutes, 15);
    assert.equal(parseOlderThan('2h').minutes, 120);
    assert.equal(parseOlderThan('1d').minutes, 1440);
    assert.equal(parseOlderThan(' 90M ').minutes, 90);
  });

  it('rejects malformed or out-of-range windows with a usage error', () => {
    for (const value of ['15', '0m', '-5m', '1.5h', '15minutes', '1w', 'abc', '1000d']) {
      assert.throws(() => parseOlderThan(value), error => error.code === 'usage_error' && /--older-than/.test(error.message), value);
    }
  });

  it('bounds --limit to 1..200', () => {
    assert.equal(validateLimit(undefined), 25);
    assert.equal(validateLimit(1), 1);
    assert.equal(validateLimit(200), 200);
    for (const value of [0, -1, 201, 1.5, 'abc']) {
      assert.throws(() => validateLimit(value), error => error.code === 'usage_error');
    }
  });

  it('rejects invalid input before any instance or network call', async () => {
    const app = makeApp();
    await assert.rejects(runQueue(app, { olderThan: '15minutes' }), { code: 'usage_error' });
    await assert.rejects(runQueue(app, { limit: 0 }), { code: 'usage_error' });
    await assert.rejects(runQueue(app, { identifier: 'bad^name' }), { code: 'usage_error' });
    assert.equal(app.instanceRequired, false);
    assert.deepEqual(app.calls, { aggregate: [], count: [], list: [], listStrict: [] });
  });
});

describe('midservers queue — query and aggregate helpers', () => {
  it('builds the verified direction/state/age query', () => {
    const older = parseOlderThan('2h');
    assert.equal(
      buildWaitingQuery(older),
      'queue=output^stateINready,processing^sys_created_on<javascript:gs.minutesAgoStart(120)',
    );
    assert.equal(
      buildWaitingQuery(older, 'mid.server.worker1'),
      'queue=output^stateINready,processing^sys_created_on<javascript:gs.minutesAgoStart(120)^agent=mid.server.worker1',
    );
    assert.equal(
      buildInputErrorQuery(older),
      'queue=input^state=error^sys_created_on<javascript:gs.minutesAgoStart(120)',
    );
  });

  it('derives routing values from MID names and back without inventing one', () => {
    assert.equal(routingAgentForName('worker1'), 'mid.server.worker1');
    assert.equal(routingAgentForName('mid.server.worker1'), 'mid.server.worker1');
    assert.equal(midNameFromAgent('mid.server.worker1'), 'worker1');
    assert.equal(midNameFromAgent('mid.server.*'), null);
    assert.equal(midNameFromAgent('worker1'), null);
    assert.equal(midNameFromAgent(''), null);
  });

  it('parses Stats groups, drops empty groups and merges topics per agent', () => {
    const groups = parseQueueGroups({ groups: [
      group('mid.server.a', 'SystemCommand', 3),
      group('mid.server.a', 'HeartbeatProbe', '1'),
      group('mid.server.b', 'SystemCommand', 0),
    ] });
    assert.deepEqual(groups.map(item => [item.agent, item.topic, item.count]), [
      ['mid.server.a', 'SystemCommand', 3],
      ['mid.server.a', 'HeartbeatProbe', 1],
    ]);
    assert.deepEqual(summarizeAgents(groups), [
      { agent: 'mid.server.a', waiting: 4, topics: [{ topic: 'SystemCommand', count: 3 }, { topic: 'HeartbeatProbe', count: 1 }] },
    ]);
  });

  it('orders rows by waiting count, then oldest row', () => {
    const rows = [
      { agent: 'mid.server.b', waiting: 1, oldest: { sys_created_on: '2026-11-20 10:00:00' } },
      { agent: 'mid.server.a', waiting: 5, oldest: { sys_created_on: '2026-11-21 10:00:00' } },
      { agent: 'mid.server.c', waiting: 1, oldest: { sys_created_on: '2026-11-19 10:00:00' } },
    ];
    assert.deepEqual(sortQueueRows(rows).map(row => row.agent), ['mid.server.a', 'mid.server.c', 'mid.server.b']);
  });
});

describe('midservers queue — command handler', () => {
  it('reports one row per agent with its MID record, oldest row and input-error count', async () => {
    const app = makeApp({
      waitingGroups: [
        group('mid.server.mid-a', 'SystemCommand', 3),
        group('mid.server.mid-a', 'HeartbeatProbe', 1),
        group('mid.server.gone', 'SystemCommand', 2),
      ],
      inputGroups: [group('mid.server.mid-a', undefined, 2)],
      agentRecords: [midRecord()],
      oldest: query => [oldestRecord(query.includes('mid.server.gone') ? 'gone' : 'mid-a')],
    });
    const data = await runQueue(app);

    assert.equal(data.table, 'ecc_queue');
    assert.equal(data.older_than, '15m');
    assert.equal(data.count, 2);
    assert.deepEqual(data.agents.map(row => row.agent), ['mid.server.mid-a', 'mid.server.gone']);
    assert.equal(data.agents[0].waiting, 4);
    assert.deepEqual(data.agents[0].topics, [
      { topic: 'SystemCommand', count: 3 },
      { topic: 'HeartbeatProbe', count: 1 },
    ]);
    assert.equal(data.agents[0].mid_server, 'mid-a');
    assert.equal(data.agents[0].sys_id, HEX);
    assert.equal(data.agents[0].status, 'Up');
    assert.equal(data.agents[0].validated, 'Yes');
    assert.equal(data.agents[0].oldest.topic, 'SystemCommand');
    assert.equal(data.agents[0].input_errors, 2);

    // An agent in the queue without an ecc_agent row is unknown, not zero.
    assert.equal(data.agents[1].mid_server, 'gone');
    assert.equal(data.agents[1].sys_id, null);
    assert.match(data.agents[1].mid_error, /no ecc_agent row/);
    assert.equal(data.agents[1].input_errors, 0);

    assert.deepEqual(data.totals, {
      agents_total: 2,
      agents_shown: 2,
      waiting_total: 6,
      waiting_shown: 6,
      waiting_grouped: 6,
      input_errors: 2,
      input_errors_grouped: 2,
    });
    assert.deepEqual(data.complete, { waiting: true, input_errors: true, topics: true, mid_lookup: 'ok' });
    assert.equal(data.url, 'https://example.service-now.com/ecc_queue_list.do?sysparm_query=queue%3Doutput%5EstateINready%2Cprocessing%5Esys_created_on%3Cjavascript%3Ags.minutesAgoStart%2815%29');

    // Oldest-row reads are exact, ascending, single-row, strict reads.
    assert.equal(app.calls.listStrict.length, 2);
    for (const call of app.calls.listStrict) {
      assert.equal(call.table, 'ecc_queue');
      assert.match(call.params.get('sysparm_query'), /\^ORDERBYASCsys_created_on$/);
      assert.equal(call.params.get('sysparm_limit'), '1');
    }
    // No mutation methods exist on this surface at all.
    assert.equal(app.calls.create, undefined);
  });

  it('reports an empty queue as zero rows without implying a healthy MID', async () => {
    const app = makeApp();
    const data = await runQueue(app);
    assert.deepEqual(data.agents, []);
    assert.equal(data.totals.waiting_total, 0);
    assert.equal(data.complete.waiting, true);
    const formatted = data._formatted;
    assert.match(formatted, /No waiting output rows matched this window/);
    assert.match(formatted, /not a MID Server health verdict/);
  });

  it('keeps _formatted out of the machine envelope and leaves --get paths intact', async () => {
    const data = await runQueue(makeApp());
    assert.equal(Object.keys(data).includes('_formatted'), false);
    assert.equal(JSON.stringify(data).includes('ECC output queue'), false);
    const writes = [];
    const output = new OutputWriter({ format: 'json', jqFilter: 'data.totals.waiting_total', writer: { write: text => writes.push(text) } });
    output.ok(data);
    assert.equal(writes.join('').trim(), '0');
  });

  it('bounds displayed agents but keeps the provider aggregate total', async () => {
    const app = makeApp({
      waitingGroups: [
        group('mid.server.a', 'SystemCommand', 5),
        group('mid.server.b', 'SystemCommand', 3),
        group('mid.server.c', 'SystemCommand', 1),
      ],
      agentRecords: [midRecord({ name: 'a' }), midRecord({ name: 'b' }), midRecord({ name: 'c' })],
    });
    const data = await runQueue(app, { limit: 1 });
    assert.equal(data.count, 1);
    assert.equal(data.agents[0].agent, 'mid.server.a');
    assert.equal(data.totals.agents_total, 3);
    assert.equal(data.totals.waiting_total, 9);
    assert.equal(data.totals.waiting_shown, 5);
    assert.equal(data.pagination.total, 3);
    assert.match(data._formatted, /2 further agent\(s\).*--limit 1/);
  });

  it('falls back to agent-only grouping and marks topics unavailable', async () => {
    const app = makeApp({
      aggregateRejectsTopic: true,
      waitingGroups: [group('mid.server.a', undefined, 2)],
      agentRecords: [midRecord({ name: 'a' })],
    });
    const data = await runQueue(app);
    assert.equal(data.complete.topics, false);
    assert.deepEqual(data.agents[0].topics, []);
    assert.equal(data.agents[0].waiting, 2);
    assert.equal(app.calls.aggregate[1].groupBy[1], undefined);
  });

  it('marks an unreadable input-error aggregate as unknown instead of zero', async () => {
    const app = makeApp({ waitingGroups: [group('mid.server.a', 'SystemCommand', 2)], agentRecords: [midRecord({ name: 'a' })] });
    app.sdk.aggregate = async (table, options) => {
      if (options.query.includes('queue=input')) throw new Error('ACL denied');
      return { groups: [group('mid.server.a', 'SystemCommand', 2)] };
    };
    app.sdk.aggregateCount = async (table, query) => {
      if (query.includes('queue=input')) throw new Error('ACL denied');
      return 2;
    };
    const data = await runQueue(app);
    assert.equal(data.agents[0].input_errors, null);
    assert.equal(data.totals.input_errors, null);
    assert.equal(data.complete.input_errors, null);
    assert.match(data._formatted, /input row\(s\) in error/);
  });

  it('flags a provider total that disagrees with the grouped counts', async () => {
    const app = makeApp({
      waitingGroups: [group('mid.server.a', 'SystemCommand', 2)],
      waitingCount: 5,
      agentRecords: [midRecord({ name: 'a' })],
    });
    const data = await runQueue(app);
    assert.equal(data.complete.waiting, false);
    assert.equal(data.totals.waiting_total, 5);
    assert.equal(data.totals.waiting_grouped, 2);
    assert.match(data._formatted, /does not match the grouped count 2; this breakdown may be incomplete/);
  });

  it('shows the agent filter in the human view', () => {
    const text = formatQueueReport({
      older_than: '15m', agent_filter: 'mid.server.worker1', agents: [],
      totals: { agents_total: 0, agents_shown: 0, waiting_shown: 0, input_errors: 0 }, pagination: { limit: 25 },
    });
    assert.match(text, /Agent filter: mid\.server\.worker1/);
  });

  it('filters by a named MID and still reports a stale routing value', async () => {
    const app = makeApp({
      waitingGroups: [group('mid.server.stale-mid', 'SystemCommand', 2)],
      agentRecords: [],
    });
    const data = await runQueue(app, { identifier: 'stale-mid' });
    assert.equal(data.agent_filter, 'mid.server.stale-mid');
    assert.equal(data.agents[0].agent, 'mid.server.stale-mid');
    assert.match(data.agents[0].mid_error, /no ecc_agent row/);
    assert.match(app.calls.aggregate[0].query, /\^agent=mid\.server\.stale-mid$/);
  });

  it('does not hide a missing MID when a full sys_id was supplied', async () => {
    const app = makeApp();
    await assert.rejects(runQueue(app, { identifier: HEX }), { code: 'not_found' });
  });
});

describe('midservers queue — registration and safety', () => {
  it('registers the subcommand with documented defaults', () => {
    const command = queueCommand();
    assert.equal(command.command, 'queue [identifier]');
    assert.match(command.describe, /read-only/);
    const options = [];
    const y = { option(name, definition) { options.push({ name, definition }); return y; } };
    command.builder(y);
    assert.deepEqual(options.map(option => option.name), ['older-than', 'limit']);
    assert.equal(options[0].definition.default, '15m');
    assert.equal(options[1].definition.default, 25);
    assert.equal(options[1].definition.alias, 'l');
  });

  it('is not a declared mutation path', () => {
    assert.equal(mutationPaths().some(path => path.join(' ') === 'midservers queue'), false);
  });

  it('renders a styled table for waiting agents', () => {
    const text = formatQueueReport({
      older_than: '2h',
      agents: [{
        agent: 'mid.server.a', mid_server: 'a', status: 'Up', validated: 'Yes', host_name: 'host',
        waiting: 3, topics: [{ topic: 'SystemCommand', count: 3 }],
        oldest: { sys_created_on: '2026-11-20 08:00:00', topic: 'SystemCommand' }, input_errors: 1,
      }],
      totals: { agents_total: 1, agents_shown: 1, waiting_shown: 3, input_errors: 1 },
      pagination: { limit: 25 },
    });
    assert.match(text, /ECC output queue older than 2h/);
    assert.match(text, /mid\.server\.a\s+3\s+1\s+2026-11-20 08:00:00\s+SystemCommand/);
    assert.match(text, /MID: a\s+status Up\s+validated Yes/);
    assert.match(text, /not a MID Server health verdict/);
  });
});
